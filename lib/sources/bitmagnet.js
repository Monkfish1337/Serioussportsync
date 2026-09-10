'use strict';

// Direct Bitmagnet search client (alternative to Prowlarr and the companion).
//
// Bitmagnet is a self-hosted DHT crawler with its own Postgres index. Unlike
// Prowlarr it is not a fan-out to remote trackers: it is one local database, so
// a query costs tens of milliseconds rather than tens of seconds, and there is
// no per-indexer flakiness to work around.
//
// Two properties matter for this pipeline:
//
//   * `infoHash` comes back directly. Prowlarr frequently returns infoHash=null
//     and needs the /download proxy hydration pass in lib/sources/prowlarr.js;
//     none of that applies here.
//   * results can be ORDERED server-side. That is the difference between a
//     truncated result set that is useful and one that is not — measured on a
//     10M-row index, the bare term "EPL" matched 1,837 rows, so whatever the
//     limit is, it will be hit. Ordering by seeders means the cut falls on the
//     tail rather than an arbitrary slice.
//
// This talks GraphQL rather than Postgres deliberately: the operator supplies
// one URL, exactly like the Prowlarr and Zilean integrations, rather than
// database credentials. scripts/mine-bitmagnet.js already uses the same
// endpoint and query shape.
//
// This source is RECALL ONLY. It does no relevance filtering of its own —
// lib/promotions.js `isRelevantStreamTitle` is the matcher, and it is far
// better at this than a query string can be. Deliberately over-fetching and
// letting the matcher decide is the whole point of the split.

const fetch = require('node-fetch');
const settings = require('../settings');
const httpAgent = require('../http-agent');
const boundedBody = require('../bounded-body');

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 300;
const DEFAULT_CONCURRENCY = 4;

// `torrent.name` is the RAW release name; `title` is Bitmagnet's own parsed
// form. The matcher expects the raw name — the parsed title hides exactly the
// naming conventions it keys on (see scripts/mine-bitmagnet.js).
const SEARCH_QUERY = `query Search($input: TorrentContentSearchQueryInput!) {
  torrentContent {
    search(input: $input) {
      totalCount
      items {
        infoHash
        publishedAt
        videoResolution
        seeders
        leechers
        torrent { name size seeders leechers magnetUri }
      }
    }
  }
}`;

function endpointUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/graphql$/i, '') + '/graphql';
}

async function search(queryString, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const cfg = opts.config || settings.getBitmagnet();
  if (!cfg.url) { log('  bitmagnet: URL not configured'); return null; }

  const limit = Math.max(1, Math.min(5000, Number(opts.limit || cfg.limit) || DEFAULT_LIMIT));
  const input = {
    queryString,
    limit,
    totalCount: true,
    cached: false,
    // Ordering is the reason this source beats the Torznab endpoint against
    // the same database. Without it, truncation takes an arbitrary slice.
    orderBy: [{ field: 'seeders', descending: true }],
  };
  // Optional server-side narrowing. Off by default: a DHT torrent whose file
  // list has not been fetched yet has no fileType, so filtering on it would
  // silently drop exactly the freshest releases this pipeline cares about.
  if (cfg.videoOnly) {
    input.facets = { torrentFileType: { filter: ['video'] } };
  }

  const url = endpointUrl(cfg.url);
  let res;
  try {
    res = await (opts.fetchImpl || fetch)(url, httpAgent.fetchOpts({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { input } }),
      timeout: Number(cfg.timeoutMs) || 15000,
    }, url));
  } catch (err) {
    log('  bitmagnet: network error: ' + err.message);
    if (opts.throwOnFailure) throw err;
    return null;
  }
  if (!res.ok) {
    log('  bitmagnet: HTTP ' + res.status + ' ' + res.statusText);
    if (opts.throwOnFailure) throw new Error('Bitmagnet HTTP ' + res.status);
    return null;
  }
  let payload;
  try { payload = await boundedBody.readJson(res, MAX_RESPONSE_BYTES, 'Bitmagnet response'); }
  catch (err) {
    log('  bitmagnet: invalid response: ' + err.message);
    if (opts.throwOnFailure) throw err;
    return null;
  }
  // GraphQL reports errors with HTTP 200, so a bad query looks like success
  // unless this is checked.
  if (payload && Array.isArray(payload.errors) && payload.errors.length) {
    const message = payload.errors.map((e) => e && e.message).filter(Boolean).join('; ');
    log('  bitmagnet: GraphQL error: ' + message);
    if (opts.throwOnFailure) throw new Error('Bitmagnet GraphQL error: ' + message);
    return null;
  }
  const result = payload && payload.data && payload.data.torrentContent
    && payload.data.torrentContent.search;
  if (!result) {
    log('  bitmagnet: unexpected response shape');
    if (opts.throwOnFailure) throw new Error('Bitmagnet returned an unexpected response');
    return null;
  }
  return {
    totalCount: Number(result.totalCount) || 0,
    items: Array.isArray(result.items) ? result.items : [],
    limit,
  };
}

