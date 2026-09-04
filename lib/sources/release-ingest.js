'use strict';

// Release-first ingestion: turn a discovered release into an event of its own.
//
// The catalogs are built from fixture feeds, and no feed covers everything the
// site carries. A scan found 620 releases within a day of some fixture that
// matched nothing at all — rugby, tennis, the South American cups — because no
// promotion claims those competitions and, for several of them, no free feed
// exists to claim them with. Every one of those was being discovered and thrown
// away.
//
// So the direction is inverted for exactly that remainder: the release becomes
// the event. The metadata is weak by construction — a name parsed out of the
// release title, the date the site published it against, and a generic sport
// logo — which is the trade the user asked for explicitly ("even just a generic
// logo for each promotion"). It is not a substitute for a real feed; where one
// exists, the feed wins and the release never reaches here.
//
// This deliberately runs through the ordinary refresh pipeline rather than
// writing events directly. Declaring `source: 'sport-video'` on a promotion
// means pruning, the event window, catalogs, streams, the availability gate and
// the Nuvio export all work with no special cases — and the next Sport-Video
// rematch links the release back to the event it produced, so playback and
// TorBox warming need no new plumbing either.

const crypto = require('crypto');

let sportVideo = null;
try { sportVideo = require('./sport-video'); } catch (_) { sportVideo = null; }

// Sport labels the discovery index assigns, mapped to the promotion that owns
// each one's leftovers. Kept here rather than in the promotion registry so the
// registry stays the description of what SSS offers, not of how the site files
// things.
const SPORTS = Object.freeze({
  rugby: 'Rugby',
  football: 'Football',
  basketball: 'Basketball',
  baseball: 'Baseball',
  americanfootball: 'American Football',
  hockey: 'Hockey',
  other: 'Other Sport',
});

// Trailing noise on a Sport-Video title. The date is the last meaningful token
// and is already carried on the record, so everything from it onwards goes.
const TRAILING_DATE_RE = /\s+\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\s*$/;
const QUALITY_RE = /\s+(?:\d{3,4}[pi]|4k|uhd|hd|sd|web[\s._-]?dl|webrip|hdtv|x26[45]|h\.?26[45]|hevc|aac|ac3|multi|dual)\b.*$/i;

function cleanName(title) {
  // Quality first: the date sits in front of it ("… 03.09.2026 1080p WEB-DL"),
  // so trimming the date first would leave it stranded mid-string.
  let text = String(title || '').replace(/\s+/g, ' ').trim();
  text = text.replace(QUALITY_RE, '');
  text = text.replace(TRAILING_DATE_RE, '');
  return text.trim();
}

// A stable id for the event this release becomes. Derived from the release's
// own identity so a rescan produces the same event rather than a duplicate, and
// so the id survives the release being re-discovered under a new record.
function eventKey(record) {
  const seed = String(record.detailUrl || record.id || record.title || '') + '|' + String(record.date || '');
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

// A release is available for ingestion when no REAL promotion claimed it.
// Matches to a discovered promotion are ignored deliberately: once ingested, a
// release matches the event it created, and treating that as "claimed" would
// make the event vanish on the next refresh and reappear on the one after.
function isIngestible(record, ownPromotionIds) {
  if (!record || !record.title || !record.date) return false;
  const matches = Array.isArray(record.matches) ? record.matches : [];
  return !matches.some((match) => match && match.promotion && !ownPromotionIds.has(match.promotion));
}

function toRaw(record, sport) {
  const name = cleanName(record.title);
  // Two words is the floor for something a person could recognise as a fixture.
  if (!name || name.length < 6) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(record.date || ''))) return null;
  const label = SPORTS[sport] || 'Sport';
  return {
    sourceId: eventKey(record),
    name,
    date: record.date,
    time: null,
    timestamp: null,
    venue: null,
    city: null,
    country: null,
    poster: null,
    thumb: null,
    fanart: null,
    banner: null,
    description: label + ' · discovered from a published release',
    source: {
      type: 'sport-video',
      sport,
      releaseId: record.id || null,
      detailUrl: record.detailUrl || null,
    },
  };
}

// Every ingestible release for one sport, as raw records the ordinary
// normalisation step understands. Signature matches the other adapters so
// scripts/refresh.js dispatches to it the same way.
function fetchAll(opts) {
  const options = opts || {};
  const log = options.log || (() => {});
  const sport = String(options.sport || '').trim().toLowerCase();
  if (!SPORTS[sport]) throw new Error('release-ingest: unsupported sport "' + sport + '"');
  const module_ = options.sportVideo || sportVideo;
  if (!module_) { log('   release-ingest: Sport-Video state unavailable'); return []; }

  const ownPromotionIds = options.ownPromotionIds instanceof Set
    ? options.ownPromotionIds
    : new Set(Object.keys(SPORTS).map(promotionIdFor));

  let releases = [];
  try { releases = (module_.load() || {}).releases || []; }
  catch (error) { log('   release-ingest: could not read Sport-Video state: ' + error.message); return []; }

  const out = [];
  const seen = new Set();
  for (const record of releases) {
    if (String(record && record.category || '') !== sport) continue;
    if (!isIngestible(record, ownPromotionIds)) continue;
    const raw = toRaw(record, sport);
    if (!raw || seen.has(raw.sourceId)) continue;
    seen.add(raw.sourceId);
    out.push(raw);
  }
  log('   release-ingest: ' + out.length + ' unclaimed ' + SPORTS[sport] + ' release(s)');
  return out;
}

function promotionIdFor(sport) { return 'discovered-' + sport; }

module.exports = { fetchAll, toRaw, cleanName, eventKey, isIngestible, promotionIdFor, SPORTS };
