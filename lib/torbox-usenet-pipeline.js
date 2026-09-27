'use strict';

// TorBox Usenet: its own pipeline, separate from built-in Usenet (native
// NNTP) and every other source. Any account may switch it on.
//
// Discovery is the indexer the account enters for this pipeline (Newznab,
// NZBHydra or Prowlarr). SSS never streams the video: the NZB is uploaded to
// the account's TorBox, which downloads it and serves it from its CDN. For
// each event the top N results — N is the account's
// "NZBs checked per event" — have their NZB downloaded into memory so TorBox
// can be asked whether it already has them, and whether the account already
// owns a finished copy. Every result becomes a row; nothing is added to the
// account's TorBox until a row is played.
//
// Row states, from NZB-Sport-Pro, where this ran in production:
//   ⚡ Instant   a finished download the account already owns
//   ⏳ Processing already queued in the account; playing reuses that job
//   📦 Cached    TorBox's shared cache knows it; playing attaches, then waits
//   ⏳ Queue     not cached; playing queues it, then waits
//
// Checking an NZB downloads it from the indexer, which counts against the
// indexer's daily grab limit — hence the per-account count (0 = check none;
// rows then all read "Queue" until played).

const crypto = require('crypto');
const torboxUsenet = require('./sources/torbox-usenet');
const nntpPlayback = require('./sources/nntp-playback');
const playbackCandidates = require('./playback-candidates');
const urlSign = require('./url-sign');

const PROVIDER = 'torbox-usenet';
const DEFAULT_CHECK_COUNT = 5;
const MAX_CHECK_COUNT = 20;
const PREPARE_CONCURRENCY = 4;
const PREPARED_TTL_MS = 20 * 60 * 1000;
const PREPARED_MAX_ENTRIES = 200;
const PREPARED_MAX_BYTES = 64 * 1024 * 1024;

// Downloaded NZBs, kept in memory only so a click right after listing does
// not download the same NZB again. Bounded by count, bytes and age; keyed per
// account so one account never reads another's NZB.
const prepared = new Map();
let preparedBytes = 0;

function checkCount(userConfig) {
  const raw = userConfig && userConfig.torboxUsenetCheckCount;
  const n = raw === undefined || raw === null || raw === '' ? DEFAULT_CHECK_COUNT : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHECK_COUNT, Math.round(n))) : DEFAULT_CHECK_COUNT;
}

// The pipeline's own search source, one of three:
//   newznab   one or more indexers searched directly, in parallel
//   nzbhydra  one NZBHydra, which fans out to the account's indexers
//   prowlarr  one Prowlarr, which does the same
// Newznab indexers are kept as a JSON list in one encrypted field
// (tbuNewznabIndexers); a single Newznab indexer saved before the list
// existed (tbuSearchUrl/tbuSearchApiKey) is read as a one-item list.
// An account without admin rights may only reach public addresses
// (lib/diy-access sets _publicNetworkOnly).
const MAX_NEWZNAB_INDEXERS = 10;
const SOURCE_KINDS = ['newznab', 'nzbhydra', 'prowlarr'];

function sourceKind(userConfig) {
  const kind = String((userConfig || {}).tbuSearchKind || '');
  return SOURCE_KINDS.includes(kind) ? kind : 'newznab';
}

function newznabIndexers(userConfig) {
  const cfg = userConfig || {};
  let list = [];
  try { list = JSON.parse(cfg.tbuNewznabIndexers || '[]'); } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter((i) => i && i.url).map((i) => ({ name: String(i.name || ''), url: String(i.url), apiKey: String(i.apiKey || '') }));
  if (!list.length && cfg.tbuSearchUrl && sourceKind(cfg) === 'newznab') {
    list = [{ name: cfg.tbuSearchName || '', url: cfg.tbuSearchUrl, apiKey: cfg.tbuSearchApiKey || '' }];
  }
  return list.slice(0, MAX_NEWZNAB_INDEXERS);
}

