'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const VERSION = 1;
const COLLECTION_ID = '629ef7ae-1a48-4e83-8ab3-0cb1f15534b0';
const TILE_SHAPES = ['landscape', 'square', 'poster'];
const DEFAULT_FOLDERS = Object.freeze([
  { id: 'ad92f4cb-2815-4178-912c-8871e5f28596', title: 'Combat Sports', promotions: ['ufc', 'one', 'boxing'], artwork: '/assets/collection-combat-sports.png', tileShape: 'landscape', hideTitle: false },
  { id: 'b276a42e-164f-4170-b383-b838a75facb5', title: 'Wrestling', promotions: ['wwe', 'aew'], artwork: '/assets/collection-wrestling.png', tileShape: 'landscape', hideTitle: false },
  { id: '0bf2a789-b07e-43d3-9c15-b9aac44c9e63', title: 'Football', promotions: ['motd', 'manutd'], artwork: '/assets/collection-football.png', tileShape: 'landscape', hideTitle: false },
  { id: 'ee428642-b118-4f85-b64b-a2867636f57e', title: 'Motorsport', promotions: ['f1', 'motogp'], artwork: '/assets/collection-motorsport.png', tileShape: 'landscape', hideTitle: false },
]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function filePath() { return config.nuvioCollectionsFile || './data/nuvio-collections.json'; }
function defaults() {
  return {
    version: VERSION,
    collection: {
      id: COLLECTION_ID,
      title: 'SeriousSportSync',
      backdropImage: '/assets/logo-banner.png',
      pinToTop: false,
      showAllTab: true,
      viewMode: 'ROWS',
    },
    folders: clone(DEFAULT_FOLDERS),
    updatedAt: null,
  };
}

function cleanText(value, label, max) {
  const out = String(value || '').trim();
  if (!out || out.length > max) throw new Error(label + ' is required (max ' + max + ' characters)');
  return out;
}

function cleanImage(value, allowPromotion) {
  const out = String(value || '').trim();
  if (allowPromotion && out === 'promotion') return out;
  if (!out) return '';
  if (/^\/assets\/[A-Za-z0-9._-]+$/.test(out)) return out;
  try {
    const url = new URL(out);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url.toString();
  } catch (_) {
    throw new Error('Image must be an http(s) URL or an SSS bundled image');
  }
}

function normalizeFolder(folder) {
  return {
    id: String(folder.id || crypto.randomUUID()),
    title: cleanText(folder.title, 'Folder title', 80),
    promotions: Array.from(new Set((Array.isArray(folder.promotions) ? folder.promotions : [])
      .map((id) => String(id || '').trim()).filter((id) => /^[a-z0-9_-]{2,30}$/.test(id)))),
    artwork: cleanImage(folder.artwork || '', true),
    tileShape: TILE_SHAPES.includes(folder.tileShape) ? folder.tileShape : 'landscape',
    hideTitle: folder.hideTitle === true,
  };
}

function normalize(data) {
  const fallback = defaults();
  const incomingCollection = data && data.collection && typeof data.collection === 'object' ? data.collection : {};
  let backdropImage;
  try { backdropImage = cleanImage(incomingCollection.backdropImage || fallback.collection.backdropImage, false); }
  catch (_) { backdropImage = fallback.collection.backdropImage; }
  let title;
  try { title = cleanText(incomingCollection.title || fallback.collection.title, 'Collection title', 80); }
  catch (_) { title = fallback.collection.title; }
  const rawFolders = data && Array.isArray(data.folders) ? data.folders : fallback.folders;
  const folders = [];
  for (const folder of rawFolders) {
    try { folders.push(normalizeFolder(folder)); }
    catch (err) { console.error('[nuvio-collections] skipped invalid folder: ' + err.message); }
  }
  return {
    version: VERSION,
    collection: {
      id: COLLECTION_ID,
      title,
      backdropImage,
      pinToTop: incomingCollection.pinToTop === true,
      showAllTab: incomingCollection.showAllTab !== false,
      viewMode: 'ROWS',
    },
    folders,
    updatedAt: data && data.updatedAt || null,
  };
}

function load() {
  try {
    const file = filePath();
    if (!fs.existsSync(file)) return defaults();
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    console.error('[nuvio-collections] load failed: ' + err.message);
    return defaults();
  }
}

function save(state) {
  const value = normalize(state || {});
  value.updatedAt = new Date().toISOString();
  const file = filePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clone(value);
}

function updateCollection(input) {
  const state = load();
  state.collection.title = cleanText(input.title, 'Collection title', 80);
  state.collection.backdropImage = cleanImage(input.backdropImage, false);
  state.collection.pinToTop = input.pinToTop === true;
  state.collection.showAllTab = input.showAllTab === true;
  return save(state);
}

function upsertFolder(id, input, validPromotionIds) {
  const state = load();
  const folderId = String(id || '').trim();
  const existingIndex = state.folders.findIndex((folder) => folder.id === folderId);
  if (folderId && existingIndex < 0) throw new Error('Collection folder not found');
  const allowed = validPromotionIds instanceof Set ? validPromotionIds : new Set(validPromotionIds || []);
  const requested = Array.isArray(input.promotions) ? input.promotions : [input.promotions];
  const selected = Array.from(new Set(requested.map((value) => String(value || '').trim())
    .filter((value) => allowed.has(value))));
  // Emptying an existing folder used to be refused, which made "take this
  // promotion out of Nuvio" impossible for a one-promotion folder and read to
  // the user as the save silently failing. An empty folder is a valid state:
  // buildNuvioCollections already skips folders that resolve to no catalogs, so
  // nothing malformed reaches Nuvio. A brand-new folder with nothing in it is
  // still refused, since that is a mis-filled form rather than an edit.
  if (existingIndex < 0 && !selected.length) throw new Error('Select at least one promotion');
  if (!String(input.artwork || '').trim()) throw new Error('Choose a folder image');
  const folder = normalizeFolder({
    id: existingIndex >= 0 ? folderId : crypto.randomUUID(),
    title: input.title,
    promotions: selected,
    artwork: input.artwork,
    tileShape: input.tileShape,
    hideTitle: input.hideTitle === true,
  });
  // A promotion belongs to one folder. Moving it here removes stale duplicates.
  state.folders = state.folders.map((item) => item.id === folder.id
    ? item
    : Object.assign({}, item, { promotions: item.promotions.filter((promotionId) => !selected.includes(promotionId)) }));
  if (existingIndex >= 0) state.folders[existingIndex] = folder;
  else state.folders.push(folder);
  // Folders emptied here are kept, not deleted. Silently removing one made a
  // user's folder vanish mid-reorganisation with no way to get it back except
  // recreating it; the export skips empty folders anyway, and the Remove button
  // is the explicit way to delete one.
  return save(state);
}

function removeFolder(id) {
  const state = load();
  const before = state.folders.length;
  state.folders = state.folders.filter((folder) => folder.id !== id);
  if (state.folders.length === before) return false;
  save(state);
  return true;
}

module.exports = {
  COLLECTION_ID,
  DEFAULT_FOLDERS,
  TILE_SHAPES,
  defaults,
  load,
  save,
  cleanImage,
  updateCollection,
  upsertFolder,
  removeFolder,
};
