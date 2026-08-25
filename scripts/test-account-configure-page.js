#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-account-test-'));
process.env.SESSION_SECRET = 'account-page-test-secret-00000000000000000000000000000000';
process.env.USERS_FILE = path.join(testDir, 'users.json');
process.env.DATA_FILE = path.join(testDir, 'events.json');
process.env.CONTENT_STUDIO_FILE = path.join(testDir, 'content-studio.json');
process.env.REFRESH_ON_EMPTY_CACHE = 'false';

const users = require('../lib/users');
const promotions = require('../lib/promotions');
const { createApp } = require('../addon');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

(async () => {
  const password = 'correct-horse-battery-staple';
  const user = await users.createUser({ username: 'account-test', password, role: 'admin' });
  const server = await listen(createApp());
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;

  try {
    const unauthenticated = await fetch(base + '/account', { redirect: 'manual' });
    assert.strictEqual(unauthenticated.status, 302, 'account page requires a login');
    assert.strictEqual(unauthenticated.headers.get('location'), '/login');

    const login = await fetch(base + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: user.username, password }).toString(),
    });
    assert.strictEqual(login.status, 302, 'valid credentials log in');
    const cookie = String(login.headers.get('set-cookie') || '').split(';', 1)[0];
    assert.ok(cookie.startsWith('sss_session='), 'login returns the signed session cookie');

    const account = await fetch(base + '/account', { headers: { Cookie: cookie } });
    assert.strictEqual(account.status, 200);
    assert.strictEqual(account.headers.get('cache-control'), 'no-store');
    const html = await account.text();
    for (const expected of [
      'Configure SeriousSportSync',
      'Signing in is the only editing authority',
      'No second editing link.',
      'name="torboxApiKey"',
      'name="easynewsUsername"',
      'name="easynewsPassword"',
      'name="uuManifestUrl"',
      'Catalogs and display order',
      'Save configuration',
      'Install Stremio',
      'Copy manifest',
      'Nuvio collection',
      'stremio://',
    ]) assert.ok(html.includes(expected), 'account page includes ' + expected);
    for (const removed of ['TorBox Unified diagnostic', 'torbox-unified-probe', '#edit=']) {
      assert.ok(!html.includes(removed), 'account page omits ' + removed);
    }

    const firstCatalog = promotions.enabled[0].catalogs[0].id;
    const save = await fetch(base + '/account/save', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        torboxApiKey: 'test-torbox-key',
        easynewsUsername: 'test-easynews-user',
        easynewsPassword: 'test-easynews-password',
        uuManifestUrl: 'https://uu.example/private/manifest.json',
        catalogs: firstCatalog,
        catalogOrder: firstCatalog,
        promotionOrder: promotions.enabled[0].id,
        showCatalogsOnHome: 'on',
        showWarmRows: 'on',
        maxStreams: '7',
      }).toString(),
    });
    assert.strictEqual(save.status, 302);
    assert.strictEqual(save.headers.get('location'), '/account?flash=saved');
    const saved = users.findById(user.id).config;
    assert.strictEqual(saved.torboxApiKey, 'test-torbox-key');
    assert.strictEqual(saved.easynewsUsername, 'test-easynews-user');
    assert.strictEqual(saved.easynewsPassword, 'test-easynews-password');
    assert.strictEqual(saved.uuManifestUrl, 'https://uu.example/private/manifest.json');
    assert.deepStrictEqual(saved.catalogs, [firstCatalog]);
    assert.strictEqual(saved.maxStreams, 7);
    assert.strictEqual(saved.showWarmRows, true);
    assert.strictEqual(saved.showCatalogsOnHome, true);

    const removedProbe = await fetch(base + '/account/torbox-unified-probe', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    assert.strictEqual(removedProbe.status, 404, 'obsolete TorBox probe endpoint stays removed');

    console.log('OK — authenticated one-page account configuration, persistence, exports, and retired diagnostic verified.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});
