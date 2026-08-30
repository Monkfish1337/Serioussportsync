'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'security-test-secret-000000000000000000000000000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const security = require('../lib/security');
const sessions = require('../lib/sessions');

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
}

test('provider URL policy keeps Docker endpoints but blocks credentials and metadata services', () => {
  assert.equal(security.cleanHttpUrl('http://nzbdav:3000/', { label: 'Provider URL' }), 'http://nzbdav:3000');
  assert.throws(() => security.cleanHttpUrl('http://user:pass@nzbdav:3000'), /credentials/);
  assert.throws(() => security.cleanHttpUrl('https://indexer.example/api?apikey=secret'), /separate secret field/);
  assert.equal(security.cleanHttpUrl('https://uu.example/manifest.json?token=secret', {
    allowSensitiveQuery: true,
  }), 'https://uu.example/manifest.json?token=secret');
  assert.throws(() => security.cleanHttpUrl('http://169.254.169.254/latest/meta-data'), /cloud metadata/);
  assert.throws(() => security.cleanHttpUrl('http://169.254.12.34/anything'), /cloud metadata/);
  assert.throws(() => security.cleanHttpUrl('file:///etc/passwd'), /HTTP or HTTPS/);
});

test('forwarded host and protocol are ignored until TRUST_PROXY is explicit', () => {
  const original = config.trustProxy;
  const originalPublicUrl = config.publicUrl;
  config.publicUrl = '';
  const req = {
    headers: { host: '192.168.1.10:7000', 'x-forwarded-host': 'sports.example', 'x-forwarded-proto': 'https' },
    socket: {},
  };
  config.trustProxy = false;
  assert.equal(security.publicOrigin(req), 'http://192.168.1.10:7000');
  config.trustProxy = true;
  assert.equal(security.publicOrigin(req), 'https://sports.example');
  config.trustProxy = original;
  config.publicUrl = originalPublicUrl;
});

test('cross-site mutations are rejected while same-origin forms are accepted', () => {
  const original = config.publicUrl;
  config.publicUrl = 'https://sports.example';
  let nextCalled = false;
  const blocked = response();
  security.csrf({ method: 'POST', headers: { host: 'sports.example', origin: 'https://evil.example' } }, blocked, () => { nextCalled = true; });
  assert.equal(blocked.statusCode, 403);
  assert.equal(nextCalled, false);

  const allowed = response();
  security.csrf({ method: 'POST', headers: { host: 'sports.example', origin: 'https://sports.example' } }, allowed, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  const sandboxedSameOrigin = response();
  security.csrf({ method: 'POST', headers: { host: 'sports.example', origin: 'null', 'sec-fetch-site': 'same-origin' } }, sandboxedSameOrigin, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  const installedWebview = response();
  security.csrf({ method: 'POST', headers: { host: 'sports.example', origin: 'null' } }, installedWebview, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  const sandboxedCrossSite = response();
  security.csrf({ method: 'POST', headers: { host: 'sports.example', origin: 'null', 'sec-fetch-site': 'cross-site' } }, sandboxedCrossSite, () => { nextCalled = true; });
  assert.equal(sandboxedCrossSite.statusCode, 403);
  assert.equal(nextCalled, false);
  config.publicUrl = original;
});

test('security headers deny framing and sensitive browser capabilities', () => {
  const res = response();
  security.headers({ path: '/admin' }, res, () => {});
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('versioned sessions support immediate server-side revocation checks', () => {
  const token = sessions.createToken('user-1', 7);
  const parsed = sessions.verifyToken(token);
  assert.equal(parsed.userId, 'user-1');
  assert.equal(parsed.sessionVersion, 7);
  assert.notEqual(parsed.sessionVersion, 8);
});

test('secure cookies trust forwarded HTTPS only behind an explicit proxy', () => {
  const original = config.trustProxy;
  const req = { headers: { 'x-forwarded-proto': 'https' }, connection: {}, socket: {} };
  const plain = response();
  config.trustProxy = false;
  sessions.setCookie(plain, { id: 'u', sessionVersion: 1 }, req);
  assert.doesNotMatch(plain.headers['set-cookie'], /; Secure/);
  const proxied = response();
  config.trustProxy = true;
  sessions.setCookie(proxied, { id: 'u', sessionVersion: 1 }, req);
  assert.match(proxied.headers['set-cookie'], /; Secure/);
  config.trustProxy = original;
});