// Every search config for the account's chosen source, ready for
// lib/sources/usenet-indexer (NZBHydra speaks the Newznab API).
function indexerConfigs(userConfig) {
  const cfg = userConfig || {};
  const publicOnly = cfg._publicNetworkOnly === true;
  const kind = sourceKind(cfg);
  if (kind === 'newznab') {
    return newznabIndexers(cfg).map((i, n) => ({ enabled: true, kind: 'newznab', url: i.url, apiKey: i.apiKey,
      name: i.name || ('Newznab ' + (n + 1)), publicOnly }));
  }
  return [{ enabled: true, kind: kind === 'prowlarr' ? 'prowlarr' : 'newznab', url: cfg.tbuSearchUrl || '', apiKey: cfg.tbuSearchApiKey || '',
    name: cfg.tbuSearchName || (kind === 'prowlarr' ? 'Prowlarr' : 'NZBHydra'), publicOnly }];
}

// What is set up, for the settings page and Configure.
function status(userConfig) {
  const cfg = userConfig || {};
  const usenetIndexer = require('./sources/usenet-indexer');
  const configured = indexerConfigs(cfg).filter((c) => usenetIndexer.isConfigured(c));
  const torbox = cfg.torboxEnabled !== false && Boolean(String(cfg.torboxApiKey || '').trim());
  return { enabled: cfg.torboxUsenetEnabled === true, kind: sourceKind(cfg), indexers: configured.length,
    indexer: configured.length > 0, torbox, ready: cfg.torboxUsenetEnabled === true && configured.length > 0 && torbox };
}

function enabled(userConfig) {
  return status(userConfig).ready;
}

function preparedKey(userId, nzbUrl) {
  return crypto.createHash('sha256').update(String(userId) + '|' + String(nzbUrl)).digest('hex');
}

function prunePrepared(now) {
  for (const [key, entry] of prepared) {
    if (entry.expiresAt <= now) { preparedBytes -= entry.buffer.length; prepared.delete(key); }
  }
  while (prepared.size > PREPARED_MAX_ENTRIES || preparedBytes > PREPARED_MAX_BYTES) {
    const [key, entry] = prepared.entries().next().value;
    preparedBytes -= entry.buffer.length;
    prepared.delete(key);
  }
}

function rememberNzb(userId, nzbUrl, buffer, hashes) {
  const key = preparedKey(userId, nzbUrl);
  const old = prepared.get(key);
  if (old) { preparedBytes -= old.buffer.length; prepared.delete(key); }
  prepared.set(key, { buffer, hash: torboxUsenet.nzbHash(buffer), hashes, expiresAt: Date.now() + PREPARED_TTL_MS });
  preparedBytes += buffer.length;
  prunePrepared(Date.now());
  return prepared.get(key);
}

