'use strict';
process.env.SESSION_SECRET = 'offline-diagnostic-secret-0000000000000000000000';
const assert = require('node:assert/strict');
const {Response} = require('node-fetch');
const settings = require('../lib/settings');
const prowlarr = require('../lib/sources/prowlarr');
settings.getProwlarr = () => ({url: 'http://example.invalid', apiKey: 'fixture'});
settings.getDiscoveryTiming = () => ({prowlarrQueryTimeoutMs: 50000});
const hash = 'a'.repeat(40);
const raw = [
  {title: 'ready hash', infoHash: hash, seeders: 5},
  {title: 'needs hydration', downloadUrl: '/download', seeders: 3},
];
async function main() {
  let proxyTimeout;
  const normal = await prowlarr.multiSearch(['fixture'], {
    detailed: true, deadlineMs: 49000, timeoutMs: 50000,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/v1/search?')) return new Response(JSON.stringify(raw));
      proxyTimeout = opts.timeout;
      return new Response('', {status: 302, headers: {location: 'magnet:?xt=urn:btih:' + 'b'.repeat(40)}});
    },
  });
  assert.equal(normal.results.length, 2);
  assert.equal(normal.partial, false);
  assert.ok(proxyTimeout > 10000 && proxyTimeout < 49000, 'Hydration uses the configured timeout bounded by discovery, not a fixed ten seconds');
  let searches = 0;
  const started = Date.now();
  const stalled = await prowlarr.multiSearch(['first', 'stalled', 'never-started'], {
    detailed: true, deadlineMs: 1000, timeoutMs: 50000,
    fetchImpl: async url => {
      if (url.includes('/api/v1/search?') && searches++ === 0) return new Response(JSON.stringify(raw));
      return new Promise(() => {});
    },
  });
  assert.ok(Date.now() - started < 1000, 'Returns before the outer discovery race');
  assert.equal(searches, 2, 'Stops starting queries after the search deadline');
  assert.equal(stalled.partial, true);
  assert.deepEqual(stalled.results.map(r => r.infoHash), [hash], 'Retains usable results when later searches and hash retrieval stall');
  console.log('OK — configured hydration timeout, shared deadline, and retained partial results verified.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
