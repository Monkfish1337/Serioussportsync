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
  const raw = await fetchPromotion(candidate, opts.log || (() => {}));
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
  return {
    ok: true,
    promotion: { id: promotion.id, name: promotion.name },
    source: { id: definition.id || '', name: definition.name, type: definition.source.type },
    fetched: raw.length,
    counts: {
      before: before.length, after: after.length, added: added.length,
      updated: updated.length, unchanged: unchanged.length, removed: removed.length,
    },
    samples: { added: samples(added), updated: samples(updated), removed: samples(removed) },
  };
}

module.exports = { compare, fingerprint, sourceKey, safeError };
