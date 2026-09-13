'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('../config');

function signature(query) {
  return String(query || '').toLowerCase().replace(/\b\d{4}[-. ]\d{2}[-. ]\d{2}\b|\b\d{2}[-.]\d{2}[-.]\d{4}\b|\b\d{2}[-.]\d{2}[-.]\d{2}\b|\b\d{8}\b/g, '{date}')
    .replace(/\b\d{4}-\d{4}\b/g, '{season}').replace(/\bw0?\d{1,2}\b/g, '{week}').replace(/\s+/g, ' ').trim();
}
function createReview(file, now = Date.now) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), {recursive: true});
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY, key TEXT, promotion TEXT, source TEXT, pattern TEXT,
    query TEXT, event TEXT, event_date TEXT, mode TEXT, status TEXT,
    hits INTEGER, matched INTEGER, unique_matches INTEGER, duration INTEGER, at INTEGER);
    CREATE INDEX IF NOT EXISTS samples_key ON samples(key);
    CREATE TABLE IF NOT EXISTS policies (key TEXT PRIMARY KEY, promotion TEXT, source TEXT, pattern TEXT, action TEXT);
    CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER);
    INSERT OR IGNORE INTO revision VALUES(1,0);`);
  let lastPrune = 0;
  const insert = db.prepare('INSERT INTO samples(key,promotion,source,pattern,query,event,event_date,mode,status,hits,matched,unique_matches,duration,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  function keyFor(promotion, source, pattern) {return crypto.createHash('sha256').update(JSON.stringify([promotion, source, pattern])).digest('hex');}
  function context(source, promo, event, mode = 'live') {
    const policies = new Map(db.prepare('SELECT pattern,action FROM policies WHERE promotion=? AND source=?').all(promo.id, source).map(row => [row.pattern, row.action]));
    const seen = new Set();
    const verdicts = new Map();
    const recorded = new Set();
    return {
      filter(queries) {return queries.filter(q => policies.get(signature(q)) !== 'disabled')
        .sort((a,b) => Number(policies.get(signature(a)) === 'demoted') - Number(policies.get(signature(b)) === 'demoted'));},
      record(query, status, results, duration) {
        recorded.add(query);
        try {
          let matched = 0, unique = 0;
          for (const item of results || []) {
            const title = String(item.title || '');
            if (!verdicts.has(title)) verdicts.set(title, promo.isRelevantStreamTitle(title, event).ok);
            if (!verdicts.get(title)) continue;
            matched++;
            const identity = String(item.infoHash || item.postHash || title).toLowerCase();
            if (!seen.has(identity)) {unique++; seen.add(identity);}
          }
          const pattern = signature(query);
          insert.run(keyFor(promo.id, source, pattern), promo.id, source, pattern, String(query).slice(0,500),
            String(event.id || event.name).slice(0,200), String(event.date || '').slice(0,10), mode, status,
            (results || []).length, matched, unique, Math.max(0, Math.round(duration || 0)), now());
          if (now() - lastPrune > 3600000) {
            db.prepare('DELETE FROM samples WHERE at<? OR id NOT IN (SELECT id FROM samples ORDER BY id DESC LIMIT 50000)').run(now()-90*86400000);
            lastPrune = now();
          }
        } catch (_) { /* Measurement must never break discovery. */ }
      },
      finish(queries) {for (const q of queries) if (!recorded.has(q)) this.record(q, 'unattempted', [], 0);},
    };
  }
  function rows(promotion) {
    const today = new Date(now()).toISOString().slice(0,10);
    const rows = db.prepare(`SELECT key,promotion,source,pattern,MAX(query) example,
      SUM(status='success') completed,SUM(status='success' AND hits=0) zeros,
      SUM(status='timeout') timeouts,SUM(status='error') errors,SUM(status='unattempted') unattempted,
      SUM(hits) hits,SUM(matched) matched,SUM(unique_matches) uniqueMatches,
      SUM(CASE WHEN status!='unattempted' THEN duration ELSE 0 END) duration,
      COUNT(DISTINCT CASE WHEN status='success' AND event_date<? AND event_date!='' AND mode!='background' THEN event END) pastFixtures,
      SUM(status='success' AND hits=0 AND event_date<? AND event_date!='' AND mode!='background') pastZeros,
      SUM(status='success' AND event_date<? AND event_date!='' AND mode!='background') pastCompleted,
      MAX(CASE WHEN status='success' AND hits>0 THEN at END) lastHit
      FROM samples WHERE promotion=? GROUP BY key ORDER BY duration DESC`).all(today,today,today,promotion);
    const savedPolicies = db.prepare('SELECT * FROM policies WHERE promotion=?').all(promotion);
    const policy = new Map(savedPolicies.map(row => [row.key,row.action]));
    for (const saved of savedPolicies) if (!rows.some(row => row.key === saved.key)) rows.push({
      ...saved, example: '', completed: 0, zeros: 0, timeouts: 0, errors: 0, unattempted: 0,
      hits: 0, matched: 0, uniqueMatches: 0, duration: 0, pastFixtures: 0, pastZeros: 0, pastCompleted: 0, lastHit: null});
    return rows.map(row => ({...row, action: policy.get(row.key) || 'active',
      flag: row.pastFixtures >= 5 && row.pastCompleted >= 10 && row.pastZeros === row.pastCompleted ? 'Repeated zero hits' : '',
      coverage: /@/.test(row.pattern) ? '@ matchup' : /\{week\}/.test(row.pattern) ? 'Week format' : ''}));
  }
  function setPolicy(promotion, key, action) {
    if (!['active','demoted','disabled'].includes(action)) throw Error('Unknown query action');
    const row = db.prepare('SELECT promotion,source,pattern FROM samples WHERE key=? AND promotion=? LIMIT 1').get(key,promotion)
      || db.prepare('SELECT promotion,source,pattern FROM policies WHERE key=? AND promotion=?').get(key,promotion);
    if (!row) throw Error('Query not found');
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO policies VALUES(?,?,?,?,?)').run(key,promotion,row.source,row.pattern,action);
      db.prepare('UPDATE revision SET value=value+1 WHERE id=1').run();
    })();
  }
  return {context, rows, setPolicy, revision: () => db.prepare('SELECT value FROM revision WHERE id=1').get().value, close: () => db.close()};
}
let singleton;
function getDefault() {return singleton || (singleton = createReview(path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'), 'query-review.sqlite')));}
function context(...args) {try {return getDefault().context(...args);} catch (_) {return null;}}
function revision() {try {return getDefault().revision();} catch (_) {return 0;}}
module.exports = {signature, createReview, getDefault, context, revision};
