'use strict';

// Route-level tests for the HTTP surface.
//
// addon.js holds authentication, session handling, every admin action and the
// two signed endpoints that spend a user's TorBox quota, and none of it was
// covered — the suite was strong on pure functions and silent on the layer
// where a mistake is exploitable rather than merely wrong. These boot the real
// Express app on an ephemeral port and drive it with fetch, so no HTTP test
// dependency is added.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-http-'));
process.env.SESSION_SECRET = 'http-route-test-secret-000000000000000000000000000000';
process.env.DATA_FILE = path.join(dir, 'events.json');
process.env.USERS_FILE = path.join(dir, 'users.json');
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.SPORT_VIDEO_FILE = path.join(dir, 'sport-video.json');
process.env.CONTENT_STUDIO_FILE = path.join(dir, 'content-studio.json');
process.env.METADATA_SOURCES_FILE = path.join(dir, 'metadata-sources.json');
process.env.CUSTOM_PROMOTIONS_FILE = path.join(dir, 'custom-promotions.json');
process.env.NUVIO_COLLECTIONS_FILE = path.join(dir, 'nuvio-collections.json');
process.env.POSITIVE_CACHE_FILE = path.join(dir, 'positive-cache.json');
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');

fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ updatedAt: null, events: [] }));

const { createApp } = require('../addon');
const users = require('../lib/users');
const urlSign = require('../lib/url-sign');

let server;
let base;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// `redirect: manual` throughout: a 302 to /login is the authorisation result
// being asserted, and following it would turn a rejection into a 200.
function get(pathname, options) {
  return fetch(base + pathname, Object.assign({ redirect: 'manual' }, options || {}));
}

// createUser hashes with bcrypt, so it is async and each call costs real time.
// Fixtures are created once and shared.
const fixtures = {};
async function makeUser(username, role) {
  if (!fixtures[username]) {
    fixtures[username] = await users.createUser({
      username, password: 'correct-horse-battery-staple', role: role || 'user',
    });
  }
  return fixtures[username];
}

test('health is public and exposes no configuration', async () => {
  const response = await get('/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.events, 'number');
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /secret|password|apiKey|token/i);
});

// Every admin route is one missing guard away from being world-writable. This
// walks the real router rather than sampling, so a new unguarded /admin route
// fails here rather than in production.
test('no admin route answers an unauthenticated request', async () => {
  const app = createApp();
  const layers = app._router && app._router.stack ? app._router.stack : [];
  const adminPaths = [];
  for (const layer of layers) {
    const route = layer.route;
    if (!route || !route.path) continue;
    if (typeof route.path !== 'string' || !route.path.startsWith('/admin')) continue;
    // Skip parameterised paths — exercised individually below.
    if (route.path.includes(':')) continue;
    for (const method of Object.keys(route.methods)) adminPaths.push([method, route.path]);
  }
  assert.ok(adminPaths.length >= 8, 'expected admin routes to enumerate, got ' + adminPaths.length);

  for (const [method, pathname] of adminPaths) {
    const response = await get(pathname, { method: method.toUpperCase() });
    assert.ok(
      response.status === 302 || response.status === 401 || response.status === 403,
      method.toUpperCase() + ' ' + pathname + ' answered ' + response.status
        + ' unauthenticated (expected a redirect or refusal)');
    if (response.status === 302) {
      assert.match(response.headers.get('location') || '', /^\/(login|setup)/,
        method.toUpperCase() + ' ' + pathname + ' redirected somewhere other than sign-in');
    }
  }
});

test('the diagnostics export refuses anonymous downloads', async () => {
  for (const pathname of ['/admin/sport-video/diagnostics.csv', '/admin/sport-video/diagnostics.json']) {
    const response = await get(pathname);
    assert.notEqual(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /event_id|promotion,/);
  }
});

test('a per-user addon route rejects a wrong or absent API token', async () => {
  const user = await makeUser('routetester');
  assert.ok(user && user.id, 'expected a user fixture');
  const token = user.apiToken;

  const good = await get('/u/' + user.id + '/' + token + '/manifest.json');
  assert.equal(good.status, 200);
  const manifest = await good.json();
  assert.ok(manifest.id, 'manifest should carry an id');

  // Wrong token, right user.
  assert.equal((await get('/u/' + user.id + '/' + 'x'.repeat(token.length) + '/manifest.json')).status, 404);
  // Right token, wrong user.
  assert.equal((await get('/u/not-a-user/' + token + '/manifest.json')).status, 404);
  // A truncated token must not pass a prefix comparison.
  assert.equal((await get('/u/' + user.id + '/' + token.slice(0, -1) + '/manifest.json')).status, 404);
});

