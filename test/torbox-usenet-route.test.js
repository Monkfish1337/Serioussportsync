'use strict';

// The play route for TorBox Usenet, on the real Express app: a regular (not
// admin) account plays a TorBox Usenet result, and the player is sent to
// TorBox, or kept waiting while TorBox downloads. Nothing is streamed by SSS.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-tbu-route-'));
process.env.SESSION_SECRET = 'tbu-route-test-secret-00000000000000000000000000000000';
for (const [key, file] of Object.entries({ DATA_FILE: 'events.json', USERS_FILE: 'users.json', SETTINGS_FILE: 'settings.json',
  SPORT_VIDEO_FILE: 'sport-video.json', CONTENT_STUDIO_FILE: 'content-studio.json', METADATA_SOURCES_FILE: 'metadata-sources.json',
  CUSTOM_PROMOTIONS_FILE: 'custom-promotions.json', NUVIO_COLLECTIONS_FILE: 'nuvio-collections.json', POSITIVE_CACHE_FILE: 'positive-cache.json',
  AVAILABILITY_DB_FILE: 'availability.sqlite', PLAYBACK_CANDIDATES_FILE: 'candidates.json' })) process.env[key] = path.join(dir, file);
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ updatedAt: null, events: [] }));

const { createApp } = require('../addon');
const users = require('../lib/users');
const urlSign = require('../lib/url-sign');
const candidates = require('../lib/playback-candidates');
const torboxUsenet = require('../lib/sources/torbox-usenet');
const nntpPlayback = require('../lib/sources/nntp-playback');

let server;
let base;
const originals = { resolveNzb: torboxUsenet.resolveNzb, downloadNzb: nntpPlayback.downloadNzb };
test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  Object.assign(torboxUsenet, { resolveNzb: originals.resolveNzb });
  nntpPlayback.downloadNzb = originals.downloadNzb;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  require('../lib/availability-index').closeDefault();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function playLink(user, eventId) {
  const stored = candidates.put({ userId: user.id, eventId, provider: 'torbox-usenet',
    payload: { nzbUrl: 'https://indexer.example/api?t=get&id=1&apikey=SECRET', title: 'MLB.2026.09.23.Twins.Giants.720p', indexer: 'NZBGeek' } });
  const { exp, sig } = urlSign.signResolve({ userId: user.id, provider: 'torbox-usenet', eventId, infoHash: stored.id });
  return '/u/' + user.id + '/' + user.apiToken + '/resolve/torbox-usenet/' + encodeURIComponent(eventId) + '/' + stored.id + '?exp=' + exp + '&sig=' + sig;
}

