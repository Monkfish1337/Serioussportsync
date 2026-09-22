'use strict';

const MAX_RECENT = 40;
const active = new Map();
const recent = [];
const totals = {
  started: 0, completed: 0, cancelled: 0, failed: 0,
  bytes: 0, retries: 0, cacheHits: 0, cacheMisses: 0,
};
let sequence = 0;

function begin(input) {
  const now = Date.now();
  const item = {
    id: ++sequence,
    user: String(input && input.user || 'admin'),
    eventId: String(input && input.eventId || ''),
    filename: String(input && input.filename || ''),
    rangeStart: Number(input && input.rangeStart) || 0,
    rangeBytes: Number(input && input.rangeBytes) || 0,
    startedAt: Number(input && input.startedAt) || now,
    firstByteAt: null,
    bytes: 0,
    retries: 0,
    state: 'starting',
  };
  active.set(item.id, item);
  totals.started++;
  return item.id;
}

function firstByte(id) {
  const item = active.get(id);
  if (item && !item.firstByteAt) { item.firstByteAt = Date.now(); item.state = 'streaming'; }
}

function addBytes(id, count) {
  const item = active.get(id);
  if (item) item.bytes += Math.max(0, Number(count) || 0);
}

function retry(id) {
  const item = active.get(id);
  if (item) item.retries++;
  totals.retries++;
}

function finish(id, state, error) {
  const item = active.get(id);
  if (!item) return null;
  active.delete(id);
  const endedAt = Date.now();
  const result = Object.assign({}, item, {
    state: state || 'completed', endedAt,
    durationMs: Math.max(0, endedAt - item.startedAt),
    firstByteMs: item.firstByteAt ? item.firstByteAt - item.startedAt : null,
    error: error ? String(error.message || error).slice(0, 240) : '',
  });
  const seconds = Math.max(0.001, result.durationMs / 1000);
  result.mbps = Math.round((result.bytes * 8 / seconds / 1000000) * 10) / 10;
  totals.bytes += result.bytes;
  if (result.state === 'completed') totals.completed++;
  else if (result.state === 'cancelled') totals.cancelled++;
  else totals.failed++;
  recent.unshift(result);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  return result;
}

function cache(hit) { if (hit) totals.cacheHits++; else totals.cacheMisses++; }

function snapshot() {
  return {
    active: Array.from(active.values()).map((item) => Object.assign({}, item, {
      durationMs: Date.now() - item.startedAt,
      firstByteMs: item.firstByteAt ? item.firstByteAt - item.startedAt : null,
    })),
    recent: recent.map((item) => Object.assign({}, item)),
    totals: Object.assign({}, totals),
  };
}

function reset() {
  recent.length = 0;
  for (const key of Object.keys(totals)) totals[key] = 0;
}

module.exports = { begin, firstByte, addBytes, retry, finish, cache, snapshot, reset };
