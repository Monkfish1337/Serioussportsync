'use strict';

// TorBox Usenet, a pipeline of its own: SSS finds the NZB with the indexer the
// account set for it, hands the NZB file to the account's TorBox, and the player is
// redirected to TorBox's CDN. The server moves NZB files only, never video.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-torbox-usenet-'));
process.env.SESSION_SECRET ||= 'torbox-usenet-test-secret-0000000000000000000000000000';
process.env.PLAYBACK_CANDIDATES_FILE = path.join(dir, 'candidates.json');

const test = require('node:test');
const assert = require('node:assert/strict');
const pipeline = require('../lib/torbox-usenet-pipeline');
const security = require('../lib/security');

const INDEXER_NZB = 'https://indexer.example/api?t=get&id=abc123&apikey=INDEXER-SECRET';
const NZB = Buffer.from('<?xml version="1.0"?><nzb><file poster="x" subject="MLB.2026.09.23.Twins.Giants.720p.mkv">'
  + '<segments><segment bytes="1" number="1">part1of99@news.example</segment></segments></file></nzb>');
const CDN = 'https://store-001.torbox.app/dl/twins-giants.mkv?token=cdn';

function fakeTorbox({ cachedHashes = [], ownedList = [], readyAfter = 1 } = {}) {
  const calls = [];
  let polls = 0;
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body;
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '') });
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.torbox.app', 'only TorBox is called');
    if (u.pathname.endsWith('/usenet/checkcached')) return reply(200, { data: Object.fromEntries(cachedHashes.map((h) => [h, { hash: h }])) });
    if (u.pathname.endsWith('/usenet/createusenetdownload')) return reply(200, { data: { usenetdownload_id: 77, hash: 'h' } });
    if (u.pathname.endsWith('/usenet/mylist') && u.searchParams.get('id') === '77') {
      polls++;
      return reply(200, { data: polls >= readyAfter
        ? { id: 77, download_finished: true, files: [{ id: 5, name: 'twins-giants.mkv', size: 3e9 }] }
        : { id: 77, download_state: 'downloading', files: [] } });
    }
    if (u.pathname.endsWith('/usenet/mylist')) return reply(200, { data: ownedList });
    if (u.pathname.endsWith('/usenet/requestdl')) return reply(200, { data: CDN });
    if (u.pathname.endsWith('/user/me')) return reply(200, { data: { plan: 2 } });
    return reply(404, {});
  };
  return { calls, fetchImpl };
}

const config = { torboxUsenetEnabled: true, tbuSearchUrl: 'https://indexer.example', tbuSearchApiKey: 'INDEXER-SECRET', torboxApiKey: 'TB-KEY', torboxUsenetCheckCount: 5 };
const urlCtx = { origin: 'https://sss.example', userId: 'user-1', apiToken: 'tok' };
const candidate = { title: 'MLB.2026.09.23.Twins.Giants.720p.WEB', nzbUrl: INDEXER_NZB, size: 3e9, indexer: 'NZBGeek' };

