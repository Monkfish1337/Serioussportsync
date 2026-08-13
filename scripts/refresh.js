#!/usr/bin/env node
// Multi-promotion refresh.

const tsdb = require('../lib/sources/thesportsdb');
const transform = require('../lib/transform');
const store = require('../lib/store');
const promotions = require('../lib/promotions');
const config = require('../config');
const contentStore = require('../lib/content-store');

let wiki = null;
try { wiki = require('../lib/sources/wikipedia'); } catch (e) { wiki = null; }
let onefc = null;
try { onefc = require('../lib/sources/onefc'); } catch (e) { onefc = null; }
let wikiList = null;
try { wikiList = require('../lib/sources/wikipedia-list'); } catch (e) { wikiList = null; }
// 0.38.0: football-data.org parallel source for custom promotions whose
// source.type === 'football-data'. Lazy-required so installs that never use
// it don't pay the require cost on cold start.
let footballData = null;
try { footballData = require('../lib/sources/football-data'); } catch (e) { footballData = null; }
// 0.42.13: TMDB parallel source for TV-style sports shows (Match of the Day,
// ITV highlights, boxing analysis shows) where football-data / TSDB don't
// apply. Same lazy-require pattern as football-data.
let tmdb = null;
try { tmdb = require('../lib/sources/tmdb'); } catch (e) { tmdb = null; }

// Generic asymmetric window. Promotions can override by exposing
// .eventScope(ev) which returns true for events they want kept.
function withinWindow(ev) {
  if (!ev || !ev.date) return false;
  const back = Math.max(0, config.eventWindowDaysBack | 0);
  const ahead = Math.max(0, config.eventWindowDaysAhead | 0);
  if (back === 0 && ahead === 0) return true;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const evDate = new Date(ev.date + 'T00:00:00Z');
  const diffDays = (evDate - today) / (1000 * 60 * 60 * 24);
  if (diffDays >= 0) return diffDays <= ahead;
  return -diffDays <= back;
}

function inScope(ev, promotion) {
  if (promotion && typeof promotion.eventScope === 'function') {
    return promotion.eventScope(ev);
  }
  return withinWindow(ev);
}

function activeSeasons() {
  if (Array.isArray(config.tsdb.seasons) && config.tsdb.seasons.length > 0) return config.tsdb.seasons;
  // Earliest = max(today - EVENT_WINDOW_DAYS_BACK, EVENT_WINDOW_START_DATE).
  // 0.31.1: the daysBack window alone misses everything before
  // (today - daysBack) even when EVENT_WINDOW_START_DATE is older — which
  // meant the 2025-01-01 floor never actually pulled 2025 seasons. Now
  // both bounds participate.
  const back = Math.max(0, config.eventWindowDaysBack | 0);
  const ahead = Math.max(0, config.eventWindowDaysAhead | 0);
  const today = new Date();
  let earliest = new Date(today); earliest.setDate(earliest.getDate() - back);
  // 0.31.1: same default as lib/promotions.js so the env var being unset
  // doesn't silently fall back to a daysBack-only window. Both files should
  // agree on the catalog floor.
  const windowStart = process.env.EVENT_WINDOW_START_DATE || '2025-01-01';
  if (/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) {
    const startDate = new Date(windowStart + 'T00:00:00Z');
    if (startDate < earliest) earliest = startDate;
  }
  const latest = new Date(today); latest.setDate(latest.getDate() + ahead);
  const years = new Set();
  for (let y = earliest.getUTCFullYear(); y <= latest.getUTCFullYear(); y++) years.add(String(y));
  return Array.from(years).sort();
}

