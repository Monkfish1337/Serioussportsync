// Stream handler.
//
// Three playback pipelines run in parallel. Pipeline A can discover torrents
// through the companion scraper, direct Prowlarr, Sport-Video, or any mix:
//
//   Pipeline A (debrid path): torrent discovery -> noise + relevance
//     filter -> sort -> TorBox cache check (per-user key) -> request
//     playable URL for each cached hash -> URL stream rows.
//     Uncached hashes are silently dropped — no infoHash rows ever leave
//     /stream, so the client can't fall through to peer-to-peer.
//
//   Pipeline B (Usenet Ultimate): event titles -> user's UU search endpoint
//     -> noise + relevance filter -> UU/NzbDAV playback rows.
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
//   - (Easynews uses per-user creds only — no admin config.)

const crypto = require('crypto');
const store = require('./store');
const { getByEventId } = require('./promotions');
const releaseFilter = require('./sources/release-filter');
const uu = require('./sources/usenet-ultimate');
const companion = require('./sources/companion-scraper');
const prowlarr = require('./sources/prowlarr');
const sportVideo = require('./sources/sport-video');
const easynews = require('./sources/easynews');
const torbox = require('./sources/torbox-resolver');
const nzbdavPlayback = require('./sources/nzbdav-playback');
const nntpPlayback = require('./sources/nntp-playback');
const usenetIndexer = require('./sources/usenet-indexer');
const playbackCandidates = require('./playback-candidates');
const availabilityStore = require('./availability-index');
const settings = require('./settings');
const urlSign = require('./url-sign');

const MAX_ROWS = parseInt(process.env.STREAM_MAX_ROWS || '20', 10);
const NZBDAV_RESOLVES = new Map();
const SEARCH_INFLIGHT = new Map();

// 0.90.3 — usenet backfill after a live search runs out of budget.
//
// A stream request has to answer inside Nuvio's ~10s patience, so each pipeline
// gets about 7.5s. A Usenet Ultimate or Newznab instance that fans out to
// several indexers routinely needs longer than that — and a search that times
// out returns nothing AND caches nothing, because cachedProviderSearch only
// records a result that succeeded. So a slow usenet source failed the same way
// on every request, forever, while torrents — which are also warmed in the
// background at a 15s budget — kept working. That reads as "this fixture used
// to give me usenet links and now gives me none".
//
// Automatic warming does not close the gap on its own: preparing usenet is off
// by default, deliberately, because Newznab indexers meter API hits per day and
// warming every event in the window would spend that allowance on fixtures
// nobody opened.
//
// So the backfill is demand-driven. The first request that times out schedules
// one search for THAT event at the warm budget; the result lands in the
// availability index and the next request is served from it. One in flight per
// event and account, and only for events someone actually opened.
const USENET_BACKFILL_INFLIGHT = new Set();
const USENET_BUDGET_FAILURE_RE = /timeout|network|abort|socket|econnreset|etimedout/i;

function isBudgetFailure(out) {
  return Boolean(out && out.ok === false && USENET_BUDGET_FAILURE_RE.test(String(out.error || '')));
}

function scheduleUsenetBackfill({ event, userConfig, username, log }) {
  if (!event || !event.id) return;
  if (String(process.env.STREAM_USENET_BACKFILL || '').toLowerCase() === 'off') return;
  const key = String(event.id) + '|' + String(username || '');
  if (USENET_BACKFILL_INFLIGHT.has(key)) return;
  USENET_BACKFILL_INFLIGHT.add(key);
  log('usenet: live search ran out of budget — retrying in the background so the next request is served from the index');
  Promise.resolve()
    .then(() => prefetchAvailability({
      event,
      userConfig,
      username,
      // Only the pipelines that just failed. Torrent and Easynews answered
      // inside the live budget, and repeating them would spend provider calls
      // to re-learn what the index already holds.
      prepare: { prepareTorrent: false, prepareUsenet: true, prepareEasynews: false },
      skipProviders: ['torrent', 'easynews'],
      log: (message) => log('backfill: ' + message),
    }))
    .catch((error) => log('usenet backfill failed: ' + (error && error.message ? error.message : error)))
    .finally(() => { USENET_BACKFILL_INFLIGHT.delete(key); });
}

function availabilityIndex(log) {
  try { return availabilityStore.getDefault(); }
  catch (error) {
    if (log) log('availability index unavailable: ' + error.message);
    return null;
  }
}

function shouldServeConfirmed() {
  try { return settings.getAvailabilityWarm().serveConfirmed !== false; }
  catch (_) { return true; }
}

function confirmedCandidates(index, input, log, label) {
  if (!index || !shouldServeConfirmed()) return [];
  try {
    const rows = index.confirmedForEvent(input);
    if (rows.length) log(label + ': recovered ' + rows.length + ' fresh confirmed candidate(s)');
    return rows.map((row) => row.candidate).filter(Boolean);
  } catch (error) {
    log(label + ': confirmed-result lookup failed: ' + error.message);
    return [];
  }
}

function mergeCandidates(index, primary, fallback) {
  const output = [];
  const seen = new Set();
  for (const candidate of [].concat(primary || [], fallback || [])) {
    if (!candidate) continue;
    const key = index ? index.releaseId(candidate) : JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function torrentDiscoveryScope(index) {
  const companionCfg = settings.getCompanion();
  const prowlarrCfg = settings.getProwlarr();
  const values = {
    companionUrl: companionCfg.url,
    companionToken: companionCfg.authToken,
    prowlarrUrl: prowlarrCfg.url,
    prowlarrApiKey: prowlarrCfg.apiKey,
  };
  // Preserve the pre-0.81 scope exactly while the opt-in source is disabled,
  // so existing cached searches remain reusable across the upgrade.
  if (settings.getSportVideo().enabled) values.sportVideo = true;
  return index ? index.scopeFingerprint('torrent', values) : 'uncached';
}

function nzbdavAvailabilityScope(index, config) {
  return index ? index.scopeFingerprint('nzbdav', {
    url: config.api && config.api.url, apiKey: config.api && config.api.apiKey,
    webdavUrl: config.webdav && config.webdav.url,
    username: config.webdav && config.webdav.username,
    password: config.webdav && config.webdav.password,
  }) : 'uncached';
}

function nntpAvailabilityScope(index, config) {
  return index ? index.scopeFingerprint('nntp', {
    host: config.host, port: config.port, tls: config.tls,
    username: config.username, password: config.password,
  }) : 'uncached';
}

async function cachedProviderSearch({ event, promo, provider, scope, queries, producer, log, index: suppliedIndex }) {
  const startedAt = Date.now();
  const index = suppliedIndex === undefined ? availabilityIndex(log) : suppliedIndex;
  const input = {
    eventId: event.id,
    promotionId: promo && promo.id,
    provider,
    scope,
    queries,
  };
  if (index) {
    try {
      const cached = index.getSearch(input);
      if (cached.hit) {
        log(provider + ': availability-index hit', {
          provider, cache: 'hit', candidates: cached.results.length,
          queryVariants: queries, durationMs: Date.now() - startedAt,
        });
        return { ok: true, results: cached.results, cached: true };
      }
    } catch (error) {
      log(provider + ': availability-index read failed: ' + error.message);
    }
  }

  const key = index ? index.searchKey(input).key : null;
  if (key && SEARCH_INFLIGHT.has(key)) {
    log(provider + ': joining in-flight availability search');
    return SEARCH_INFLIGHT.get(key);
  }
  const pending = Promise.resolve().then(producer).then((out) => {
    const normalized = Array.isArray(out) ? { ok: true, results: out } : (out || { ok: false, results: [] });
    if (index && normalized.ok !== false) {
      try { index.recordSearch(Object.assign({}, input, { results: normalized.results || [] })); }
      catch (error) { log(provider + ': availability-index write failed: ' + error.message); }
    }
    log(provider + ': search completed', {
      provider, cache: 'miss', ok: normalized.ok !== false,
      candidates: (normalized.results || []).length,
      queryVariants: queries, durationMs: Date.now() - startedAt,
      error: normalized.error || undefined,
    });
    return normalized;
  }).finally(() => {
    if (key && SEARCH_INFLIGHT.get(key) === pending) SEARCH_INFLIGHT.delete(key);
  });
  if (key) SEARCH_INFLIGHT.set(key, pending);
  return pending;
}

function resRank(title) {
  if (!title) return 0;
  if (/\b(2160p|4k|uhd)\b/i.test(title)) return 4;
  if (/\b1080p|fhd\b/i.test(title)) return 3;
  if (/\b720p\b/i.test(title)) return 2;
  if (/\b480p|sd\b/i.test(title)) return 1;
  return 0;
}

// Some sources report a pixel geometry ("1280x720") on a structured field
// instead of a scene token in the title. Translating it lets those candidates
// rank and label alongside ordinary indexer results rather than being treated
// as unknown-quality and sorted last.
function geometryResolution(value) {
  const match = String(value || '').match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
  if (!match) return '';
  const height = Math.min(Number(match[1]), Number(match[2]));
  if (height >= 1800) return '2160p';
  if (height >= 900) return '1080p';
  if (height >= 600) return '720p';
  if (height >= 380) return '480p';
  return '';
}

// Resolution for a candidate: the title's scene token when it has one, then
// any structured resolution/video field the source supplied.
function candidateResolution(candidate) {
  if (!candidate) return '';
  return detectResolution(candidate.title)
    || geometryResolution(candidate.resolution)
    || detectResolution(candidate.resolution)
    || geometryResolution(candidate.video);
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
    const rb = resRank(candidateResolution(b) || b.title)
      - resRank(candidateResolution(a) || a.title);
    if (rb !== 0) return rb;
    const sb = (Number(b[sizeField]) || 0) - (Number(a[sizeField]) || 0);
    if (sb !== 0) return sb;
    return (Date.parse(b[dateField]) || 0) - (Date.parse(a[dateField]) || 0);
  });
}

