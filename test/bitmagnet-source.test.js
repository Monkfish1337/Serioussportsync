'use strict';

// Direct Bitmagnet source.
//
// Every request is served by an injected fetch, so these run offline. The
// assertions that matter are about the GraphQL request shape, because a wrong
// field name or enum value fails at runtime against a real instance and looks
// exactly like "no results" — GraphQL reports errors with HTTP 200.

const test = require('node:test');
const assert = require('node:assert');
const bitmagnet = require('../lib/sources/bitmagnet');

const CFG = { url: 'http://bitmagnet:3333', limit: 300, concurrency: 4, timeoutMs: 15000 };
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function item(hash, name, seeders, extra) {
  return Object.assign({
    infoHash: hash, publishedAt: '2026-09-06T00:00:00Z', seeders,
    torrent: { name, size: 4e9, seeders, leechers: 1, magnetUri: 'magnet:?xt=urn:btih:' + hash },
  }, extra || {});
}

function fakeFetch(handler) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const payload = handler(body, url) || { data: { torrentContent: { search: { totalCount: 0, items: [] } } } };
    return {
      ok: payload.__httpOk !== false,
      status: payload.__status || 200,
      statusText: payload.__statusText || 'OK',
      headers: { get: () => 'application/json' },
      async json() { return payload; },
      async text() { return JSON.stringify(payload); },
      body: null,
    };
  };
}

function ok(items, totalCount) {
  return { data: { torrentContent: { search: { totalCount: totalCount == null ? items.length : totalCount, items } } } };
}

test('appends /graphql without doubling it', () => {
  assert.equal(bitmagnet.endpointUrl('http://bitmagnet:3333'), 'http://bitmagnet:3333/graphql');
  assert.equal(bitmagnet.endpointUrl('http://bitmagnet:3333/'), 'http://bitmagnet:3333/graphql');
  assert.equal(bitmagnet.endpointUrl('http://bitmagnet:3333/graphql'), 'http://bitmagnet:3333/graphql');
});

test('requests the raw torrent name, ordered by seeders', async () => {
  let seen = null;
  await bitmagnet.search('EPL', {
    config: CFG, fetchImpl: fakeFetch((body) => { seen = body; return ok([]); }),
  });
  // torrent.name is the RAW release name; `title` is Bitmagnet's parsed form,
  // which hides the naming conventions the matcher keys on.
  assert.match(seen.query, /torrent\s*\{[^}]*name/);
  // Ordering is what makes truncation cut the tail rather than a random slice.
  assert.deepEqual(seen.variables.input.orderBy, [{ field: 'seeders', descending: true }]);
  assert.equal(seen.variables.input.limit, 300);
  assert.equal(seen.variables.input.queryString, 'EPL');
  // These are the enum spellings Bitmagnet actually defines
  // (graphql/schema/enums.graphqls: TorrentContentOrderByField).
  assert.ok(/field: *"?seeders/.test(JSON.stringify(seen.variables.input).replace(/"field":"/, 'field: "')));
});

test('video-only facet is off unless configured', async () => {
  let seen = null;
  const capture = fakeFetch((body) => { seen = body; return ok([]); });
  await bitmagnet.search('EPL', { config: CFG, fetchImpl: capture });
  assert.equal(seen.variables.input.facets, undefined,
    'a freshly crawled torrent has no file list, so filtering on fileType by '
    + 'default would hide the newest releases');

  await bitmagnet.search('EPL', {
    config: Object.assign({}, CFG, { videoOnly: true }), fetchImpl: capture,
  });
  assert.deepEqual(seen.variables.input.facets, { torrentFileType: { filter: ['video'] } });
});

test('GraphQL errors are failures, not empty results', async () => {
  // Bitmagnet returns HTTP 200 with an errors array for a bad query. Treating
  // that as success is how a broken query silently becomes "nothing indexed".
  const errored = fakeFetch(() => ({ errors: [{ message: 'Cannot query field "nope"' }] }));
  const detailed = await bitmagnet.multiSearch(['EPL'], { config: CFG, fetchImpl: errored, detailed: true });
  assert.equal(detailed.ok, false);
  assert.equal(detailed.error, 'all-failed');
  assert.deepEqual(detailed.results, []);
});

