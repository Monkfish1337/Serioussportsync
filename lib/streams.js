// Multi-debrid stream resolver. For each Prowlarr candidate, ask each
// configured debrid provider whether the magnet is cached, and return one
// Stremio stream per provider with a cache hit. Providers run in series
// per candidate, candidates in parallel (bounded by RESOLVE_PARALLEL).
//
// Promotion-specific relevance lives in lib/promotions.js; this file just
// dispatches to it.

const config = require('../config');
const store = require('./store');
const prowlarr = require('./sources/prowlarr');
// Optional drop-in HTML indexer client: a local-only module that implements
//   { multiSearch(queries, opts) => Promise<Array<{ title, infoHash, ... }>> }
// and lives at lib/sources/extra.js (or, for back-compat with older private
// installs, lib/sources/local.js). NOT shipped in this repo — gitignored.
// Use it to plug in any custom HTML-scraping source alongside Prowlarr +
// Zilean without touching core. Absent by default, which is expected and fine.
let extra = null;
try { extra = require('./sources/extra'); }
catch (e) {
  try { extra = require('./sources/local'); }
  catch (e2) { extra = null; }
}
const zilean = require('./sources/zilean');
const rd = require('./sources/realdebrid');
const tb = require('./sources/torbox');
const pm = require('./sources/premiumize');
const promotions = require('./promotions');
const streamcache = require('./streamcache');
const rdDenylist = require('./rd-denylist');
const positiveCache = require('./positive-cache');
const urlSign = require('./url-sign');
const settings = require('./settings');
const { redact } = require('./redact');

// Real-Debrid keyword pre-filter (0.22.1). RD started keyword-filtering
// cached torrents in May 2026 (HTTP 451). A candidate whose title contains
// any of these tags will not get an RD row advertised (TB/PM rows still
// show). The persistent rd-denylist catches per-hash blocks the keyword
// list misses. List is env-tunable via RD_BLOCKED_KEYWORDS — see config.js.
function buildRdKeywordRegex() {
  const list = (config.rdDenylist && config.rdDenylist.blockedKeywords) || [];
  if (list.length === 0) return null;
  const escaped = list.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Word-boundary on each side; case-insensitive. Examples that match:
  //   "WrestleMania 42 AMZN WEB-DL"  → AMZN
  //   "WWE.PPV.YTS.720p"             → YTS
  // Example that does NOT match: "ENGAGEMENT" (no \bAMZN\b inside).
  return new RegExp('\\b(?:' + escaped.join('|') + ')\\b', 'i');
}
const RD_KEYWORD_RE = buildRdKeywordRegex();

// (0.22.0: stream rows resolve on play — see resolvePlay + the /resolve route.)
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|ts|webm|wmv)$/i;
const JUNK = /\b(sample|trailer|featurette|extras?)\b/i;
const CACHE_TTL_MS = 60 * 60 * 1000;
const RESOLVE_PARALLEL = 2;
const RESOLVE_MAX = 12;
const MIN_TORRENT_SIZE = 1 * 1024 * 1024 * 1024; // 1 GB

