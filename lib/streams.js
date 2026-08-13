// Stream handler.
//
// Three playback pipelines run in parallel. Pipeline A can discover torrents
// through the companion scraper, direct Prowlarr, or both:
//
//   Pipeline A (debrid path): torrent discovery -> noise + relevance
//     filter -> sort -> TorBox cache check (per-user key) -> request
//     playable URL for each cached hash -> URL stream rows.
//     Uncached hashes are silently dropped — no infoHash rows ever leave
//     /stream, so the client can't fall through to peer-to-peer.
//
//   Pipeline B (Usenet handoff): admin-Newsnab -> noise + relevance filter
//     -> sort -> user's UU URL builder (existing 0.30.x behaviour).
//
//   Pipeline C (direct Easynews): user's Easynews creds -> search
//     members.easynews.com -> noise + relevance filter -> sort ->
//     signed deferred URL with embedded playback token. On play-click,
//     /resolve/easynews injects basic auth + 302-redirects to Easynews
//     CDN. Creds never appear in /stream responses or log buffers.
//
// Per-user requirements:
//   - At least one of `torboxApiKey`, `uuManifestUrl`, or
//     `easynewsUsername`+`easynewsPassword` on /account.
//
// Admin requirements:
//   - Companion scraper URL and/or direct Prowlarr URL + API key (Pipeline A).
//   - Newsnab URL + API key (for Pipeline B).
//   - (Easynews uses per-user creds only — no admin config.)

const store = require('./store');
const { getByEventId } = require('./promotions');
const newsnab = require('./sources/newsnab');
const uu = require('./sources/usenet-ultimate');
const companion = require('./sources/companion-scraper');
const prowlarr = require('./sources/prowlarr');
const easynews = require('./sources/easynews');
const torbox = require('./sources/torbox-resolver');
const settings = require('./settings');
const urlSign = require('./url-sign');

const MAX_ROWS = parseInt(process.env.STREAM_MAX_ROWS || '20', 10);

function resRank(title) {
  if (!title) return 0;
  if (/\b(2160p|4k|uhd)\b/i.test(title)) return 4;
  if (/\b1080p|fhd\b/i.test(title)) return 3;
  if (/\b720p\b/i.test(title)) return 2;
  if (/\b480p|sd\b/i.test(title)) return 1;
  return 0;
}

function detectResolution(t) {
  if (!t) return '';
  if (/\b(2160p|4k|uhd)\b/i.test(t)) return '2160p';
  if (/\b1080p|fhd\b/i.test(t)) return '1080p';
  if (/\b720p\b/i.test(t)) return '720p';
  if (/\b480p|sd\b/i.test(t)) return '480p';
  return '';
}

function detectSource(t) {
  if (!t) return '';
  if (/\bWEB[\s._-]*DL\b/i.test(t)) return 'WEB-DL';
  if (/\bWEBRip\b/i.test(t)) return 'WEBRip';
  if (/\bWEB\b/i.test(t)) return 'WEB';
  if (/\bHDTV\b/i.test(t)) return 'HDTV';
  if (/\bBluRay\b/i.test(t)) return 'BluRay';
  return '';
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + ' MB';
  return '';
}

function sortCandidates(results, sizeField, dateField) {
  results.sort((a, b) => {
    const rb = resRank(b.title) - resRank(a.title);
    if (rb !== 0) return rb;
    const sb = (Number(b[sizeField]) || 0) - (Number(a[sizeField]) || 0);
    if (sb !== 0) return sb;
    return (Date.parse(b[dateField]) || 0) - (Date.parse(a[dateField]) || 0);
  });
}

// 0.34.0: LOG_EXCLUDED_TITLES=1 env switch enables per-title rejection lines
// for the relevance filter. Default OFF — only enable when actively debugging
// false-positive rejection (e.g. a real release being dropped as wrong-event
// or wrong-round). Lines land in /admin/logs alongside the existing SUMMARY.
const LOG_EXCLUDED = process.env.LOG_EXCLUDED_TITLES === '1';