function recallNzb(userId, nzbUrl) {
  const entry = prepared.get(preparedKey(userId, nzbUrl));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

async function fetchNzb(candidate, options) {
  const opts = options || {};
  return (opts.downloadNzb || nntpPlayback.downloadNzb)(candidate.nzbUrl, {
    timeoutMs: opts.timeoutMs || 4500, publicOnly: opts.publicOnly === true, fetchImpl: opts.fetchImpl,
  });
}

// Download the top `count` NZBs and ask TorBox about them in one batch.
async function classify(candidates, { userId, torboxKey, count, publicOnly, log, deps }) {
  const d = deps || {};
  const selected = candidates.slice(0, count);
  const entries = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < selected.length) {
      const candidate = selected[cursor++];
      try {
        let entry = recallNzb(userId, candidate.nzbUrl);
        if (!entry) {
          const buffer = await fetchNzb(candidate, { publicOnly, downloadNzb: d.downloadNzb });
          entry = rememberNzb(userId, candidate.nzbUrl, buffer, torboxUsenet.nzbCacheHashes(buffer, candidate.nzbUrl));
        }
        entries.set(candidate, entry);
      } catch (error) {
        log('torbox-usenet: could not check ' + (candidate.indexer || 'indexer') + ' NZB: ' + error.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREPARE_CONCURRENCY, selected.length) }, worker));
  // One hash per entry per round, so a many-file NZB cannot crowd out the rest.
  const hashes = [];
  const all = Array.from(entries.values());
  for (let round = 0; hashes.length < torboxUsenet.CACHE_HASH_MAX; round++) {
    let added = false;
    for (const entry of all) {
      const hash = entry.hashes[round];
      if (!hash || hashes.includes(hash)) continue;
      hashes.push(hash);
      added = true;
    }
    if (!added) break;
  }
  const [cachedHashes, ownedHashes] = entries.size ? await Promise.all([
    (d.checkCachedMany || torboxUsenet.checkCachedMany)(hashes, torboxKey, log, { timeoutMs: 6000, fetchImpl: d.fetchImpl }),
    (d.getOwnedReadyHashes || torboxUsenet.getOwnedReadyHashes)(torboxKey, log, { timeoutMs: 3500, fetchImpl: d.fetchImpl }),
  ]) : [new Set(), new Map()];
  const states = new Map();
  for (const [candidate, entry] of entries) {
    const owned = entry.hashes.find((hash) => ownedHashes.has(hash));
    const remembered = (d.getKnownDownload || torboxUsenet.getKnownDownload)(torboxKey, entry.hash);
    states.set(candidate, {
      ownedId: owned ? ownedHashes.get(owned) : null,
      pendingId: !owned && remembered ? remembered.id : null,
      cached: entry.hashes.some((hash) => cachedHashes.has(hash)),
    });
  }
  const ready = Array.from(states.values()).filter((s) => s.ownedId != null).length;
  const cached = Array.from(states.values()).filter((s) => s.ownedId == null && s.cached).length;
  log('torbox-usenet: checked ' + entries.size + ' of ' + candidates.length + ' NZB(s): '
    + ready + ' owned, ' + cached + ' cached, ' + (entries.size - ready - cached) + ' to queue');
  return states;
}

function stateOf(s) {
  if (s && s.ownedId != null) return { rank: 3, icon: '⚡', name: 'TorBox Usenet · Instant', detail: 'In your TorBox, ready', group: 'ready' };
  if (s && s.pendingId != null) return { rank: 2, icon: '⏳', name: 'TorBox Usenet · Processing', detail: 'Already queued, play to wait', group: 'processing' };
  if (s && s.cached) return { rank: 1, icon: '\u{1F4E6}', name: 'TorBox Usenet · Cached', detail: 'TorBox has it, play to attach', group: 'cached' };
  return { rank: 0, icon: '⏳', name: 'TorBox Usenet · Queue', detail: s ? 'Not cached, play to download' : 'Not checked, play to download', group: 'queue' };
}

function buildRow(candidate, url, state, helpers) {
  const h = helpers || {};
  const quality = [h.detectResolution && h.detectResolution(candidate.title), h.detectSource && h.detectSource(candidate.title)].filter(Boolean).join(' ') || 'Usenet';
  const size = h.formatSize ? h.formatSize(candidate.size) : '';
  const date = candidate.publishedAt && Number.isFinite(Date.parse(candidate.publishedAt))
    ? new Date(candidate.publishedAt).toISOString().slice(0, 10) : '';
  const meta = [size ? '\u{1F4BE} ' + size : '', candidate.indexer || 'Usenet', date, state.icon + ' ' + state.detail].filter(Boolean).join(' · ');
  return {
    name: state.icon + ' ' + state.name + '\n' + quality,
    title: candidate.title + '\n' + meta,
    url,
    behaviorHints: { bingeGroup: 'serioussportsync-torbox-usenet-' + state.group, notWebReady: false },
    _sssDedupeScope: PROVIDER,
  };
}