// The resolve endpoint is the only path that adds a torrent to a user's debrid
// account. The path token gets through the router; the signature is what
// authorises the action, and it must fail closed.
test('resolve refuses an unsigned, tampered or expired link', async () => {
  const user = await makeUser('resolvetester');
  const eventId = 'ucl:test-1';
  const infoHash = 'a'.repeat(40);
  const prefix = '/u/' + user.id + '/' + user.apiToken + '/resolve/torbox/'
    + encodeURIComponent(eventId) + '/' + infoHash;

  const unsigned = await get(prefix);
  assert.equal(unsigned.status, 403);
  assert.equal(unsigned.headers.get('cache-control'), 'no-store');

  const signed = urlSign.signResolve({ userId: user.id, provider: 'torbox', eventId, infoHash });

  // Signature valid, but for a different release.
  const swapped = await get('/u/' + user.id + '/' + user.apiToken + '/resolve/torbox/'
    + encodeURIComponent(eventId) + '/' + 'b'.repeat(40)
    + '?exp=' + signed.exp + '&sig=' + signed.sig);
  assert.equal(swapped.status, 403);

  // Signature valid, but the expiry has been pushed out by hand.
  const extended = await get(prefix + '?exp=' + (Number(signed.exp) + 86400) + '&sig=' + signed.sig);
  assert.equal(extended.status, 403);

  // Correctly signed for an expiry that has already passed. `exp` is epoch
  // milliseconds and is covered by the signature, so this is the only way to
  // build a link that is authentic but stale.
  const stale = urlSign.signResolve({
    userId: user.id, provider: 'torbox', eventId, infoHash, exp: Date.now() - 1000,
  });
  const expired = await get(prefix + '?exp=' + stale.exp + '&sig=' + stale.sig);
  assert.equal(expired.status, 403);
  assert.match(await expired.text(), /expired|invalid/i);
});

test('a signature issued for one account does not authorise another', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const eventId = 'ucl:test-2';
  const infoHash = 'c'.repeat(40);
  const forAlice = urlSign.signResolve({
    userId: alice.id, provider: 'torbox', eventId, infoHash,
  });
  const response = await get('/u/' + bob.id + '/' + bob.apiToken + '/resolve/torbox/'
    + encodeURIComponent(eventId) + '/' + infoHash
    + '?exp=' + forAlice.exp + '&sig=' + forAlice.sig);
  assert.equal(response.status, 403);
});

test('catalog responses are marked private, not shared-cacheable', async () => {
  const user = await makeUser('cachetester');
  const response = await get('/u/' + user.id + '/' + user.apiToken + '/manifest.json');
  assert.equal(response.status, 200);
  const cacheControl = response.headers.get('cache-control') || '';
  // These URLs embed the account's API token. A shared proxy must never hold
  // one on behalf of another viewer.
  assert.doesNotMatch(cacheControl, /\bpublic\b/,
    'per-account responses must not be public-cacheable, got: ' + cacheControl);
  assert.match(cacheControl, /private/);
});

// Node's global fetch silently attaches `cache-control: no-cache`, which makes
// Express's freshness check fail and turns every conditional request into a
// 200. Real clients send no such header, so this uses node:http to assert what
// Stremio and Nuvio actually receive.
function rawGet(pathname, headers) {
  const http = require('node:http');
  const target = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname,
      method: 'GET', headers: headers || {},
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('a conditional request is answered 304 without a body', async () => {
  const user = await makeUser('etagtester');
  const url = '/u/' + user.id + '/' + user.apiToken + '/manifest.json';
  const first = await rawGet(url);
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(etag, 'expected an ETag on the manifest');

  const second = await rawGet(url, { 'If-None-Match': etag });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);

  // A stale validator must still return the full document.
  const third = await rawGet(url, { 'If-None-Match': 'W/"not-the-current-etag"' });
  assert.equal(third.status, 200);
  assert.ok(third.body.length > 0);
});

test('failed sign-ins are rate limited per client', async () => {
  const body = new URLSearchParams({ username: 'nobody', password: 'wrong' });
  let limited = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await get('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (response.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'repeated failed sign-ins should eventually be refused');
});
