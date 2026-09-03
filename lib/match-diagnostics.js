'use strict';

// Why a catalog event did or did not pick up a Sport-Video release.
//
// The console can say a release is unmatched, but not *why* — and "why" is the
// only thing that tells you whether to add an alias, relax an exclusion, or
// accept that the release genuinely is not on the site. This module replays
// the matching decision for every event and every release within a day of it,
// keeping each rejection reason instead of discarding it, and flattens the
// result to something a spreadsheet can sort.
//
// It is read-only: no network calls, no TorBox lookups, no state writes.

const store = require('./store');
const promotions = require('./promotions');
const sportVideo = require('./sources/sport-video');
const releaseFilter = require('./sources/release-filter');

const MAX_SEARCH_TITLES = 12;
const MAX_CANDIDATES_PER_EVENT = 25;

function dayNumber(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 86400000) : null;
}

function safeCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

// One title form's verdict, as a short stable string. `ok` means this form
// alone would have satisfied the promotion.
function verdictFor(promotion, title, event) {
  if (!title) return { ok: false, reason: 'no-title' };
  try {
    const verdict = promotion.isRelevantStreamTitle(title, event);
    return { ok: !!(verdict && verdict.ok), reason: (verdict && verdict.reason) || (verdict && verdict.ok ? 'ok' : 'unknown') };
  } catch (error) {
    return { ok: false, reason: 'threw:' + String(error.message || error).slice(0, 60) };
  }
}

// Replays lib/sources/sport-video.js matchRelease for one pair, keeping the
// intermediate reasons. Order matches the real path exactly: shared release
// filter, then per-event exclusions, then promotion relevance on either title
// form.
function explain(promotion, event, record) {
  const noiseReason = releaseFilter.rejectionReason(record.title, null, {
    allowForeignLanguage: !!promotion.allowForeignLanguage,
  });
  if (noiseReason) {
    return { decision: 'rejected', stage: 'release-filter', reason: noiseReason };
  }
  const blocked = (event.excludePatterns || []).find((pattern) => {
    try { return new RegExp(pattern, 'i').test(record.title || ''); } catch (_) { return false; }
  });
  if (blocked) {
    return { decision: 'rejected', stage: 'event-exclusion', reason: String(blocked).slice(0, 80) };
  }
  const card = verdictFor(promotion, record.title, event);
  const index = record.indexTitle && record.indexTitle !== record.title
    ? verdictFor(promotion, record.indexTitle, event) : null;
  if (card.ok || (index && index.ok)) {
    return {
      decision: 'matched',
      stage: card.ok ? 'card-title' : 'index-title',
      reason: 'ok',
      cardReason: card.reason,
      indexReason: index ? index.reason : '',
    };
  }
  return {
    decision: 'rejected',
    stage: 'relevance',
    // The card title is the stricter form and the usual thing to fix.
    reason: card.reason,
    cardReason: card.reason,
    indexReason: index ? index.reason : '',
  };
}

function eventsInScope(options) {
  const opts = options || {};
  const promotionId = String(opts.promotionId || '').trim();
  const today = dayNumber(new Date().toISOString().slice(0, 10));
  const days = Math.max(1, Math.min(3650, Number(opts.days) || 60));
  return (opts.events || store.getEvents() || []).filter((event) => {
    if (!event || !event.id || !event.date) return false;
    if (promotionId) {
      const promotion = promotions.getByEventId(event.id);
      if (!promotion || promotion.id !== promotionId) return false;
    }
    const day = dayNumber(event.date);
    // A window centred on today: recent fixtures are the ones with releases,
    // upcoming ones show what is about to need matching.
    return day !== null && today !== null && Math.abs(day - today) <= days;
  });
}