function filterCandidates(label, results, log, promo, event) {
  // 0.35.0: pass promo.id so the noise filter can layer admin-added
  // per-promotion rejection patterns on top of the global NOISE_PATTERNS list.
  const noise = newsnab.filterSportsNoise(results, log, promo && promo.id);
  const relevant = [];
  const rejectReasons = {};
  for (const r of noise.results) {
    const blockedByEvent = (event.excludePatterns || []).some((pattern) => {
      try { return new RegExp(pattern, 'i').test(r.title || ''); } catch (_) { return false; }
    });
    if (blockedByEvent) {
      rejectReasons['event exclusion'] = (rejectReasons['event exclusion'] || 0) + 1;
      continue;
    }
    let verdict = promo.isRelevantStreamTitle(r.title, event);
    const eventYear = String(event.date || '').slice(0, 4);
    const titleYears = String(r.title || '').match(/\b20\d{2}\b/g) || [];
    const wrongExplicitYear = eventYear && titleYears.length > 0 && !titleYears.includes(eventYear);
    if (!verdict.ok && !wrongExplicitYear && (event.searchAliases || []).some((alias) =>
      String(alias || '').trim().length >= 4
      && String(r.title || '').toLowerCase().includes(String(alias).trim().toLowerCase())
    )) verdict = { ok: true, reason: 'content-studio alias' };
    if (verdict.ok) relevant.push(r);
    else {
      rejectReasons[verdict.reason] = (rejectReasons[verdict.reason] || 0) + 1;
      if (LOG_EXCLUDED) {
        // Per-title visibility for debugging the relevance filter. The
        // noise filter (newsnab.filterSportsNoise) already logs its own
        // drops, so this only covers the relevance stage.
        log('  ' + label + ' relevance-drop (' + verdict.reason + '): ' + r.title);
      }
    }
  }
  const breakdown = Object.entries(rejectReasons)
    .map(([k, v]) => v + ' ' + k).join(' / ') || 'none';
  log(label + ' SUMMARY: ' + results.length + ' raw -> '
    + noise.results.length + ' post-noise -> '
    + relevant.length + ' post-relevance (rejected: ' + breakdown + ')');
  return relevant;
}

// Build a TorBox stream row. The URL points at this addon's own /resolve
// endpoint so the actual TorBox createTorrent + requestdl only fires when
// the user clicks Play — NOT during /stream. Without this deferral, every
// catalog browse / event open silently adds every cached hash to the
// user's TorBox library, which is exactly what the 0.22.0 design rule
// (debrid-resolve-on-play) was put in place to prevent.
//
// The URL is HMAC-signed with a short TTL (lib/url-sign.js) so a leaked
// resolve link can't be reused indefinitely against the user's TorBox
// quota.
function buildTorboxRow(candidate, deferredUrl) {
  const resolution = detectResolution(candidate.title);
  const sourceTag = detectSource(candidate.title);
  const qualityLine = [resolution, sourceTag].filter(Boolean).join(' ') || 'TorBox';
  const sizeLabel = formatSize(candidate.size);
  const datePart = candidate.publishDate
    ? new Date(candidate.publishDate).toISOString().slice(0, 10) : '';
  // Source attribution intentionally generic ("TorBox") — see
  // companion-scraper.js comment: the public addon stays source-agnostic.
  const metaLine = [
    sizeLabel ? '\u{1F4BE} ' + sizeLabel : '',
    'TorBox',
    datePart,
  ].filter(Boolean).join(' · ');
  return {
    name: '\u{2601}\u{FE0F} TorBox\n' + qualityLine,
    title: candidate.title + (metaLine ? '\n' + metaLine : ''),
    url: deferredUrl,
    behaviorHints: { bingeGroup: 'serioussportsync-torbox', notWebReady: false },
  };
}

function buildDeferredUrl({ origin, userId, apiToken, eventId, infoHash }) {
  const { exp, sig } = urlSign.signResolve({
    userId, provider: 'torbox', eventId, infoHash,
  });
  const path = '/u/' + encodeURIComponent(userId)
    + '/' + encodeURIComponent(apiToken)
    + '/resolve/torbox/' + encodeURIComponent(eventId)
    + '/' + encodeURIComponent(infoHash)
    + '?exp=' + encodeURIComponent(exp) + '&sig=' + encodeURIComponent(sig);
  return (origin || '') + path;
}

