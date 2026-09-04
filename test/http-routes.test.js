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

// The manifest is configuration, not content: it carries the catalog
// selection, the published order and the showInHome hint. A one-hour max-age
// meant a change saved on the Configure page appeared not to take effect until
// the client's cache expired. The ETag test below keeps revalidation cheap.
test('the manifest is revalidated rather than held for an hour', async () => {
  const user = await makeUser('manifestcache');
  const response = await get('/u/' + user.id + '/' + user.apiToken + '/manifest.json');
  assert.equal(response.status, 200);
  const cacheControl = response.headers.get('cache-control') || '';
  assert.match(cacheControl, /no-cache/,
    'the manifest must be revalidated on use, got: ' + cacheControl);
  assert.doesNotMatch(cacheControl, /max-age=[1-9]/,
    'the manifest must not carry a positive max-age, got: ' + cacheControl);
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

// The team wizard lives on the Configure page because picking a team is a
// choice a user makes. Creating the promotion is not: it changes the registry
// every account shares, so that action stays admin-only. Getting this wrong
// would let any invited user add catalogs for everyone.
test('a signed-in user can browse teams but not create a promotion', async () => {
  const user = await makeUser('teampicker');
  const login = await get('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'teampicker', password: 'correct-horse-battery-staple' }).toString(),
  });
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
    .map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'expected a session cookie');
  assert.ok(user.id);

  const create = await get('/account/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ chooser: 'nfl', teamId: '6' }).toString(),
  });
  assert.equal(create.status, 403);
  const body = await create.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /admin/i);
});

test('the wizard endpoints refuse anonymous callers', async () => {
  for (const [method, pathname] of [['GET', '/account/teams/nfl.json'], ['POST', '/account/teams']]) {
    const response = await get(pathname, { method });
    assert.ok(response.status === 302 || response.status === 401 || response.status === 403,
      method + ' ' + pathname + ' answered ' + response.status + ' anonymously');
  }
});

// Two regressions worth pinning, both from splitting the Configure page up.
//
// 1. The Nuvio collection editor has forms of its own. Embedding it INSIDE the
//    account form made the browser close the outer form at the first inner
//    </form>, which orphaned the Save button — it rendered, and did nothing.
// 2. The DIY Usenet fields moved to their own page. If /account/save still
//    listed them, every Configure save would blank the lot, because those
//    inputs are no longer in that form.
test('saving Configure does not blank the settings that moved off it', async () => {
  const user = await makeUser('splitpage', 'admin');
  const login = await get('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'splitpage', password: 'correct-horse-battery-staple' }).toString(),
  });
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
    .map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'expected a session cookie');
  const post = (pathname, fields) => get(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields).toString(),
  });

  await post('/account/usenet/save', {
    diySearchKind: 'prowlarr', diySearchName: 'My Prowlarr',
    diySearchUrl: 'http://prowlarr:9696', diySearchApiKey: 'secret-key',
    nntpHost: 'news.example.com', nntpPort: '563', nntpConnections: '20',
  });
  assert.equal(users.findById(user.id).config.diySearchName, 'My Prowlarr');

  // A Configure save carrying none of those fields.
  await post('/account/save', { torboxEnabled: 'on', diyUsenetEnabled: 'on', maxStreams: '10' });
  const config = users.findById(user.id).config;
  assert.equal(config.diySearchName, 'My Prowlarr', 'Configure save must not blank DIY settings');
  assert.equal(config.diySearchApiKey, 'secret-key');
  assert.equal(config.nntpHost, 'news.example.com');
  assert.equal(config.diyUsenetEnabled, true, 'the switch that stayed on Configure still saves');
});

test('the Save button on Configure belongs to the account form', async () => {
  const user = await makeUser('savebutton', 'admin');
  const login = await get('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'savebutton', password: 'correct-horse-battery-staple' }).toString(),
  });
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
    .map((value) => value.split(';')[0]).join('; ');
  const html = await (await get('/account', { headers: { cookie } })).text();
  assert.ok(user.id);

  // The account form must still be open where the Save button sits: no </form>
  // may appear between the form that posts to /account/save and that button.
  const formStart = html.indexOf('action="/account/save"');
  const saveButton = html.indexOf('Save configuration');
  assert.ok(formStart > -1 && saveButton > formStart, 'expected the Save button after the form opens');
  const between = html.slice(formStart, saveButton);
  assert.equal(between.includes('</form>'), false,
    'a nested </form> before the Save button detaches it from the account form');
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

// A promotion added before its first refresh answers its catalog with an empty
// list. Caching that for an hour is how a newly added promotion ends up
// registered in the client — visible in Nuvio's home layout — with a
// permanently blank row, while every older catalog works. NFL and NBA hit
// exactly this after 0.84.0.
test('an empty catalog or meta miss is never cached as an answer', async () => {
  const user = await makeUser('emptycatalog');
  const prefix = '/u/' + user.id + '/' + user.apiToken;
  const manifest = await (await get(prefix + '/manifest.json')).json();
  const catalog = manifest.catalogs[0];
  assert.ok(catalog, 'expected at least one catalog in the manifest');

  // This fixture's store is empty, so every catalog is a legitimate miss.
  const response = await get(prefix + '/catalog/' + catalog.type + '/' + catalog.id + '.json');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.metas.length, 0, 'fixture store should be empty');
  assert.match(response.headers.get('cache-control') || '', /no-cache/,
    'an empty catalog must be revalidated, got: ' + response.headers.get('cache-control'));

  const miss = await get(prefix + '/meta/' + catalog.type + '/nfl%3Anot-a-real-event.json');
  assert.equal(miss.status, 200);
  assert.equal((await miss.json()).meta, null);
  assert.match(miss.headers.get('cache-control') || '', /no-cache/,
    'a meta miss must be revalidated, got: ' + miss.headers.get('cache-control'));
});