function deferredUrl({ origin, userId, apiToken, eventId, candidateId }) {
  const { exp, sig } = urlSign.signResolve({ userId, provider: PROVIDER, eventId, infoHash: candidateId });
  return (origin || '') + '/u/' + encodeURIComponent(userId) + '/' + encodeURIComponent(apiToken)
    + '/resolve/' + PROVIDER + '/' + encodeURIComponent(eventId) + '/' + encodeURIComponent(candidateId)
    + '?exp=' + encodeURIComponent(exp) + '&sig=' + encodeURIComponent(sig);
}

async function pipeline({ event, userConfig, getUsenetCandidates, urlCtx, log, helpers, deps }) {
  if (!enabled(userConfig)) return [];
  const candidates = (await getUsenetCandidates()) || [];
  if (!candidates.length) return [];
  const torboxKey = String(userConfig.torboxApiKey).trim();
  const states = await classify(candidates, {
    userId: urlCtx.userId, torboxKey, count: checkCount(userConfig),
    publicOnly: userConfig._publicNetworkOnly === true, log, deps,
  });
  const ordered = candidates.map((candidate, order) => ({ candidate, order, state: stateOf(states.get(candidate)), known: states.get(candidate) }))
    .sort((a, b) => b.state.rank - a.state.rank || a.order - b.order);
  const rows = ordered.map(({ candidate, state, known }) => {
    const stored = (deps && deps.store || playbackCandidates).put({
      userId: urlCtx.userId, eventId: event.id, provider: PROVIDER,
      payload: { nzbUrl: candidate.nzbUrl, title: candidate.title, indexer: candidate.indexer || '',
        ownedId: known ? known.ownedId : null, pendingId: known ? known.pendingId : null, cached: Boolean(known && known.cached) },
    });
    return buildRow(candidate, deferredUrl({ origin: urlCtx.origin, userId: urlCtx.userId, apiToken: urlCtx.apiToken,
      eventId: event.id, candidateId: stored.id }), state, helpers);
  });
  log('torbox-usenet: built ' + rows.length + ' row(s)');
  return rows;
}

// A play click. Returns { url } to redirect to, { queued } while TorBox is
// still working, or { ok:false, error }.
async function resolve({ eventId, token, creds, userId, log, deps }) {
  const d = deps || {};
  const cfg = creds || {};
  if (!enabled(cfg)) return { ok: false, error: 'torbox-usenet-disabled' };
  const found = (d.store || playbackCandidates).get({ id: token, userId, eventId, provider: PROVIDER });
  if (!found.ok) return { ok: false, error: 'candidate-' + found.reason };
  const candidate = found.candidate.payload;
  const torboxKey = String(cfg.torboxApiKey).trim();
  let entry = recallNzb(userId, candidate.nzbUrl);
  let buffer = entry && entry.buffer;
  if (!buffer) {
    log('torbox-usenet: fetching the NZB from ' + (candidate.indexer || 'the indexer'));
    buffer = await fetchNzb(candidate, { timeoutMs: 15000, publicOnly: cfg._publicNetworkOnly === true, downloadNzb: d.downloadNzb });
    entry = rememberNzb(userId, candidate.nzbUrl, buffer, torboxUsenet.nzbCacheHashes(buffer, candidate.nzbUrl));
  }
  const outcome = await (d.resolveNzb || torboxUsenet.resolveNzb)(buffer, candidate.title || eventId, torboxKey, log, {
    knownCached: candidate.cached === true,
    knownId: candidate.ownedId != null ? candidate.ownedId : candidate.pendingId,
    knownReady: candidate.ownedId != null,
    nzbUrl: candidate.nzbUrl,
    waitMs: d.waitMs,
    pollIntervalMs: d.pollIntervalMs,
    fetchImpl: d.fetchImpl,
  });
  if (outcome.url) log('torbox-usenet: playing from TorBox');
  else if (outcome.queued) log('torbox-usenet: ' + (outcome.processing ? 'still processing' : 'queued') + ' in TorBox (job ' + outcome.id + ')');
  return outcome;
}