// 0.38.0: Warm-to-cache URL. Same HMAC signing scheme as /resolve so the link
// can't be forged, but points to the /warm route which submits the magnet to
// the user's TorBox account (rather than asking TB for a playable URL).
function buildWarmUrl({ origin, userId, apiToken, eventId, infoHash }) {
  const { exp, sig } = urlSign.signResolve({
    userId, provider: 'torbox-warm', eventId, infoHash,
  });
  const path = '/u/' + encodeURIComponent(userId)
    + '/' + encodeURIComponent(apiToken)
    + '/warm/torbox/' + encodeURIComponent(eventId)
    + '/' + encodeURIComponent(infoHash)
    + '?exp=' + encodeURIComponent(exp) + '&sig=' + encodeURIComponent(sig);
  return (origin || '') + path;
}

// 0.38.0: Warm-pseudo-stream row. Visibly distinct from cached rows so users
// don't click it expecting instant playback. Plays a tiny placeholder MP4
// after the magnet has been queued at TorBox.
function buildWarmRow(candidate, warmUrl) {
  const resolution = detectResolution(candidate.title);
  const sourceTag = detectSource(candidate.title);
  const qualityLine = [resolution, sourceTag].filter(Boolean).join(' ') || 'TorBox';
  const sizeLabel = formatSize(candidate.size);
  const datePart = candidate.publishDate
    ? new Date(candidate.publishDate).toISOString().slice(0, 10) : '';
  const metaLine = [
    sizeLabel ? '\u{1F4BE} ' + sizeLabel : '',
    'Click to warm',
    datePart,
  ].filter(Boolean).join(' · ');
  return {
    name: '\u{1F525} Warm to TorBox\n' + qualityLine,            // 🔥
    title: candidate.title + (metaLine ? '\n' + metaLine : ''),
    url: warmUrl,
    behaviorHints: { bingeGroup: 'serioussportsync-warm', notWebReady: false },
  };
}

// 0.34.0: Easynews deferred URL. Same signing scheme as TorBox — but the
// "infoHash" slot carries a base64url playback token (hash+title+farm+port)
// instead of a 40-char torrent hash. url-sign.js normalises with toLowerCase
// both at sign-time and verify-time, so the case-sensitive original token
// can travel through the URL intact and decode cleanly at /resolve.
function buildEasynewsDeferredUrl({ origin, userId, apiToken, eventId, token }) {
  const { exp, sig } = urlSign.signResolve({
    userId, provider: 'easynews', eventId, infoHash: token,
  });
  const path = '/u/' + encodeURIComponent(userId)
    + '/' + encodeURIComponent(apiToken)
    + '/resolve/easynews/' + encodeURIComponent(eventId)
    + '/' + encodeURIComponent(token)
    + '?exp=' + encodeURIComponent(exp) + '&sig=' + encodeURIComponent(sig);
  return (origin || '') + path;
}

// 0.34.0: Easynews stream row. Distinct branding (📡 Easynews) so the user
// can tell which backend is serving each row. Same two-line layout as the
// TorBox / UU rows: name=tag+quality, title=release+meta.
function buildEasynewsRow(candidate, deferredUrl) {
  // Easynews's `fullres` is "1920x1080" style — translate to "1080p" if we
  // can; otherwise fall back to scene-style detection on the release title.
  let resolution = '';
  const fr = candidate.resolution || '';
  const m = fr.match(/(\d{3,4})/);
  if (m) {
    const px = parseInt(m[1], 10);
    if (px >= 2000) resolution = '2160p';
    else if (px >= 1900) resolution = '1080p';
    else if (px >= 1200) resolution = '720p';
    else if (px >= 600) resolution = '480p';
  }
  if (!resolution) resolution = detectResolution(candidate.title);
  const sourceTag = detectSource(candidate.title);
  const qualityLine = [resolution, sourceTag].filter(Boolean).join(' ') || 'Easynews';
  const sizeLabel = candidate.sizeLabel || formatSize(candidate.size);
  const datePart = candidate.publishedAt
    ? new Date(candidate.publishedAt).toISOString().slice(0, 10) : '';
  const metaLine = [
    sizeLabel ? '\u{1F4BE} ' + sizeLabel : '',                // 💾 size
    'Easynews',
    datePart,
  ].filter(Boolean).join(' · ');                          //  ·
  return {
    name: '\u{1F4E1} Easynews\n' + qualityLine,                // 📡 Easynews
    title: candidate.title + (metaLine ? '\n' + metaLine : ''),
    url: deferredUrl,
    behaviorHints: { bingeGroup: 'serioussportsync-easynews', notWebReady: false },
  };
}