test('a regular account plays a TorBox Usenet result from TorBox, never through SSS', async () => {
  const user = await users.createUser({ username: 'viewer', password: 'correct-horse-battery-staple', role: 'user' });
  users.updateUserConfig(user.id, { torboxUsenetEnabled: true, tbuSearchUrl: 'https://indexer.example', tbuSearchApiKey: 'SECRET', torboxApiKey: 'TB-KEY',
    diyUsenetEnabled: true, nntpHost: 'news.example', nntpUsername: 'u', nntpPassword: 'p' });
  const handed = [];
  nntpPlayback.downloadNzb = async (url, opts) => { handed.push({ url, publicOnly: opts.publicOnly }); return Buffer.from('<nzb/>'); };
  torboxUsenet.resolveNzb = async (buffer, title, key) => {
    handed.push({ toTorbox: buffer.toString(), key });
    return { ok: true, url: 'https://store-001.torbox.app/dl/twins.mkv' };
  };
  const response = await fetch(base + await playLink(user, 'mlb:823168'), { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://store-001.torbox.app/dl/twins.mkv', 'the player is sent to TorBox');
  assert.deepEqual(handed[0], { url: 'https://indexer.example/api?t=get&id=1&apikey=SECRET', publicOnly: true },
    'SSS fetched only the NZB, and for a regular account only from a public address');
  assert.deepEqual(handed[1], { toTorbox: '<nzb/>', key: 'TB-KEY' }, 'and handed that NZB to the account\'s TorBox');
  // Built-in Usenet is untouched: still admin-only, so its NNTP link is refused.
  const { exp, sig } = urlSign.signResolve({ userId: user.id, provider: 'nntp', eventId: 'mlb:823168', infoHash: 'x' });
  const nntp = await fetch(base + '/u/' + user.id + '/' + user.apiToken + '/resolve/nntp/mlb%3A823168/x?exp=' + exp + '&sig=' + sig, { redirect: 'manual' });
  assert.equal(nntp.status, 403);
});

test('while TorBox downloads, the player is kept waiting through signed redirects, then told to retry', async () => {
  const user = await users.createUser({ username: 'waiter', password: 'correct-horse-battery-staple', role: 'user' });
  users.updateUserConfig(user.id, { torboxUsenetEnabled: true, tbuSearchUrl: 'https://indexer.example', tbuSearchApiKey: 'SECRET', torboxApiKey: 'TB-KEY' });
  nntpPlayback.downloadNzb = async () => Buffer.from('<nzb/>');
  torboxUsenet.resolveNzb = async () => ({ ok: true, queued: true, id: 77, retryAfter: 35 });
  const link = await playLink(user, 'mlb:824301');
  const first = await fetch(base + link, { redirect: 'manual' });
  assert.equal(first.status, 302);
  const next = first.headers.get('location');
  assert.match(next, /[?&]wait=1(&|$)/);
  assert.match(next, /sig=/, 'the signature travels with every round');
  const last = await fetch(base + link + '&wait=5', { redirect: 'manual' });
  assert.equal(last.status, 425);
  assert.match(await last.text(), /still downloading/);

  torboxUsenet.resolveNzb = async () => ({ ok: false, error: 'torbox-job-failed', state: 'failed', detail: 'missing articles' });
  const failed = await fetch(base + await playLink(user, 'mlb:824302'), { redirect: 'manual' });
  assert.equal(failed.status, 502);
  assert.match(await failed.text(), /missing articles/);
});

test('any account saves its own TorBox Usenet indexer; a local-network indexer is refused', async () => {
  const user = await users.createUser({ username: 'setter', password: 'correct-horse-battery-staple', role: 'user' });
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'setter', password: 'correct-horse-battery-staple' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'signed in');
  const page = await fetch(base + '/account/torbox-usenet', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /NZBs checked per event/);
  const save = (fields) => fetch(base + '/account/torbox-usenet/save', { method: 'POST', redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

  const lan = await save({ torboxUsenetEnabled: 'on', tbuSearchKind: 'prowlarr', tbuSearchUrl: 'http://192.168.1.16:9696', tbuSearchApiKey: 'k', torboxUsenetCheckCount: '3' });
  assert.match(decodeURIComponent(lan.headers.get('location')), /public internet address/);
  assert.equal(users.findById(user.id).config.tbuSearchUrl, '', 'nothing saved');

  // Two Newznab indexers from repeated rows; the empty row is ignored.
  const body = new URLSearchParams({ torboxUsenetEnabled: 'on', tbuSearchKind: 'newznab', torboxUsenetCheckCount: '3' });
  for (const [name, url, key] of [['One', 'https://1.1.1.1', 'k1'], ['', '', ''], ['Two', 'https://8.8.8.8', 'k2']]) {
    body.append('nzIndexerName', name); body.append('nzIndexerUrl', url); body.append('nzIndexerApiKey', key);
  }
  const ok = await save(body);
  assert.match(decodeURIComponent(ok.headers.get('location')), /saved/);
  const saved = users.findById(user.id).config;
  assert.equal(saved.torboxUsenetEnabled, true);
  assert.deepEqual(JSON.parse(saved.tbuNewznabIndexers), [{ name: 'One', url: 'https://1.1.1.1', apiKey: 'k1' }, { name: 'Two', url: 'https://8.8.8.8', apiKey: 'k2' }]);
  assert.equal(saved.torboxUsenetCheckCount, 3);
  const raw = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8')).users.find((u) => u.id === user.id).config.tbuNewznabIndexers;
  assert.doesNotMatch(raw, /k1|k2|1\.1\.1\.1/, 'the indexer list is encrypted on disk');

  const lanRow = new URLSearchParams({ tbuSearchKind: 'newznab' });
  lanRow.append('nzIndexerName', 'Home'); lanRow.append('nzIndexerUrl', 'http://10.0.0.5'); lanRow.append('nzIndexerApiKey', 'k');
  assert.match(decodeURIComponent((await save(lanRow)).headers.get('location')), /Indexer 1 URL must be a public internet address/);
  assert.equal(saved.diyUsenetEnabled, false, 'built-in Usenet is untouched');
  assert.equal(saved.diySearchUrl, '');
});

test('Check TorBox Usenet shows each step on the page', async () => {
  await users.createUser({ username: 'checker', password: 'correct-horse-battery-staple', role: 'user' });
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'checker', password: 'correct-horse-battery-staple' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  users.updateUserConfig(users.findByUsername('checker').id, { torboxApiKey: 'TB-KEY', torboxUsenetEnabled: true });
  const original = torboxUsenet.testConnection;
  torboxUsenet.testConnection = async () => ({ ok: false, status: 403, error: 'invalid-key' });
  try {
    const page = await fetch(base + '/account/torbox-usenet/check', { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tbuTestQuery: 'UFC' }) });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Check result/);
    assert.match(html, /TorBox Usenet access/);
    assert.match(html, /plan includes Usenet/);
  } finally { torboxUsenet.testConnection = original; }
});
