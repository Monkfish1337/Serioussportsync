#!/usr/bin/env node
// Multi-promotion refresh.

const tsdb = require('../lib/sources/thesportsdb');
const transform = require('../lib/transform');
const store = require('../lib/store');
const promotions = require('../lib/promotions');
const config = require('../config');

let wiki = null;
try { wiki = require('../lib/sources/wikipedia'); } catch (e) { wiki = null; }
let onefc = null;
try { onefc = require('../lib/sources/onefc'); } catch (e) { onefc = null; }
let wikiList = null;
try { wikiList = require('../lib/sources/wikipedia-list'); } catch (e) { wikiList = null; }

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
  const back = Math.max(0, config.eventWindowDaysBack | 0);
  const ahead = Math.max(0, config.eventWindowDaysAhead | 0);
  const today = new Date();
  const earliest = new Date(today); earliest.setDate(earliest.getDate() - back);
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
  log('[refresh] starting multi-promotion refresh (default window: -' + config.eventWindowDaysBack + ' / +' + config.eventWindowDaysAhead + ' days)');
  const start = Date.now();

  const existing = store.loadFromDisk();
  const byId = new Map();
  let prunedExisting = 0;
  let prunedStaleSource = 0;
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

  let totalAdded = 0, totalUpdated = 0, totalSkipped = 0;
  for (const p of promotions.enabled) {
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
      else if (p.source.type === 'wikipedia' || p.source.type === 'onefc' || p.source.type === 'wikipedia-list') {
        norm = transform.fromWiki(r, p);
      }
      if (!norm) continue;
      // Promotion-level filter (e.g. drop WWE weekly TV, UFC Contender Series).
      if (typeof p.includeEvent === 'function' && !p.includeEvent(norm, config)) {
        skipped++; continue;
      }
      if (!inScope(norm, p)) { skipped++; continue; }
      if (byId.has(norm.id)) updated++;
      else added++;
      byId.set(norm.id, norm);
      promotionEvents.push(norm);
    }
    log('  ' + p.id + ': +' + added + ' new, ~' + updated + ' updated, -' + skipped + ' outside scope');
    totalAdded += added;
    totalUpdated += updated;
    totalSkipped += skipped;

    // Wikipedia poster/description backfill for events that lack imagery.
    if (wiki && p.wikipediaTitle && (p.source.type === 'thesportsdb' || p.source.type === 'onefc' || p.source.type === 'wikipedia-list')) {
      const needsArt = promotionEvents.filter((ev) =>
        (!ev.hasSourceImage || !ev.hasSourceDescription) && ev.linkTarget
      );
      if (needsArt.length > 0) {
        log('  ' + p.id + ': backfilling ' + needsArt.length + ' events from Wikipedia');
        try {
          await wiki.enrichWithSummaries(needsArt, log);
          for (const ev of needsArt) byId.set(ev.id, ev);
        } catch (err) {
          log('  ' + p.id + ' Wikipedia backfill failed: ' + err.message);
        }
      }
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