test('an NZB is found, uploaded to TorBox on play, and the player goes to TorBox\'s CDN', async () => {
  pipeline._test.reset();
  const tb = fakeTorbox();
  let nzbDownloads = 0;
  const deps = { fetchImpl: tb.fetchImpl, downloadNzb: async () => { nzbDownloads++; return NZB; }, waitMs: 1000, pollIntervalMs: 1 };
  const rows = await pipeline.pipeline({ event: { id: 'mlb:823168' }, userConfig: config, getUsenetCandidates: async () => [candidate], urlCtx, log: () => {}, deps });
  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /TorBox Usenet · Queue/);
  assert.match(rows[0].url, /^https:\/\/sss\.example\/u\/user-1\/tok\/resolve\/torbox-usenet\/mlb%3A823168\/[^/?]+\?exp=/);
  assert.doesNotMatch(rows[0].url + rows[0].title, /indexer\.example|INDEXER-SECRET/, 'the client never sees the indexer link');

  const token = decodeURIComponent(rows[0].url.split('/resolve/torbox-usenet/')[1].split('/')[1].split('?')[0]);
  const out = await pipeline.resolve({ eventId: 'mlb:823168', token, creds: config, userId: 'user-1', log: () => {}, deps });
  assert.equal(out.url, CDN, 'playback is a redirect to TorBox, not a stream from this server');
  assert.equal(nzbDownloads, 1, 'the NZB checked while listing is reused on play');

  const create = tb.calls.find((c) => c.url.endsWith('/usenet/createusenetdownload'));
  assert.ok(create, 'the NZB was handed to TorBox');
  assert.match(create.body, /name="file"; filename=/, 'as an uploaded file');
  assert.match(create.body, /part1of99@news\.example/, 'containing the NZB itself');
  for (const call of tb.calls) {
    assert.doesNotMatch(call.url + call.body, /INDEXER-SECRET|indexer\.example/, 'the indexer link and key never reach TorBox');
  }
  assert.ok(tb.calls.some((c) => c.url.includes('/usenet/requestdl') && c.url.includes('usenet_id=77') && c.url.includes('file_id=5')));
});

test('rows are ranked owned, cached, then queue, and a count of 0 checks nothing', async () => {
  pipeline._test.reset();
  require('../lib/sources/torbox-usenet')._test.ID_CACHE.clear(); // the first test really queued job 77
  const torboxUsenet = require('../lib/sources/torbox-usenet');
  const other = Buffer.from('<nzb><file><segments><segment>other@news</segment></segments></file></nzb>');
  const cachedHash = torboxUsenet.nzbCacheHashes(other, 'https://indexer.example/api?t=get&id=2')[0];
  const tb = fakeTorbox({ cachedHashes: [cachedHash] });
  const second = { ...candidate, title: 'MLB.2026.09.23.Twins.Giants.1080p.WEB', nzbUrl: 'https://indexer.example/api?t=get&id=2' };
  const deps = { fetchImpl: tb.fetchImpl, downloadNzb: async (url) => (url.includes('id=2') ? other : NZB) };
  const rows = await pipeline.pipeline({ event: { id: 'mlb:1' }, userConfig: config, getUsenetCandidates: async () => [candidate, second], urlCtx, log: () => {}, deps });
  assert.match(rows[0].name, /Cached/);
  assert.match(rows[1].name, /Queue/);

  pipeline._test.reset();
  let downloads = 0;
  const none = await pipeline.pipeline({ event: { id: 'mlb:1' }, userConfig: { ...config, torboxUsenetCheckCount: 0 },
    getUsenetCandidates: async () => [candidate, second], urlCtx, log: () => {},
    deps: { fetchImpl: tb.fetchImpl, downloadNzb: async () => { downloads++; return NZB; } } });
  assert.equal(downloads, 0, 'no indexer grabs spent while listing');
  assert.equal(none.length, 2);
  assert.ok(none.every((row) => /Not checked/.test(row.title)));
});

test('a job still downloading keeps the player waiting instead of failing', async () => {
  pipeline._test.reset();
  const tb = fakeTorbox({ readyAfter: 99 });
  const deps = { fetchImpl: tb.fetchImpl, downloadNzb: async () => NZB, waitMs: 5, pollIntervalMs: 1 };
  const rows = await pipeline.pipeline({ event: { id: 'mlb:2' }, userConfig: config, getUsenetCandidates: async () => [candidate], urlCtx, log: () => {}, deps });
  const token = decodeURIComponent(rows[0].url.split('/resolve/torbox-usenet/')[1].split('/')[1].split('?')[0]);
  const out = await pipeline.resolve({ eventId: 'mlb:2', token, creds: config, userId: 'user-1', log: () => {}, deps });
  assert.equal(out.queued, true);
  assert.equal(out.id, 77);
  assert.equal(await pipeline.resolve({ eventId: 'mlb:2', token, creds: config, userId: 'someone-else', log: () => {}, deps }).then((r) => r.error), 'candidate-wrong-user');
});

