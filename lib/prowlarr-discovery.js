'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const config = require('../config');
const settings = require('./settings');
const keys = require('./crypto-keys');
const prowlarr = require('./sources/prowlarr');
const bitmagnet = require('./sources/bitmagnet');
const filter = require('./sources/release-filter');
const bounded = require('./bounded-body');
const httpAgent = require('./http-agent');
const HOUR = 3600000;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function eligible(events, now, days, selected = ['mlb','nba','nfl']) {
  return events.filter(event => {
    if (!selected.includes(event.id.split(':')[0]) || /cancel|postpon/i.test(String(event.status || ''))) return false;
    const start = require('./discovery-cadence').startAt(event);
    const date = Number.isFinite(start) ? start : Date.parse(event.date + 'T23:59:59Z');
    return Number.isFinite(date) && require('./discovery-cadence').readyAt(event)<=now && date >= now - days*24*HOUR;
  }).sort((a,b) => String(b.date).localeCompare(String(a.date)));
}
function createQueue(file, dependencies = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), {recursive:true});
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS jobs(scope TEXT,event TEXT,indexer INTEGER,cursor INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,status TEXT,PRIMARY KEY(scope,event,indexer));
    CREATE TABLE IF NOT EXISTS limits(scope TEXT,indexer INTEGER,day TEXT,requests INTEGER DEFAULT 0,failures INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,name TEXT,PRIMARY KEY(scope,indexer));
    CREATE TABLE IF NOT EXISTS matches(scope TEXT,event TEXT,hash TEXT,payload TEXT,at INTEGER,PRIMARY KEY(scope,event,hash));
    CREATE TABLE IF NOT EXISTS research(scope TEXT,event TEXT,title TEXT,payload TEXT,at INTEGER,PRIMARY KEY(scope,event,title));
    CREATE TABLE IF NOT EXISTS hashes(scope TEXT,url TEXT,hash TEXT,expires INTEGER,PRIMARY KEY(scope,url));
    CREATE TABLE IF NOT EXISTS priority(scope TEXT,event TEXT,at INTEGER,PRIMARY KEY(scope,event));
    CREATE TABLE IF NOT EXISTS queries(scope TEXT,indexer INTEGER,query TEXT,at INTEGER,status TEXT,PRIMARY KEY(scope,indexer,query));
    CREATE TABLE IF NOT EXISTS worker(id INTEGER PRIMARY KEY,next_at INTEGER DEFAULT 0,lease INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS success_counts(scope TEXT,indexer INTEGER,successes INTEGER DEFAULT 0,PRIMARY KEY(scope,indexer));
    CREATE TABLE IF NOT EXISTS event_attempts(scope TEXT,event TEXT,first_at INTEGER,last_at INTEGER,PRIMARY KEY(scope,event));
    INSERT OR IGNORE INTO worker(id) VALUES(1);`);
  const now = dependencies.now || Date.now;
  const options = dependencies.options || settings.getProwlarrDiscovery;
  const provider = dependencies.provider || settings.getProwlarr;
  const bitmagnetProvider = dependencies.bitmagnet || settings.getBitmagnet;
  const getEvents = dependencies.events || (() => require('./store').getEvents());
  const getPromo = dependencies.promotion || (id => require('./promotions').getByEventId(id));
  const search = dependencies.search || prowlarr.multiSearch;
  const queryContext = dependencies.review || require('./query-review').context;
  const log = dependencies.log || (message => console.log('[prowlarr queue] ' + message));
  const scope = () => hash(JSON.stringify([provider().url,provider().apiKey]));
  let busy = false, catalog = null, catalogAt = 0;
  async function api(resource) {
    const pw = provider(), url = pw.url.replace(/\/$/,'') + '/api/v1/' + resource;
    const res = await fetch(url,httpAgent.fetchOpts({headers:{'X-Api-Key':pw.apiKey},timeout:15000},url));
    if (!res.ok) throw new Error('Prowlarr control API HTTP ' + res.status);
    const rows = await bounded.readJson(res,1024*1024,'Prowlarr indexer status');
    if (!Array.isArray(rows)) throw new Error('Invalid Prowlarr indexer status');
    return rows;
  }
  async function indexers() {
    if (dependencies.indexers) return dependencies.indexers();
    if (!catalog || now()-catalogAt>5*60000 || catalog.scope!==scope()) {
      const entries = await api('indexer'), statuses = await api('indexerstatus');
      const blocked = new Set(statuses.filter(s => Date.parse(s.disabledTill)>now()).map(s=>s.indexerId));
      catalog = {scope:scope(), entries:entries.filter(i=>i.enable && i.protocol==='torrent' && !blocked.has(i.id))};
      catalogAt = now();
    }
    return catalog.entries;
  }
  function candidates(event) {
    const promo = getPromo(event.id);
    if (!promo) return [];
    return db.prepare('SELECT payload FROM matches WHERE scope=? AND event=? AND at>? ORDER BY at DESC LIMIT 100').all(scope(),event.id,now()-30*24*HOUR)
      .flatMap(row => {try {const c = JSON.parse(keys.decrypt(row.payload)); return c.manualConfirmedEvent===event.id || relevant(c,promo,event) ? [c] : [];} catch (_) {return [];}});
  }
  function relevant(candidate,promo,event) {
    return filter.filterSportsNoise([candidate],null,promo.id).results.length>0 && promo.isRelevantStreamTitle(candidate.title || '',event).ok;
  }
  const claim = db.transaction(() => {
    const w = db.prepare('SELECT * FROM worker WHERE id=1').get();
    if (w.next_at>now() || w.lease>now()) return false;
    db.prepare('UPDATE worker SET lease=?,next_at=? WHERE id=1').run(now()+10*60000,now()+options().intervalSeconds*1000);
    return true;
  });
  function allowance(id,name) {
    const day = new Date(now()).toISOString().slice(0,10);
    db.prepare('INSERT OR IGNORE INTO limits(scope,indexer,day,name) VALUES(?,?,?,?)').run(scope(),id,day,name);
    db.prepare('UPDATE limits SET day=?,requests=0 WHERE scope=? AND indexer=? AND day<>?').run(day,scope(),id,day);
    return db.prepare('SELECT * FROM limits WHERE scope=? AND indexer=?').get(scope(),id);
  }
  // One search: one query against one indexer. `force` (Search now) skips the
  // queue's pacing (the worker interval, per-game retry waits, the indexer's
  // success spacing and the six-hour repeat suppression) but never a failure
  // cooldown, a daily budget or the ten seconds between requests. `promotion`
  // and `eventId` limit which games are chosen; results still save against
  // every eligible game they match. `exclude` holds event ids (or
  // event|indexer keys) a sweep has already tried.
  async function run(runOptions = {}) {
    const pw = provider(), opt = options();
    const runScope = scope();
    const force = Boolean(runOptions.force), exclude = runOptions.exclude || new Set();
    if (busy || !opt.enabled || pw.enabled===false || !pw.url || !pw.apiKey) return {skipped:'paused'};
    if (force) {
      const w = db.prepare('SELECT lease FROM worker WHERE id=1').get();
      if (w.lease>now()) return {skipped:'busy'};
      db.prepare('UPDATE worker SET lease=? WHERE id=1').run(now()+10*60000);
    } else if (!claim()) return {skipped:'spacing'};
    busy = true;
    let chosen,upstreamWait=0;
    try {
      const fixtures = eligible(getEvents(),now(),opt.lookbackDays,opt.promotions).filter(e => {const p=getPromo(e.id); return p && p.enabled!==false && !(p.disabledPipelines || []).includes('torbox');});
      const priorities = new Map(db.prepare('SELECT event,at FROM priority WHERE scope=? AND at>?').all(runScope,now()-24*HOUR).map(row=>[row.event,row.at]));
      const searched = new Set(db.prepare("SELECT DISTINCT event FROM jobs WHERE scope=? AND (cursor>0 OR status='failed')").all(runScope).map(row=>row.event));
      const covered = new Set(fixtures.filter(event=>candidates(event).some(candidate=>Number(candidate.seeders)>0)).map(event=>event.id));
      // A due retry for a recent game must not keep older untouched games from
      // receiving their first search. Explicit admin priorities still win.
      fixtures.sort((a,b)=>(priorities.get(b.id)||0)-(priorities.get(a.id)||0) || Number(searched.has(a.id))-Number(searched.has(b.id)));
      const available = [...await indexers()];
      const successes=new Map(db.prepare('SELECT indexer,successes FROM success_counts WHERE scope=?').all(runScope).map(r=>[r.indexer,r.successes]));
      // Every tenth request explores alternatives; other passes prefer proven sources.
      const used=db.prepare('SELECT COALESCE(SUM(requests),0) n FROM limits WHERE scope=?').get(runScope).n;
      available.sort((a,b)=>{
        const la=allowance(a.id,a.name),lb=allowance(b.id,b.name);
        if(used%10===9) return la.requests-lb.requests || a.id-b.id;
        return la.failures-lb.failures || (successes.get(b.id)||0)-(successes.get(a.id)||0) || la.requests-lb.requests || a.id-b.id;
      });
      // Prefer untouched recent games, then overdue retries. Stop searching any game with a usable matched torrent.
      for (const event of fixtures) {
        if (covered.has(event.id) || exclude.has(event.id)) continue;
        if (runOptions.promotion && event.id.split(':')[0]!==runOptions.promotion) continue;
        if (runOptions.eventId && event.id!==runOptions.eventId) continue;
        const promo = getPromo(event.id);
        const titles = (promo.torrentSearchTitles || promo.searchTitles).call(promo,event);
        const general = queryContext('prowlarr',promo,event,'queue');
        const broad = promo.id==='nfl' && event.week && event.seasonSpan
          ? 'NFL '+event.seasonSpan+(event.seasonPhase==='preseason'?' PS':'')+' W'+String(event.week).padStart(2,'0')
          : promo.id.toUpperCase()+' '+event.date.replace(/-/g,'.');
        const planned = [broad,...require('./discovery-plan').selectTorrentQueries(titles,event,promo,60)];
        for (const indexer of available) {
          const limit = allowance(indexer.id,indexer.name);
          if ((limit.next_at>now() && !(force && !limit.failures)) || limit.requests>=opt.dailyRequests) continue;
          if (exclude.has(event.id+'|'+indexer.id)) continue;
          const review = queryContext('prowlarr · '+indexer.name,promo,event,'queue');
          const queries = (review ? review.filter(general ? general.filter(planned) : planned) : general ? general.filter(planned) : planned).slice(0,6);
          if (!queries.length) continue;
          db.prepare('INSERT OR IGNORE INTO jobs(scope,event,indexer) VALUES(?,?,?)').run(runScope,event.id,indexer.id);
          const job = db.prepare('SELECT * FROM jobs WHERE scope=? AND event=? AND indexer=?').get(runScope,event.id,indexer.id);
          if (job.next_at>now() && !force) continue;
          let selectedCursor = force ? job.cursor : undefined;
          for (let offset=0;offset<queries.length && selectedCursor===undefined;offset++) {
            const cursor=job.cursor+offset;
            const recent=db.prepare('SELECT at FROM queries WHERE scope=? AND indexer=? AND query=?').get(runScope,indexer.id,hash(queries[cursor%queries.length]));
            if (!recent || recent.at<=now()-6*HOUR) {selectedCursor=cursor;break;}
          }
          if (selectedCursor===undefined) {
            db.prepare('UPDATE jobs SET next_at=? WHERE scope=? AND event=? AND indexer=?').run(now()+2*HOUR,runScope,event.id,indexer.id); continue;
          }
          chosen = {event,promo,indexer,job:{...job,cursor:selectedCursor},review,queries,limit}; break;
        }
        if (chosen) break;
      }
      if (!chosen) return {skipped:'no-due-games'};
      const {event,promo,indexer,job,review,queries,limit} = chosen;
      const query = queries[job.cursor % queries.length];
      db.prepare('INSERT OR REPLACE INTO queries VALUES(?,?,?,?,?)').run(runScope,indexer.id,hash(query),now(),'searching');
      const matchingEvents = new Map();
      const observations = [];
      const measuredReview = review && {filter:q=>review.filter(q),record:(...args)=>observations.push(args),finish:()=>{}};
      const matching = candidate => {
        const title = String(candidate.title || '');
        if (!matchingEvents.has(title)) matchingEvents.set(title,fixtures.filter(e=>relevant(candidate,getPromo(e.id),e)));
        return matchingEvents.get(title);
      };
      // Reserve the job before the network call: restarts cannot immediately repeat it.
      db.prepare('UPDATE jobs SET next_at=?,status=? WHERE scope=? AND event=? AND indexer=?').run(now()+2*HOUR,'searching',runScope,event.id,indexer.id);
      let lastRequest = 0;
      const requestDeadline = Date.now()+(opt.timeoutSeconds+60)*1000;
      const measuredFetch = async (url,opts) => {
        if(upstreamWait) throw new Error('Prowlarr upstream requested a retry delay');
        if (scope()!==runScope || !options().enabled || provider().enabled===false) throw new Error('Prowlarr discovery settings changed; stopping this search');
        const used = allowance(indexer.id,indexer.name);
        if (used.requests>=opt.dailyRequests) throw new Error('Prowlarr daily request budget reached');
        if (lastRequest && Date.now()-lastRequest<10000) await new Promise(resolve=>setTimeout(resolve,10000-(Date.now()-lastRequest)));
        if (Date.now()>=requestDeadline) throw new Error('Prowlarr discovery deadline reached');
        if (scope()!==runScope || !options().enabled || provider().enabled===false) throw new Error('Prowlarr discovery settings changed; stopping this search');
        db.prepare('UPDATE limits SET requests=requests+1 WHERE scope=? AND indexer=?').run(runScope,indexer.id);
        lastRequest = Date.now();
        const response=await (dependencies.fetch || fetch)(url,opts);
        if(response.status===429 || response.status===503) {
          upstreamWait=Math.max(upstreamWait,require('./discovery-cadence').retryAfter(response.headers?.get('retry-after'),now()));
        }
        return response;
      };
      const hashCache = {
        get(url) {const row=db.prepare('SELECT hash FROM hashes WHERE scope=? AND url=? AND expires>?').get(runScope,hash(url),now()); return row ? row.hash || false : undefined;},
        set(url,value) {db.prepare('INSERT OR REPLACE INTO hashes VALUES(?,?,?,?)').run(runScope,hash(url),value,now()+(value?30*24*HOUR:6*HOUR));},
      };
      const retainTitles = db.transaction(rows=>{
        for (const row of rows.slice(0,100)) {
          const candidate={title:String(row.title || '').slice(0,500),size:row.size || 0,indexer:row.indexer || indexer.name,publishDate:row.publishDate || null};
          if (!candidate.title) continue;
          db.prepare('INSERT OR REPLACE INTO research VALUES(?,?,?,?,?)').run(runScope,event.id,hash(candidate.title),keys.encrypt(JSON.stringify(candidate)),now());
        }
        db.prepare('DELETE FROM research WHERE scope=? AND event=? AND title NOT IN (SELECT title FROM research WHERE scope=? AND event=? ORDER BY at DESC LIMIT 200)').run(runScope,event.id,runScope,event.id);
      });
      log('searching '+indexer.name+' for '+event.id+' (one query)');
      const result = await search([query],{indexerId:indexer.id,maxQueries:1,detailed:true,
        timeoutMs:opt.timeoutSeconds*1000,deadlineMs:(opt.timeoutSeconds+60)*1000,queryReview:measuredReview,
        hydrationLimit:3,hydrationConcurrency:1,hashCache,fetchImpl:measuredFetch,log,
        onRawResults:retainTitles,
        filterResults: candidate=>matching(candidate).some(fixture=>!covered.has(fixture.id))});
      let upstreamFailed = false;
      if (!dependencies.indexers || dependencies.statuses) {
        try {
          const statuses = dependencies.statuses ? await dependencies.statuses() : await api('indexerstatus');
          upstreamFailed = statuses.some(s=>s.indexerId===indexer.id && Date.parse(s.disabledTill)>now());
        } catch (_) {upstreamFailed=true;}
      }
      if (review) for (const [q,status,rows,duration] of observations) review.record(q,
        upstreamFailed && status==='success' ? 'error' : status,rows,duration);
      let matched = 0;
      const write = db.transaction(() => {
        for (const candidate of result.results || []) {
          if (!/^[a-f0-9]{40}$/i.test(candidate.infoHash || '')) continue;
          for (const fixture of matching(candidate)) {
            db.prepare('INSERT OR REPLACE INTO matches VALUES(?,?,?,?,?)').run(runScope,fixture.id,candidate.infoHash,keys.encrypt(JSON.stringify(candidate)),now()); matched++;
          }
        }
      }); write();
      if (matched > 0) db.prepare('INSERT INTO success_counts VALUES(?,?,1) ON CONFLICT(scope,indexer) DO UPDATE SET successes=successes+1').run(runScope,indexer.id);
      const failed = !result.ok || (result.upstreamFailed === undefined ? result.partial : result.upstreamFailed) || upstreamFailed;
      db.prepare('INSERT INTO event_attempts VALUES(?,?,?,?) ON CONFLICT(scope,event) DO UPDATE SET last_at=excluded.last_at').run(runScope,event.id,now(),now());
      db.prepare('UPDATE queries SET status=? WHERE scope=? AND indexer=? AND query=?').run(failed?'incomplete':'completed',runScope,indexer.id,hash(query));
      const failures = failed ? limit.failures+1 : 0;
      const cooldown = Math.max(upstreamWait,failed ? Math.min(24*HOUR,HOUR*2**Math.min(failures-1,5)) : opt.intervalSeconds*1000);
      db.prepare('UPDATE limits SET failures=?,next_at=? WHERE scope=? AND indexer=?').run(failures,now()+cooldown,runScope,indexer.id);
      const cursor = job.cursor+1;
      const retry = require('./discovery-cadence').retryDelay(event,now(),cursor%queries.length===0);
      db.prepare('UPDATE jobs SET cursor=?,next_at=?,status=? WHERE scope=? AND event=? AND indexer=?').run(cursor,now()+retry,failed?'incomplete':matched?'matched':'zero matches',runScope,event.id,indexer.id);
      catalog = null; // Re-read Prowlarr cooldowns before the next upstream search.
      log('finished '+event.id+': '+matched+' fixture match(es)'+(failed?', indexer cooling down':''));
      db.prepare('DELETE FROM matches WHERE at<?').run(now()-30*24*HOUR);
      db.prepare('DELETE FROM hashes WHERE expires<?').run(now());
      db.prepare('DELETE FROM jobs WHERE scope<>? OR next_at<?').run(runScope,now()-90*24*HOUR);
      db.prepare('DELETE FROM priority WHERE at<?').run(now()-24*HOUR);
      db.prepare('DELETE FROM queries WHERE at<?').run(now()-7*24*HOUR);
      db.prepare('DELETE FROM research WHERE at<?').run(now()-30*24*HOUR);
      db.prepare('DELETE FROM event_attempts WHERE last_at<?').run(now()-90*24*HOUR);
      return {matched,partial:failed,eventId:event.id,indexer:indexer.name,indexerId:indexer.id,query};
    } catch (error) {
      if (chosen) {
        db.prepare('INSERT INTO event_attempts VALUES(?,?,?,?) ON CONFLICT(scope,event) DO UPDATE SET last_at=excluded.last_at').run(runScope,chosen.event.id,now(),now());
        db.prepare('UPDATE limits SET failures=failures+1,next_at=? WHERE scope=? AND indexer=?').run(now()+Math.max(HOUR,upstreamWait),runScope,chosen.indexer.id);
        db.prepare('UPDATE jobs SET status=? WHERE scope=? AND event=? AND indexer=?').run('failed',runScope,chosen.event.id,chosen.indexer.id);
      }
      catalog=null;
      log('worker failed: '+error.message); return {error:error.message};
    }
    finally {busy=false; db.prepare('UPDATE worker SET lease=0 WHERE id=1').run();}
  }
  function status() {
    const activeScope=scope();
    const opt=options();
    const jobs=db.prepare('SELECT event,indexer,status,next_at,cursor FROM jobs WHERE scope=? ORDER BY next_at').all(activeScope);
    const jobsByEvent=new Map();
    for (const job of jobs) { if (!jobsByEvent.has(job.event)) jobsByEvent.set(job.event,[]); jobsByEvent.get(job.event).push(job); }
    const fixtures=eligible(getEvents(),now(),opt.lookbackDays,opt.promotions).filter(e=>{const p=getPromo(e.id);return p && p.enabled!==false && !(p.disabledPipelines || []).includes('torbox');});
    const eventStates=fixtures.map(event=>{
      const releases=candidates(event), attempts=(jobsByEvent.get(event.id) || []).filter(j=>j.cursor>0 || j.status==='failed');
      const seeded=releases.some(c=>Number(c.seeders)>0);
      const matchingTitles = !releases.length && researchCandidates(event).some(candidate=>relevant(candidate,getPromo(event.id),event));
      const state=seeded?'Matched — playback check required':releases.length?'Matched — no known seeders':matchingTitles?'Matching titles found — no usable torrent saved':!attempts.length?'Not searched yet':attempts.every(j=>['incomplete','failed'].includes(j.status))?'Indexer failure — awaiting retry':attempts.some(j=>j.status==='zero matches')?'No matches — awaiting retry':'Awaiting retry';
      return {id:event.id,name:event.name,date:event.date,promotion:event.id.split(':')[0],state,searched:attempts.length>0,matched:releases.length>0,seeded,nextAt:attempts.length?Math.min(...attempts.map(j=>j.next_at)):null};
    });
    const outstanding=eventStates.filter(e=>!e.seeded), untouched=outstanding.filter(e=>!e.searched);
    const missingIds = new Set(outstanding.map(event=>event.id));
    const retryJobs = jobs.filter(job=>missingIds.has(job.event)).slice(0,50);
    const sample=db.prepare('SELECT first_at FROM event_attempts WHERE scope=? AND first_at>? ORDER BY first_at').all(activeScope,now()-24*HOUR);
    const span=sample.length?now()-sample[0].first_at:0;
    const firstPassEstimateMs=sample.length>=3 && span>=HOUR && opt.enabled ? Math.ceil(untouched.length*span/sample.length) : null;
    const progress={eligible:eventStates.length,searched:eventStates.filter(e=>e.searched).length,matched:eventStates.filter(e=>e.matched).length,outstanding:outstanding.length,untouched:untouched.length,firstPassEstimateMs,sampleEvents:sample.length,byPromotion:(opt.promotions || ['mlb','nba','nfl']).map(id=>{const rows=eventStates.filter(e=>e.promotion===id);return {id,eligible:rows.length,searched:rows.filter(e=>e.searched).length,matched:rows.filter(e=>e.matched).length};})};
    const eventById=new Map(getEvents().map(event=>[event.id,event]));
    const matchedEvents=db.prepare('SELECT event,MAX(at) at FROM matches WHERE scope=? AND at>? GROUP BY event ORDER BY at DESC').all(activeScope,now()-30*24*HOUR)
      .flatMap(row=>{const event=eventById.get(row.event);if (!event) return [];const releases=candidates(event);return releases.length?[{event:row.event,name:event.name,date:event.date,at:row.at,releases:releases.length,warmable:releases.some(c=>Number(c.seeders)>0 && /^[a-f0-9]{40}$/i.test(String(c.infoHash))),indexers:[...new Set(releases.map(c=>c.indexer).filter(Boolean))]}]:[];});
    return {options:options(),indexers:db.prepare('SELECT l.indexer id,l.name,l.requests,l.day,l.failures,l.next_at,COALESCE(s.successes,0) successes FROM limits l LEFT JOIN success_counts s ON s.scope=l.scope AND s.indexer=l.indexer WHERE l.scope=?').all(activeScope),
      sweep:sweep && {...sweep,searches:sweep.searches.slice()},jobs:jobs.slice(0,50),retryJobs,matches:db.prepare('SELECT COUNT(*) n FROM matches WHERE scope=?').get(activeScope).n,matchedEvents,progress,eventStates};
  }
  // Search now: a short sweep of forced searches, run in the background.
  // For a promotion, one search per missing game (newest first); for one
  // event, one search per indexer until it has a match. A broad query can
  // match several games at once, so a sweep often covers more than it
  // searches. Each search still waits ten seconds after the last.
  let sweep = null;
  function searchNow(request = {}) {
    if (sweep && !sweep.finishedAt) throw new Error('A Search now is already running.');
    const opt = options(), pw = provider();
    if (!opt.enabled) throw new Error('Prowlarr discovery is switched off.');
    if (pw.enabled===false || !pw.url || !pw.apiKey) throw new Error('Configure Prowlarr first.');
    const selected = opt.promotions || ['mlb','nba','nfl'];
    const promotion = request.promotion ? String(request.promotion) : '';
    const eventId = request.eventId ? String(request.eventId) : '';
    if (promotion && !selected.includes(promotion)) throw new Error('Add this promotion to the Prowlarr queue first.');
    const pool = eligible(getEvents(),now(),opt.lookbackDays,selected).filter(e => {
      const p=getPromo(e.id); return p && p.enabled!==false && !(p.disabledPipelines || []).includes('torbox');
    });
    const targets = pool.filter(e => (!promotion || e.id.split(':')[0]===promotion) && (!eventId || e.id===eventId)
      && !candidates(e).some(c=>Number(c.seeders)>0));
    if (eventId && !pool.some(e=>e.id===eventId)) throw new Error('Choose a selected past event within the discovery window.');
    if (!targets.length) throw new Error(eventId ? 'This event already has a saved, seeded match.' : 'Every recent event already has a saved, seeded match.');
    const limit = eventId ? 4 : Math.min(20, targets.length);
    sweep = {promotion, eventId, label: eventId ? (targets[0].name || eventId) : (promotion ? promotion.toUpperCase() : 'all selected promotions'),
      startedAt: now(), finishedAt: null, planned: limit, searches: [], matched: 0, note: ''};
    const current = sweep;
    const wait = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const exclude = new Set();
    (async () => {
      try {
        for (let i = 0; i < limit; i++) {
          if (i) await wait(10000);
          let result = await run({force:true, promotion, eventId, exclude});
          for (let tries = 0; result.skipped==='busy' && tries < 30; tries++) { await wait(10000); result = await run({force:true, promotion, eventId, exclude}); }
          if (result.skipped || result.error) {
            current.note = result.error ? 'Stopped: ' + result.error
              : result.skipped==='no-due-games' ? (current.searches.length ? '' : 'No indexer is available: all are cooling down or out of budget.')
                : result.skipped==='paused' ? 'Stopped: Prowlarr discovery was switched off.' : 'Stopped: the queue stayed busy.';
            break;
          }
          current.searches.push({eventId: result.eventId, indexer: result.indexer, query: result.query, matched: result.matched, partial: result.partial});
          current.matched += result.matched;
          exclude.add(eventId ? result.eventId+'|'+result.indexerId : result.eventId);
          if (eventId && result.matched) break;
        }
      } catch (error) {
        current.note = 'Stopped: ' + error.message;
      } finally {
        current.finishedAt = now();
        log('search now finished: '+current.searches.length+' search(es), '+current.matched+' match(es)'+(current.note ? ' — '+current.note : ''));
      }
    })();
    log('search now started for '+sweep.label+': up to '+limit+' search(es)');
    return {started:true, planned:limit, label:sweep.label};
  }
  function enqueue(event) {
    if (!eligible([event],now(),options().lookbackDays,options().promotions).length) throw new Error('Choose a selected past event within the discovery window.');
    db.prepare('INSERT OR REPLACE INTO priority VALUES(?,?,?)').run(scope(),event.id,now());
    // Repeated clicks only raise priority; they never reset an existing search cooldown.
    return {queued:true};
  }
  function researchCandidates(event) {
    return [...candidates(event),...db.prepare('SELECT payload FROM research WHERE scope=? AND event=? AND at>? ORDER BY at DESC LIMIT 200').all(scope(),event.id,now()-30*24*HOUR)
      .flatMap(row=>{try {const c=JSON.parse(keys.decrypt(row.payload));return [{title:c.title,size:c.size||0,indexer:c.indexer||'',publishDate:c.publishDate||c.publishedAt||null,seeders:Number(c.seeders)||0,infoHash:/^[a-f0-9]{40}$/i.test(String(c.infoHash||''))?String(c.infoHash).toLowerCase():undefined}];} catch (_) {return [];}})];
  }
  function manualCandidates(event) {
    const promo=getPromo(event.id);
    if(!promo) return [];
    const seen=new Set();
    return db.prepare('SELECT payload,at FROM research WHERE scope=? AND event=? AND at>? ORDER BY at DESC LIMIT 200').all(scope(),event.id,now()-30*24*HOUR).flatMap(row=>{
      try {
        const c=JSON.parse(keys.decrypt(row.payload)),infoHash=String(c.infoHash||'').toLowerCase();
        if(!/^[a-f0-9]{40}$/.test(infoHash)||seen.has(infoHash)) return [];
        seen.add(infoHash);
        return [{title:String(c.title||'').slice(0,500),infoHash,indexer:String(c.indexer||'Torrent source').slice(0,100),size:Number(c.size)||0,seeders:Number(c.seeders)||0,at:row.at,automatic:relevant(c,promo,event)}];
      } catch (_) {return [];}
    });
  }
  async function manualSearch(event, query) {
    const promo=getPromo(event.id);
    if(!promo || promo.enabled===false) throw new Error('Choose an enabled event.');
    const eventAt=Date.parse(event.date+'T23:59:59Z');
    if(!Number.isFinite(eventAt)||eventAt>now()||eventAt<now()-90*24*HOUR) throw new Error('Choose a past event from the last 90 days.');
    const manual=String(query||'').split(/[;\r\n]+/).map(v=>v.trim().slice(0,200)).filter(Boolean);
    const generated=(promo.torrentSearchTitles||promo.searchTitles).call(promo,event);
    const queries=(manual.length?manual:require('./discovery-plan').selectTorrentQueries(generated,event,promo,60)).slice(0,6);
    if(!queries.length) throw new Error('Enter at least one search query.');
    const tasks=[];
    const bm=bitmagnetProvider(),pw=provider(),timing=settings.getDiscoveryTiming();
    if(bm && bm.enabled!==false && bm.url) tasks.push({name:'Bitmagnet',run:()=>
      (dependencies.bitmagnetSearch||bitmagnet.multiSearch)(queries,{config:bm,detailed:true,deadlineMs:timing.discoveryBudgetMs})});
    if(pw && pw.enabled!==false && pw.url && pw.apiKey) tasks.push({name:'Prowlarr',run:()=>
      (dependencies.manualProwlarrSearch||prowlarr.multiSearch)(queries,{detailed:true,deadlineMs:timing.prowlarrLiveBudgetMs,timeoutMs:timing.prowlarrLiveBudgetMs,hydrationLimit:20,hydrationConcurrency:2})});
    if(!tasks.length) throw new Error('Configure Bitmagnet or Prowlarr first.');
    const outcomes=await Promise.allSettled(tasks.map(async task=>({task,result:await task.run()})));
    const providers=[];let stored=0;
    const retain=db.transaction(rows=>{
      for(const c of rows.slice(0,200)) {
        const infoHash=String(c&&c.infoHash||'').toLowerCase(),title=String(c&&c.title||'').trim().slice(0,500);
        if(!title||!/^[a-f0-9]{40}$/.test(infoHash)) continue;
        const candidate={...c,title,infoHash,indexer:String(c.indexer||'Torrent source').slice(0,100)};
        db.prepare('INSERT OR REPLACE INTO research VALUES(?,?,?,?,?)').run(scope(),event.id,hash(title+'|'+infoHash),keys.encrypt(JSON.stringify(candidate)),now());stored++;
      }
    });
    for(const outcome of outcomes) {
      if(outcome.status==='rejected') {providers.push({name:'Torrent source',ok:false,error:String(outcome.reason&&outcome.reason.message||'Search failed')});continue;}
      const {task,result}=outcome.value;providers.push({name:task.name,ok:result&&result.ok!==false,count:(result&&result.results||[]).length,error:result&&result.ok===false?String(result.error||'Search failed'):''});
      retain(result&&result.results||[]);
    }
    return {queries,providers,stored,candidates:manualCandidates(event)};
  }
  function confirmManual(event, hashes) {
    const selected=new Set([].concat(hashes||[]).map(v=>String(v).toLowerCase()).filter(v=>/^[a-f0-9]{40}$/.test(v)));
    if(!selected.size) throw new Error('Select at least one torrent result.');
    const rows=db.prepare('SELECT payload FROM research WHERE scope=? AND event=? AND at>?').all(scope(),event.id,now()-30*24*HOUR);
    let saved=0;
    const write=db.transaction(()=>{for(const row of rows){try{const c=JSON.parse(keys.decrypt(row.payload)),infoHash=String(c.infoHash||'').toLowerCase();if(!selected.has(infoHash))continue;c.manualConfirmedEvent=event.id;c.manualConfirmedAt=now();db.prepare('INSERT OR REPLACE INTO matches VALUES(?,?,?,?,?)').run(scope(),event.id,infoHash,keys.encrypt(JSON.stringify(c)),now());saved++;}catch(_){}}});write();
    if(!saved) throw new Error('The selected results are no longer available. Search again.');
    return {saved};
  }
  function resetCooldown(indexerId) {
    const id = Number(indexerId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Choose a valid indexer.');
    if (busy) throw new Error('A discovery search is running. Try resetting the cooldown after it finishes.');
    const row = db.prepare('SELECT failures FROM limits WHERE scope=? AND indexer=?').get(scope(),id);
    if (!row) throw new Error('Indexer not found in this Prowlarr discovery history.');
    if (row.failures > 0) {
      db.prepare('UPDATE limits SET failures=0,next_at=0 WHERE scope=? AND indexer=?').run(scope(),id);
      catalog = null; // Still check Prowlarr's own disabled-indexer restrictions.
      log('SSS cooldown reset for indexer '+id+'; request budgets and fixture retries preserved');
    }
    return {reset:row.failures > 0};
  }
  return {run,searchNow,candidates,researchCandidates,manualCandidates,manualSearch,confirmManual,status,enqueue,resetCooldown,close:()=>db.close()};
}
let singleton, timer;
function getDefault() {return singleton || (singleton=createQueue(path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'),'prowlarr-discovery.sqlite')));}
function usesQueue(promo) {const opt=settings.getProwlarrDiscovery(); return (opt.promotions || ['mlb','nba','nfl']).includes(promo.id) && opt.enabled;}
function start() {if (timer) return; timer=setInterval(()=>Promise.resolve().then(()=>getDefault().run()).catch(error=>console.error('[prowlarr queue]',error.message)),30000); timer.unref();}
function stop() {clearInterval(timer); timer=null;}
module.exports={createQueue,eligible,getDefault,usesQueue,start,stop};
