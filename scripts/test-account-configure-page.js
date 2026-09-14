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
process.env.SETTINGS_FILE = path.join(testDir, 'settings.json');
process.env.AVAILABILITY_DB_FILE = path.join(testDir, 'availability.sqlite');
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

    const regular = await users.createUser({username:'restricted-test',password,role:'user'});
    const regularLogin = await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:regular.username,password}).toString()});
    const regularCookie = regularLogin.headers.get('set-cookie').split(';',1)[0];
    for (const route of ['/account/usenet','/account/usenet/save','/account/test-diy-search','/account/test-nntp','/account/test-nzbdav']) {
      const response = await fetch(base+route,{method:route==='/account/usenet'?'GET':'POST',headers:{Cookie:regularCookie}});
      assert.strictEqual(response.status,403,'regular users cannot access '+route);
    }
    const restrictedPage = await fetch(base+'/account',{headers:{Cookie:regularCookie}});
    const restrictedHtml = await restrictedPage.text();
    assert.ok(restrictedHtml.includes('DIY Usenet is admin only'));
    assert.ok(!restrictedHtml.includes('href="/account/usenet"'));
    const forgedSave = await fetch(base+'/account/save',{method:'POST',redirect:'manual',headers:{Cookie:regularCookie,'Content-Type':'application/x-www-form-urlencoded'},body:'diyUsenetEnabled=on'});
    assert.strictEqual(forgedSave.status,302);
    assert.strictEqual(users.findById(regular.id).config.diyUsenetEnabled,false);

    const post = (route, body, auth) => {
      const form=new URLSearchParams();
      for(const [key,value] of Object.entries(body)) for(const entry of [].concat(value)) form.append(key,entry);
      return fetch(base+route,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',...(auth ? {Cookie:auth} : {})},body:form.toString()});
    };
    assert.ok((await (await fetch(base+'/login')).text()).includes('href="/request-access"'));
    assert.strictEqual((await post('/request-access',{username:'pending-test',password,role:'admin'})).status,202);
    assert.strictEqual(users.findByUsername('pending-test'),null);
    assert.strictEqual((await post('/login',{username:'pending-test',password})).status,401);
    assert.strictEqual((await post('/request-access',{username:'PENDING-test',password})).status,400);
    const pending=users.listAccessRequests()[0];
    assert.ok(!JSON.stringify(pending).includes('password'));
    assert.ok(!fs.readFileSync(process.env.USERS_FILE,'utf8').includes(password));
    assert.strictEqual((await fetch(base+'/admin/user-management',{headers:{Cookie:regularCookie}})).status,403);
    assert.strictEqual((await post('/admin/access-requests/'+pending.id+'/approve',{},regularCookie)).status,403);
    const managementHtml=await (await fetch(base+'/admin/user-management',{headers:{Cookie:cookie}})).text();
    assert.ok(managementHtml.includes('pending-test') && managementHtml.includes('Approve') && managementHtml.includes('Create a new user'));
    assert.ok(!managementHtml.includes('passwordHash'));
    assert.strictEqual((await post('/admin/access-requests/'+pending.id+'/approve',{},cookie)).status,303);
    assert.strictEqual(users.findByUsername('pending-test').role,'user');
    assert.strictEqual((await post('/login',{username:'pending-test',password})).status,302);
    assert.strictEqual((await post('/request-access',{username:'declined-test',password})).status,202);
    const declined=users.listAccessRequests()[0];
    await post('/admin/access-requests/'+declined.id+'/decline',{},cookie);
    assert.strictEqual(users.findByUsername('declined-test'),null);
    assert.strictEqual(users.listAccessRequests().length,0);
    const decisions=users.listAccessReviews();
    assert.equal(decisions[0].outcome,'declined');
    assert.equal(decisions[0].adminId,user.id);
    assert.strictEqual((await post('/admin/access-policy',{enabled:'1',expiryDays:'7'},regularCookie)).status,403);
    await post('/admin/access-policy',{expiryDays:'7'},cookie);
    assert.ok(!(await (await fetch(base+'/login')).text()).includes('href="/request-access"'));
    assert.strictEqual((await post('/request-access',{username:'blocked-test',password})).status,403);
    await post('/admin/access-policy',{enabled:'1',expiryDays:'14'},cookie);
    const metadataHtml=await (await fetch(base+'/admin/metadata',{headers:{Cookie:cookie}})).text();
    const discoveryHtml=await (await fetch(base+'/admin/prowlarr-discovery',{headers:{Cookie:cookie}})).text();
    assert.ok(discoveryHtml.includes('Catch-up progress') && discoveryHtml.includes('Event discovery status'));
    for (const tab of ['overview','events','prowlarr','preparation']) {
      const response=await fetch(base+'/admin/discovery?tab='+tab,{headers:{Cookie:cookie}});
      assert.strictEqual(response.status,200);
      const html=await response.text();
      if(tab==='overview') assert.ok(html.includes('Coverage by promotion') && html.includes('Missing usable identities'));
    }
    assert.strictEqual((await fetch(base+'/admin/discovery',{headers:{Cookie:regularCookie}})).status,403);
    assert.strictEqual((await fetch(base+'/assets/discovery-controls.js')).status,200);
    assert.strictEqual((await fetch(base+'/assets/table-sort.js')).status,200);
    await post('/admin/prowlarr-discovery',{enabled:'1',intervalSeconds:'120',dailyRequests:'100',lookbackDays:'7',timeoutSeconds:'120',promotions:['ucl','mlb']},cookie);
    assert.deepEqual(require('../lib/settings').getProwlarrDiscovery().promotions,['ucl','mlb']);
    const selectedQueue=await (await fetch(base+'/admin/discovery?tab=prowlarr',{headers:{Cookie:cookie}})).text();
    assert.ok(selectedQueue.includes('name="promotions" value="ucl" checked'));
    const bitmagnetHtml=await (await fetch(base+'/admin/discovery?tab=preparation',{headers:{Cookie:cookie}})).text();
    assert.ok(bitmagnetHtml.includes('>Bitmagnet</a>'));
    assert.ok(!bitmagnetHtml.includes('name="prepareUsenet"') && !bitmagnetHtml.includes('name="prepareEasynews"'));
    assert.strictEqual((await post('/admin/discovery/promotions',{promotions:'mlb'},regularCookie)).status,403);
    assert.strictEqual((await post('/admin/discovery/bitmagnet/promotions',{promotions:'mlb'},regularCookie)).status,403);
    assert.strictEqual((await post('/admin/discovery/promotions',{},cookie)).status,410);
    await post('/admin/discovery/bitmagnet/promotions',{promotions:'mlb'},cookie);
    const discoverySettings=require('../lib/settings');
    assert.strictEqual(discoverySettings.sourceDiscoveryIncludes('bitmagnet','mlb:fixture'),true);
    assert.strictEqual(discoverySettings.sourceDiscoveryIncludes('bitmagnet','nfl:fixture'),false);
    await post('/admin/discovery/bitmagnet/promotions',{},cookie);
    assert.strictEqual(discoverySettings.sourceDiscoveryIncludes('bitmagnet','mlb:fixture'),false);
    assert.deepEqual(discoverySettings.getProwlarrDiscovery().promotions,['ucl','mlb']);
    await post('/admin/discovery/sport-video/promotions',{promotions:'nfl'},cookie);
    assert.strictEqual(discoverySettings.sourceDiscoveryIncludes('sport-video','nfl:fixture'),true);
    assert.strictEqual(discoverySettings.sourceDiscoveryIncludes('sport-video','mlb:fixture'),false);
    for(const source of ['bitmagnet','sport-video']) await post('/admin/discovery/'+source+'/promotions',{promotions:require('../lib/promotions').all.map(p=>p.id)},cookie);
    assert.ok(metadataHtml.includes('Metadata API keys') && metadataHtml.includes('Force Metadata Refresh'));
    await post('/admin/metadata-keys',{footballDataApiKey:'test-football-key',apiFootballApiKey:'test-api-key',tmdbApiKey:'test-tmdb-key'},cookie);
    assert.strictEqual(require('../lib/settings').getTmdb().apiKey,'test-tmdb-key');

    const serverPage = await fetch(base + '/admin', {headers:{Cookie:cookie}});
    const serverHtml = await serverPage.text();
    assert.ok(serverHtml.includes('src="/assets/table-sort.js"'));
    assert.ok(!serverHtml.includes('Metadata API keys') && !serverHtml.includes('Create a new user') && !serverHtml.includes('Refresh catalogs now'));
    assert.ok(serverHtml.indexOf('server-time-zone') < serverHtml.indexOf('<h3 class="card-title">Discovery pipelines'), 'time zone appears above source settings');
    assert.ok(serverHtml.includes('href="/admin/prowlarr-discovery"'), 'discovery has its own sidebar link');
    const saveZone = await fetch(base + '/admin/time-zone', {method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:'timeZone=Europe%2FLondon'});
    assert.strictEqual(saveZone.status,303);
    assert.strictEqual(require('../lib/settings').getDisplayTimeZone(),'Europe/London');
    const logsPage = await fetch(base + '/admin/logs', {headers:{Cookie:cookie}});
    assert.ok((await logsPage.text()).includes('Europe/London · click'), 'logs use the selected zone');
    if (process.env.SSS_UI_PREVIEW) fs.writeFileSync(process.env.SSS_UI_PREVIEW,serverHtml);

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
    // 0.91.0 — Configure is a five-step flow in the new design system. What is
    // asserted here is the CONTRACT, not the chrome: every field the save route
    // reads must be present on the page, or a save silently blanks it.
    for (const expected of [
      'id="configure-form"',
      'action="/account/save"',
      'name="torboxApiKey"',
      'name="torboxEnabled"',
      'name="easynewsUsername"',
      'name="easynewsEnabled"',
      'name="easynewsPassword"',
      'name="uuManifestUrl"',
      'name="uuEnabled"',
      'name="diyUsenetEnabled"',
      'name="maxStreams"',
      'name="showWarmRows"',
      'name="promotionOrder"',
      'Open DIY Usenet settings',
      'Your teams',
      'Catalogs',
      'Install',
      'stremio://',
    ]) assert.ok(html.includes(expected), 'account page includes ' + expected);

    // The five steps exist, in order, and the flow can be navigated.
    for (const step of ['Services', 'Your teams', 'Catalogs', 'Collections', 'Install']) {
      assert.ok(html.includes('>' + step + '</span>') || html.includes(step),
        'Configure has a ' + step + ' step');
    }
    assert.ok(html.includes('data-step-to="0"') && html.includes('data-step-to="4"'),
      'every step is reachable from the rail');

    // The old page is still served, so a regression is one word to undo.
    const classic = await fetch(base + '/account/classic', { headers: { Cookie: cookie } });
    assert.strictEqual(classic.status, 200, 'the previous Configure page is still reachable');
    assert.ok((await classic.text()).includes('Configure SeriousSportSync'));
    for (const removed of ['TorBox Unified diagnostic', 'torbox-unified-probe', '#edit=']) {
      assert.ok(!html.includes(removed), 'account page omits ' + removed);
    }

    // The DIY Usenet pipeline moved to its own page in 0.89.1; Configure keeps
    // only the switch. Everything that moved is asserted where it now lives.
    const usenet = await fetch(base + '/account/usenet', { headers: { Cookie: cookie } });
    assert.strictEqual(usenet.status, 200, 'DIY Usenet page is available');
    const usenetHtml = await usenet.text();
    for (const expected of [
      '1. Discover', '2. Match', '3. Play',
      'Search and candidate discovery', 'Playback backends',
      'name="diyNativeSearchEnabled"', 'name="diyUuSearchEnabled"',
      'name="diySearchKind"', 'name="diySearchUrl"', 'name="diySearchApiKey"',
      'Test native search', 'name="nzbdavUrl"', 'name="nzbdavApiKey"',
      'name="nzbdavWebdavUrl"', 'name="nativeNntpEnabled"',
      'name="nntpHost"', 'name="nntpPassword"',
      'action="/account/usenet/save"',
    ]) assert.ok(usenetHtml.includes(expected), 'DIY Usenet page includes ' + expected);

    const database = await fetch(base + '/admin/database', { headers: { Cookie: cookie } });
    assert.strictEqual(database.status, 200, 'Database page is available to admins');
    const databaseHtml = await database.text();
    assert.ok(!databaseHtml.includes('What should SSS prepare?'));
    for (const expected of ['Database maintenance', 'Discovery', 'Prune expired rows', 'Wipe database']) {
      assert.ok(databaseHtml.includes(expected), 'Database page includes ' + expected);
    }
    assert.ok(!databaseHtml.includes('Legacy positive history'), 'legacy Health content is removed');

    const databaseStatus = await fetch(base + '/admin/database/status.json', { headers: { Cookie: cookie } });
    assert.strictEqual(databaseStatus.status, 200);
    const databasePayload = await databaseStatus.json();
    assert.ok(databasePayload.stats && databasePayload.warm && databasePayload.scheduler,
      'Database status exposes storage, warmer and scheduler state');

    const saveDatabase = await fetch(base + '/admin/database/settings', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        enabled: 'on', serveConfirmed: 'on', prepareTorrent: 'on',
        windowDays: '10', intervalHours: '2',
        maxEventsPerRun: '30', startDelaySeconds: '45',
      }).toString(),
    });
    assert.strictEqual(saveDatabase.status, 302, 'Database settings save successfully');
    assert.ok(String(saveDatabase.headers.get('location')).startsWith('/admin/discovery?tab=preparation&flash='));
    assert.equal(require('../lib/settings').getAvailabilityWarm().windowDays, 10);
    assert.equal(require('../lib/settings').getAvailabilityWarm().serveConfirmed, true);
    assert.equal(require('../lib/settings').getAvailabilityWarm().prepareTorrent, true);
    assert.equal(require('../lib/settings').getAvailabilityWarm().prepareUsenet, false);

    const legacyHealth = await fetch(base + '/admin/health', {
      redirect: 'manual', headers: { Cookie: cookie },
    });
    assert.strictEqual(legacyHealth.status, 302);
    assert.strictEqual(legacyHealth.headers.get('location'), '/admin/database');
    const retiredHealthAction = await fetch(base + '/admin/health/warm-availability', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.strictEqual(retiredHealthAction.status, 404, 'legacy Health mutations are removed');

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
        catalogs: firstCatalog,
        catalogOrder: firstCatalog,
        promotionOrder: promotions.enabled[0].id,
        showCatalogsOnHome: 'on',
        showWarmRows: 'on',
        maxStreams: '7',
      }).toString(),
    });
    // The DIY settings now save from their own page. Posting them separately
    // also proves a Configure save does not blank them, which is the failure
    // splitting the page could most easily have introduced.
    const usenetSave = await fetch(base + '/account/usenet/save', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
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
      }).toString(),
    });
    assert.strictEqual(usenetSave.status, 302, 'DIY Usenet settings save');

    assert.strictEqual(save.status, 302, 'installed-app null-origin form saves successfully');
    assert.strictEqual(save.headers.get('location'), '/account?flash=saved&step=0');
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
    // Configure no longer owns this switch, so a Configure save must leave it
    // exactly as the DIY page last set it.
    assert.strictEqual(isolated.nativeNntpEnabled, true,
      'Configure does not touch settings that moved to the DIY Usenet page');
    assert.strictEqual(isolated.torboxApiKey, 'test-torbox-key', 'disabling preserves TorBox credentials');
    assert.strictEqual(isolated.easynewsPassword, 'test-easynews-password', 'disabling preserves Easynews credentials');
    assert.strictEqual(isolated.uuManifestUrl, 'https://uu.example/private/manifest.json', 'disabling preserves UU configuration');
    assert.strictEqual(isolated.nntpPassword, 'test-nntp-secret', 'disabling preserves NNTP credentials');

    // Turning NNTP off happens on its own page now, and must keep the password.
    const nntpOff = await fetch(base + '/account/usenet/save', {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        diySearchKind: 'newznab', diySearchName: 'Test Hydra',
        diySearchUrl: 'https://hydra.example', diySearchApiKey: 'test-search-api-secret',
        nntpHost: 'news.example', nntpPort: '563', nntpUsername: 'nntp-user',
        nntpPassword: 'test-nntp-secret', nntpConnections: '12',
      }).toString(),
    });
    assert.strictEqual(nntpOff.status, 302);
    const afterNntpOff = users.findById(user.id).config;
    assert.strictEqual(afterNntpOff.nativeNntpEnabled, false, 'the DIY page turns NNTP off');
    assert.strictEqual(afterNntpOff.nntpPassword, 'test-nntp-secret', 'disabling preserves NNTP credentials');

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

    console.log('OK — account configuration, Database controls, persistence, retired-tool redirects, and exports verified.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { require('../lib/availability-index').getDefault().close(); } catch (_) { /* already closed */ }
    try { require('../lib/prowlarr-discovery').getDefault().close(); } catch (_) { /* already closed */ }
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});