test('the pipeline is its own: its switch, its indexer and a TorBox key, nothing from built-in Usenet', () => {
  assert.equal(pipeline.enabled(config), true);
  assert.equal(pipeline.enabled({ ...config, torboxUsenetEnabled: false }), false);
  assert.equal(pipeline.enabled({ ...config, tbuSearchUrl: '' }), false, 'needs its own indexer');
  assert.equal(pipeline.enabled({ ...config, torboxApiKey: '' }), false);
  assert.equal(pipeline.enabled({ ...config, torboxEnabled: false }), false);
  const builtIn = { diyUsenetEnabled: true, diySearchUrl: 'https://other.example', diySearchApiKey: 'k', torboxApiKey: 'TB-KEY' };
  assert.equal(pipeline.enabled(builtIn), false, 'built-in Usenet settings do not switch it on');
  assert.equal(pipeline.indexerConfigs({ ...config, _publicNetworkOnly: true })[0].publicOnly, true);
});

test('three search sources: several Newznab indexers, one NZBHydra, or one Prowlarr', () => {
  const two = JSON.stringify([{ name: 'NZBGeek', url: 'https://api.nzbgeek.info', apiKey: 'a' }, { url: 'https://api.drunkenslug.com', apiKey: 'b' }]);
  const newznab = pipeline.indexerConfigs({ tbuSearchKind: 'newznab', tbuNewznabIndexers: two });
  assert.deepEqual(newznab.map((c) => [c.kind, c.name, c.url]), [['newznab', 'NZBGeek', 'https://api.nzbgeek.info'], ['newznab', 'Newznab 2', 'https://api.drunkenslug.com']]);
  assert.equal(pipeline.status({ torboxUsenetEnabled: true, torboxApiKey: 't', tbuSearchKind: 'newznab', tbuNewznabIndexers: two }).indexers, 2);
  const hydra = pipeline.indexerConfigs({ tbuSearchKind: 'nzbhydra', tbuSearchUrl: 'https://hydra.example', tbuSearchApiKey: 'k', tbuNewznabIndexers: two });
  assert.deepEqual(hydra.map((c) => [c.kind, c.name]), [['newznab', 'NZBHydra']], 'NZBHydra speaks Newznab; the indexer list is not used');
  assert.deepEqual(pipeline.indexerConfigs({ tbuSearchKind: 'prowlarr', tbuSearchUrl: 'https://prowlarr.example', tbuSearchApiKey: 'k' }).map((c) => c.kind), ['prowlarr']);
  assert.deepEqual(pipeline.indexerConfigs({ tbuSearchUrl: 'https://api.nzbgeek.info', tbuSearchApiKey: 'x', tbuSearchName: 'Old' }).map((c) => c.name), ['Old'],
    'a single indexer saved before the list existed still works');
  assert.equal(pipeline.checkCount({}), 5);
  assert.equal(pipeline.checkCount({ torboxUsenetCheckCount: 50 }), 20);
  assert.equal(pipeline.checkCount({ torboxUsenetCheckCount: '0' }), 0);
});

test('accounts limited to public addresses cannot reach the local network', async () => {
  const lookup = async (host) => [{ address: host === 'lan.example' ? '192.168.1.16' : '104.21.3.4' }];
  await assert.rejects(security.assertPublicUrl('http://192.168.1.16:9696', { lookup }), /public internet address/);
  await assert.rejects(security.assertPublicUrl('http://lan.example/api', { lookup }), /public internet address/);
  await assert.rejects(security.assertPublicUrl('http://localhost:5076', { lookup }), /public internet address/);
  await assert.rejects(security.assertPublicUrl('http://[::ffff:192.168.1.1]/', { lookup }), /public internet address/);
  await security.assertPublicUrl('https://api.nzbgeek.info/api', { lookup });
  const indexer = require('../lib/sources/usenet-indexer');
  await assert.rejects(indexer.searchOne('UFC', { enabled: true, url: 'http://lan.example', apiKey: 'k', publicOnly: true }, { lookup }), /public internet address/);
  const nntp = require('../lib/sources/nntp-playback');
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return { status: 302, headers: { get: () => 'http://192.168.1.16/x.nzb' } }; };
  await assert.rejects(nntp.downloadNzb('https://indexer.example/api?t=get&id=1', { publicOnly: true, lookup, fetchImpl }), /public internet address/);
  assert.equal(fetched, 1, 'a redirect into the LAN is refused before it is followed');
});

