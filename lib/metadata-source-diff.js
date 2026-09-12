'use strict';

const config = require('../config');
const refresh = require('../scripts/refresh');
const metadataPreview = require('./metadata-preview');

function fingerprint(event) {
  return String(event && event.date || '') + '|' + String(event && event.name || '').toLowerCase().trim();
}

function sourceKey(event) {
  const type = event && event.source && event.source.type || '';
  const id = event && event.sourceId != null ? String(event.sourceId) : '';
  return type && id ? type + '|' + id : '';
}

function samples(events) { return events.slice(0, 6).map(metadataPreview.safeEvent); }

function safeError(error) {
  return String(error && error.message ? error.message : error || 'Source preview failed')
    .replace(/(\/api\/v1\/json\/)[^/\s]+\//gi, '$1[redacted]/')
    .replace(/([?&](?:api_?key|apikey|token)=)[^&\s]+/gi, '$1[redacted]');
}

async function compare(promotion, definition, existingEvents, opts) {
  opts = opts || {};
  if (!promotion || !promotion.id) throw new Error('Promotion is required');
  if (!definition || !definition.source) throw new Error('Metadata source is required');
  const candidate = Object.assign({}, promotion, {
    source: JSON.parse(JSON.stringify(definition.source)),
    sourceRef: definition.id || null,
  });
  const fetchPromotion = opts.fetchPromotion || refresh.refreshPromotion;
  const normalizeRecord = opts.normalizeRecord || refresh.normalizeRecord;
  const inScope = opts.inScope || refresh.inScope;
  // Everything through this module is a preview: it compares and writes
  // nothing, and it answers a person waiting on a page. Two parts of a
  // TheSportsDB fetch are rate-limited request loops that can each outlast the
  // preview's 60s deadline on their own — the named-card lookups (one request
  // per name) and the per-round season walk (one per round, until five come
  // back empty). WWE has no name list and still timed out, because the round
  // walk alone is 40-odd requests three seconds apart. A preview takes the
  // list endpoints only, plus a budget so a slow source degrades to a partial
  // answer instead of an error.
  const raw = await fetchPromotion(candidate, opts.log || (() => {}), {
    skipNamedLookups: true,
    skipRoundWalk: true,
    deadlineMs: Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 45000,
  });
  if (!Array.isArray(raw)) throw new Error('The source did not return an event list');
  const after = [];
  for (const record of raw) {
    const event = normalizeRecord(record, candidate);
    if (!event) continue;
    if (typeof candidate.includeEvent === 'function' && !candidate.includeEvent(event, config)) continue;
    if (!inScope(event, candidate)) continue;
    after.push(event);
  }

  const before = (existingEvents || []).filter((event) => event && event.promotion === promotion.id);
  // Match as a multiset so doubleheaders with the same teams/date remain two
  // distinct events. First retain exact title/date matches (also useful across
  // source migrations), then classify same-source IDs with changed metadata as
  // updates. Anything left is genuinely added or removed.
  const usedBefore = new Set();
  const unchanged = [];
  const possibleAdded = [];
  for (const event of after) {
    const index = before.findIndex((candidate, candidateIndex) =>
      !usedBefore.has(candidateIndex) && fingerprint(candidate) === fingerprint(event));
    if (index >= 0) { usedBefore.add(index); unchanged.push(event); }
    else possibleAdded.push(event);
  }
  const added = [];
  const updated = [];
  for (const event of possibleAdded) {
    const key = sourceKey(event);
    const index = key ? before.findIndex((candidate, candidateIndex) =>
      !usedBefore.has(candidateIndex) && sourceKey(candidate) === key) : -1;
    if (index >= 0) { usedBefore.add(index); updated.push(event); }
    else { added.push(event); }
  }
  const removed = before.filter((_event, index) => !usedBefore.has(index));

  // Was this fetch deliberately incomplete?
  //
  // Reported as "AEW still looks broken", with a preview reading:
  //
  //   After refresh: 3 events · +0 added · ~0 updated · =0 unchanged · 29 removed
  //   Removed: 2026-08-30 All In London | 2026-10-26 Redemption | ...
  //
  // Nothing was removed — a preview writes nothing — but the number is worse
  // than harmless, because it is not a prediction of what a refresh would do
  // either. The preview asks for the list endpoints ONLY, skipping the named
  // lookups and the per-round walk (see the note above), and those two are
  // where most of AEW's events come from. So it compares a deliberately
  // truncated fetch against the full store and reports the difference as
  // deletions, for events a real refresh fetches perfectly well.
  //
  // The flags are only honoured by the TheSportsDB adapter — no other source
  // has a skippable path — so that is the condition. Extend this if another
  // adapter gains one, or the next source to get a skip flag will quietly
  // reintroduce this.
  const partial = definition.source.type === 'thesportsdb';
  return {
    ok: true,
    promotion: { id: promotion.id, name: promotion.name },
    source: { id: definition.id || '', name: definition.name, type: definition.source.type },
    fetched: raw.length,
    // True when the fetch skipped paths a real refresh would take, so the
    // caller can stop presenting "removed" as something that would happen.
    partial,
    partialNote: partial
      ? 'A preview asks the list endpoints only — it skips the per-round walk and the '
        + 'named-card lookups, which are slow and are where most events come from. '
        + 'Events it did not see are listed below as not seen, not as removed: a real '
        + 'refresh still fetches them.'
      : null,
    counts: {
      before: before.length, after: after.length, added: added.length,
      updated: updated.length, unchanged: unchanged.length,
      // A truncated fetch cannot say anything about removals, so it does not.
      removed: partial ? 0 : removed.length,
      unseen: partial ? removed.length : 0,
    },
    samples: {
      added: samples(added),
      updated: samples(updated),
      removed: partial ? [] : samples(removed),
      unseen: partial ? samples(removed) : [],
    },
  };
}

module.exports = { compare, fingerprint, sourceKey, safeError };
