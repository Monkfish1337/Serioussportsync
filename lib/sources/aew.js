'use strict';

// AEW's own event schedule, from allelitewrestling.com.
//
// Why this exists at all: TheSportsDB's free key cannot reach AEW's upcoming
// cards. `eventsnextleague` returns one event, `eventsseason` returns fifteen,
// and AEW runs roughly three weekly TV tapings a week — so the fifteen are
// spent before February and every PPV falls outside them. Three separate fixes
// were made to work around that (named-card lookups keyed off a hand-written
// list of recurring names) and AEW's Upcoming row was still empty or wrong.
//
// AEW publishes the schedule itself, so ask AEW.
//
// The page is a Wix site, which is better news than it sounds: Wix embeds the
// page's data as JSON in a <script id="wix-warmup-data"> tag, so this reads a
// structured collection rather than scraping markup. Each record:
//
//   { _id, title: "AEW All Out 2026", eventName: "AEW: All Out",
//     eventType: "AEW: All Out PPV", date: "SEPTEMBER 26, 2026",
//     sortByDate: { $date: "2026-09-26T16:00:00.000Z" },
//     venue: "Now Arena", city: "Chicago, IL", isRoh: false,
//     promoImage: "wix:image://v1/<slug>/<name>.jpg#..." }
//
// Measured on 2026-09-12: 18 records, covering every announced card out to
// February 2027 — All Out, Grand Slam France, WrestleDream, Fright Night, Full
// Gear and Dynasty, plus the weekly tapings the promotion filters out.
//
// Two things this gets right that TheSportsDB did not:
//
//   * The dates are AEW's own LOCAL dates. TSDB had All Out on the 27th and
//     Full Gear on the 15th; AEW says the 26th and the 14th, and releases are
//     named by the local date, so TSDB's were wrong for matching as well as for
//     the catalogue.
//   * Every card carries real artwork. TSDB gave AEW none at the event level.
//
// It is an undocumented implementation detail of somebody's CMS, which is the
// trade being made knowingly — the same bet already taken on statsapi.mlb.com
// and ESPN's scoreboard. Everything fails soft: a shape change returns fewer
// records or none, and never throws into the refresh.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');
const boundedBody = require('../bounded-body');

const EVENTS_URL = 'https://www.allelitewrestling.com/events';
// The PPV replays page, which is where the PAST cards live. /events lists only
// what is still to come, so on its own it leaves the Recent row permanently
// empty. Same CMS, same warmup blob, slightly different field names on the
// records (`sortBy` as a plain date string rather than `sortByDate`, and
// `image` rather than `promoImage`) — hence the alternatives below.
const REPLAYS_URL = 'https://www.allelitewrestling.com/aewonppv';
// The page is about 900 KB, most of it Wix runtime. Four megabytes leaves room
// for it to grow without letting a runaway response exhaust memory.
const MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25000;