// Issue #66: a read-only round trip testers can run on their own account.
test('Check TorBox Usenet walks every step and adds nothing to TorBox', async () => {
  const tb = fakeTorbox();
  const out = await pipeline.check({ userConfig: config, query: 'Twins Giants', deps: { fetchImpl: tb.fetchImpl,
    search: async () => ({ ok: true, results: [candidate] }), downloadNzb: async () => NZB } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps.map((s) => [s.name, s.ok]), [['TorBox key', true], ['TorBox Usenet access', true], ['TorBox plan', true], ['Search source', true],
    ['Search', true], ['Download the NZB', true], ['TorBox cache check', true]]);
  assert.match(out.steps[6].detail, /does not have this release yet/);
  assert.ok(!tb.calls.some((c) => /createusenetdownload|requestdl/.test(c.url)), 'nothing is added to TorBox');
  for (const call of tb.calls) assert.doesNotMatch(call.url + call.body, /INDEXER-SECRET/);
});

test('Check TorBox Usenet stops at the first failing step and says why', async () => {
  const refused = await pipeline.check({ userConfig: config, deps: {
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) } });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.steps.map((s) => s.name), ['TorBox key', 'TorBox Usenet access']);
  assert.match(refused.steps[1].detail, /plan includes Usenet/);
  const empty = await pipeline.check({ userConfig: config, query: 'nothing', deps: { fetchImpl: fakeTorbox().fetchImpl,
    search: async () => ({ ok: true, results: [] }) } });
  assert.equal(empty.steps.at(-1).name, 'Search');
  assert.match(empty.steps.at(-1).detail, /No results for "nothing"/);
  const noKey = await pipeline.check({ userConfig: { ...config, torboxApiKey: '' } });
  assert.deepEqual(noKey.steps.map((s) => [s.name, s.ok]), [['TorBox key', false]]);
});

// Found on v1.3.0: a non-Pro account passed "TorBox Usenet access", because
// listing Usenet downloads works on any plan. Only Pro can download them.
test('Check TorBox Usenet stops when the TorBox plan has no Usenet downloads', async () => {
  const out = await pipeline.check({ userConfig: config, deps: { fetchImpl: fakeTorbox().fetchImpl,
    getPlan: async () => ({ ok: true, plan: 1, name: 'Essential', usenet: false }) } });
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps.map((s) => [s.name, s.ok]), [['TorBox key', true], ['TorBox Usenet access', true], ['TorBox plan', false]]);
  assert.match(out.steps[2].detail, /Your plan is Essential/);
  const unreadable = await pipeline.check({ userConfig: config, deps: { fetchImpl: fakeTorbox().fetchImpl,
    getPlan: async () => ({ ok: false, error: 'http-error' }), search: async () => ({ ok: true, results: [] }) } });
  assert.equal(unreadable.steps[2].name, 'TorBox plan');
  assert.equal(unreadable.steps[2].ok, true, 'an unreadable plan does not block the check');
});

test('getPlan reads the plan from TorBox', async () => {
  const torboxUsenet = require('../lib/sources/torbox-usenet');
  const answer = (plan) => async () => ({ ok: true, status: 200, json: async () => ({ data: { plan } }) });
  assert.deepEqual(await torboxUsenet.getPlan('k', { fetchImpl: answer(2) }), { ok: true, plan: 2, name: 'Pro', usenet: true });
  assert.equal((await torboxUsenet.getPlan('k', { fetchImpl: answer(0) })).usenet, false);
});