test('maps items to the candidate shape used by the discovery pipeline', async () => {
  const results = await bitmagnet.multiSearch(['EPL'], {
    config: CFG,
    fetchImpl: fakeFetch(() => ok([
      item(HASH_B, 'EPL R.02 TOT vs NEW 720p.mkv', 27),
      item(HASH_A, 'EPL R.03 ARS vs CHE 720p.mkv', 60),
    ])),
  });
  assert.equal(results.length, 2);
  // Highest seeders first, regardless of the order the index returned them.
  assert.equal(results[0].infoHash, HASH_A);
  assert.equal(results[0].seeders, 60);
  assert.equal(results[0].indexer, 'Bitmagnet');
  assert.match(results[0].magnetUrl, /^magnet:\?xt=urn:btih:/);
  // infoHash arrives directly — no /download hydration pass, unlike Prowlarr.
  assert.match(results[0].infoHash, /^[a-f0-9]{40}$/);
});

test('drops unusable rows rather than passing them downstream', () => {
  assert.equal(bitmagnet.toCandidate({ infoHash: 'not-a-hash', torrent: { name: 'x' } }), null);
  assert.equal(bitmagnet.toCandidate({ infoHash: HASH_A, torrent: { name: '   ' } }), null);
  assert.equal(bitmagnet.toCandidate(null), null);
});

test('maps the 1999 published_at sentinel to unknown', () => {
  // Bitmagnet defaults publishedAt to 1999-01-01 rather than null.
  const mapped = bitmagnet.toCandidate(item(HASH_A, 'x', 1, { publishedAt: '1999-01-01T00:00:00Z' }));
  assert.equal(mapped.publishDate, null);
});

test('deduplicates across query variants', async () => {
  const results = await bitmagnet.multiSearch(['EPL', 'Premier League', '  ', 'EPL'], {
    config: CFG,
    fetchImpl: fakeFetch(() => ok([item(HASH_A, 'EPL R.03 ARS vs CHE', 60)])),
  });
  assert.equal(results.length, 1, 'same hash from several queries collapses to one');
});

test('an unconfigured URL is reported, not thrown', async () => {
  const detailed = await bitmagnet.multiSearch(['EPL'], { config: { url: '' }, detailed: true });
  assert.equal(detailed.ok, false);
  assert.equal(detailed.error, 'not-configured');
});

test('one failing query does not lose the others', async () => {
  let call = 0;
  const flaky = fakeFetch(() => {
    call += 1;
    if (call === 1) return { errors: [{ message: 'boom' }] };
    return ok([item(HASH_A, 'EPL R.03 ARS vs CHE', 60)]);
  });
  const detailed = await bitmagnet.multiSearch(['one', 'two'], {
    config: Object.assign({}, CFG, { concurrency: 1 }), fetchImpl: flaky, detailed: true,
  });
  assert.equal(detailed.ok, true, 'a partial failure is still a usable result set');
  assert.equal(detailed.results.length, 1);
});

test('test() probe reports index size and explains failures', async () => {
  const good = await bitmagnet.test({
    config: CFG, fetchImpl: fakeFetch(() => ok([], 10119014)),
  });
  assert.equal(good.ok, true);
  assert.match(good.message, /10,119,014 indexed/);

  const dns = await bitmagnet.test({
    config: CFG,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND bitmagnet'); },
  });
  assert.equal(dns.ok, false);
  assert.match(dns.message, /host not found/);

  const wrongApi = await bitmagnet.test({
    config: CFG,
    fetchImpl: fakeFetch(() => ({ errors: [{ message: 'Cannot query field "torrentContent"' }] })),
  });
  assert.equal(wrongApi.ok, false);
  assert.match(wrongApi.message, /does not look like a Bitmagnet GraphQL API/);
});