function releasesByDay(releases) {
  const buckets = new Map();
  for (const record of (releases || [])) {
    const key = String(record && record.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  return buckets;
}

function nearbyReleases(buckets, date) {
  const day = Date.parse(String(date || '') + 'T00:00:00Z');
  if (!Number.isFinite(day)) return [];
  const out = [];
  for (let offset = -1; offset <= 1; offset += 1) {
    const key = new Date(day + offset * 86400000).toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) out.push(...bucket);
  }
  return out.slice(0, MAX_CANDIDATES_PER_EVENT);
}

function diagnose(options) {
  const opts = options || {};
  const events = eventsInScope(opts);
  const state = opts.state || sportVideo.load();
  const buckets = releasesByDay(state.releases || []);
  const rows = [];
  const summary = {
    events: events.length,
    matchedEvents: 0,
    eventsWithNoRelease: 0,
    eventsAllRejected: 0,
    rejectionsByReason: {},
  };

  for (const event of events) {
    const promotion = promotions.getByEventId(event.id);
    if (!promotion) continue;
    const candidates = nearbyReleases(buckets, event.date);
    const searchTitles = safeCall(() => promotion.searchTitles(event), [])
      .slice(0, MAX_SEARCH_TITLES);
    const torrentTitles = typeof promotion.torrentSearchTitles === 'function'
      ? safeCall(() => promotion.torrentSearchTitles(event), []).slice(0, MAX_SEARCH_TITLES) : [];
    const teamNames = event.teamNames || {};
    const base = {
      promotion: promotion.id,
      promotionName: promotion.name,
      eventId: event.id,
      eventDate: event.date,
      eventName: event.name || '',
      eventAliases: Array.isArray(event.aliases) ? event.aliases : [],
      homeNames: Array.isArray(teamNames.home) ? teamNames.home : [],
      awayNames: Array.isArray(teamNames.away) ? teamNames.away : [],
      searchTitles,
      torrentSearchTitles: torrentTitles,
    };

    if (!candidates.length) {
      summary.eventsWithNoRelease += 1;
      rows.push(Object.assign({}, base, {
        release: null,
        decision: 'no-candidate',
        stage: 'discovery',
        reason: 'no Sport-Video release within one day of this fixture',
      }));
      continue;
    }

    let matched = 0;
    for (const record of candidates) {
      const outcome = explain(promotion, event, record);
      if (outcome.decision === 'matched') matched += 1;
      else {
        const key = outcome.stage + ':' + outcome.reason;
        summary.rejectionsByReason[key] = (summary.rejectionsByReason[key] || 0) + 1;
      }
      rows.push(Object.assign({}, base, {
        release: {
          id: record.id,
          title: record.title || '',
          indexTitle: record.indexTitle || '',
          date: record.date || '',
          category: record.category || '',
          // The public listing page, never the torrent URL.
          detailUrl: record.detailUrl || '',
          prepared: !!record.infoHash,
          infoHash: record.infoHash || '',
          sizeBytes: Number(record.size) || 0,
          autoWarmedAt: record.autoWarmedAt || '',
        },
      }, outcome));
    }
    if (matched) summary.matchedEvents += 1;
    else summary.eventsAllRejected += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    promotionFilter: String(opts.promotionId || '') || 'all',
    windowDays: Math.max(1, Math.min(3650, Number(opts.days) || 60)),
    discoverySource: state.discoverySource || '',
    releasesKnown: (state.releases || []).length,
    summary,
    rows,
  };
}

const CSV_COLUMNS = Object.freeze([
  'promotion', 'event_id', 'event_date', 'event_name',
  'event_aliases', 'home_names', 'away_names', 'search_titles',
  'release_title', 'release_index_title', 'release_date', 'release_category',
  'release_url', 'decision', 'stage', 'reason', 'card_title_reason',
  'index_title_reason', 'prepared', 'info_hash', 'size_bytes', 'auto_warmed_at',
]);

// Excel and Sheets both treat a leading =, +, - or @ as a formula. Release
// titles are third-party text, so the cell is prefixed rather than trusted.
function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' | ') : String(value === undefined || value === null ? '' : value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return '"' + guarded.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}

function toCsv(report) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of (report.rows || [])) {
    const release = row.release || {};
    lines.push([
      row.promotion, row.eventId, row.eventDate, row.eventName,
      row.eventAliases, row.homeNames, row.awayNames, row.searchTitles,
      release.title, release.indexTitle, release.date, release.category,
      release.detailUrl, row.decision, row.stage, row.reason,
      row.cardReason || '', row.indexReason || '',
      release.prepared === undefined ? '' : (release.prepared ? 'yes' : 'no'),
      release.infoHash, release.sizeBytes, release.autoWarmedAt,
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { diagnose, toCsv, explain, CSV_COLUMNS };
