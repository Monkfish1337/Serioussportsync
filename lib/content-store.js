// Persistent, refresh-safe editorial layer for Content Studio.
// Source refreshes continue to own events.json; everything an admin creates,
// edits or disables is stored separately and composed at read time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const promotions = require('./promotions');

const EMPTY = () => ({
  version: 1,
  updatedAt: null,
  manualEvents: [],
  eventOverrides: {},
  disabledEventIds: [],
  inbox: [],
});

let cache = null;
let cacheMtime = 0;

function filePath() {
  return path.resolve(__dirname, '..', config.contentStudioFile || './data/content-studio.json');
}

function load() {
  const fp = filePath();
  if (!fs.existsSync(fp)) return (cache = EMPTY());
  const stat = fs.statSync(fp);
  if (cache && stat.mtimeMs === cacheMtime) return cache;
  const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
  cache = Object.assign(EMPTY(), parsed || {});
  cache.manualEvents = Array.isArray(cache.manualEvents) ? cache.manualEvents : [];
  cache.eventOverrides = cache.eventOverrides && typeof cache.eventOverrides === 'object' ? cache.eventOverrides : {};
  cache.disabledEventIds = Array.isArray(cache.disabledEventIds) ? cache.disabledEventIds : [];
  cache.inbox = Array.isArray(cache.inbox) ? cache.inbox : [];
  cacheMtime = stat.mtimeMs;
  return cache;
}

function save(state) {
  const fp = filePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const next = Object.assign(EMPTY(), state || {}, { updatedAt: new Date().toISOString() });
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
  cache = next;
  cacheMtime = fs.statSync(fp).mtimeMs;
  return next;
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 52) || 'event';
}

function lines(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value || '').split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
}

function normaliseDate(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const d = new Date(v.length === 10 ? v + 'T00:00:00Z' : v);
  if (Number.isNaN(d.getTime())) throw new Error('A valid event date is required.');
  const iso = d.toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && iso !== v) throw new Error('A valid event date is required.');
  return iso;
}

function buildEvent(input, existingId) {
  const promotionId = String(input.promotion || '').trim();
  const promotion = promotions.all.find((p) => p.id === promotionId);
  if (!promotion) throw new Error('Choose a valid promotion.');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Event name is required.');
  const date = normaliseDate(input.date);
  const dateLocal = normaliseDate(input.dateLocal || input.date);
  const id = existingId || promotion.idPrefix + ':manual-' + date + '-' + slug(name) + '-' + crypto.randomBytes(3).toString('hex');
  const aliases = lines(input.aliases);
  const searchAliases = lines(input.searchAliases);
  const kind = String(input.kind || '').trim() || (promotion.classify ? promotion.classify(name) : 'event');
  return {
    id,
    sourceId: id.slice(id.indexOf(':') + 1),
    promotion: promotion.id,
    name,
    kind,
    date,
    dateLocal,
    time: String(input.time || '').trim() || null,
    venue: String(input.venue || '').trim() || null,
    city: String(input.city || '').trim() || null,
    country: String(input.country || '').trim() || null,
    poster: String(input.poster || '').trim() || (promotion.defaults && promotion.defaults.poster) || null,
    thumb: String(input.poster || '').trim() || (promotion.defaults && promotion.defaults.poster) || null,
    fanart: String(input.fanart || '').trim() || (promotion.defaults && promotion.defaults.fanart) || null,
    banner: String(input.fanart || '').trim() || (promotion.defaults && promotion.defaults.fanart) || null,
    description: String(input.description || '').trim() || null,
    shortDescription: String(input.description || '').trim().slice(0, 280) || null,
    aliases,
    searchAliases,
    excludePatterns: lines(input.excludePatterns),
    posterShape: promotion.posterShape || 'regular',
    genres: promotion.genres ? promotion.genres({ name, kind, date }) : [promotion.name],
    source: { type: 'manual' },
    manual: true,
    updatedAt: new Date().toISOString(),
  };
}

