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
    CREATE INDEX IF NOT EXISTS samples_source ON samples(promotion, source, pattern);
    CREATE TABLE IF NOT EXISTS policies (key TEXT PRIMARY KEY, promotion TEXT, source TEXT, pattern TEXT, action TEXT);
    CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER);
    INSERT OR IGNORE INTO revision VALUES(1,0);`);
  let lastPrune = 0;
  const insert = db.prepare('INSERT INTO samples(key,promotion,source,pattern,query,event,event_date,mode,status,hits,matched,unique_matches,duration,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  // How often each query pattern found the right release, per promotion and
  // source (issue #70). For the Prowlarr queue the source is one indexer
  // ("prowlarr · 720pier"), so each indexer's own record decides its order:
  // team-name searches lead on 720pier, date searches where they work.
  // Cached for five minutes; the queue asks for it on every search.
  const MIN_SAMPLES = 5;
  const performanceCache = new Map();
  function performance(ids, source) {
    const cacheKey = JSON.stringify([ids, source]);
    const cached = performanceCache.get(cacheKey);
    if (cached && now() - cached.at < 5 * 60000) return cached.value;
    const marks = ids.map(() => '?').join(',');
    const value = new Map(db.prepare(`SELECT pattern, COUNT(*) n, SUM(matched>0) good FROM samples
      WHERE promotion IN (${marks}) AND source=? AND status='success' GROUP BY pattern`).all(...ids, source)
      .map((row) => [row.pattern, { n: row.n, rate: row.n ? row.good / row.n : 0 }]));
    if (performanceCache.size > 500) performanceCache.clear();
    performanceCache.set(cacheKey, { at: now(), value });
    return value;
  }
  // Proven patterns first (best rate first), then patterns without enough
  // data in the planner's order (so new ones are still tried), then patterns
  // that have never found anything. Stable: equal ranks keep their order.
  function rankFor(stats) {
    if (!stats || stats.n < MIN_SAMPLES) return { group: 1, rate: 0 };
    return stats.rate > 0 ? { group: 0, rate: stats.rate } : { group: 2, rate: 0 };
  }

  function keyFor(promotion, source, pattern) {return crypto.createHash('sha256').update(JSON.stringify([promotion, source, pattern])).digest('hex');}
  function context(source, promo, event, mode = 'live') {
    // A team catalog follows its league's rules for the same fixture, so a
    // pattern disabled on the EPL page stays disabled when the match is opened
    // from the Man United catalog. Its own rules, if any, win.
    const policies = new Map();
    for (const id of [promo.reviewParent, promo.id].filter(Boolean)) {
      for (const row of db.prepare('SELECT pattern,action FROM policies WHERE promotion=? AND source=?').all(id, source)) {
        policies.set(row.pattern, row.action);
      }
    }
    const seen = new Set();
    const verdicts = new Map();
    const recorded = new Set();
    let learned = null;
    return {
      filter(queries) {
        if (!learned) {
          try { learned = performance([promo.reviewParent, promo.id].filter(Boolean), source); } catch (_) { learned = new Map(); }
        }
        return queries.filter(q => policies.get(signature(q)) !== 'disabled')
          .map((q, order) => ({ q, order, demoted: policies.get(signature(q)) === 'demoted', rank: rankFor(learned.get(signature(q))) }))
          .sort((a, b) => Number(a.demoted) - Number(b.demoted) || a.rank.group - b.rank.group || b.rank.rate - a.rank.rate || a.order - b.order)
          .map((x) => x.q);
      },
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
  // `related` adds other promotions' measurements to this page: a league's
  // team catalogs, whose searches are otherwise invisible here.
  function rows(promotion, related = []) {
    const today = new Date(now()).toISOString().slice(0,10);
    const ids = [promotion, ...related.filter(id => id && id !== promotion)];
    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT key,promotion,source,pattern,MAX(query) example,
      SUM(status='success') completed,SUM(status='success' AND hits=0) zeros,
      SUM(status='timeout') timeouts,SUM(status='error') errors,SUM(status='unattempted') unattempted,
      SUM(hits) hits,SUM(matched) matched,SUM(unique_matches) uniqueMatches,
      SUM(CASE WHEN status!='unattempted' THEN duration ELSE 0 END) duration,
      COUNT(DISTINCT CASE WHEN status='success' AND event_date<? AND event_date!='' AND mode!='background' THEN event END) pastFixtures,
      SUM(status='success' AND hits=0 AND event_date<? AND event_date!='' AND mode!='background') pastZeros,
      SUM(status='success' AND event_date<? AND event_date!='' AND mode!='background') pastCompleted,
      MAX(CASE WHEN status='success' AND hits>0 THEN at END) lastHit
      FROM samples WHERE promotion IN (${marks}) GROUP BY key ORDER BY duration DESC`).all(today,today,today,...ids);
    const savedPolicies = db.prepare(`SELECT * FROM policies WHERE promotion IN (${marks})`).all(...ids);
    const policy = new Map(savedPolicies.map(row => [row.key,row.action]));
    for (const saved of savedPolicies) if (!rows.some(row => row.key === saved.key)) rows.push({
      ...saved, example: '', completed: 0, zeros: 0, timeouts: 0, errors: 0, unattempted: 0,
      hits: 0, matched: 0, uniqueMatches: 0, duration: 0, pastFixtures: 0, pastZeros: 0, pastCompleted: 0, lastHit: null});
    return rows.map(row => ({...row, action: policy.get(row.key) || 'active',
      flag: row.pastFixtures >= 5 && row.pastCompleted >= 10 && row.pastZeros === row.pastCompleted ? 'Repeated zero hits' : '',
      coverage: /@/.test(row.pattern) ? '@ matchup' : /\{week\}/.test(row.pattern) ? 'Week format' : ''}));
  }
  // The row's own promotion owns the policy; `related` lets a league page act
  // on the team-catalog rows it shows.
  function setPolicy(promotion, key, action, related = []) {
    if (!['active','demoted','disabled'].includes(action)) throw Error('Unknown query action');
    const ids = [promotion, ...related.filter(id => id && id !== promotion)];
    const marks = ids.map(() => '?').join(',');
    const row = db.prepare(`SELECT promotion,source,pattern FROM samples WHERE key=? AND promotion IN (${marks}) LIMIT 1`).get(key,...ids)
      || db.prepare(`SELECT promotion,source,pattern FROM policies WHERE key=? AND promotion IN (${marks})`).get(key,...ids);
    if (!row) throw Error('Query not found');
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO policies VALUES(?,?,?,?,?)').run(key,row.promotion,row.source,row.pattern,action);
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