// Check TorBox Usenet (issue #66): a read-only round trip with the saved
// settings, so a tester can prove it works on their account. Nothing is
// added to TorBox. Each step reports ok/failed with a short detail, and the
// check stops at the first failure.
async function check({ userConfig, query, deps }) {
  const d = deps || {};
  const cfg = userConfig || {};
  const steps = [];
  const step = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };
  const done = () => ({ ok: steps.every((s) => s.ok), steps });
  const key = String(cfg.torboxApiKey || '').trim();
  if (!step('TorBox key', Boolean(key), key ? 'Found on Configure' : 'Add your TorBox key on Configure')) return done();
  const access = await (d.testConnection || torboxUsenet.testConnection)(key, { fetchImpl: d.fetchImpl });
  if (!step('TorBox Usenet access', access.ok, access.ok ? 'Your account can list its Usenet downloads'
    : access.error === 'invalid-key' ? 'TorBox refused the key for Usenet (HTTP ' + access.status + '). Check the key, and that your plan includes Usenet downloads.'
      : 'TorBox did not answer (' + (access.error || 'HTTP ' + access.status) + ')')) return done();
  const usenetIndexer = require('./sources/usenet-indexer');
  const configs = indexerConfigs(cfg).filter((c) => usenetIndexer.isConfigured(c));
  if (!step('Search source', configs.length > 0, configs.length ? configs.map((c) => c.name).join(', ') : 'Add a search source below')) return done();
  const q = String(query || 'UFC').trim().slice(0, 200) || 'UFC';
  let result = null;
  let source = null;
  const failures = [];
  for (const config of configs) {
    try {
      const out = await (d.search || usenetIndexer.search)([q], config, { lookup: d.lookup, fetchImpl: d.searchFetch });
      if (out.ok && out.results.length) { result = out.results[0]; source = config; break; }
      failures.push(config.name + ': ' + (out.ok ? 'no results' : 'failed'));
    } catch (error) { failures.push(config.name + ': ' + error.message); }
  }
  if (!step('Search', Boolean(result), result ? source.name + ' found "' + String(result.title).slice(0, 120) + '"'
    : 'No results for "' + q + '" (' + failures.join('; ') + '). Try another test search.')) return done();
  let buffer;
  try { buffer = await fetchNzb(result, { timeoutMs: 15000, publicOnly: cfg._publicNetworkOnly === true, downloadNzb: d.downloadNzb }); }
  catch (error) { step('Download the NZB', false, error.message); return done(); }
  step('Download the NZB', true, Math.max(1, Math.round(buffer.length / 1024)) + ' KB from ' + source.name);
  const hashes = torboxUsenet.nzbCacheHashes(buffer, result.nzbUrl);
  let answered = true;
  const cached = await (d.checkCachedMany || torboxUsenet.checkCachedMany)(hashes, key,
    (line) => { if (/checkcached/.test(line)) answered = false; }, { timeoutMs: 8000, fetchImpl: d.fetchImpl });
  step('TorBox cache check', answered, !answered ? 'TorBox did not answer the cache check'
    : cached.size ? 'TorBox already has this release: it would play straight away' : 'TorBox answered; it does not have this release yet, so playing it would queue a download');
  return done();
}

module.exports = { PROVIDER, check, DEFAULT_CHECK_COUNT, MAX_CHECK_COUNT, MAX_NEWZNAB_INDEXERS, SOURCE_KINDS, checkCount, sourceKind, newznabIndexers, indexerConfigs, status, enabled, pipeline, resolve, stateOf, buildRow,
  _test: { prepared, rememberNzb, recallNzb, reset: () => { prepared.clear(); preparedBytes = 0; } } };