function upsertManual(input, id) {
  const state = load();
  const event = buildEvent(input, id || null);
  const idx = state.manualEvents.findIndex((e) => e.id === event.id);
  if (id && idx === -1) throw new Error('Manual event not found.');
  if (idx >= 0) state.manualEvents[idx] = Object.assign({}, state.manualEvents[idx], event);
  else state.manualEvents.push(event);
  state.disabledEventIds = state.disabledEventIds.filter((x) => x !== event.id);
  save(state);
  return event;
}

const EDITABLE = ['name','kind','date','dateLocal','time','venue','city','country','poster','thumb','fanart','banner','description','shortDescription','aliases','searchAliases','excludePatterns'];

function setOverride(id, input) {
  const state = load();
  const patch = {};
  for (const key of EDITABLE) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (['aliases','searchAliases','excludePatterns'].includes(key)) patch[key] = lines(input[key]);
    else if (key === 'date' || key === 'dateLocal') patch[key] = normaliseDate(input[key]);
    else patch[key] = String(input[key] || '').trim() || null;
  }
  state.eventOverrides[id] = Object.assign({}, state.eventOverrides[id] || {}, patch);
  save(state);
  return patch;
}

function removeOverride(id) {
  const state = load();
  delete state.eventOverrides[id];
  save(state);
}

function setDisabled(id, disabled) {
  const state = load();
  const ids = new Set(state.disabledEventIds);
  if (disabled) ids.add(id); else ids.delete(id);
  state.disabledEventIds = Array.from(ids);
  save(state);
}

function deleteManual(id) {
  const state = load();
  const before = state.manualEvents.length;
  state.manualEvents = state.manualEvents.filter((e) => e.id !== id);
  delete state.eventOverrides[id];
  state.disabledEventIds = state.disabledEventIds.filter((x) => x !== id);
  if (state.manualEvents.length !== before) save(state);
  return state.manualEvents.length !== before;
}

function compose(sourceEvents) {
  const state = load();
  const disabled = new Set(state.disabledEventIds);
  const combined = [].concat(sourceEvents || [], state.manualEvents || []);
  return combined
    .filter((e) => e && e.id && !disabled.has(e.id))
    .map((e) => Object.assign({}, e, state.eventOverrides[e.id] || {}))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function inboxKey(candidate, reason) {
  return crypto.createHash('sha1').update([
    candidate && candidate.promotion,
    candidate && (candidate.sourceId || candidate.id),
    candidate && candidate.name,
    candidate && candidate.date,
    reason,
  ].join('|')).digest('hex').slice(0, 16);
}

function recordInbox(candidate, reason, details) {
  if (!candidate || !candidate.name) return null;
  const state = load();
  const key = inboxKey(candidate, reason);
  const idx = state.inbox.findIndex((x) => x.key === key);
  const previous = idx >= 0 ? state.inbox[idx] : null;
  if (previous && previous.status === 'ignored') return previous;
  const item = {
    key,
    status: previous ? previous.status : 'pending',
    reason: reason || 'needs-review',
    details: String(details || ''),
    candidate,
    firstSeenAt: previous ? previous.firstSeenAt : new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  if (idx >= 0) state.inbox[idx] = item; else state.inbox.unshift(item);
  state.inbox = state.inbox.slice(0, 500);
  save(state);
  return item;
}

function updateInbox(key, status, extra) {
  const state = load();
  const item = state.inbox.find((x) => x.key === key);
  if (!item) throw new Error('Inbox item not found.');
  item.status = status;
  item.reviewedAt = new Date().toISOString();
  Object.assign(item, extra || {});
  save(state);
  return item;
}

module.exports = {
  load, save, filePath, compose, buildEvent, upsertManual, setOverride,
  removeOverride, setDisabled, deleteManual, recordInbox, updateInbox, lines,
};