// Pipeline A — companion + TorBox cache check (read-only).
//
// Builds rows for every CACHED candidate, but does NOT call createTorrent
// or requestdl. Those happen later, only if the user clicks Play, via the
// /resolve route in addon.js -> resolvePlay() below.
async function discoverTorrentCandidates({ promo, event, titles, log }) {
  const tasks = [];
  const companionCfg = settings.getCompanion();
  const prowlarrCfg = settings.getProwlarr();

  if (companionCfg.url) {
    tasks.push(companion.scrape({
      promotion: promo, event, searchTitles: titles, log,
    }).catch((err) => {
      log('companion: search failed: ' + err.message);
      return [];
    }));
  }
  if (prowlarrCfg.url && prowlarrCfg.apiKey) {
    log('prowlarr: searching ' + titles.length + ' title variant(s)');
    tasks.push(prowlarr.multiSearch(titles, { log }).catch((err) => {
      log('prowlarr: search failed: ' + err.message);
      return [];
    }));
  }
  if (tasks.length === 0) {
    log('torrent discovery: no companion or direct Prowlarr configured');
    return [];
  }

  const lists = await Promise.all(tasks);
  const byHash = new Map();
  for (const list of lists) {
    for (const candidate of (list || [])) {
      const hash = String(candidate.infoHash || '').toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(hash)) continue;
      if (!byHash.has(hash)) byHash.set(hash, Object.assign({}, candidate, { infoHash: hash }));
    }
  }
  const candidates = Array.from(byHash.values());
  log('torrent discovery: ' + candidates.length + ' unique candidate(s)');
  return candidates;
}

async function pipelineTorrentTorbox({ promo, event, titles, torboxKey, urlCtx, log }) {
  if (!torboxKey) { log('torbox: no user key — skipping pipeline A'); return []; }

  // 1. Search the configured torrent sources. Both are read-only.
  const candidates = await discoverTorrentCandidates({ promo, event, titles, log });
  if (candidates.length === 0) return [];

  // 2. Filter + sort (top N).
  const relevant = filterCandidates('torrent', candidates, log, promo, event);
  sortCandidates(relevant, 'size', 'publishDate');
  const top = relevant.slice(0, MAX_ROWS);
  if (top.length === 0) return [];

  // 3. Batch TorBox cache check (read-only — checkcached does not add).
  log('torbox: checking cache for ' + top.length + ' hash(es)');
  const cachedSet = await torbox.checkCachedBatch(top.map((c) => c.infoHash), torboxKey, log);
  log('torbox: ' + cachedSet.size + ' cached / ' + (top.length - cachedSet.size) + ' uncached');
  const cached = top.filter((c) => cachedSet.has(c.infoHash));
  const uncached = top.filter((c) => !cachedSet.has(c.infoHash));

  // 4. Build DEFERRED-URL rows for cached candidates. No createTorrent here —
  //    only on play-click via the /resolve route in addon.js -> resolvePlay().
  const rows = cached.map((c) => buildTorboxRow(c, buildDeferredUrl({
    origin:   urlCtx.origin,
    userId:   urlCtx.userId,
    apiToken: urlCtx.apiToken,
    eventId:  event.id,
    infoHash: c.infoHash,
  })));
  log('torbox: built ' + rows.length + ' deferred row(s)');

  // 5. 0.38.0: Warm-to-cache pseudo-streams for uncached candidates. User
  //    setting `showWarmRows` (default true) controls whether these appear.
  //    Capped at WARM_MAX_ROWS so we don't pollute the UI with 20 warm
  //    options for a popular event — top N by relevance + size only.
  const showWarm = urlCtx.showWarmRows !== false;
  if (showWarm && uncached.length > 0) {
    const WARM_MAX_ROWS = Math.max(1, parseInt(process.env.WARM_MAX_ROWS || '5', 10));
    const warmTop = uncached.slice(0, WARM_MAX_ROWS);
    for (const c of warmTop) {
      rows.push(buildWarmRow(c, buildWarmUrl({
        origin:   urlCtx.origin,
        userId:   urlCtx.userId,
        apiToken: urlCtx.apiToken,
        eventId:  event.id,
        infoHash: c.infoHash,
      })));
    }
    log('torbox: surfaced ' + warmTop.length + ' warm-to-cache row(s)');
  }
  return rows;
}