function toCandidate(item) {
  const hash = String(item && item.infoHash || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;
  const torrent = (item && item.torrent) || {};
  const name = String(torrent.name || '').trim();
  if (!name) return null;
  // seeders live on both TorrentContent and Torrent; prefer the content-level
  // value, which is what the index orders by.
  const seeders = Number(item.seeders != null ? item.seeders : torrent.seeders) || 0;
  const leechers = Number(item.leechers != null ? item.leechers : torrent.leechers) || 0;
  let publishDate = item.publishedAt || null;
  // Bitmagnet defaults publishedAt to 1999-01-01 rather than null when it has
  // no real date, so surfacing it verbatim would invent a publication date.
  if (publishDate && /^1999-01-01/.test(String(publishDate))) publishDate = null;
  return {
    title: name,
    infoHash: hash,
    size: Number(torrent.size) || 0,
    seeders,
    leechers,
    magnetUrl: torrent.magnetUri || null,
    indexer: 'Bitmagnet',
    publishDate,
  };
}

// Matches lib/sources/prowlarr.js: returns a flat array, or
// { ok, error, results } when `detailed` is set, so streams.js can tell an
// empty index apart from a source that failed.
async function multiSearch(queries, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const cfg = opts.config || settings.getBitmagnet();
  const unique = Array.from(new Set((queries || [])
    .map((q) => String(q || '').trim()).filter(Boolean)));

  if (!cfg.url) {
    return opts.detailed ? { ok: false, error: 'not-configured', results: [] } : [];
  }
  if (unique.length === 0) {
    return opts.detailed ? { ok: true, error: null, results: [] } : [];
  }

  log('  bitmagnet: searching ' + unique.length + ' title variant(s)');
  const collected = [];
  let completed = 0;
  let truncated = false;
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= unique.length) return;
      const q = unique[index];
      let page;
      try {
        page = await search(q, Object.assign({}, opts, { config: cfg, log, throwOnFailure: true }));
        completed++;
      } catch (error) {
        log('    -> "' + q + '" failed: ' + error.message);
        continue;
      }
      if (!page) continue;
      if (page.items.length >= page.limit) {
        truncated = true;
        log('    -> "' + q + '" ' + page.items.length + ' of ' + page.totalCount
          + ' (limit reached; ordered by seeders so the tail is what was cut)');
      } else {
        log('    -> "' + q + '" ' + page.items.length + ' result(s)');
      }
      for (const item of page.items) collected.push(item);
    }
  }

  const concurrency = Math.max(1, Math.min(8,
    Number(cfg.concurrency) || DEFAULT_CONCURRENCY, unique.length));
  await Promise.all(Array.from({ length: concurrency }, worker));

  const seen = new Set();
  const out = [];
  for (const item of collected) {
    const candidate = toCandidate(item);
    if (!candidate || seen.has(candidate.infoHash)) continue;
    seen.add(candidate.infoHash);
    out.push(candidate);
  }
  out.sort((a, b) => b.seeders - a.seeders);

  log('  bitmagnet: ' + out.length + ' unique candidate(s)'
    + (truncated ? ' (at least one query was truncated)' : ''));

  return opts.detailed
    ? { ok: completed > 0, error: completed > 0 ? null : 'all-failed', results: out }
    : out;
}

// Admin "Test" probe: proves the endpoint is a Bitmagnet GraphQL API and
// reports how much index is behind it.
async function test(options) {
  const opts = options || {};
  const cfg = opts.config || settings.getBitmagnet();
  if (!cfg.url) return { ok: false, message: 'Bitmagnet URL not configured' };
  const start = Date.now();
  try {
    const page = await search('', Object.assign({}, opts, {
      config: cfg, limit: 1, throwOnFailure: true,
    }));
    const latencyMs = Date.now() - start;
    if (!page) return { ok: false, latencyMs, message: 'no response from Bitmagnet' };
    return { ok: true, latencyMs,
      message: 'Bitmagnet reachable — ' + page.totalCount.toLocaleString() + ' indexed' };
  } catch (error) {
    const latencyMs = Date.now() - start;
    let message = error.message;
    if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
      message = 'host not found — if Bitmagnet runs in Docker, use its service '
        + 'name and put this service on the same Docker network';
    } else if (/ECONNREFUSED/i.test(message)) {
      message = 'connection refused — check the host and port';
    } else if (/Cannot query field|Unknown type/i.test(message)) {
      message = 'reachable, but this does not look like a Bitmagnet GraphQL API';
    }
    return { ok: false, latencyMs, message };
  }
}

module.exports = { search, multiSearch, test, toCandidate, endpointUrl, SEARCH_QUERY };
