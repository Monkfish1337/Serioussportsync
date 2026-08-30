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
    assert.strictEqual(account.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(account.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(String(account.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
    assert.strictEqual(account.headers.get('access-control-allow-origin'), null,
      'account HTML is not exposed through wildcard CORS');
    const manifest = await fetch(base + '/u/' + user.id + '/' + user.apiToken + '/manifest.json');
    assert.strictEqual(manifest.status, 200);
    assert.strictEqual(manifest.headers.get('access-control-allow-origin'), '*',
      'addon API retains client-compatible CORS');
    const html = await account.text();
    for (const expected of [
      'Configure SeriousSportSync',
      'Signing in is the only editing authority',
      'No second editing link.',
      'name="torboxApiKey"',
      'name="torboxEnabled"',
      'name="easynewsUsername"',
      'name="easynewsEnabled"',
      'name="easynewsPassword"',
      'name="uuManifestUrl"',
      'name="uuEnabled"',
      'DIY Usenet pipeline',
      '1. Discover',
      '2. Match',
      '3. Play',
      'Search and candidate discovery',
      'Playback backends',
      'name="diyUsenetEnabled"',
      'name="diyNativeSearchEnabled"',
      'name="diyUuSearchEnabled"',
      'name="diySearchKind"',
      'name="diySearchUrl"',
      'name="diySearchApiKey"',
      'Test native search',
      'name="nzbdavUrl"',
      'name="nzbdavApiKey"',
      'name="nzbdavWebdavUrl"',
      'Test NZB DAV pipeline',
      'name="nativeNntpEnabled"',
      'name="nntpHost"',
      'name="nntpPassword"',
      'Test NNTP pipeline',
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

    const crossSiteSave = await fetch(base + '/account/save', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'torboxApiKey=must-not-save',
    });
    assert.strictEqual(crossSiteSave.status, 403, 'cross-site account mutations are rejected');

    const getLogout = await fetch(base + '/logout', {
      method: 'GET', redirect: 'manual', headers: { Cookie: cookie },
    });
    assert.strictEqual(getLogout.status, 404, 'logout is POST-only');

    for (const legacy of [
      { method: 'GET', path: '/admin/power-tool' },
      { method: 'POST', path: '/admin/power-tool/warm' },
      { method: 'GET', path: '/admin/search' },
      { method: 'POST', path: '/admin/search/scrape' },
      { method: 'GET', path: '/admin/match-editor' },
      { method: 'POST', path: '/admin/match-editor/save' },
      { method: 'POST', path: '/admin/match-test' },
      { method: 'GET', path: '/admin/content' },
      { method: 'POST', path: '/admin/content/events/create' },
    ]) {
      const response = await fetch(base + legacy.path, {
        method: legacy.method,
        redirect: 'manual',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: legacy.method === 'POST' ? 'event=must-not-mutate' : undefined,
      });
      assert.strictEqual(response.status, 303, legacy.path + ' is retired');
      assert.ok(String(response.headers.get('location') || '').startsWith('/admin/promotions?flash='),
        legacy.path + ' redirects to Promotions');
    }

    const firstCatalog = promotions.enabled[0].catalogs[0].id;
    const save = await fetch(base + '/account/save', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: cookie,
        Origin: 'null',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        torboxEnabled: 'on',
        torboxApiKey: 'test-torbox-key',
        easynewsEnabled: 'on',
        easynewsUsername: 'test-easynews-user',
        easynewsPassword: 'test-easynews-password',
        uuEnabled: 'on',
        uuManifestUrl: 'https://uu.example/private/manifest.json',
        diyUsenetEnabled: 'on',
        diyNativeSearchEnabled: 'on',
        diyUuSearchEnabled: 'on',
        diySearchKind: 'newznab',
        diySearchName: 'Test Hydra',
        diySearchUrl: 'https://hydra.example',
        diySearchApiKey: 'test-search-api-secret',
        nzbdavUrl: 'https://dav.example',
        nzbdavApiKey: 'test-nzbdav-api-secret',
        nzbdavWebdavUrl: 'https://dav.example',
        nzbdavWebdavUsername: 'dav-user',
        nzbdavWebdavPassword: 'test-webdav-secret',
        nativeNntpEnabled: 'on',
        nntpHost: 'news.example',
        nntpPort: '563',
        nntpTls: 'on',
        nntpUsername: 'nntp-user',
        nntpPassword: 'test-nntp-secret',
        nntpConnections: '12',
        catalogs: firstCatalog,
        catalogOrder: firstCatalog,
        promotionOrder: promotions.enabled[0].id,
        showCatalogsOnHome: 'on',
        showWarmRows: 'on',
        maxStreams: '7',
      }).toString(),
    });
    assert.strictEqual(save.status, 302, 'installed-app null-origin form saves successfully');
    assert.strictEqual(save.headers.get('location'), '/account?flash=saved');
    const saved = users.findById(user.id).config;
    assert.strictEqual(saved.torboxEnabled, true);
    assert.strictEqual(saved.torboxApiKey, 'test-torbox-key');
    assert.strictEqual(saved.easynewsEnabled, true);
    assert.strictEqual(saved.easynewsUsername, 'test-easynews-user');
    assert.strictEqual(saved.easynewsPassword, 'test-easynews-password');
    assert.strictEqual(saved.uuManifestUrl, 'https://uu.example/private/manifest.json');
    assert.strictEqual(saved.uuEnabled, true);
    assert.strictEqual(saved.diyUsenetEnabled, true);
    assert.strictEqual(saved.diyNativeSearchEnabled, true);
    assert.strictEqual(saved.diyUuSearchEnabled, true);
    assert.strictEqual(saved.diySearchKind, 'newznab');
    assert.strictEqual(saved.diySearchUrl, 'https://hydra.example');
    assert.strictEqual(saved.diySearchApiKey, 'test-search-api-secret');
    assert.strictEqual(saved.nzbdavUrl, 'https://dav.example');
    assert.strictEqual(saved.nzbdavApiKey, 'test-nzbdav-api-secret');
    assert.strictEqual(saved.nzbdavWebdavUsername, 'dav-user');
    assert.strictEqual(saved.nzbdavWebdavPassword, 'test-webdav-secret');
    assert.strictEqual(saved.nativeNntpEnabled, true);
    assert.strictEqual(saved.nntpHost, 'news.example');
    assert.strictEqual(saved.nntpTls, true);
    assert.strictEqual(saved.nntpUsername, 'nntp-user');
    assert.strictEqual(saved.nntpPassword, 'test-nntp-secret');
    assert.strictEqual(saved.nntpConnections, 12);
    const usersOnDisk = fs.readFileSync(process.env.USERS_FILE, 'utf8');
    assert.ok(!usersOnDisk.includes(user.apiToken), 'install/API token is encrypted at rest');
    assert.strictEqual(users.findByApiToken(user.id, user.apiToken).id, user.id,
      'encrypted-at-rest install token still authenticates');
    assert.ok(!usersOnDisk.includes('test-nzbdav-api-secret'));
    assert.ok(!usersOnDisk.includes('test-webdav-secret'));
    assert.ok(!usersOnDisk.includes('test-search-api-secret'));
    assert.ok(!usersOnDisk.includes('test-nntp-secret'));
    assert.ok(!usersOnDisk.includes('https://uu.example/private/manifest.json'));
    assert.ok(!usersOnDisk.includes('test-easynews-user'));
    assert.ok(!usersOnDisk.includes('dav-user'));
    assert.ok(!usersOnDisk.includes('nntp-user'));
    assert.deepStrictEqual(saved.catalogs, [firstCatalog]);
    assert.strictEqual(saved.maxStreams, 7);
    assert.strictEqual(saved.showWarmRows, true);
    assert.strictEqual(saved.showCatalogsOnHome, true);

    const disableLegacy = await fetch(base + '/account/save', {
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
        diyUsenetEnabled: 'on',
        nzbdavUrl: 'https://dav.example',
        nzbdavApiKey: 'test-nzbdav-api-secret',
        nzbdavWebdavUrl: 'https://dav.example',
        nzbdavWebdavUsername: 'dav-user',
        nzbdavWebdavPassword: 'test-webdav-secret',
        nntpHost: 'news.example',
        nntpPort: '563',
        nntpTls: 'on',
        nntpUsername: 'nntp-user',
        nntpPassword: 'test-nntp-secret',
        nntpConnections: '12',
      }).toString(),
    });
    assert.strictEqual(disableLegacy.status, 302);
    const isolated = users.findById(user.id).config;
    assert.strictEqual(isolated.torboxEnabled, false);
    assert.strictEqual(isolated.uuEnabled, false);
    assert.strictEqual(isolated.easynewsEnabled, false);
    assert.strictEqual(isolated.diyUsenetEnabled, true);
    assert.strictEqual(isolated.nativeNntpEnabled, false);
    assert.strictEqual(isolated.torboxApiKey, 'test-torbox-key', 'disabling preserves TorBox credentials');
    assert.strictEqual(isolated.easynewsPassword, 'test-easynews-password', 'disabling preserves Easynews credentials');
    assert.strictEqual(isolated.uuManifestUrl, 'https://uu.example/private/manifest.json', 'disabling preserves UU configuration');
    assert.strictEqual(isolated.nntpPassword, 'test-nntp-secret', 'disabling preserves NNTP credentials');

    const removedProbe = await fetch(base + '/account/torbox-unified-probe', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    assert.strictEqual(removedProbe.status, 404, 'obsolete TorBox probe endpoint stays removed');

    await users.setPassword(user.id, 'replacement-password-063');
    const revokedSession = await fetch(base + '/account', {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    assert.strictEqual(revokedSession.status, 302, 'password changes revoke existing sessions');
    assert.strictEqual(revokedSession.headers.get('location'), '/login');

    console.log('OK — account configuration, persistence, retired-tool redirects, exports, and retired diagnostic verified.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});