// Pipeline C — direct Easynews search using per-user credentials.
//
// Easynews returns playable URLs directly (HTTPS+basic-auth) from its CDN.
// SSS does NOT relay the bytes — it just mints a signed deferred URL whose
// /resolve handler injects auth and 302-redirects to Easynews. Per-stream
// rows therefore contain no credentials, and even if a row's URL leaks, the
// HMAC TTL bounds the damage to ~4h (RESOLVE_URL_TTL_MINUTES default).
async function pipelineEasynews({ promo, event, titles, easynewsCreds, urlCtx, log }) {
  if (!easynewsCreds || !easynewsCreds.username || !easynewsCreds.password) {
    log('easynews: no user creds — skipping pipeline C');
    return [];
  }
  log('easynews: searching ' + titles.length + ' title variant(s)');
  let out;
  try {
    out = await easynews.multiSearch(titles, {
      username: easynewsCreds.username,
      password: easynewsCreds.password,
      log,
    });
  } catch (err) {
    log('easynews: multiSearch threw: ' + err.message);
    return [];
  }
  if (!out || !out.results || out.results.length === 0) return [];
  const relevant = filterCandidates('easynews', out.results, log, promo, event);
  // Sort by resolution, then size, then publishedAt (newest first).
  relevant.sort((a, b) => {
    const rb = resRank(b.title) - resRank(a.title);
    if (rb !== 0) return rb;
    const sb = (Number(b.size) || 0) - (Number(a.size) || 0);
    if (sb !== 0) return sb;
    return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
  });
  const top = relevant.slice(0, MAX_ROWS);
  if (top.length === 0) return [];
  const rows = [];
  for (const c of top) {
    const token = easynews.packPlaybackToken(c);
    if (!token) continue;
    rows.push(buildEasynewsRow(c, buildEasynewsDeferredUrl({
      origin:   urlCtx.origin,
      userId:   urlCtx.userId,
      apiToken: urlCtx.apiToken,
      eventId:  event.id,
      token,
    })));
  }
  log('easynews: built ' + rows.length + ' row(s)');
  return rows;
}

// Pipeline B - Newsnab + Usenet Ultimate (restored 0.42.10 per user's UFC
// screenshot showing one row per NZB with size/quality/filename visible).
// SSS runs newsnab.multiSearch to get NZB candidates, filters by relevance,
// then wraps each surviving NZB in a UU playback URL. UU plays the specific
// NZB via NzbDAV. Indexer coverage is set by NEWSNAB_URL - CSV multi-endpoint
// from 0.42.7 stays supported so nzbgeek + usenet-crawler both get queried.
async function pipelineNewsnabUU({ promo, event, titles, uuConfig, log }) {
  if (!uuConfig) { log('uu: not configured - skipping pipeline B'); return []; }
  log('newsnab: searching ' + titles.length + ' title variant(s)');
  const searchOut = await newsnab.multiSearch(titles, { log });
  if (searchOut.results.length === 0) return [];
  const relevant = filterCandidates('newsnab', searchOut.results, log, promo, event);
  relevant.sort((a, b) => {
    const rb = resRank(b.title) - resRank(a.title);
    if (rb !== 0) return rb;
    const sb = (Number(b.size) || 0) - (Number(a.size) || 0);
    if (sb !== 0) return sb;
    return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
  });
  return uu.buildStreamRows(relevant.slice(0, MAX_ROWS), uuConfig, event.name);
}