const LANG_BLACKLIST = /\b(RU|RUS|RUSSIAN|UA|UKR|UKRAINIAN|GER|GERMAN|FRA|FRENCH|ITA|ITALIAN|ESP|SPANISH|POR|PORTUGUESE|JPN|JAPANESE|KOR|KOREAN|MULTI|DUBBED)\b/i;
// Cyrillic anywhere in the title is a strong signal of a Russian/Ukrainian rip
// (e.g. "UFC 327 Прохазка vs. Ульберг … RU"). The bare "RU" tag above is easy
// to miss when groups abbreviate inconsistently, so script detection backs it up.
const CYRILLIC = /[Ѐ-ӿ]/;
const NON_MAIN_CARD = /\b(early[\s.\-_]*prelim(?:s|inaries)?|prelim(?:s|inaries)?|countdown|post[\s.\-_]?show|pre[\s.\-_]?show|weigh[\s.\-_]?ins?|press[\s.\-_]?conf|embedded|mic'?d[\s.\-_]?up|recap|fight[\s.\-_]?night[\s.\-_]?vlog|behind[\s.\-_]?the[\s.\-_]?scenes|ceremonial|open[\s.\-_]?workout)\b/i;


// Resolution priority for sorting Stremio output. Higher = nicer.
function resolutionPriority(streamName) {
  const t = String(streamName || '').toLowerCase();
  if (/2160p|4k|uhd/.test(t)) return 4;
  if (/1080p|fhd/.test(t)) return 3;
  if (/720p|hd\b/.test(t)) return 2;
  if (/480p|sd\b/.test(t)) return 1;
  return 0;
}

function sortStreamsBySize(streams) {
  // Descending by file size (behaviorHints.videoSize). Most releases are 1080p+
  // so file size is a better proxy for content completeness (full event >
  // main-card only > prelims). Warming pseudo-stream stays last.
  return streams.slice().sort((a, b) => {
    const aWarm = (a.name || '').startsWith('\u{1F525}'); // 🔥 Cache warming
    const bWarm = (b.name || '').startsWith('\u{1F525}');
    if (aWarm !== bWarm) return aWarm ? 1 : -1;
    const aSize = (a.behaviorHints && a.behaviorHints.videoSize) || 0;
    const bSize = (b.behaviorHints && b.behaviorHints.videoSize) || 0;
    return bSize - aSize;
  });
}

const resultCache = new Map();
const WARMING_TTL_MS = 60 * 1000; // short TTL when result is empty but cache is being warmed
const fromCache = (id) => {
  const e = resultCache.get(id);
  if (!e) return null;
  const ttl = e.ttlMs || CACHE_TTL_MS;
  if (Date.now() - e.ts > ttl) { resultCache.delete(id); return null; }
  return e.streams;
};
const intoCache = (id, streams, ttlMs) =>
  resultCache.set(id, { ts: Date.now(), streams, ttlMs: ttlMs || CACHE_TTL_MS });

// All known providers — only those returning isConfigured()=true are used.
const ALL_PROVIDERS = [rd, tb, pm];

function configuredProviders() {
  return ALL_PROVIDERS.filter((p) => p.isConfigured());
}

// Helpers passed into each provider as `ctx`.
function buildMagnet(result) {
  const isRealMagnet = result.magnetUrl && result.magnetUrl.startsWith('magnet:');
  if (isRealMagnet) return result.magnetUrl;
  return 'magnet:?xt=urn:btih:' + result.infoHash.toUpperCase()
    + '&dn=' + encodeURIComponent(result.title || '')
    + '&tr=' + encodeURIComponent('udp://tracker.opentrackr.org:1337/announce')
    + '&tr=' + encodeURIComponent('udp://tracker.openbittorrent.com:80/announce')
    + '&tr=' + encodeURIComponent('udp://exodus.desync.com:6969/announce');
}

function humanSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  return Math.round(bytes / 1048576) + ' MB';
}

function qualityFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b2160p|4k|uhd\b/.test(t)) return '2160p';
  if (/\b1080p|fhd\b/.test(t)) return '1080p';
  if (/\b720p|hd\b/.test(t)) return '720p';
  if (/\b480p|sd\b/.test(t)) return '480p';
  return null;
}

function pickVideoFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const videos = files
    .filter((f) => VIDEO_EXT.test(f.path || '') && !JUNK.test(f.path || ''))
    .sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  return videos[0] || null;
}

function promotionOf(event) {
  if (!event) return null;
  if (event.promotion && promotions.byPrefix[event.promotion]) {
    return promotions.byPrefix[event.promotion];
  }
  return promotions.getByEventId(event.id);
}