// Compute an ISO date for "this many days from today" — used as a hint
// when the source supports it (e.g. wikipedia-list eventStartIso prune).
function isoDaysFromToday(days) {
  const d = new Date(); d.setUTCHours(0,0,0,0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function refreshPromotion(promotion, log) {
  log('==> refreshing ' + promotion.id + ' (' + promotion.name + ')');
  let raw = [];

  if (promotion.source.type === 'thesportsdb') {
    const seasons = activeSeasons();
    log('  TSDB seasons: ' + seasons.join(', '));
    raw = await tsdb.fetchAll({ leagueId: promotion.source.leagueId, seasons, log });
  } else if (promotion.source.type === 'wikipedia') {
    if (!wiki) { log('  wikipedia source unavailable — skipping'); return { ok: true }; }
    raw = await wiki.fetchAll({ pattern: promotion.source.yearPagePattern, promotion, log });
  } else if (promotion.source.type === 'onefc') {
    if (!onefc) { log('  onefc source unavailable — skipping'); return { ok: true }; }
    raw = await onefc.fetchAll({ log });
  } else if (promotion.source.type === 'wikipedia-list') {
    if (!wikiList) { log('  wikipedia-list source unavailable — skipping'); return { ok: true }; }
    // Tell the parser the earliest date we care about so it skips year
    // sections that lie entirely before scope.
    let eventStartIso = null;
    if (typeof promotion.eventScope === 'function') {
      // Simple heuristic — go back 1 year to be safe; the per-event filter
      // in the loop below applies the precise window.
      eventStartIso = isoDaysFromToday(-365);
      // If the eventScope is a Jan-1-of-year style filter, use that exactly.
      const yearStart = new Date().getUTCFullYear() + '-01-01';
      eventStartIso = yearStart;
    }
    raw = await wikiList.fetchAll({
      pageTitle: promotion.source.pageTitle,
      promotion,
      eventStartIso,
      log,
    });
  } else if (promotion.source.type === 'football-data') {
    // 0.38.0: football-data.org parallel source for custom football promotions.
    // 0.38.1: API key now sourced via settings.js (admin-saved /admin field,
    // falls back to FOOTBALL_DATA_API_KEY env var).
    if (!footballData) { log('  football-data module unavailable — skipping'); return { ok: true }; }
    const settings = require('../lib/settings');
    const fd = settings.getFootballData();
    if (!fd.apiKey) {
      log('  football-data: no API key configured (set on /admin or via FOOTBALL_DATA_API_KEY env) — skipping ' + promotion.id);
      return { ok: true };
    }
    const seasons = activeSeasons();
    log('  football-data competition: ' + promotion.source.competitionId + ' seasons: ' + seasons.join(', '));
    raw = await footballData.fetchAll({
      competitionId: promotion.source.competitionId,
      seasons,
      apiKey: fd.apiKey,
      log,
    });
  } else if (promotion.source.type === 'tmdb') {
    // 0.42.13: TMDB TV show. Fetches all episodes with air dates. Each becomes
    // an event whose date drives DARKSPORT-style search title generation.
    if (!tmdb) { log('  tmdb module unavailable - skipping'); return { ok: true }; }
    const tk = (config && config.tmdb && config.tmdb.apiKey) || (process.env.TMDB_API_KEY || '');
    if (!tk) {
      log('  tmdb: no API key configured (set TMDB_API_KEY env) - skipping ' + promotion.id);
      return { ok: true };
    }
    log('  tmdb tvId: ' + promotion.source.tvId);
    raw = await tmdb.fetchAll({
      tvId: promotion.source.tvId,
      apiKey: tk,
      log,
    });
  } else {
    log('  unknown source type: ' + promotion.source.type);
    return { ok: false };
  }
  log('  fetched ' + raw.length + ' raw events from ' + promotion.source.type);
  return raw;
}

async function runRefresh(options) {
  const opts = options || {};
  const log = opts.log || ((m) => console.log(m));

  // 0.41.0 — optional per-promotion refresh. When `promotionId` is set:
  //   1. Events belonging to OTHER promotions are preserved verbatim (no
  //      pruning, no source-mismatch check). We're intentionally not
  //      touching them.
  //   2. Only the target promotion's source is fetched and normalised.
  // Speeds up iteration when tweaking a single promotion's aliases/keywords/
  // templates without paying the cost of refetching every source.
  const targetPromotionId = opts.promotionId ? String(opts.promotionId).trim() : null;

  const scopeLabel = targetPromotionId ? 'promotion "' + targetPromotionId + '"' : 'all promotions';
  log('[refresh] starting refresh (' + scopeLabel + ', window: -' + config.eventWindowDaysBack + ' / +' + config.eventWindowDaysAhead + ' days)');
  const start = Date.now();

  const existing = store.loadFromDisk();
  const byId = new Map();
  let prunedExisting = 0;
  let prunedStaleSource = 0;
  let preservedOther = 0;
  // Prune existing events: drop anything outside scope OR tagged with a
  // source.type that no longer matches the promotion's current source.
  //
  // Two rules:
  //   • TSDB promotions: an event without explicit source.type is kept if
  //     its sourceId is numeric (looks like a TSDB idEvent). Otherwise
  //     it's a stale slug from an old Wikipedia/onefc source — drop.
  //   • Non-TSDB promotions (onefc, wikipedia-list, wikipedia): REQUIRE an
  //     explicit source.type match. Slug-shaped IDs from different
  //     sources can collide (e.g. old `one:one-fight-night-42` from the
  //     Wikipedia year-page parser vs new `one:onefightnight42` from the
  //     onefc API) so we can't tell them apart by ID format — only the
  //     explicit tag is reliable.
  for (const ev of existing.events || []) {
    const p = promotions.getByEventId(ev.id);

    // 0.41.0 — per-promotion refresh: keep every event that ISN'T ours,
    // untouched. No prune, no source-mismatch check. Only the target
    // promotion's events flow through the normal refresh logic below.
    if (targetPromotionId && (!p || p.id !== targetPromotionId)) {
      byId.set(ev.id, ev);
      preservedOther++;
      continue;
    }

    const expectedSourceType = p && p.source && p.source.type;
    const cachedSourceType = ev.source && ev.source.type;

    if (expectedSourceType) {
      let mismatch = false;
      if (expectedSourceType === 'thesportsdb') {
        if (cachedSourceType && cachedSourceType !== 'thesportsdb') mismatch = true;
        if (!cachedSourceType) {
          const sourcePart = ev.id.slice(ev.id.indexOf(':') + 1);
          if (!/^\d+$/.test(sourcePart)) mismatch = true; // slug ID under a TSDB promotion = stale
        }
      } else {
        // Non-TSDB promotion: only keep if explicitly tagged with this exact source.
        if (cachedSourceType !== expectedSourceType) mismatch = true;
      }
      if (mismatch) { prunedStaleSource++; continue; }
    }

    if (inScope(ev, p)) byId.set(ev.id, ev);
    else prunedExisting++;
  }
  if (prunedStaleSource > 0) log('[refresh] pruned ' + prunedStaleSource + ' events from previous source(s)');
  if (prunedExisting > 0) log('[refresh] pruned ' + prunedExisting + ' existing events outside scope');
  if (preservedOther > 0) log('[refresh] preserved ' + preservedOther + ' events from other promotions');

  // 0.41.0 — filter the fetch loop to the target promotion (if any). Missing
  // ID or disabled promotion is a soft-fail: we bail early rather than write
  // out a store that could clobber other promotions' data with nothing.
  let toFetch = promotions.enabled;
  if (targetPromotionId) {
    toFetch = promotions.enabled.filter((p) => p.id === targetPromotionId);
    if (toFetch.length === 0) {
      log('[refresh] no enabled promotion with id "' + targetPromotionId + '" — nothing to do');
      return { ok: false, error: 'promotion "' + targetPromotionId + '" not found or not enabled', total: existing.events ? existing.events.length : 0 };
    }
  }

  let totalAdded = 0, totalUpdated = 0, totalSkipped = 0;
  for (const p of toFetch) {
    let raw;
    try {
      raw = await refreshPromotion(p, log);
    } catch (err) {
      log('  ' + p.id + ' FATAL: ' + err.message);
      continue;
    }
    if (!Array.isArray(raw)) continue;

    const promotionEvents = [];
    let added = 0, updated = 0, skipped = 0;
    for (const r of raw) {
      let norm;
      if (p.source.type === 'thesportsdb') norm = transform.fromTsdb(r, p);
      else if (p.source.type === 'football-data') norm = transform.fromFootballData(r, p);
      else if (p.source.type === 'tmdb') norm = transform.fromTmdb(r, p);
      else if (p.source.type === 'wikipedia' || p.source.type === 'onefc' || p.source.type === 'wikipedia-list') {
        norm = transform.fromWiki(r, p);
      }
      if (!norm) continue;
      // Promotion-level filter (e.g. drop WWE weekly TV, UFC Contender Series).
      if (typeof p.includeEvent === 'function' && !p.includeEvent(norm, config)) {
        contentStore.recordInbox(norm, 'promotion-filter', 'The source returned this event but the promotion filter excluded it.');
        skipped++; continue;
      }
      if (!inScope(norm, p)) { skipped++; continue; }
      const possibleDuplicate = Array.from(byId.values()).find((existingEvent) =>
        existingEvent && existingEvent.id !== norm.id
        && existingEvent.promotion === norm.promotion
        && String(existingEvent.date || '') === String(norm.date || '')
        && String(existingEvent.name || '').toLowerCase() === String(norm.name || '').toLowerCase()
      );
      if (possibleDuplicate) {
        contentStore.recordInbox(norm, 'possible-duplicate', 'Looks like ' + possibleDuplicate.id + '. Review and merge if needed.');
      }
      if (byId.has(norm.id)) updated++;
      else added++;
      byId.set(norm.id, norm);
      promotionEvents.push(norm);
    }
    log('  ' + p.id + ': +' + added + ' new, ~' + updated + ' updated, -' + skipped + ' outside scope');
    totalAdded += added;
    totalUpdated += updated;
    totalSkipped += skipped;

    // 0.31.1: per-promotion synthesis hook. Lets a promotion add derived
    // events that aren't in the source's data — e.g. MotoGP Qualifying,
    // synthesised from Race events because TSDB doesn't catalogue separate
    // qualifying sessions. Synthesised events are skipped if their id
    // already exists (real events always win).
    if (typeof p.expandEvents === 'function') {
      const extras = p.expandEvents(promotionEvents) || [];
      let synth = 0;
      for (const ev of extras) {
        if (!ev || !ev.id || byId.has(ev.id)) continue;
        if (!inScope(ev, p)) continue;
        byId.set(ev.id, ev);
        promotionEvents.push(ev);
        synth++;
      }
      if (synth) log('  ' + p.id + ': +' + synth + ' synthesised event(s)');
      totalAdded += synth;
    }

    // Wikipedia poster backfill for events that lack imagery.
    // 0.31.1: removed the hasSourceDescription leg of the OR — descriptions
    // aren't rendered to clients anymore (see lib/transform.js), so fetching
    // them was pure waste. Halves Wikipedia traffic at minimum, and skips
    // the call entirely for image-complete events.
    // Also gated by WIKIPEDIA_ENRICH env (default on) — set to "off" for
    // fastest possible refresh when you don't care about per-event posters.
    const wikiEnrichOn = (process.env.WIKIPEDIA_ENRICH || 'on').toLowerCase() !== 'off';
    if (wikiEnrichOn && wiki && p.wikipediaTitle && (p.source.type === 'thesportsdb' || p.source.type === 'onefc' || p.source.type === 'wikipedia-list')) {
      const needsArt = promotionEvents.filter((ev) => !ev.hasSourceImage && ev.linkTarget);
      if (needsArt.length > 0) {
        const wikiStart = Date.now();
        log('  ' + p.id + ': backfilling ' + needsArt.length + ' image-less events from Wikipedia');
        try {
          await wiki.enrichWithSummaries(needsArt, log);
          for (const ev of needsArt) byId.set(ev.id, ev);
        } catch (err) {
          log('  ' + p.id + ' Wikipedia backfill failed: ' + err.message);
        }
        log('  ' + p.id + ': wiki took ' + ((Date.now() - wikiStart) / 1000).toFixed(1) + 's');
      }
    } else if (!wikiEnrichOn && p.wikipediaTitle) {
      log('  ' + p.id + ': Wikipedia enrichment disabled (WIKIPEDIA_ENRICH=off)');
    }
  }

  const merged = Array.from(byId.values()).sort((a, b) =>
    (b.date || '').localeCompare(a.date || '')
  );
  store.saveToDisk({ updatedAt: new Date().toISOString(), events: merged });

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  log('[refresh] done in ' + dur + 's — ' + merged.length + ' total (' + totalAdded + ' new, ' + totalUpdated + ' updated, ' + totalSkipped + ' skipped)');
  return { ok: true, total: merged.length, added: totalAdded, updated: totalUpdated };
}

if (require.main === module) {
  runRefresh().then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = { runRefresh };
