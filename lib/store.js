const fs = require('fs');
const path = require('path');
const config = require('../config');

let cache = null;
let cacheMtime = 0;

function dataFilePath() {
  return path.resolve(__dirname, '..', config.dataFile);
}

function ensureDataDir() {
  const dir = path.dirname(dataFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadFromDisk() {
  const fp = dataFilePath();
  if (!fs.existsSync(fp)) {
    cache = { updatedAt: null, events: [] };
    cacheMtime = 0;
    return cache;
  }
  const stat = fs.statSync(fp);
  if (cache && stat.mtimeMs === cacheMtime) return cache;

  const raw = fs.readFileSync(fp, 'utf8');
  cache = JSON.parse(raw);
  cacheMtime = stat.mtimeMs;
  return cache;
}

function saveToDisk(payload) {
  ensureDataDir();
  const fp = dataFilePath();
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2), 'utf8');
  cache = payload;
  cacheMtime = fs.statSync(fp).mtimeMs;
}

function getEvents() {
  return loadFromDisk().events || [];
}

function getEvent(id) {
  return getEvents().find((e) => e.id === id) || null;
}

module.exports = {
  loadFromDisk,
  saveToDisk,
  getEvents,
  getEvent,
  dataFilePath,
};