// Some events are released by AIR DATE rather than by name/number. WWE
// Saturday Night's Main Event rips, for example, are titled
// "WWE Saturday Nights Main Event 2026 01 24" — the event number (43) never
// appears. Generate dated query variants for those so the indexer search can
// actually match the release.
function buildDateQueries(event) {
  if (!event || !event.date) return [];
  if (!/saturday\s*night.?s?\s*main\s*event/i.test(event.name || '')) return [];
  const core = (event.name || '')
    .replace(/[\u2019']/g, '')                              // drop apostrophes
    .replace(/\s*#?\d+\s*$/, '')                            // drop trailing number (43)
    .replace(/\s+/g, ' ').trim();                            // "Saturday Nights Main Event"
  const wwe = 'WWE ' + core;
  // Release groups title these by the LOCAL air date (Saturday), but TSDB's
  // dateEvent is UTC, which rolls to Sunday for US late-night cards. Prefer
  // dateLocal so the query matches the release (e.g. "...2026 01 24" not 25),
  // and keep the UTC date as a fallback variant.
  const local = (event.dateLocal || '').slice(0, 10);
  const utc = event.date.slice(0, 10);
  const dates = [];
  if (local) dates.push(local);
  if (utc && utc !== local) dates.push(utc);
  const out = [];
  for (const d of dates) {
    const dSpace = d.replace(/-/g, ' ');
    out.push(wwe + ' ' + dSpace);                           // WWE Saturday Nights Main Event 2026 01 24
    out.push(core + ' ' + dSpace);                          // Saturday Nights Main Event 2026 01 24
  }
  return out;
}

// Formula 1 release naming is year + round + location based, e.g.
// "Formula1.2026.Round01.Australian.GP.Race.1080p". The event carries the year
// (date) and round, which buildAliases (name-only) can't see — so synthesize
// the high-signal dated queries here.
function buildF1Queries(event) {
  if (!event || event.promotion !== 'f1' || !event.date) return [];
  const year = event.date.slice(0, 4);
  const round = event.round ? String(parseInt(event.round, 10)).padStart(2, '0') : '';
  const name = event.name || '';
  const loc = name.replace(/\bgrand\s*prix\b.*$/i, '').trim();                 // "Canadian"
  const after = name.replace(/^.*\bgrand\s*prix\b/i, '').replace(/\s+/g, ' ').trim(); // session suffix
  const locGP = loc.replace(/\s+/g, '') + 'GP';                                // "CanadianGP"
  const out = [];
  // BROAD first: scene F1 rips use the compact "CanadianGP" token and label the
  // session "Qualification" (vs TSDB's "Qualifying"), so a session-worded query
  // (with "Grand", "Prix", "Qualifying") can't AND-match them. Search the whole
  // weekend by the compact GP token + round/year and let session-precise
  // relevance keep the right session.
  out.push(locGP);                                                             // "CanadianGP" — matches all sessions
  if (year && loc) out.push('Formula 1 ' + year + ' ' + loc + ' Grand Prix');  // spelled-out releases
  if (year && round) out.push('Formula 1 ' + year + ' R' + round);             // round token
  // Session-specific too, for indexers that key on full names.
  if (year && loc && after) out.push(('F1 ' + year + ' ' + loc + ' ' + after).trim());
  return out;
}

function buildQueries(event) {
  const aliases = event.aliases || [event.name];
  const out = [];
  const seen = new Set();
  const MAX = 5;
  function push(raw) {
    if (out.length >= MAX) return;
    const q = (raw || '').replace(/[\u2019']/g, '').replace(/[:.\-_#]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q || q.length < 3) return;
    const k = q.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(q);
  }
  // Promotion-specific high-signal queries first (F1 year+round, WWE date).
  for (const q of buildF1Queries(event)) push(q);
  for (const q of buildDateQueries(event)) push(q);
  // Then the promotion's name/number aliases, shortest (broadest) first.
  for (const a of aliases.slice().sort((a, b) => a.length - b.length)) push(a);
  return out;
}

function relevanceCheck(resultTitle, size, event, promotion, minSize) {
  if (minSize === undefined) minSize = MIN_TORRENT_SIZE;
  const promoCheck = promotion.isRelevantStreamTitle(resultTitle, event);
  if (!promoCheck.ok) return promoCheck;
  if (NON_MAIN_CARD.test(resultTitle)) return { ok: false, reason: 'non-main-card' };
  if (LANG_BLACKLIST.test(resultTitle) || CYRILLIC.test(resultTitle)) return { ok: false, reason: 'foreign-lang' };
  if (minSize > 0 && (size || 0) < minSize) {
    return { ok: false, reason: 'too-small (' + Math.round((size || 0) / 1048576) + ' MB)' };
  }
  return { ok: true };
}

// Build the per-request providers list. If `creds` is provided (per-user
// path), only include providers whose creds are non-empty for that user.
// Otherwise (legacy env path) fall back to the env-configured providers.
function providersForRequest(creds) {
  if (creds) {
    return ALL_PROVIDERS.filter((p) => p.isAvailable && p.isAvailable(creds));
  }
  return configuredProviders();
}

// ---- Deferred (play-time) resolution -------------------------------------
// We no longer add anything to a debrid during /stream. Instead each stream row
// points at the per-user /resolve endpoint; the destructive add + unrestrict
// happens here, only when the user actually clicks play. This is why a search
// can never pollute a debrid account or stall on a provider outage.
function providerByCode(code) {
  const c = String(code || '').toLowerCase();
  return ALL_PROVIDERS.find((p) => (p.code || '').toLowerCase() === c) || null;
}

// Find a candidate by infoHash from the persistent cache, falling back to a
// fresh indexer search if the cache has expired since the row was advertised.
async function findCandidate(event, infoHash, log) {
  const want = String(infoHash || '').toLowerCase();
  if (!want) return null;
  let list = streamcache.get(event.id);
  if (!list) {
    log('  resolve: candidate cache miss — re-searching indexers');
    list = await searchCandidates(event, log);
    try { streamcache.put(event.id, list); } catch (e) { /* non-fatal */ }
  }
  return (list || []).find((r) => String(r.infoHash || '').toLowerCase() === want) || null;
}

// Resolve a single (provider, event, infoHash) at play time and return the
// playable URL, or null if the provider doesn't actually have it cached /
// resolvable. Called by the addon's /resolve route.
async function resolvePlay(opts) {
  const { eventId, infoHash, providerCode } = opts;
  const creds = opts.creds || null;
  const tag = opts.username ? ' u=' + opts.username : '';
  const log = (m) => console.log('[resolve' + tag + '] ' + redact(String(m)));

  const provider = providerByCode(providerCode);
  if (!provider) { log('unknown provider ' + providerCode); return null; }
  if (provider.isAvailable && !provider.isAvailable(creds)) {
    log(provider.code + ' not available for this user'); return null;
  }
  const event = store.getEvent(eventId);
  if (!event) { log('no event for ' + eventId); return null; }

  const result = await findCandidate(event, infoHash, log);
  if (!result) { log('candidate ' + infoHash + ' not found for ' + eventId); return null; }

  const ctx = { buildMagnet, qualityFromTitle, humanSize, pickVideoFile, log, creds };
  log('play-resolve ' + provider.code + ' ' + infoHash + ' (' + event.name + ')');
  try {
    const r = await provider.resolveCached(result, ctx);
    if (r && r.ok && r.stream && r.stream.url) {
      // 0.24.0: record positive resolve so future /stream calls can advertise
      // this (hash, provider) confidently without re-rolling the dice. The
      // big win is RD, where there's no non-destructive cache check.
      try {
        if (positiveCache.record(infoHash, provider.code, result.title || event.name)) {
          log('  -> positive-cache recorded ' + provider.code + ' ' + infoHash);
        }
      } catch (e) { log('  -> positive-cache write failed: ' + e.message); }
      log('  -> resolved playable URL via ' + provider.code);
      return { url: r.stream.url, filename: r.stream.behaviorHints && r.stream.behaviorHints.filename };
    }
    log('  -> ' + provider.code + ' not cached / unresolvable');
    return null;
  } catch (err) {
    log('  -> ' + provider.code + ' error: ' + err.message);
    return null;
  }
}

// Run the live indexer search (Prowlarr + Zilean + optional extra source) and
// return the merged, deduped candidate list. User-agnostic — safe to cache.
async function searchCandidates(event, log) {
  const queries = buildQueries(event);
  const [pwResults, zlResults, exResults] = await Promise.all([
    prowlarr.multiSearch(queries, { log }),
    zilean.multiSearch(queries, { log }).catch((e) => { log('  zilean: error ' + e.message); return []; }),
    (extra ? extra.multiSearch(queries, { log }).catch((e) => { log('  extra: error ' + e.message); return []; }) : Promise.resolve([])),
  ]);
  // Merge dedup by infoHash, preferring whichever source has a real magnetUrl.
  const merged = new Map();
  for (const r of pwResults) merged.set(r.infoHash, r);
  for (const r of exResults) {
    const prev = merged.get(r.infoHash);
    if (!prev) merged.set(r.infoHash, r);
    else if (!prev.magnetUrl && r.magnetUrl) merged.set(r.infoHash, Object.assign({}, prev, { magnetUrl: r.magnetUrl }));
  }
  // Zilean only contributes the infoHash (no magnet/seeders); add any new hash.
  for (const r of zlResults) {
    if (!merged.has(r.infoHash)) merged.set(r.infoHash, r);
  }
  const found = Array.from(merged.values());
  log('  total deduped: ' + found.length
    + ' (prowlarr=' + pwResults.length + ', zilean=' + zlResults.length + ', extra=' + exResults.length + ')');
  return found;
}

// Candidate list with the persistent-cache layer in front. Checks
// data/stream-cache.json first; on a miss (or when forceFresh) runs the live
// search and writes the result back. Returns { candidates, cached }.
async function getCandidates(event, log, opts) {
  opts = opts || {};
  if (!opts.forceFresh) {
    const hit = streamcache.get(event.id);
    if (hit) {
      log('  candidate cache HIT (' + hit.length + ') for ' + event.id);
      return { candidates: hit, cached: true };
    }
  }
  log('  candidate cache MISS for ' + event.id + ' — searching indexers');
  const found = await searchCandidates(event, log);
  try { streamcache.put(event.id, found); }
  catch (e) { log('  streamcache put failed: ' + e.message); }
  return { candidates: found, cached: false };
}

async function handleStream(params) {
  const debug = !!params.debug;
  const debugLog = [];
  // Username (when known) is logged on every line so requests can be traced to
  // a specific user. The resolve base is what each stream row points at — the
  // actual debrid add happens there (on play), never here.
  const uTag = params.username ? ' u=' + params.username : '';
  const log = (m) => { const r = redact(String(m)); console.log('[stream' + uTag + '] ' + r); if (debug) debugLog.push(r); };

  if (!params) return { streams: [] };
  const id = params.id;
  if (!id) return { streams: [] };

  const event = store.getEvent(id);
  if (!event) { log('no event for ' + id); return { streams: [] }; }
  const promotion = promotionOf(event);
  if (!promotion) { log('no promotion for event ' + id); return { streams: [] }; }

  // Per-request creds (Phase 2 multi-tenant) or null (legacy env-based).
  const creds = params.userConfig || null;

  // Stream result cache is keyed per-user when creds are supplied so users
  // can't see each other's cached resolutions.
  const cacheKey = creds ? (id + '::' + (creds.rd || '') + '::' + (creds.tb || '') + '::' + (creds.pm || '')) : id;
  if (!debug) {
    const cached = fromCache(cacheKey);
    if (cached) { log('cache hit (' + cached.length + ')'); return { streams: cached }; }
  }

  const providers = providersForRequest(creds);
  if (providers.length === 0) { log('no debrid providers configured for this request'); return { streams: [] }; }
  // Source-agnostic gate: we just need at least ONE indexer source configured
  // (Prowlarr, Zilean, or an optional extra source). If none, surface a clear
  // 'configure a source' note instead of a silent empty list.
  const pw = settings.getProwlarr();
  const haveProwlarr = !!(pw.url && pw.apiKey);
  const haveZilean = !!settings.getZilean().url;
  const haveExtra = !!extra;
  if (!haveProwlarr && !haveZilean && !haveExtra) {
    log('no indexer source configured (set Prowlarr or Zilean in /admin)');
    return { streams: [{
      name: '\u2139\uFE0F No indexer configured',
      title: 'No Prowlarr or Zilean source is set up yet.\n'
        + 'Add one in the admin panel \u2192 Sources.',
      url: 'https://serioussportsync.invalid/no-source',
      behaviorHints: { notWebReady: true, bingeGroup: 'sport-config' },
    }] };
  }

  log('resolving ' + id + ' [' + promotion.id + '] (' + event.name + ')' + (creds ? ' (per-user)' : ' (env)'));
  log('providers configured: ' + providers.map((p) => p.code).join(', '));
  const queries = buildQueries(event); // kept for the debug payload / logs
  // Candidate search goes through the persistent cache. debug always forces a
  // fresh search so the debug payload reflects the live indexers.
  const { candidates: found, cached: candCached } = await getCandidates(event, log, { forceFresh: debug });
  if (candCached) log('  using cached candidates (skipped live indexer search)');

  function runFilter(minSize) {
    const rej = {};
    const cand = [];
    for (const r of found) {
      // Do NOT reject zero-seeder candidates. Seeder data is unreliable: Zilean
      // returns none at all, and some sources' scraped counts parse as 0 — yet
      // the torrent may still be cached on the user's debrid, which is all that
      // matters for playback. Seeders only drive sort order (below) and the
      // warm-on-miss decision (which has its own seeders>0 guard).
      const check = relevanceCheck(r.title, r.size, event, promotion, minSize);
      if (!check.ok) {
        rej[check.reason] = (rej[check.reason] || 0) + 1;
        if (debug) log('    REJECT [' + check.reason + ']: ' + r.title);
        continue;
      }
      cand.push(r);
    }
    cand.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    return { cand, rej };
  }

  let { cand: candidates, rej: rejections } = runFilter(MIN_TORRENT_SIZE);
  log('  rejection summary (>=1GB): ' + JSON.stringify(rejections));
  if (candidates.length === 0) {
    log('  no candidates at >=1GB, retrying without size minimum');
    const r2 = runFilter(0);
    candidates = r2.cand; rejections = r2.rej;
    log('  rejection summary (no-min): ' + JSON.stringify(rejections));
  }
  log('  passing relevance: ' + candidates.length);

  const top = candidates.slice(0, RESOLVE_MAX);
  if (top.length === 0) {
    // Nothing on the indexers for this event. There's no candidate torrent to
    // add to a debrid, so warming is impossible — surface an informational row
    // (instead of a silent empty list) so the user knows it's "no releases
    // found yet", not a broken addon. Short-TTL cache so a re-click re-checks
    // once the persistent candidate cache expires.
    const note = {
      name: '\u2139\uFE0F No releases found yet',
      title: 'No torrent releases were found for this event.\n'
        + 'The addon re-checks automatically \u2014 try again later.',
      url: 'https://serioussportsync.invalid/none/' + encodeURIComponent(id),
      behaviorHints: { notWebReady: true, bingeGroup: 'sport-none' },
    };
    intoCache(cacheKey, [note], WARMING_TTL_MS);
    return debug
      ? { streams: [note], debug: { event: event.name, promotion: promotion.id, providers: providers.map(p => p.code), queries, totalFound: found.length, rejections, debugLog } }
      : { streams: [note] };
  }

  // Build the play-time resolve base for this user's row URLs. Each row points
  // back at the addon; the debrid add/unrestrict happens only when the user
  // clicks play (see resolvePlay + the /resolve route). If we can't build a
  // per-user URL (origin/ids missing), we can't advertise playable rows.
  const resolveBase = (params.origin && params.userId && params.apiToken)
    ? (params.origin.replace(/\/+$/, '') + '/u/' + params.userId + '/' + params.apiToken + '/resolve/')
    : null;
  if (!resolveBase) {
    log('  cannot build resolve URL (missing origin/userId/apiToken) — returning empty');
    return debug
      ? { streams: [], debug: { event: event.name, promotion: promotion.id, providers: providers.map(p => p.code), queries, totalFound: found.length, rejections, debugLog } }
      : { streams: [] };
  }

  // Display order: largest file first (full event > main-card-only > prelims).
  const maxStreams = (creds && Number(creds.maxStreams)) || 0;
  const cap = maxStreams > 0 ? maxStreams : RESOLVE_MAX;
  const shown = top.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, cap);

  // Row builder (0.23.1). Three layers of filtering, applied per provider:
  //   1. WARMER-VERIFIED cache (TB/PM only) — if cachedProviders.<p> === true,
  //      advertise; if false, skip with reason 'verified-not-cached'.
  //      Populated by the warmer's batch cache check (scripts/refresh-streams).
  //   2. DENYLIST (all providers) — when no verified cache info is available,
  //      check the per-provider denylist (RD has the longest history, TB/PM
  //      learn from click failures as a fallback). Skip if denied.
  //   3. OPTIMISTIC (default) — advertise the row; resolution happens on click.
  //   PLUS RD-only keyword pre-filter (RD's May-2026 "infringing_file" tags).
  //
  // RD has no warmer verification (its API doesn't allow a clean non-
  // destructive check), so layers 2+3 are the only defence there.
  const tbDenylist = require('./tb-denylist');
  const pmDenylist = require('./pm-denylist');
  const haveRd = providers.some((p) => (p.code || '').toUpperCase() === 'RD');
  const haveTb = providers.some((p) => (p.code || '').toUpperCase() === 'TB');
  const havePm = providers.some((p) => (p.code || '').toUpperCase() === 'PM');
  const rdDenied = haveRd ? rdDenylist.loadDeniedSet() : new Set();
  const tbDenied = haveTb ? tbDenylist.loadDeniedSet() : new Set();
  const pmDenied = havePm ? pmDenylist.loadDeniedSet() : new Set();
  // Positive cache (0.24.0) — fresh "hash:provider" entries from past successful
  // resolves. Treated as the strongest signal (authoritative-cached), overrides
  // both denylist and warmer "verified-not-cached" (because the user proved it
  // works). Especially powerful for RD where no warmer pre-check is possible.
  const posCached = positiveCache.loadCachedSet();
  // 0.26.1: strict-when-warmer-active row builder. When WARMER_TB_TOKEN /
  // WARMER_PM_KEY are set, TB/PM rows are STRICT — only verified-cached or
  // positive-cached rows are advertised. Unverified rows (no warmer verdict,
  // or verdict was 'not cached') are dropped because they're dead clicks
  // when verification is the source of truth. RD remains optimistic (no
  // non-destructive cache check exists for RD's API).
  //
  // When warmer creds are NOT set (verification disabled), fall back to the
  // pre-0.26.1 optimistic behaviour: denylist filtering only, then show
  // everything else. The `relaxed` parameter is no longer used; kept for
  // signature stability in case something else calls buildRows.
  const tbWarmerActive = !!(config.warmer && config.warmer.tbToken);
  const pmWarmerActive = !!(config.warmer && config.warmer.pmApiKey);
  function buildRows(relaxed) {
    const out = [];
    const c = {
      rdSkippedKw: 0, rdSkippedDeny: 0, rdPosCached: 0,
      tbSkippedVerified: 0, tbSkippedDeny: 0, tbSkippedUnverified: 0, tbVerifiedCached: 0, tbPosCached: 0,
      pmSkippedVerified: 0, pmSkippedDeny: 0, pmSkippedUnverified: 0, pmVerifiedCached: 0, pmPosCached: 0,
    };
    for (const r of shown) {
      const quality = qualityFromTitle(r.title);
      const sizeStr = humanSize(r.size);
      const hashLc = String(r.infoHash || '').toLowerCase();
      const rdKwHit = haveRd && RD_KEYWORD_RE && r.title && RD_KEYWORD_RE.test(r.title);
      const rdDenyHit = haveRd && hashLc && rdDenied.has(hashLc);
      const verif = r.cachedProviders || null;
      for (const p of providers) {
        const code = (p.code || '').toUpperCase();
        const codeLc = code.toLowerCase();
        const positive = hashLc && posCached.has(hashLc + ':' + codeLc);

        // ---- RD ----
        if (code === 'RD') {
          if (positive)       { c.rdPosCached++; /* advertise below */ }
          else if (rdKwHit)   { c.rdSkippedKw++;   continue; }
          else if (rdDenyHit) { c.rdSkippedDeny++; continue; }
        }
        // ---- TB: positive → warmer-verified → (strict-or-denylist) ----
        else if (code === 'TB') {
          if (positive)                          { c.tbPosCached++; /* advertise below */ }
          else if (verif && verif.tb === true)   { c.tbVerifiedCached++; /* advertise below */ }
          else if (tbWarmerActive) {
            // Warmer is the source of truth — never show TB row as optimistic.
            if (verif && verif.tb === false) c.tbSkippedVerified++;
            else                              c.tbSkippedUnverified++;
            continue;
          }
          else if (hashLc && tbDenied.has(hashLc)) { c.tbSkippedDeny++; continue; }
          // else: warmer inactive → fall through to optimistic advertise.
        }
        // ---- PM: positive → warmer-verified → (strict-or-denylist) ----
        else if (code === 'PM') {
          if (positive)                          { c.pmPosCached++; /* advertise below */ }
          else if (verif && verif.pm === true)   { c.pmVerifiedCached++; /* advertise below */ }
          else if (pmWarmerActive) {
            if (verif && verif.pm === false) c.pmSkippedVerified++;
            else                              c.pmSkippedUnverified++;
            continue;
          }
          else if (hashLc && pmDenied.has(hashLc)) { c.pmSkippedDeny++; continue; }
          // else: warmer inactive → fall through to optimistic advertise.
        }

      // 0.25.0: sign + time-limit the per-play URL so leaked links expire.
      const sigParts = urlSign.signResolve({
        userId: params.userId, provider: codeLc, eventId: id, infoHash: r.infoHash,
      });
      const urlPath = resolveBase + codeLc
        + '/' + encodeURIComponent(id)
        + '/' + encodeURIComponent(r.infoHash);
      const url = urlPath + '?exp=' + sigParts.exp + '&sig=' + sigParts.sig;
      out.push({
        name: p.code + (quality ? ' ' + quality : '') + (sizeStr ? '\n' + sizeStr : ''),
        title: (r.title || r.infoHash)
          + '\n👥 ' + (r.seeders || 0)
          + (sizeStr ? ' | 💾 ' + sizeStr : '')
          + (r.indexer ? '\n[' + r.indexer + ']' : ''),
        url,
        behaviorHints: {
          bingeGroup: 'sport-' + codeLc,
          videoSize: r.size || undefined,
          filename: r.title || undefined,
        },
      });
      }
    }
    return { rows: out, c };
  } // end buildRows

  // 0.26.1: strict only. When TB/PM warmer is active, unverified TB/PM rows
  // are dropped (dead clicks). When the warmer is inactive for a provider,
  // optimistic display still happens (via the buildRows logic). Auto-warm
  // below picks up any opted-in provider with nothing cached on this event.
  let { rows: streams, c: cc } = buildRows(false);

  // 0.26.2: user-facing auto-warm is DISABLED by default. Repeated /stream
  // calls from the same user (or different users in quick succession) on the
  // same hash caused TB createTorrent 429 storms that wrongly soft-denylisted
  // already-cached playable links. Re-enable per-user warming by setting
  // AUTO_CACHE_ENABLED=on in the env — recommended only after the admin
  // per-event power tool ships and there's a proper de-duplication layer.
  // The autoCache schema in users.json is preserved so a future admin tool
  // can write to it server-side.
  const autoCacheEnabled = String(process.env.AUTO_CACHE_ENABLED || 'off').toLowerCase() === 'on';
  const userAutoCache = autoCacheEnabled ? ((creds && creds.autoCache) || {}) : {};
  const providerHasNothingCached = (codeLc) => {
    for (const r of shown) {
      const hashLc = String(r.infoHash || '').toLowerCase();
      if (hashLc && posCached.has(hashLc + ':' + codeLc)) return false;  // positive cache hit
      const verif = r.cachedProviders;
      if (verif && verif[codeLc] === true) return false;  // warmer verified cached
    }
    return true;  // 0 cached rows for this provider on this event
  };
  const warmProvidersNeedingCache = providers.filter((p) => {
    const code = (p.code || '').toLowerCase();
    if (!p.warmCache || !userAutoCache[code]) return false;  // not opted in
    return providerHasNothingCached(code);  // nothing cached for this provider
  });

  if (warmProvidersNeedingCache.length > 0 && shown.length > 0) {
    const topResult = shown[0]; // already sorted size-desc
    const warmCodes = warmProvidersNeedingCache.map((p) => p.code).join(', ');
    log('  auto-warm: queuing ' + topResult.infoHash + ' on ' + warmCodes
      + ' (no cached rows for these providers; per-user opt-in)');
    const ctx = { buildMagnet, qualityFromTitle, humanSize, pickVideoFile, log, creds: creds || null };
    // Fire-and-forget — don't block /stream response on the debrid adds.
    Promise.allSettled(warmProvidersNeedingCache.map((p) =>
      Promise.resolve()
        .then(() => p.warmCache(topResult, ctx))
        .catch((err) => { log('  auto-warm: ' + p.code + ' failed: ' + err.message); return false; })
    )).then(() => log('  auto-warm: queue dispatched'));
    // Surface a placeholder row so the user sees what's happening, even when
    // other (verified-cached) rows are also present.
    const sizeStr = humanSize(topResult.size);
    streams.unshift({
      name: '🔥 Warming on ' + warmCodes,
      title: 'Added the top candidate to your ' + warmCodes + ' library.\n'
        + 'Try again in 30-60 seconds — the next warm cycle picks it up.\n'
        + (topResult.title || topResult.infoHash)
        + (sizeStr ? '\n💾 ' + sizeStr : ''),
      url: 'https://serioussportsync.invalid/warming/' + topResult.infoHash,
      behaviorHints: { notWebReady: true, bingeGroup: 'sport-warming' },
    });
  }
  streams = sortStreamsBySize(streams);
  if (cc.rdPosCached || cc.rdSkippedKw || cc.rdSkippedDeny) {
    log('  RD filter: ' + cc.rdPosCached + ' positive-cached'
      + ', skipped ' + (cc.rdSkippedKw + cc.rdSkippedDeny)
      + ' (' + cc.rdSkippedKw + ' keyword, ' + cc.rdSkippedDeny + ' denylist)');
  }
  const tbSkippedTotal = cc.tbSkippedVerified + cc.tbSkippedUnverified + cc.tbSkippedDeny;
  if (cc.tbPosCached || cc.tbVerifiedCached || tbSkippedTotal) {
    log('  TB filter: ' + cc.tbPosCached + ' positive-cached, '
      + cc.tbVerifiedCached + ' verified-cached'
      + ', skipped ' + tbSkippedTotal
      + ' (' + cc.tbSkippedVerified + ' verified-not-cached, '
      + cc.tbSkippedUnverified + ' unverified [warmer-active], '
      + cc.tbSkippedDeny + ' denylist)');
  }
  const pmSkippedTotal = cc.pmSkippedVerified + cc.pmSkippedUnverified + cc.pmSkippedDeny;
  if (cc.pmPosCached || cc.pmVerifiedCached || pmSkippedTotal) {
    log('  PM filter: ' + cc.pmPosCached + ' positive-cached, '
      + cc.pmVerifiedCached + ' verified-cached'
      + ', skipped ' + pmSkippedTotal
      + ' (' + cc.pmSkippedVerified + ' verified-not-cached, '
      + cc.pmSkippedUnverified + ' unverified [warmer-active], '
      + cc.pmSkippedDeny + ' denylist)');
  }
  log('  advertising ' + streams.length + ' row(s) from ' + shown.length
    + ' release(s) × ' + providers.length + ' provider(s)'
    + (tbWarmerActive || pmWarmerActive ? ' (strict mode — warmer is source of truth for verified providers)' : '')
    + ' — resolve on play');

  intoCache(cacheKey, streams, streams.length === 0 ? WARMING_TTL_MS : undefined);

  if (debug) {
    return { streams, debug: { event: event.name, promotion: promotion.id, providers: providers.map((p) => p.code), queries, totalFound: found.length, rejections, kept: candidates.length, advertised: streams.length, debugLog } };
  }
  return { streams };
}

module.exports = { handleStream, resolvePlay, searchCandidates, getCandidates, buildQueries, buildDateQueries };