async function handleStream(params) {
  const log = makeLogger(params);
  const id = params.id;
  if (params.type !== 'movie' || !id || !id.includes(':')) {
    return { streams: [] };
  }

  const data = store.loadFromDisk();
  const event = (data.events || []).find((e) => e.id === id);
  if (!event) { log('no event in store for ' + id); return { streams: [] }; }
  const promo = getByEventId(id);
  if (!promo || typeof promo.searchTitles !== 'function') {
    log('no promotion / no searchTitles for ' + id);
    return { streams: [] };
  }

  const titles = Array.from(new Set([].concat(promo.searchTitles(event) || [], event.searchAliases || []).filter(Boolean)));
  if (titles.length === 0) {
    log('no searchTitles for ' + id + ' (' + event.name + ')');
    return { streams: [] };
  }

  const userConfig = params.userConfig || {};
  const torboxKey = (userConfig.torboxApiKey || '').trim();
  const uuManifest = (userConfig.uuManifestUrl || '').trim();
  const uuConfig = uuManifest ? uu.parseManifestUrl(uuManifest) : null;
  // 0.34.0: Pipeline C credentials (Easynews). Per-user only — no admin
  // config. If either field is blank, the pipeline self-skips.
  const easynewsUser = (userConfig.easynewsUsername || '').trim();
  const easynewsPass = userConfig.easynewsPassword || '';
  const easynewsCreds = (easynewsUser && easynewsPass)
    ? { username: easynewsUser, password: easynewsPass } : null;

  // Context needed to mint signed deferred-resolve URLs for TorBox + Easynews.
  // 0.38.0: showWarmRows controls whether Pipeline A emits 🔥 warm-to-cache
  // pseudo-streams for uncached candidates. Default true; user opt-out via
  // /account Services tab.
  const urlCtx = {
    origin:   params.origin,
    userId:   params.userId,
    apiToken: params.apiToken,
    showWarmRows: userConfig.showWarmRows !== false,
  };

  // 0.42.0 — Pipeline budget. Nuvio times out at ~10s; if any single
  // pipeline (typically A → companion scraper → Prowlarr) is still running,
  // the whole /stream response is delayed and the client gives up. Wrap each
  // pipeline in a race against STREAM_PIPELINE_TIMEOUT_MS (default 8s) and
  // let whichever finished by then contribute rows. Slow pipelines just log
  // a timeout warning and return zero — the client still gets fast results.
  const budgetMs = parseInt(process.env.STREAM_PIPELINE_TIMEOUT_MS || '8000', 10);
  function budgeted(name, promise) {
    return Promise.race([
      promise.catch((err) => { log('pipeline ' + name + ' failed: ' + err.message); return []; }),
      new Promise((resolve) => setTimeout(() => {
        log('pipeline ' + name + ' TIMEOUT after ' + budgetMs + 'ms — returning empty');
        resolve([]);
      }, budgetMs)),
    ]);
  }

  // 0.42.0 — per-promotion pipeline toggles. `promo.disabledPipelines` is
  // an array of pipeline names ('torbox' | 'newsnab' | 'easynews') that
  // should be skipped for events from this promotion. Lets an operator
  // disable the slow-and-useless-here TorBox pipeline for football events
  // where UU carries all the water.
  const disabled = new Set((promo && Array.isArray(promo.disabledPipelines))
    ? promo.disabledPipelines.map((s) => String(s || '').toLowerCase().trim())
    : []);
  function runOrSkip(name, factory) {
    if (disabled.has(name)) {
      log('pipeline ' + name + ' disabled for this promotion — skipping');
      return Promise.resolve([]);
    }
    return budgeted(name, factory());
  }

  const [torboxRows, uuRows, easynewsRows] = await Promise.all([
    runOrSkip('torbox',   () => pipelineTorrentTorbox({ promo, event, titles, torboxKey, urlCtx, log })),
    runOrSkip('newsnab',  () => pipelineNewsnabUU({ promo, event, titles, uuConfig, log })),
    runOrSkip('easynews', () => pipelineEasynews({ promo, event, titles, easynewsCreds, urlCtx, log })),
  ]);

  // Merge with title-based dedupe (same release surfaced via multiple
  // backends). Order: TorBox -> UU -> Easynews so the highest-priority
  // backend wins the slot when titles collide.
  const seen = new Set();
  const merged = [];
  for (const set of [torboxRows, uuRows, easynewsRows]) {
    for (const row of set) {
      const key = row && row.title ? row.title.split('\n')[0] : null;
      if (!key) { merged.push(row); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  log('returning ' + merged.length + ' stream row(s) total');
  return { streams: merged };
}

function makeLogger(params) {
  const tag = '[stream' + (params.username ? ' ' + params.username : '') + ']';
  return (msg) => console.log(tag + ' ' + msg);
}

// Play-time resolution — called from addon.js's /u/:userId/:apiToken/
// resolve/:provider/:eventId/:infoHash route, but only AFTER lib/url-sign
// has verified the signature + TTL on the URL the client just hit. This
// is the ONLY place the metadata addon ever calls TorBox createTorrent +
// requestdl — /stream is read-only against the user's debrid account.
//
// Returns { url } on success (caller 302-redirects), { ok: false, error }
// otherwise (caller 404/502s).
async function resolvePlay({ providerCode, eventId, infoHash, creds, username }) {
  const tag = '[resolve' + (username ? ' ' + username : '') + ']';
  const log = (msg) => console.log(tag + ' ' + msg);
  const provider = String(providerCode || '').toLowerCase();

  if (provider === 'easynews') {
    return resolveEasynews({ eventId, token: infoHash, creds, log });
  }
  if (provider !== 'torbox') {
    log('unsupported provider: ' + provider);
    return { ok: false, error: 'unsupported-provider' };
  }
  const torboxKey = (creds && (creds.torboxApiKey || '')).trim();
  if (!torboxKey) {
    log('no torbox key on user');
    return { ok: false, error: 'no-torbox-key' };
  }
  if (!/^[a-f0-9]{40}$/i.test(String(infoHash || ''))) {
    log('bad hash');
    return { ok: false, error: 'bad-hash' };
  }
  const hash = String(infoHash).toLowerCase();
  log('resolving ' + eventId + ' ' + hash);

  // Defensive re-check of cache state — TorBox might have evicted the hash
  // between /stream and the user clicking Play. Cheaper than waking
  // createTorrent for an uncached hash.
  const cachedSet = await torbox.checkCachedBatch([hash], torboxKey, log);
  if (!cachedSet.has(hash)) {
    log('hash no longer cached on torbox');
    return { ok: false, error: 'not-cached' };
  }

  // At play-time we don't have the original magnetTrackers. For a TorBox-
  // cached torrent a hash-only magnet is sufficient — TorBox already has
  // the data, it just needs to identify the torrent.
  const magnet = torbox.buildMagnet(hash);
  const url = await torbox.resolveCached(hash, magnet, torboxKey, log);
  if (!url) {
    log('torbox returned no url');
    return { ok: false, error: 'resolve-failed' };
  }
  log('resolved -> ' + url.slice(0, 60) + '...');
  return { ok: true, url };
}

// 0.34.0: Easynews resolve. Decodes the playback token from the signed URL,
// looks up the user's stored Easynews creds, and constructs the playable
// HTTPS+basic-auth URL on members.easynews.com. Caller 302-redirects.
// Never relays bytes — just hands off the URL with embedded auth.
function resolveEasynews({ eventId, token, creds, log }) {
  const username = (creds && creds.easynewsUsername || '').trim();
  const password = (creds && creds.easynewsPassword) || '';
  if (!username || !password) {
    log('no easynews creds on user');
    return { ok: false, error: 'no-easynews-creds' };
  }
  if (!token || typeof token !== 'string') {
    log('missing easynews token');
    return { ok: false, error: 'bad-token' };
  }
  const decoded = easynews.unpackPlaybackToken(token);
  if (!decoded) {
    log('failed to decode easynews token');
    return { ok: false, error: 'bad-token' };
  }
  log('resolving easynews ' + eventId + ' hash=' + decoded.postHash.slice(0, 10) + '…');
  const url = easynews.buildPlaybackUrl(decoded, username, password);
  if (!url) {
    log('failed to build easynews playback url');
    return { ok: false, error: 'resolve-failed' };
  }
  // Don't log the URL — it carries basic auth. The redact middleware would
  // scrub it on the way to the log buffer, but better not to write it at all.
  log('resolved easynews -> members.easynews.com/' + decoded.dlFarm + '/...');
  return { ok: true, url };
}

// Candidate search for the companion-backed warmer and power-tool consumers.
//
// This returns candidates in the legacy shape expected by those callers.
// Direct Prowlarr is intentionally excluded: it is request-only and runs from
// pipelineTorrentTorbox when a user opens an event.
async function searchCandidates(event, log) {
  log = log || (() => {});
  if (!event || !event.id) return [];
  const promo = getByEventId(event.id);
  if (!promo || typeof promo.searchTitles !== 'function') {
    log('  searchCandidates: no promotion for ' + event.id);
    return [];
  }
  const titles = Array.from(new Set([].concat(promo.searchTitles(event) || [], event.searchAliases || []).filter(Boolean)));
  if (!titles || titles.length === 0) {
    log('  searchCandidates: no searchTitles for ' + event.id);
    return [];
  }
  const companionCfg = settings.getCompanion();
  if (!companionCfg.url) {
    log('  searchCandidates: companion not configured — scheduled search skipped');
    return [];
  }
  try {
    const out = await companion.scrape({
      promotion: promo, event, searchTitles: titles, log,
    });
    return Array.isArray(out) ? out : [];
  } catch (err) {
    log('  searchCandidates: companion threw: ' + err.message);
    return [];
  }
}

module.exports = { handleStream, resolvePlay, searchCandidates };