// Keep normal logs useful without allowing a broad search to bury everything
// else. A small sample is logged for every rejection reason; the Logs console
// can enable full detail while actively diagnosing a match.
const REJECTION_SAMPLE_PER_REASON = Math.max(1, Math.min(20,
  parseInt(process.env.LOG_REJECTION_SAMPLE_LIMIT || '4', 10) || 4));

function filterCandidates(label, results, log, promo, event) {
  // 0.35.0: pass promo.id so the noise filter can layer admin-added
  // per-promotion rejection patterns on top of the global NOISE_PATTERNS list.
  const noise = releaseFilter.filterSportsNoise(results, log, promo && promo.id, {
    allowForeignLanguage: !!(promo && promo.allowForeignLanguage),
  });
  const relevant = [];
  const rejectReasons = {};
  const loggedReasons = {};
  let detailedRejections = false;
  try { detailedRejections = settings.getLogPreferences().detailedRejections; }
  catch (_) { /* sampled detail remains available */ }
  const reject = (reason, title) => {
    rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
    loggedReasons[reason] = loggedReasons[reason] || 0;
    if (detailedRejections || loggedReasons[reason] < REJECTION_SAMPLE_PER_REASON) {
      log(label + ' candidate rejected', {
        pipeline: label, decision: 'rejected', reason, releaseTitle: title,
      });
      loggedReasons[reason]++;
    }
  };
  for (const r of noise.results) {
    const blockedByEvent = (event.excludePatterns || []).some((pattern) => {
      try { return new RegExp(pattern, 'i').test(r.title || ''); } catch (_) { return false; }
    });
    if (blockedByEvent) {
      reject('event exclusion', r.title);
      continue;
    }
    let verdict = promo.isRelevantStreamTitle(r.title, event);
    const eventYear = String(event.date || '').slice(0, 4);
    const titleYears = String(r.title || '').match(/\b20\d{2}\b/g) || [];
    const wrongExplicitYear = eventYear && titleYears.length > 0 && !titleYears.includes(eventYear);
    const aliasMayOverride = ['no-keyword-match', 'relevance'].includes(verdict.reason);
    if (!verdict.ok && aliasMayOverride && !wrongExplicitYear && (event.searchAliases || []).some((alias) =>
      String(alias || '').trim().length >= 4
      && String(r.title || '').toLowerCase().includes(String(alias).trim().toLowerCase())
    )) verdict = { ok: true, reason: 'content-studio alias' };
    if (verdict.ok) relevant.push(r);
    // The shared release noise filter logs its own drops, so this only covers
    // the event/promotion relevance stage.
    else reject(verdict.reason || 'relevance', r.title);
  }
  if (!detailedRejections) {
    for (const [reason, count] of Object.entries(rejectReasons)) {
      const hidden = count - (loggedReasons[reason] || 0);
      if (hidden > 0) log(label + ' rejection detail sampled', {
        pipeline: label, reason, hidden,
        hint: 'Enable full rejection detail in Logs to show every title',
      });
    }
  }
  const breakdown = Object.entries(rejectReasons)
    .map(([k, v]) => v + ' ' + k).join(' / ') || 'none';
  log(label + ' filter summary', {
    pipeline: label,
    discovered: results.length,
    afterNoise: noise.results.length,
    matched: relevant.length,
    rejected: rejectReasons,
    summary: breakdown,
  });
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
  const resolution = candidateResolution(candidate);
  const sourceTag = detectSource(candidate.title);
  const qualityLine = [resolution, sourceTag].filter(Boolean).join(' ') || 'TorBox';
  const sizeLabel = formatSize(candidate.size);
  const datePart = candidate.publishDate
    ? new Date(candidate.publishDate).toISOString().slice(0, 10) : '';
  // Search aggregators remain source-agnostic, while an operator-enabled
  // direct catalogue is identified so users understand why this curated row
  // differs from ordinary Companion/Prowlarr discoveries.
  const directSource = candidate.source === 'sport-video';
  const metaLine = [
    sizeLabel ? '\u{1F4BE} ' + sizeLabel : '',
    directSource ? 'Sport-Video → TorBox' : 'TorBox',
    datePart,
  ].filter(Boolean).join(' · ');
  return {
    name: '\u{2601}\u{FE0F} ' + (directSource ? 'Sport-Video · TorBox' : 'TorBox') + '\n' + qualityLine,
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
  const resolution = candidateResolution(candidate);
  const sourceTag = detectSource(candidate.title);
  const qualityLine = [resolution, sourceTag].filter(Boolean).join(' ') || 'TorBox';
  const sizeLabel = formatSize(candidate.size);
  const datePart = candidate.publishDate
    ? new Date(candidate.publishDate).toISOString().slice(0, 10) : '';
  const directSource = candidate.source === 'sport-video';
  const metaLine = [
    sizeLabel ? '\u{1F4BE} ' + sizeLabel : '',
    'Check TorBox dashboard, then Refresh Links when complete',
    datePart,
  ].filter(Boolean).join(' · ');
  return {
    name: '\u{1F525} ' + (directSource ? 'Sport-Video → TorBox' : 'Warm to TorBox')
      + '\n' + qualityLine + ' · Refresh Links when ready', // 🔥
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

// Keep generated provider searches compact and useful. Exact-date, concise
// matchup queries outrank broad permutations so UU/Easynews can finish before
// the client response deadline.
// Competition words that appear in a query without saying who is playing.
// Deliberately short: this only has to stop league furniture from splitting one
// spelling into two, so a missing word costs a duplicate query, not a miss.
const QUERY_CHROME = new Set([
  'epl', 'efl', 'premier', 'league', 'english', 'football', 'soccer', 'liga',
  'serie', 'bundesliga', 'ligue', 'eredivisie', 'primeira', 'championship',
  'cup', 'copa', 'coupe', 'uefa', 'fifa', 'champions', 'europa', 'conference',
  'nfl', 'nba', 'wnba', 'mlb', 'nhl', 'ncaa', 'matchday', 'round', 'week',
  'season', 'live', 'full', 'match', 'game', 'replay', 'versus',
]);

// Merge the pipelines' rows with title-based dedupe, PER PIPELINE.
//
// 0.93.3 — the dedupe scope used to be shared, so the first pipeline to produce
// a release title took the slot and every other pipeline's copy was dropped. In
// practice Easynews rows vanished the moment Usenet Ultimate caught up: a real
// request had 3 TorBox + 10 UU + 3 Easynews rows arrive and 11 go out, five
// silently removed. Results appeared to get worse the more the addon found.
//
// Two rows with the same release title from different pipelines are not
// duplicates. They are different ways to play the same file — Easynews streams
// it directly, UU hands an NZB to your debrid, TorBox resolves a torrent — and
// they fail differently, perform differently, and are labelled differently in
// the client. Dropping one removes a working fallback for a release the user
// can already see.
//
// Within a pipeline, deduping is still right: one provider returning the same
// release twice is a duplicate. nzbdav and nntp already set their own scopes
// for exactly this reason, and those still win where present — this
// generalises what they were doing rather than inventing a new rule.
function mergePipelineRows(sets) {
  const seen = new Set();
  const merged = [];
  for (const [pipeline, rows] of sets) {
    for (const row of rows || []) {
      const scope = (row && row._sssDedupeScope) || pipeline;
      const key = row && row.title ? scope + ':' + String(row.title).split('\n')[0] : null;
      if (row && row._sssDedupeScope) delete row._sssDedupeScope;
      if (!key) { merged.push(row); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  return merged;
}

function selectProviderQueries(titles, event, limit, promotion) {
  const date = String(event && event.date || '');
  const dateParts = date.split('-');
  const dmy = dateParts.length === 3 ? dateParts[2] + '.' + dateParts[1] + '.' + dateParts[0] : '';
  const dateForms = date ? [date, date.replace(/-/g, ' '), date.replace(/-/g, '.'), dmy] : [];
  const eventTokens = Array.from(new Set(String(event && event.name || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .match(/[a-z0-9]+/g) || []))
    .filter((token) => !/^(?:vs|v|at|fc|cf|sc|afc|sk|fk|de|the)$/.test(token));
  // Words that are page furniture rather than an identity: stripping them is
  // what makes "EPL Man United vs Ipswich" and "Man United vs Ipswich" count
  // as the same spelling, so they cannot take two slots between them.
  const chrome = new Set();
  for (const phrase of [].concat(
    (promotion && promotion.promotionAliases) || [],
    (promotion && promotion.name) ? [promotion.name] : []
  )) {
    for (const token of String(phrase).toLowerCase().match(/[a-z]+/g) || []) {
      if (token.length > 2) chrome.add(token);
    }
  }

  const scored = Array.from(new Set((titles || []).map((value) => String(value || '').trim()).filter(Boolean)))
    .map((title, index) => {
      const lower = title.toLowerCase();
      const normalized = lower.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      const hasExactDate = dateForms.some((form) => form && lower.includes(form.toLowerCase()));
      let score = hasExactDate ? 100 : 0;
      if (/\b(?:vs\.?|v\.?|@)\b/i.test(title)) score += 20;
      if (/\b(?:19|20)\d{2}\b/.test(title)) score += 10;
      score += eventTokens.filter((token) => new RegExp('\\b' + token + '\\b').test(normalized)).length * 8;
      score += Math.max(0, 20 - Math.floor(title.length / 10));
      // Promotions put their best observed release pattern first. Preserve that
      // deliberate choice instead of allowing the generic brevity bonus to
      // promote a nickname-only query above it (for example "Celts vs LASK").
      if (index === 0 && hasExactDate) score += 1000;
      return { title, index, score };
    })
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length || a.index - b.index);

  // 0.93.1 — spend the slots on DIFFERENT SPELLINGS, not different punctuation.
  //
  // The scorer above optimises for brevity and token overlap, and both favour
  // whichever short name the fixture happens to be titled with. So all four
  // queries that reached Usenet Ultimate for an EPL fixture were
  // "Man United vs Ipswich Town" with the date moved around — effectively one
  // query, repeated. Releases are named "Manchester United", so every one of
  // them missed, and only Sport-Video (which matches against stored titles
  // rather than a search string) returned anything.
  //
  // A provider search is a text match: what buys coverage is the club being
  // spelled a different way, not the separator being a dot instead of a dash.
  // Two shapes per spelling is enough to cover date-order differences; the
  // rest of the budget goes to spellings not yet tried.
  const PER_SPELLING = 2;
  const signature = (title) => {
    const tokens = String(title).toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .match(/[a-z]+/g) || [];
    return tokens
      .filter((token) => token.length > 2 && !QUERY_CHROME.has(token) && !chrome.has(token))
      .sort().join(' ');
  };

  const cap = Math.max(1, limit || 6);
  const seen = new Map();
  const primary = [];
  const overflow = [];
  for (const row of scored) {
    const key = signature(row.title);
    const used = seen.get(key) || 0;
    if (used < PER_SPELLING) { seen.set(key, used + 1); primary.push(row.title); }
    else overflow.push(row.title);
    if (primary.length >= cap) break;
  }
  // Only if the fixture genuinely has fewer spellings than slots.
  return primary.concat(overflow).slice(0, cap);
}

function buildNzbdavDeferredUrl({ origin, userId, apiToken, eventId, candidateId }) {
  const { exp, sig } = urlSign.signResolve({
    userId, provider: 'nzbdav', eventId, infoHash: candidateId,
  });
  return (origin || '') + '/u/' + encodeURIComponent(userId)
    + '/' + encodeURIComponent(apiToken)
    + '/resolve/nzbdav/' + encodeURIComponent(eventId)
    + '/' + encodeURIComponent(candidateId)
    + '?exp=' + encodeURIComponent(exp) + '&sig=' + encodeURIComponent(sig);
}

function buildNzbdavRow(candidate, deferredUrl) {
  const resolution = detectResolution(candidate.title);
  const sourceTag = detectSource(candidate.title);
  const qualityLine = [resolution, sourceTag].filter(Boolean).join(' ') || 'NZB DAV';
  const sizeLabel = formatSize(candidate.size);
  const datePart = candidate.publishedAt
    ? new Date(candidate.publishedAt).toISOString().slice(0, 10) : '';
  const metaLine = [sizeLabel ? '\u{1F4BE} ' + sizeLabel : '',
    candidate.indexer || 'Usenet', 'DIY NZB DAV', datePart].filter(Boolean).join(' · ');
  return {
    name: '\u{1F4E6} DIY Usenet\n' + qualityLine,
    title: candidate.title + (metaLine ? '\n' + metaLine : ''),
    url: deferredUrl,
    behaviorHints: { bingeGroup: 'serioussportsync-nzbdav', notWebReady: false },
    _sssDedupeScope: 'nzbdav',
  };
}

function buildNntpDeferredUrl({ origin, userId, apiToken, eventId, candidateId }) {
  const { exp, sig } = urlSign.signResolve({
    userId, provider: 'nntp', eventId, infoHash: candidateId,
  });
  return (origin || '') + '/u/' + encodeURIComponent(userId)
    + '/' + encodeURIComponent(apiToken)
    + '/resolve/nntp/' + encodeURIComponent(eventId)
    + '/' + encodeURIComponent(candidateId)
    + '?exp=' + encodeURIComponent(exp) + '&sig=' + encodeURIComponent(sig);
}

function buildNntpRow(candidate, deferredUrl) {
  const resolution = detectResolution(candidate.title);
  const sourceTag = detectSource(candidate.title);
  const qualityLine = [resolution, sourceTag].filter(Boolean).join(' ') || 'Native NNTP';
  const sizeLabel = formatSize(candidate.size);
  const datePart = candidate.publishedAt
    ? new Date(candidate.publishedAt).toISOString().slice(0, 10) : '';
  const metaLine = [sizeLabel ? '\u{1F4BE} ' + sizeLabel : '',
    candidate.indexer || 'Usenet', 'Native NNTP preview', datePart].filter(Boolean).join(' · ');
  return {
    name: '\u{26A1} Native NNTP\n' + qualityLine,
    title: candidate.title + (metaLine ? '\n' + metaLine : ''),
    url: deferredUrl,
    behaviorHints: { bingeGroup: 'serioussportsync-nntp', notWebReady: false },
    _sssDedupeScope: 'nntp',
  };
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
async function discoverTorrentCandidates({ promo, event, titles, log, discoveryBudgetMs }) {
  const companionCfg = settings.getCompanion();
  const prowlarrCfg = settings.getProwlarr();
  const sportVideoEnabled = settings.getSportVideo().enabled;
  let direct = [];
  if (sportVideoEnabled) {
    try {
      direct = await sportVideo.candidatesForEvent(event.id, { hydrate: true, limit: 5 });
      log('sport-video: recovered ' + direct.length + ' matched direct candidate(s)');
    } catch (error) {
      log('sport-video: candidate lookup failed: ' + error.message);
    }
  }
  if (!companionCfg.url && !(prowlarrCfg.url && prowlarrCfg.apiKey)) {
    if (!sportVideoEnabled) log('torrent discovery: no companion or direct Prowlarr configured; Sport-Video disabled');
    return direct;
  }
  const index = availabilityIndex(log);
  const scope = torrentDiscoveryScope(index);
  const out = await cachedProviderSearch({
    event, promo, provider: 'torrent', scope, queries: titles, log,
    producer: async () => {
      const tasks = [];
      if (companionCfg.url) {
        tasks.push(companion.scrape({
          promotion: promo, event, searchTitles: titles, log, budgetMs: discoveryBudgetMs,
          throwOnFailure: true,
        }).then((results) => ({ ok: true, results })).catch((err) => {
          log('companion: search failed: ' + err.message);
          return { ok: false, results: [] };
        }));
      }
      if (prowlarrCfg.url && prowlarrCfg.apiKey) {
        log('prowlarr: searching ' + titles.length + ' title variant(s)');
        tasks.push(prowlarr.multiSearch(titles, { log, detailed: true }).catch((err) => {
          log('prowlarr: search failed: ' + err.message);
          return { ok: false, results: [] };
        }));
      }
      const outcomes = await Promise.all(tasks);
      return {
        ok: outcomes.some((outcome) => outcome && outcome.ok),
        error: outcomes.some((outcome) => outcome && outcome.ok)
          ? null : 'all-discovery-sources-failed',
        results: outcomes.flatMap((outcome) => outcome && Array.isArray(outcome.results)
          ? outcome.results : []),
      };
    },
  });
  if (out && out.ok === false) {
    throw new Error(out.error || 'torrent discovery failed');
  }
  const lists = [direct, out.results || []];
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

async function pipelineTorrentTorbox({ promo, event, titles, torboxKey, urlCtx, log, discoveryBudgetMs, allowConfirmed = true }) {
  if (!torboxKey) { log('torbox: no user key — skipping pipeline A'); return []; }

  // 1. Recover confirmed knowledge, but never treat that ready subset as the
  // complete event result. Merge it with the stored/full discovery set so a
  // second candidate that has just finished warming can be promoted too.
  const index = availabilityIndex(log);
  const discoveryScope = torrentDiscoveryScope(index);
  const torboxScope = index
    ? index.scopeFingerprint('torbox', { apiKey: torboxKey }) : 'uncached';
  const recordOutcome = (matchedCount, readyCount) => {
    if (!index) return;
    try {
      index.recordSearchOutcome({
        eventId: event.id, provider: 'torrent', scope: discoveryScope,
        matchedCount, readyCount,
      });
    } catch (error) {
      log('torrent: availability outcome write failed: ' + error.message);
    }
  };
  const confirmed = allowConfirmed ? confirmedCandidates(index, {
    eventId: event.id,
    sourceProvider: 'torrent', sourceScope: discoveryScope,
    availabilityProvider: 'torbox', availabilityScope: torboxScope,
    states: ['cached', 'verified'], limit: MAX_ROWS,
  }, log, 'torbox') : [];
  let discovered = [];
  try {
    discovered = await discoverTorrentCandidates({ promo, event, titles, log, discoveryBudgetMs });
  } catch (error) {
    // A provider outage must not hide a known playable row, but it also must
    // not turn the confirmed subset back into the stored discovery set.
    if (!confirmed.length) throw error;
    log('torrent discovery failed; retaining ' + confirmed.length + ' confirmed candidate(s): ' + error.message);
  }
  const candidates = mergeCandidates(index, confirmed, discovered);
  if (candidates.length === 0) { recordOutcome(0, 0); return []; }

  // 2. Filter + sort (top N).
  const relevant = filterCandidates('torrent', candidates, log, promo, event);
  sortCandidates(relevant, 'size', 'publishDate');
  const top = relevant.slice(0, MAX_ROWS);
  if (top.length === 0) { recordOutcome(0, 0); return []; }

  // 3. Reuse fresh, account-scoped availability observations. Only unknown or
  // stale hashes reach TorBox's read-only cache endpoint.
  const observations = index
    ? index.availabilityFor({ provider: 'torbox', scope: torboxScope, candidates: top })
    : new Map();
  const cachedSet = new Set();
  const knownUnavailable = new Set();
  for (const candidate of top) {
    const observation = index && observations.get(index.releaseId(candidate));
    if (observation && ['cached', 'verified'].includes(observation.state)) cachedSet.add(candidate.infoHash);
    else if (observation && observation.state === 'unavailable') knownUnavailable.add(candidate.infoHash);
  }
  const unknown = top.filter((candidate) =>
    !cachedSet.has(candidate.infoHash) && !knownUnavailable.has(candidate.infoHash));
  if (unknown.length) {
    log('torbox: checking cache for ' + unknown.length + ' unknown/stale hash(es)');
    const checked = await torbox.checkCachedBatch(unknown.map((c) => c.infoHash), torboxKey, log);
    for (const candidate of unknown) {
      const isCached = checked.has(candidate.infoHash);
      if (isCached) cachedSet.add(candidate.infoHash);
      else knownUnavailable.add(candidate.infoHash);
      if (index) {
        const previous = observations.get(index.releaseId(candidate));
        index.observe({
          provider: 'torbox', scope: torboxScope,
          // A refresh immediately after submission often happens before TorBox
          // finishes. Preserve the refreshable warming state until it becomes
          // cached instead of recreating the 30-minute negative observation.
          state: isCached ? 'cached'
            : (previous && previous.state === 'warming' ? 'warming' : 'unavailable'),
          candidate,
        });
      }
    }
  } else {
    log('torbox: availability-index covered all ' + top.length + ' hash(es)');
  }
  log('torbox: ' + cachedSet.size + ' cached / ' + knownUnavailable.size + ' uncached');
  recordOutcome(relevant.length, cachedSet.size);
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
async function pipelineEasynews({ promo, event, titles, easynewsCreds, urlCtx, log, budgetMs }) {
  if (!easynewsCreds || !easynewsCreds.username || !easynewsCreds.password) {
    log('easynews: no user creds — skipping pipeline C');
    return [];
  }
  const index = availabilityIndex(log);
  const scope = index ? index.scopeFingerprint('easynews', easynewsCreds) : 'uncached';
  const confirmed = confirmedCandidates(index, {
    eventId: event.id,
    sourceProvider: 'easynews', sourceScope: scope,
    availabilityProvider: 'easynews', availabilityScope: scope,
    states: ['verified'], limit: MAX_ROWS,
  }, log, 'easynews');
  let out = { ok: true, results: [] };
  if (!confirmed.length) {
    try {
      out = await cachedProviderSearch({
        event, promo, provider: 'easynews', scope, queries: titles, log,
        producer: () => {
          log('easynews: searching ' + titles.length + ' title variant(s)');
          return easynews.multiSearch(titles, {
            username: easynewsCreds.username,
            password: easynewsCreds.password,
            log,
            maxQueries: 4,
            timeoutMs: 2500,
            totalTimeoutMs: Math.max(1000, (Number(budgetMs) || 7500) - 1500),
            queryDelayMs: 150,
          });
        },
      });
    } catch (err) {
      log('easynews: multiSearch threw: ' + err.message);
      out = { ok: false, results: [] };
    }
  }
  const candidates = mergeCandidates(index, confirmed, out && out.results);
  if (candidates.length === 0) return [];
  const relevant = filterCandidates('easynews', candidates, log, promo, event);
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

// SSS owns event title generation, relevance, ranking, and cross-source
// deduplication. UU and the native indexer client are interchangeable inputs.
function finalizeUsenetCandidates(label, candidates, promo, event, log) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.title || !candidate.nzbUrl) continue;
    const key = candidate.nzbUrl + '|' + candidate.title.toLowerCase() + '|'
      + (Number(candidate.size) || 0);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  const relevant = filterCandidates(label, unique, log, promo, event);
  relevant.sort((a, b) => {
    const rb = resRank(b.title) - resRank(a.title);
    if (rb !== 0) return rb;
    const sb = (Number(b.size) || 0) - (Number(a.size) || 0);
    if (sb !== 0) return sb;
    return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
  });
  const kept = relevant.slice(0, MAX_ROWS);
  // 0.90.5 — name what was ACCEPTED, not only what was rejected.
  //
  // The filter summary reported "discovered=4 matched=4" and the rejection log
  // printed every refused title, so a log could prove which releases SSS threw
  // away and could not prove which four it kept. Answering "is it finding the
  // release I can see on my own indexer?" meant guessing. The titles are the
  // whole answer, so log them.
  for (const candidate of kept) {
    log(label + ': accepted ' + candidate.title
      + (candidate.indexer ? ' [' + candidate.indexer + ']' : ''));
  }
  return kept;
}

async function pipelineUsenetUltimate({ event, uuConfig, getUsenetCandidates, log }) {
  if (!uuConfig) { log('uu: not configured - skipping pipeline B'); return []; }
  return uu.buildStreamRows(await getUsenetCandidates(), uuConfig, event.name);
}

async function pipelineNzbdav({ event, config, getUsenetCandidates, getConfirmedCandidates, urlCtx, log }) {
  if (!nzbdavPlayback.isConfigured(config)) {
    log('nzbdav: DIY provider disabled or incomplete - skipping');
    return [];
  }
  const rows = [];
  const confirmed = getConfirmedCandidates ? getConfirmedCandidates('nzbdav') : [];
  const candidates = mergeCandidates(availabilityIndex(log), confirmed,
    confirmed.length ? [] : await getUsenetCandidates());
  for (const candidate of candidates) {
    if (!candidate || !candidate.nzbUrl || !candidate.title) continue;
    const stored = playbackCandidates.put({
      userId: urlCtx.userId, eventId: event.id, provider: 'nzbdav',
      payload: { nzbUrl: candidate.nzbUrl, title: candidate.title, category: 'sports' },
    });
    rows.push(buildNzbdavRow(candidate, buildNzbdavDeferredUrl({
      origin: urlCtx.origin, userId: urlCtx.userId, apiToken: urlCtx.apiToken,
      eventId: event.id, candidateId: stored.id,
    })));
  }
  log('nzbdav: built ' + rows.length + ' opaque deferred row(s)');
  return rows;
}

async function pipelineNativeNntp({ event, config, getUsenetCandidates, getConfirmedCandidates, urlCtx, log }) {
  if (!nntpPlayback.isConfigured(config)) {
    log('nntp: native provider disabled or incomplete - skipping');
    return [];
  }
  const rows = [];
  const confirmed = getConfirmedCandidates ? getConfirmedCandidates('nntp') : [];
  const candidates = mergeCandidates(availabilityIndex(log), confirmed,
    confirmed.length ? [] : await getUsenetCandidates());
  for (const candidate of candidates) {
    if (!candidate || !candidate.nzbUrl || !candidate.title) continue;
    const stored = playbackCandidates.put({
      userId: urlCtx.userId, eventId: event.id, provider: 'nntp',
      payload: { nzbUrl: candidate.nzbUrl, title: candidate.title },
    });
    rows.push(buildNntpRow(candidate, buildNntpDeferredUrl({
      origin: urlCtx.origin, userId: urlCtx.userId, apiToken: urlCtx.apiToken,
      eventId: event.id, candidateId: stored.id,
    })));
  }
  log('nntp: built ' + rows.length + ' opaque deferred preview row(s)');
  return rows;
}

// Selective background preparation. It only runs the provider groups enabled
// on the Database page and never creates playback candidates, submits NZBs or
// resolves content. All other providers retain their database-backed on-demand
// cache, so disabling preparation does not disable normal playback.
async function prefetchAvailability(params) {
  const input = params || {};
  const event = input.event || store.getEvent(input.eventId);
  if (!event) return { ok: false, errors: ['event-not-found'], providers: [] };
  const promo = getByEventId(event.id);
  if (!promo || typeof promo.searchTitles !== 'function') {
    return { ok: false, errors: ['promotion-not-found'], providers: [] };
  }
  const titles = Array.from(new Set([].concat(promo.searchTitles(event) || []).filter(Boolean)));
  if (!titles.length) return { ok: false, errors: ['no-search-titles'], providers: [] };
  const torrentTitles = typeof promo.torrentSearchTitles === 'function'
    ? Array.from(new Set([].concat(promo.torrentSearchTitles(event) || []).filter(Boolean)))
    : titles;
  const providerTitles = selectProviderQueries(titles, event, promo.uuMaxQueries || 6, promo);
  const userConfig = input.userConfig || {};
  const tag = input.username ? ' ' + String(input.username).replace(/[^A-Za-z0-9_.-]/g, '') : '';
  const log = input.log || ((message) => console.log('[availability warm' + tag + '] ' + message));
  const disabled = new Set(Array.isArray(promo.disabledPipelines)
    ? promo.disabledPipelines.map((value) => String(value || '').toLowerCase().trim()) : []);
  if (disabled.has('newsnab')) disabled.add('uu');
  if (userConfig.torboxEnabled === false) disabled.add('torbox');
  if (userConfig.uuEnabled === false) disabled.add('uu');
  if (userConfig.easynewsEnabled === false) disabled.add('easynews');
  // 0.90.4 — 25s, up from 15s. Nothing waits on this path: it runs after the
  // stream response has already gone out, or on the warmer's own schedule, and
  // its whole job is to be the slow-and-thorough counterpart to the live
  // budget. A real Usenet Ultimate instance fanning out to several indexers
  // measured 14.8s on a good run and lost to the old ceiling by 600ms on a
  // worse one — so the backfill built to rescue slow sources was itself timing
  // out against the very sources it exists for.
  const discoveryBudgetMs = Math.max(1000,
    parseInt(process.env.AVAILABILITY_WARM_PROVIDER_TIMEOUT_MS || '25000', 10) || 25000);
  const tasks = [];
  const skipProviders = new Set([].concat(input.skipProviders || [])
    .map((value) => String(value || '').toLowerCase().trim()).filter(Boolean));
  const prepare = input.prepare || settings.getAvailabilityWarm();
  function addTask(provider, promise) {
    const startedAt = Date.now();
    tasks.push({ provider, startedAt, promise });
  }

  const companionCfg = settings.getCompanion();
  const prowlarrCfg = settings.getProwlarr();
  const torrentConfigured = Boolean(companionCfg.url || (prowlarrCfg.url && prowlarrCfg.apiKey)
    || settings.getSportVideo().enabled);
  if (prepare.prepareTorrent !== false && torrentConfigured
      && !disabled.has('torbox') && !skipProviders.has('torrent')) {
    const torboxKey = String(userConfig.torboxApiKey || '').trim();
    addTask('torrent', torboxKey
        ? pipelineTorrentTorbox({
          promo, event, titles: torrentTitles, torboxKey, discoveryBudgetMs, log,
          allowConfirmed: false,
          urlCtx: { origin: 'http://localhost', userId: 'warm', apiToken: 'warm', showWarmRows: false },
        })
        : discoverTorrentCandidates({ promo, event, titles: torrentTitles, log, discoveryBudgetMs }));
  }

  const uuManifest = String(userConfig.uuManifestUrl || '').trim();
  const uuConfig = uuManifest ? uu.parseManifestUrl(uuManifest) : null;
  const diyUsesUu = userConfig.diyUuSearchEnabled !== false
    && (nzbdavPlayback.isConfigured(nzbdavPlayback.providerConfig(userConfig))
      || nntpPlayback.isConfigured(nntpPlayback.providerConfig(userConfig)));
  if (prepare.prepareUsenet === true && uuConfig && !skipProviders.has('uu')
      && (!disabled.has('uu') || (!disabled.has('diy-usenet') && diyUsesUu))) {
    const index = availabilityIndex(log);
    const scope = index ? index.scopeFingerprint('uu', uuConfig) : 'uncached';
    addTask('uu', cachedProviderSearch({
      event, promo, provider: 'uu', scope, queries: providerTitles, log,
      producer: () => uu.search(providerTitles, uuConfig, {
        log, maxQueries: promo.uuMaxQueries, timeoutMs: discoveryBudgetMs,
      }),
    }));
  }

  const nativeConfig = usenetIndexer.providerConfig(userConfig);
  if (prepare.prepareUsenet === true && !disabled.has('diy-usenet') && !skipProviders.has('native-indexer')
      && usenetIndexer.isConfigured(nativeConfig)) {
    const index = availabilityIndex(log);
    const scope = index ? index.scopeFingerprint('native-indexer', nativeConfig) : 'uncached';
    addTask('native-indexer', cachedProviderSearch({
      event, promo, provider: 'native-indexer', scope, queries: providerTitles, log,
      producer: () => usenetIndexer.search(providerTitles, nativeConfig, {
        log, maxQueries: promo.uuMaxQueries, timeoutMs: discoveryBudgetMs,
      }),
    }));
  }

  const easynewsCreds = userConfig.easynewsUsername && userConfig.easynewsPassword
    ? { username: String(userConfig.easynewsUsername).trim(), password: userConfig.easynewsPassword }
    : null;
  if (prepare.prepareEasynews === true && !disabled.has('easynews') && !skipProviders.has('easynews')
      && easynewsCreds && easynewsCreds.username) {
    const index = availabilityIndex(log);
    const scope = index ? index.scopeFingerprint('easynews', easynewsCreds) : 'uncached';
    addTask('easynews', cachedProviderSearch({
      event, promo, provider: 'easynews', scope, queries: providerTitles, log,
      producer: () => easynews.multiSearch(providerTitles, Object.assign({
        log, maxQueries: 6, timeoutMs: 3000, totalTimeoutMs: discoveryBudgetMs, queryDelayMs: 150,
      }, easynewsCreds)),
    }));
  }

  const settled = await Promise.allSettled(tasks.map((task) => task.promise));
  const errors = [];
  const outcomes = [];
  settled.forEach((result, index) => {
    const task = tasks[index];
    const durationMs = Math.max(0, Date.now() - task.startedAt);
    if (result.status === 'rejected') {
      const error = result.reason && result.reason.message || String(result.reason || 'search-failed');
      errors.push(task.provider + ': ' + error);
      outcomes.push({ provider: task.provider, ok: false, error, durationMs });
    } else if (result.value && result.value.ok === false) {
      const error = String(result.value.error || 'search-failed');
      errors.push(task.provider + ': ' + error);
      outcomes.push({ provider: task.provider, ok: false, error, durationMs });
    } else {
      outcomes.push({ provider: task.provider, ok: true, durationMs });
    }
  });
  return {
    ok: errors.length === 0,
    errors,
    providers: tasks.map((task) => task.provider),
    outcomes,
    skippedProviders: Array.from(skipProviders),
  };
}

async function handleStream(params) {
  const log = makeLogger(params);
  const requestStartedAt = Date.now();
  const id = params.id;
  if (params.type !== 'movie' || !id || !id.includes(':')) {
    return { streams: [] };
  }

  // Read the composed event so Content Studio overrides and search aliases
  // affect playback exactly as they affect catalog/meta responses.
  const event = store.getEvent(id);
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
  const torrentTitles = (typeof promo.torrentSearchTitles === 'function')
    ? Array.from(new Set([].concat(promo.torrentSearchTitles(event) || []).filter(Boolean)))
    : titles;
  const providerTitles = selectProviderQueries(titles, event, promo.uuMaxQueries || 6, promo);

  const userConfig = params.userConfig || {};
  const torboxKey = (userConfig.torboxApiKey || '').trim();
  const uuManifest = (userConfig.uuManifestUrl || '').trim();
  const uuConfig = uuManifest ? uu.parseManifestUrl(uuManifest) : null;
  const nzbdavConfig = nzbdavPlayback.providerConfig(userConfig);
  const nntpConfig = nntpPlayback.providerConfig(userConfig);
  const nativeUsenetConfig = usenetIndexer.providerConfig(userConfig);
  // 0.34.0: Pipeline C credentials (Easynews). Per-user only — no admin
  // config. If either field is blank, the pipeline self-skips.
  const easynewsUser = (userConfig.easynewsUsername || '').trim();
  const easynewsPass = userConfig.easynewsPassword || '';
  const easynewsCreds = (easynewsUser && easynewsPass)
    ? { username: easynewsUser, password: easynewsPass } : null;

  log.info('stream request started', {
    eventTitle: event.name,
    promotion: promo.id,
    queryVariants: titles,
    torrentQueryVariants: torrentTitles,
    configured: {
      torbox: Boolean(torboxKey),
      usenetUltimate: Boolean(uuConfig),
      nativeIndexer: usenetIndexer.isConfigured(nativeUsenetConfig),
      sportVideo: settings.getSportVideo().enabled,
      nzbdav: nzbdavPlayback.isConfigured(nzbdavConfig),
      nativeNntp: nntpPlayback.isConfigured(nntpConfig),
      easynews: Boolean(easynewsCreds),
    },
  });

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
  // pipeline in a race against STREAM_PIPELINE_TIMEOUT_MS and let whichever
  // finished by then contribute rows. Slow pipelines just log a timeout
  // warning and return zero — the client still gets fast results.
  //
  // 0.93.2 — 9500ms, up from 8000. Usenet Ultimate fans out across several
  // indexers and some sports take it past the old ceiling; at 8000 it got
  // 7500ms and timed out repeatedly. It now gets 9000ms.
  //
  // NOT 10000, and this is the constraint worth stating plainly: the ceiling
  // is the client's patience, not ours. The response still has to merge,
  // dedupe and serialise after the slowest pipeline returns, so a 10s budget
  // means answering at about 10.1s — past the point Nuvio gives up, which
  // turns "some rows" into no rows at all. 9500 leaves that headroom.
  //
  // The real answer for a provider that needs longer is the demand-driven
  // backfill added in 0.90.3: a live search that runs out of budget schedules
  // one at the 25s background budget, and the next request is served from the
  // availability index in milliseconds. Raising the live budget buys one
  // slow provider a little more room; the backfill is what makes a
  // consistently slow one work at all.
  //
  // `params.budgetMs` lets a caller with no client waiting on it — the
  // install check on Configure — ask for a generous budget instead.
  const budgetMs = Number(params.budgetMs)
    || parseInt(process.env.STREAM_PIPELINE_TIMEOUT_MS || '9500', 10);
  // Discovery must finish before the pipeline deadline so relevance filtering,
  // dedupe and TorBox's cache check still have time to complete.
  const discoveryBudgetMs = Math.max(1000, Math.min(
    parseInt(process.env.STREAM_DISCOVERY_BUDGET_MS || '5000', 10),
    budgetMs - 1000));
  function budgeted(name, promise) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log.warn('pipeline timed out', { pipeline: name, durationMs: budgetMs, rows: 0 });
        resolve([]);
      }, budgetMs);
      Promise.resolve(promise)
        .then((rows) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          log.debug('pipeline completed', {
            pipeline: name, durationMs: Date.now() - startedAt,
            rows: Array.isArray(rows) ? rows.length : 0,
          });
          resolve(rows);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          log.error('pipeline failed', {
            pipeline: name, durationMs: Date.now() - startedAt,
            error: err && err.message || String(err),
          });
          resolve([]);
        });
    });
  }

  // 0.42.0 — per-promotion pipeline toggles. `promo.disabledPipelines` is
  // an array of pipeline names ('torbox' | 'uu' | 'easynews') that
  // should be skipped for events from this promotion. Lets an operator
  // disable the slow-and-useless-here TorBox pipeline for football events
  // where UU carries all the water.
  const disabled = new Set((promo && Array.isArray(promo.disabledPipelines))
    ? promo.disabledPipelines.map((s) => String(s || '').toLowerCase().trim())
    : []);
  if (disabled.has('newsnab')) disabled.add('uu');
  if (userConfig.torboxEnabled === false) disabled.add('torbox');
  if (userConfig.uuEnabled === false) disabled.add('uu');
  if (userConfig.easynewsEnabled === false) disabled.add('easynews');
  function runOrSkip(name, factory) {
    if (disabled.has(name)) {
      log('pipeline ' + name + ' disabled by account or promotion — skipping');
      return Promise.resolve([]);
    }
    return budgeted(name, factory());
  }

  let uuSearchPromise = null;
  const getUuSearch = () => {
    if (!uuSearchPromise) {
      if (!uuConfig) uuSearchPromise = Promise.resolve({ ok: false, error: 'not-configured', results: [] });
      else {
        const index = availabilityIndex(log);
        const scope = index ? index.scopeFingerprint('uu', uuConfig) : 'uncached';
        uuSearchPromise = cachedProviderSearch({
          event, promo, provider: 'uu', scope, queries: providerTitles, log,
          producer: () => uu.search(providerTitles, uuConfig, {
            log, maxQueries: promo && promo.uuMaxQueries,
            timeoutMs: Math.max(1000, budgetMs - 500),
          }),
        }).then((out) => {
          if (isBudgetFailure(out)) scheduleUsenetBackfill({ event, userConfig, username: params.username, log });
          return out;
        });
      }
    }
    return uuSearchPromise;
  };
  let uuCandidatesPromise = null;
  const getUuCandidates = () => {
    if (!uuCandidatesPromise) {
      uuCandidatesPromise = getUuSearch().then((out) => finalizeUsenetCandidates(
        'uu', out && out.results, promo, event, log));
    }
    return uuCandidatesPromise;
  };
  let diyCandidatesPromise = null;
  const getDiyCandidates = () => {
    if (!diyCandidatesPromise) diyCandidatesPromise = (async () => {
      const searches = [];
      if (usenetIndexer.isConfigured(nativeUsenetConfig)) {
        const index = availabilityIndex(log);
        const scope = index
          ? index.scopeFingerprint('native-indexer', nativeUsenetConfig) : 'uncached';
        searches.push(cachedProviderSearch({
          event, promo, provider: 'native-indexer', scope, queries: providerTitles, log,
          producer: () => usenetIndexer.search(providerTitles, nativeUsenetConfig, {
            log, maxQueries: promo && promo.uuMaxQueries,
            timeoutMs: Math.max(500, discoveryBudgetMs),
          }),
        }).then((out) => {
          if (isBudgetFailure(out)) scheduleUsenetBackfill({ event, userConfig, username: params.username, log });
          return out;
        }));
      }
      if (userConfig.diyUuSearchEnabled !== false && uuConfig) searches.push(getUuSearch());
      if (!searches.length) {
        log('diy-usenet: no native or UU search source configured');
        return [];
      }
      const outputs = await Promise.all(searches);
      return finalizeUsenetCandidates('diy-usenet',
        outputs.flatMap((out) => out && Array.isArray(out.results) ? out.results : []),
        promo, event, log);
    })();
    return diyCandidatesPromise;
  };
  const diyConfirmed = new Map();
  const getDiyConfirmed = (playbackProvider) => {
    if (diyConfirmed.has(playbackProvider)) return diyConfirmed.get(playbackProvider);
    const index = availabilityIndex(log);
    if (!index || !shouldServeConfirmed()) { diyConfirmed.set(playbackProvider, []); return []; }
    const availabilityScope = playbackProvider === 'nzbdav'
      ? nzbdavAvailabilityScope(index, nzbdavConfig)
      : nntpAvailabilityScope(index, nntpConfig);
    let recovered = [];
    if (usenetIndexer.isConfigured(nativeUsenetConfig)) {
      const sourceScope = index.scopeFingerprint('native-indexer', nativeUsenetConfig);
      recovered = recovered.concat(confirmedCandidates(index, {
        eventId: event.id,
        sourceProvider: 'native-indexer', sourceScope,
        availabilityProvider: playbackProvider, availabilityScope,
        states: ['verified'], limit: MAX_ROWS,
      }, log, playbackProvider + '/native-indexer'));
    }
    if (userConfig.diyUuSearchEnabled !== false && uuConfig) {
      const sourceScope = index.scopeFingerprint('uu', uuConfig);
      recovered = recovered.concat(confirmedCandidates(index, {
        eventId: event.id,
        sourceProvider: 'uu', sourceScope,
        availabilityProvider: playbackProvider, availabilityScope,
        states: ['verified'], limit: MAX_ROWS,
      }, log, playbackProvider + '/uu'));
    }
    const filtered = finalizeUsenetCandidates('diy-usenet', recovered, promo, event, log);
    diyConfirmed.set(playbackProvider, filtered);
    return filtered;
  };
  const [torboxRows, uuRows, nzbdavRows, nntpRows, easynewsRows] = await Promise.all([
    runOrSkip('torbox',   () => pipelineTorrentTorbox({ promo, event, titles: torrentTitles, torboxKey, urlCtx, log, discoveryBudgetMs })),
    runOrSkip('uu',       () => pipelineUsenetUltimate({ event, uuConfig, getUsenetCandidates: getUuCandidates, log })),
    runOrSkip('diy-usenet', () => pipelineNzbdav({ event, config: nzbdavConfig, getUsenetCandidates: getDiyCandidates, getConfirmedCandidates: getDiyConfirmed, urlCtx, log })),
    runOrSkip('native-nntp', () => pipelineNativeNntp({ event, config: nntpConfig, getUsenetCandidates: getDiyCandidates, getConfirmedCandidates: getDiyConfirmed, urlCtx, log })),
    runOrSkip('easynews', () => pipelineEasynews({
      promo, event, titles: providerTitles, easynewsCreds, urlCtx, log, budgetMs,
    })),
  ]);

  const merged = mergePipelineRows([
    ['torbox', torboxRows], ['uu', uuRows], ['nzbdav', nzbdavRows],
    ['nntp', nntpRows], ['easynews', easynewsRows],
  ]);

  log.info('stream request complete', {
    durationMs: Date.now() - requestStartedAt,
    rows: merged.length,
    pipelineRows: {
      torbox: torboxRows.length,
      usenetUltimate: uuRows.length,
      nzbdav: nzbdavRows.length,
      nativeNntp: nntpRows.length,
      easynews: easynewsRows.length,
    },
  });
  // 0.93.1 — report which pipeline produced what.
  //
  // The install check used to work this out by pattern-matching each row's
  // display name, which is a guess about presentation rather than a fact about
  // provenance: a row whose label changed, or a TorBox row fed by Sport-Video,
  // lands in the wrong bucket or none at all — and the check then reports
  // "nothing found" for a pipeline that answered. handleStream already knows
  // exactly where every row came from, so it says so.
  return {
    streams: merged,
    pipelineRows: {
      torbox: torboxRows.length,
      uu: uuRows.length,
      nzbdav: nzbdavRows.length,
      nativeNntp: nntpRows.length,
      easynews: easynewsRows.length,
      total: merged.length,
    },
  };
}

function makeLogger(params) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const username = params.username || '';
  const tag = '[stream' + (username ? ' u=' + username : '') + ' rid=' + requestId + ']';
  const base = { module: 'stream', requestId, eventId: params.id, user: username || undefined };
  const emit = (level, message, fields) => {
    const method = typeof console[level] === 'function' ? level : 'log';
    console[method](tag + ' ' + message, Object.assign({}, base, fields || {}));
  };
  const logger = (message, fields) => emit('debug', message, fields);
  logger.trace = (message, fields) => emit('trace', message, fields);
  logger.debug = (message, fields) => emit('debug', message, fields);
  logger.info = (message, fields) => emit('info', message, fields);
  logger.warn = (message, fields) => emit('warn', message, fields);
  logger.error = (message, fields) => emit('error', message, fields);
  logger.requestId = requestId;
  return logger;
}

// Play-time resolution — called from addon.js's /u/:userId/:apiToken/
// resolve/:provider/:eventId/:infoHash route, but only AFTER lib/url-sign
// has verified the signature + TTL on the URL the client just hit. This
// is the ONLY place the metadata addon ever calls TorBox createTorrent +
// requestdl — /stream is read-only against the user's debrid account.
//
// Returns { url } on success (caller 302-redirects), { ok: false, error }
// otherwise (caller 404/502s).
async function resolvePlay({ providerCode, eventId, infoHash, creds, username, userId }) {
  const tag = '[resolve' + (username ? ' ' + username : '') + ']';
  const log = (msg) => console.log(tag + ' ' + msg);
  const provider = String(providerCode || '').toLowerCase();

  if (provider === 'easynews') {
    return resolveEasynews({ eventId, token: infoHash, creds, log });
  }
  if (provider === 'nzbdav') {
    return resolveNzbdav({ eventId, infoHash, creds, userId, log });
  }
  if (provider === 'nntp') {
    return resolveNativeNntp({ eventId, infoHash, creds, userId, log });
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
  const index = availabilityIndex(log);
  const torboxScope = index
    ? index.scopeFingerprint('torbox', { apiKey: torboxKey }) : 'uncached';
  const torboxCandidate = { infoHash: hash };
  log('resolving ' + eventId + ' ' + hash);

  // Defensive re-check of cache state — TorBox might have evicted the hash
  // between /stream and the user clicking Play. Cheaper than waking
  // createTorrent for an uncached hash.
  const cachedSet = await torbox.checkCachedBatch([hash], torboxKey, log);
  if (!cachedSet.has(hash)) {
    log('hash no longer cached on torbox');
    if (index) index.observe({
      provider: 'torbox', scope: torboxScope, state: 'unavailable', candidate: torboxCandidate,
    });
    return { ok: false, error: 'not-cached' };
  }

  // At play-time we don't have the original magnetTrackers. For a TorBox-
  // cached torrent a hash-only magnet is sufficient — TorBox already has
  // the data, it just needs to identify the torrent.
  const magnet = torbox.buildMagnet(hash);
  const url = await torbox.resolveCached(hash, magnet, torboxKey, log);
  if (!url) {
    log('torbox returned no url');
    if (index) index.observe({
      provider: 'torbox', scope: torboxScope, state: 'failed', candidate: torboxCandidate,
      error: 'resolve-failed',
    });
    return { ok: false, error: 'resolve-failed' };
  }
  if (index) index.observe({
    provider: 'torbox', scope: torboxScope, state: 'verified', candidate: torboxCandidate,
  });
  log('resolved -> ' + url.slice(0, 60) + '...');
  return { ok: true, url };
}

// Submit an uncached TorBox result, or turn an old warm row into playback once
// TorBox reports it ready. Recording `warming` deliberately replaces a stale
// `unavailable` observation: pipelineTorrentTorbox treats that state as due for
// a fresh cache check whenever the client uses Refresh Links.
async function warmTorbox({ eventId, infoHash, creds, username, log: suppliedLog, beforeSubmit }) {
  const tag = '[warm' + (username ? ' u=' + username : '') + ']';
  const log = suppliedLog || ((message) => console.log(tag + ' ' + message));
  const torboxKey = (creds && (creds.torboxApiKey || '')).trim();
  if (!torboxKey) return { ok: false, error: 'no-torbox-key' };
  if (!/^[a-f0-9]{40}$/i.test(String(infoHash || ''))) {
    return { ok: false, error: 'bad-hash' };
  }
  const hash = String(infoHash).toLowerCase();
  const directCandidate = sportVideo.findCandidate(eventId, hash);
  const candidate = directCandidate || { infoHash: hash };
  const index = availabilityIndex(log);
  const scope = index
    ? index.scopeFingerprint('torbox', { apiKey: torboxKey }) : 'uncached';
  const magnet = torbox.buildMagnet(hash, candidate.trackers || []);

  const cached = await torbox.checkCachedBatch([hash], torboxKey, log);
  if (cached.has(hash)) {
    const url = await torbox.resolveCached(hash, magnet, torboxKey, log);
    if (url) {
      if (index) index.observe({ provider: 'torbox', scope, state: 'verified', candidate });
      return { ok: true, ready: true, url };
    }
    // TorBox can briefly expose the hash before its file listing is ready.
    if (index) index.observe({ provider: 'torbox', scope, state: 'warming', candidate });
    log('torbox has the hash but playback is still being prepared');
    return { ok: true, waiting: true };
  }

  const gate = typeof beforeSubmit === 'function' ? beforeSubmit() : { ok: true };
  if (!gate || gate.ok === false) {
    return { ok: false, error: 'rate-limited', retryAfterSec: Number(gate && gate.retryAfterSec) || 1 };
  }
  const torrentId = await torbox.createTorrent(magnet, torboxKey, log);
  if (torrentId == null) return { ok: false, error: 'submit-failed' };
  if (index) index.observe({ provider: 'torbox', scope, state: 'warming', candidate });
  log('queued ' + hash.slice(0, 10) + '… on user TorBox');
  return { ok: true, queued: true, torrentId };
}

async function resolveNzbdav({ eventId, infoHash, creds, userId, log }) {
  const config = nzbdavPlayback.providerConfig(creds);
  if (!nzbdavPlayback.isConfigured(config)) return { ok: false, error: 'not-configured' };
  const found = playbackCandidates.get({ id: infoHash, userId, eventId, provider: 'nzbdav' });
  if (!found.ok) return { ok: false, error: 'candidate-' + found.reason };
  const index = availabilityIndex(log);
  const scope = nzbdavAvailabilityScope(index, config);
  const key = [userId, eventId, infoHash].join('|');
  let pending = NZBDAV_RESOLVES.get(key);
  if (!pending) {
    pending = (async () => {
      const playable = await nzbdavPlayback.resolveCandidate(
        config, found.candidate.payload, { log });
      if (!found.candidate.payload.playback) {
        playbackCandidates.updatePayload({
          id: infoHash, userId, eventId, provider: 'nzbdav',
          update: (payload) => Object.assign({}, payload, {
            playback: { url: playable.url, size: playable.size, jobId: playable.jobId },
          }),
        });
      }
      return playable;
    })();
    NZBDAV_RESOLVES.set(key, pending);
    pending.finally(() => {
      if (NZBDAV_RESOLVES.get(key) === pending) NZBDAV_RESOLVES.delete(key);
    }).catch(() => {});
  }
  try {
    const playable = await pending;
    if (index) index.observe({
      provider: 'nzbdav', scope, state: 'verified', candidate: found.candidate.payload,
    });
    log('resolved DIY NZB DAV candidate');
    return { ok: true, upstream: { url: playable.url, headers: playable.headers || {} } };
  } catch (error) {
    if (index) index.observe({
      provider: 'nzbdav', scope, state: 'failed', candidate: found.candidate.payload,
      error: error && error.code || 'resolve-failed',
    });
    throw error;
  }
}

async function resolveNativeNntp({ eventId, infoHash, creds, userId, log }) {
  const config = nntpPlayback.providerConfig(creds);
  if (!nntpPlayback.isConfigured(config)) return { ok: false, error: 'not-configured' };
  const found = playbackCandidates.get({ id: infoHash, userId, eventId, provider: 'nntp' });
  if (!found.ok) return { ok: false, error: 'candidate-' + found.reason };
  const index = availabilityIndex(log);
  const scope = nntpAvailabilityScope(index, config);
  try {
    const descriptor = await nntpPlayback.resolveCandidate(config, found.candidate.payload, {
      cacheKey: [userId, eventId, infoHash].join('|'), log,
    });
    if (index) index.observe({
      provider: 'nntp', scope, state: 'verified', candidate: found.candidate.payload,
    });
    log('resolved native NNTP candidate');
    return { ok: true, nativeNntp: { descriptor, config } };
  } catch (error) {
    if (index) index.observe({
      provider: 'nntp', scope, state: 'failed', candidate: found.candidate.payload,
      error: error && error.code || 'resolve-failed',
    });
    throw error;
  }
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
  const index = availabilityIndex(log);
  if (index) index.observe({
    provider: 'easynews',
    scope: index.scopeFingerprint('easynews', { username, password }),
    state: 'verified',
    candidate: { postHash: decoded.postHash, title: decoded.postTitle || eventId },
  });
  // Don't log the URL — it carries basic auth. The redact middleware would
  // scrub it on the way to the log buffer, but better not to write it at all.
  log('resolved easynews -> members.easynews.com/' + decoded.dlFarm + '/...');
  return { ok: true, url };
}

module.exports = {
  handleStream,
  prefetchAvailability,
  resolvePlay,
  warmTorbox,
  _test: {
    cachedProviderSearch, discoverTorrentCandidates, pipelineTorrentTorbox, pipelineEasynews,
    mergeCandidates, selectProviderQueries, filterCandidates,
    candidateResolution, sortCandidates, buildTorboxRow, buildWarmRow, mergePipelineRows,
    isBudgetFailure, scheduleUsenetBackfill, USENET_BACKFILL_INFLIGHT,
  },
};