// Wix stores media as a custom URI. The public form is the slug appended to
// its media host:
//   wix:image://v1/815952_1fdb…~mv2.jpg/AEW-All-Out-2026-X.jpg#originWidth=…
//   -> https://static.wixstatic.com/media/815952_1fdb…~mv2.jpg
function wixImageUrl(value) {
  const raw = String(value || '');
  const match = raw.match(/^wix:image:\/\/v1\/([^/#]+)/);
  if (!match) return /^https?:\/\//i.test(raw) ? raw : null;
  return 'https://static.wixstatic.com/media/' + match[1];
}

// "SEPTEMBER 26, 2026" — the human-readable field, used only as a fallback.
// It is not reliable on its own: one live record reads "OCTOBER, 21", with no
// year and a stray comma, which is why sortByDate is preferred.
const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};
function parseWrittenDate(value) {
  const match = String(value || '').trim().toLowerCase()
    .match(/^([a-z]+)\s*,?\s*(\d{1,2})\s*,?\s*(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1]];
  if (!month) return null;
  return match[3] + '-' + month + '-' + String(match[2]).padStart(2, '0');
}

// Every sortByDate observed sits between 15:00 and 17:00 UTC — mid-afternoon,
// never near midnight — so the UTC date part is always the intended local date
// and no timezone correction is needed or wanted. Taking the date part of a
// timestamp that COULD roll over is the bug already fixed for ESPN; it does not
// arise here, and this note is so the next person does not have to re-derive
// that.
function recordDate(record) {
  const stamp = record && record.sortByDate && record.sortByDate.$date;
  const iso = String(stamp || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  // The replays collection stores a plain "YYYY-MM-DD" string instead.
  const plain = String((record && record.sortBy) || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(plain)) return plain;
  return parseWrittenDate(record && record.date);
}

// The event name, with AEW's own prefix removed.
//
// The promotion's includeEvent filter and its alias builder were both written
// against unprefixed names — "Collision #161", "All Out" — and AEW's CMS writes
// "AEW Collision Springfield". Left prefixed, the weekly-TV filter matches
// nothing and every taping lands in the catalogue.
function eventNameOf(record) {
  const raw = String((record && (record.title || record.eventName)) || '').trim();
  return raw.replace(/^AEW\s*[:–-]?\s*/i, '').replace(/\s+/g, ' ').trim();
}

// Find the event collection without hard-coding where Wix put it. The key has
// been 'AEWEvents', but a CMS collection can be renamed by whoever edits the
// site, so fall back to any collection whose records look like events.
function eventRecordsFrom(warmup) {
  const store = warmup && warmup.appsWarmupData && warmup.appsWarmupData.dataBinding
    && warmup.appsWarmupData.dataBinding.dataStore;
  const byCollection = store && store.recordsByCollectionId;
  if (!byCollection || typeof byCollection !== 'object') return [];
  const looksLikeEvents = (records) => Object.values(records || {})
    .some((record) => record && (record.sortByDate || record.sortBy)
      && (record.title || record.eventName));
  for (const key of ['AEWEvents', 'PPVReplays']) {
    if (byCollection[key] && looksLikeEvents(byCollection[key])) return Object.values(byCollection[key]);
  }
  for (const records of Object.values(byCollection)) {
    if (looksLikeEvents(records)) return Object.values(records);
  }
  return [];
}

function extractWarmup(html) {
  const match = String(html || '')
    .match(/<script[^>]*id=["']wix-warmup-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  const body = match[1].trim().replace(/^window\.[\w.]+\s*=\s*/, '').replace(/;+\s*$/, '');
  try { return JSON.parse(body); } catch (_) { return null; }
}

// One CMS record to the raw shape scripts/refresh.js expects, matching
// lib/sources/mlb.js and lib/sources/espn.js so all three flow through
// transform.fromWiki.
function toRaw(record) {
  if (!record || !record._id) return null;
  // Ring of Honor shares this CMS and is a different promotion.
  if (record.isRoh === true) return null;
  const name = eventNameOf(record);
  if (!name) return null;
  const date = recordDate(record);
  if (!date) return null;
  const poster = wixImageUrl(record.promoImage || record.image);
  const venue = String(record.venue || '').trim() || null;
  const city = String(record.city || '').trim() || null;
  return {
    sourceId: String(record._id),
    name,
    date,
    time: null,
    timestamp: (record.sortByDate && record.sortByDate.$date) || null,
    venue,
    city,
    country: null,
    poster,
    thumb: poster,
    fanart: poster,
    banner: null,
    description: ['AEW', venue, city].filter(Boolean).join(' · '),
    source: { type: 'aew', eventId: String(record._id) },
  };
}

function parseEvents(html, log) {
  log = log || (() => {});
  const warmup = extractWarmup(html);
  if (!warmup) {
    log('  aew: no embedded event data on the page (the site\'s shape may have changed)');
    return [];
  }
  const records = eventRecordsFrom(warmup);
  if (!records.length) {
    log('  aew: the embedded data carried no event collection');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const record of records) {
    const raw = toRaw(record);
    if (!raw || seen.has(raw.sourceId)) continue;
    seen.add(raw.sourceId);
    out.push(raw);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function fetchPage(url, log) {
  const response = await fetch(url, httpAgent.fetchOpts({
    headers: { Accept: 'text/html', 'User-Agent': 'SeriousSportSync/0.95' },
    timeout: REQUEST_TIMEOUT_MS,
  }, url));
  if (!response.ok) throw new Error('aew HTTP ' + response.status + ' for ' + url);
  const body = await boundedBody.readBuffer(response, MAX_BYTES, 'AEW events');
  return parseEvents(body.toString('utf8'), log);
}

// Both pages, because between them they are the whole schedule: /events is what
// is still to come and /aewonppv is what has already happened. Two requests to
// one site, no key, no date window.
//
// Each page is fetched independently and a failure on one does not lose the
// other — an upcoming row is worth having even if the replays page is down, and
// the reverse. Only a total failure throws, so the refresh can report it.
async function fetchAll(opts) {
  const options = opts || {};
  const log = options.log || (() => {});
  const urls = options.url ? [options.url] : [EVENTS_URL, REPLAYS_URL];
  const byId = new Map();
  const failures = [];
  for (const url of urls) {
    log('-> aew: ' + url);
    try {
      const events = await fetchPage(url, log);
      log('   aew: ' + events.length + ' event(s) from ' + url);
      // First page wins on a duplicate: /events carries the richer record
      // (venue, city, artwork, event type) for anything listed on both.
      for (const event of events) if (!byId.has(event.sourceId)) byId.set(event.sourceId, event);
    } catch (error) {
      failures.push(url);
      log('  aew: ' + url + ' failed: ' + (error && error.message ? error.message : error));
    }
  }
  if (failures.length === urls.length) {
    throw new Error('aew: every page failed (' + failures.join(', ') + ')');
  }
  const all = Array.from(byId.values()).sort((a, b) => a.date.localeCompare(b.date));
  log('   aew: ' + all.length + ' event(s) total');
  return all;
}

module.exports = {
  fetchAll, parseEvents, toRaw, extractWarmup, eventRecordsFrom,
  wixImageUrl, parseWrittenDate, recordDate, eventNameOf,
  EVENTS_URL, REPLAYS_URL, MAX_BYTES,
};
