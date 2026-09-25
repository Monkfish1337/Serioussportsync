'use strict';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'query-queue-test-secret-0000000000000000000000000000';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const discovery = require('../lib/prowlarr-discovery');
const HOUR = 3600000;
test('measured discovery supports selected promotions beyond the original leagues',()=>{
  const events=[{id:'ucl:test',date:'2026-09-10'},{id:'mlb:test',date:'2026-09-10'}];
  const now=Date.parse('2026-09-14T12:00:00Z');
  assert.deepEqual(discovery.eligible(events,now,7,['ucl']).map(e=>e.id),['ucl:test']);
  assert.deepEqual(discovery.eligible(events,now,7,[]),[]);
});
const fixtures = [{id:'mlb:1',name:'Mets vs Yankees',date:'2026-09-11'}, {id:'mlb:2',name:'Mariners vs Rangers',date:'2026-09-11'}];
function setup(extra={}) {
  let clock = Date.parse('2026-09-13T12:00:00Z');
  const promo={id:'mlb',enabled:true,searchTitles:e=>[e.name+' '+e.date],isRelevantStreamTitle:(title,e)=>({ok:title.includes(e.name)})};
  const deps = {now:()=>clock,provider:()=>({url:'http://prowlarr:9696',apiKey:'private',enabled:true}),
    options:()=>({enabled:true,intervalSeconds:120,dailyRequests:10,lookbackDays:30,timeoutSeconds:120}),
    events:()=>fixtures,promotion:()=>promo,indexers:async()=>[{id:30,name:'RuTracker'}],review:()=>null,
    fetch:async()=>({ok:true}),log:()=>{},...extra};
  return {deps,advance:ms=>{clock+=ms;},promo};
}
test('queue excludes future, running, cancelled and unrelated events',()=>{
  const clock=Date.parse('2026-09-13T12:00:00Z');
  const rows=[...fixtures,{id:'nba:3',date:'2026-09-13',time:'10:00:00'},{id:'nfl:4',date:'2026-09-13',time:'01:00:00'},
    {id:'nfl:5',date:'2026-09-14'},{id:'mlb:6',date:'2026-09-11',status:'cancelled'},{id:'ucl:7',date:'2026-09-11'}];
  assert.deepEqual(discovery.eligible(rows,clock,30).map(e=>e.id),['nfl:4','mlb:1','mlb:2']);
});

test('upstream Retry-After prevents another request and extends the stored cooldown',async()=>{
  let calls=0;
  const {deps}=setup({fetch:async()=>{calls++;return {status:429,ok:false,headers:{get:()=> '14400'}};},
    search:async(_queries,opts)=>{
      await opts.fetchImpl('http://prowlarr/search',{});
      await assert.rejects(opts.fetchImpl('http://prowlarr/detail',{}),/retry delay/);
      return {ok:false,upstreamFailed:true,results:[]};
    }});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run();
    assert.equal(calls,1);
    assert.equal(queue.status().indexers[0].next_at,deps.now()+4*HOUR);
  } finally {queue.close();}
});
test('one indexer search matches multiple fixtures and suppresses repeat searches',async()=>{
  let calls=0;
  const {deps,advance}=setup({search:async(queries,opts)=>{
    calls++; assert.equal(queries.length,1); assert.equal(queries[0],'MLB 2026.09.11'); assert.equal(opts.indexerId,30);
    assert.equal(opts.hydrationLimit,3); await opts.fetchImpl('http://prowlarr:9696/search',{});
    return {ok:true,partial:false,results:fixtures.map((e,i)=>({title:'MLB '+e.name+' 1080p',infoHash:String(i+1).repeat(40),seeders:5}))};
  }});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    assert.equal((await queue.run()).matched,2);
    assert.equal(queue.candidates(fixtures[0]).length,1); assert.equal(queue.candidates(fixtures[1]).length,1);
    assert.equal(queue.status().indexers[0].requests,1);
    assert.equal(queue.status().indexers[0].successes,1);
    assert.equal(queue.status().matchedEvents.length,2);
    assert.equal(queue.status().progress.eligible,2);
    assert.equal(queue.status().progress.matched,2);
    assert.equal(queue.status().progress.outstanding,0);
    assert.match(queue.status().eventStates[0].state,/playback check required/);
    assert.equal(queue.status().matchedEvents[0].name,fixtures[0].name);
    queue.enqueue(fixtures[0]); advance(120000);
    assert.equal((await queue.run()).skipped,'no-due-games'); assert.equal(calls,1);
  } finally {queue.close();}
});

test('success counts survive restart and count partial matched searches once',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sss-prowlarr-success-')),file=path.join(dir,'queue.sqlite');
  const {deps}=setup({search:async()=>({ok:true,partial:true,results:[1,2].map(i=>({title:'MLB Mets vs Yankees 1080p',infoHash:String(i).repeat(40),seeders:5,indexer:'RuTracker'}))})});
  let queue=discovery.createQueue(file,deps);
  try {
    await queue.run();queue.close();queue=discovery.createQueue(file,deps);
    assert.equal(queue.status().indexers[0].successes,1);
    assert.equal(queue.status().matchedEvents.length,1);
    assert.equal(queue.status().matchedEvents[0].releases,2);
    assert.deepEqual(queue.status().matchedEvents[0].indexers,['RuTracker']);
  } finally {queue.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('backlog estimates wait for measured history and failed searches remain distinguishable',async()=>{
  const events=Array.from({length:4},(_,i)=>({id:'mlb:'+(i+10),name:'Game '+i,date:'2026-09-'+String(11-i).padStart(2,'0')}));
  const {deps,advance}=setup({events:()=>events,search:async()=>({ok:true,partial:false,results:[]})});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    assert.equal(queue.status().progress.untouched,4);
    assert.equal(queue.status().progress.firstPassEstimateMs,null);
    for(let i=0;i<3;i++) { await queue.run(); advance(1800000); }
    const progress=queue.status().progress;
    assert.ok(progress.sampleEvents>=3);
    assert.ok(progress.firstPassEstimateMs!==null);
    assert.ok(queue.status().eventStates.some(e=>e.state==='No matches — awaiting retry'));
  } finally {queue.close();}
  const failure=setup({search:async()=>{throw new Error('indexer timed out');}});
  const failedQueue=discovery.createQueue(':memory:',failure.deps);
  try {
    await failedQueue.run();
    assert.ok(failedQueue.status().eventStates.some(e=>e.state==='Indexer failure — awaiting retry'));
    assert.equal(failedQueue.status().progress.searched,1);
  } finally {failedQueue.close();}
});

test('discovery page shows event names, successes and matched events without test playback controls',()=>{
  const store=require('../lib/store'),page=require('../lib/admin-prowlarr-discovery');
  const originals=[discovery.getDefault,store.getEvents];
  discovery.getDefault=()=>({status:()=>({options:{enabled:true,lookbackDays:7},matches:2,indexers:[{id:30,name:'RuTracker',requests:4,day:'2026-09-13',successes:1,failures:0}],
    jobs:[{event:'mlb:1',indexer:30,status:'matched'}],matchedEvents:[{event:'mlb:1',name:'Mets <vs> Yankees',date:'2026-09-11',indexers:['RuTracker'],releases:2}]})});
  store.getEvents=()=>[{...fixtures[0],name:'Mets <vs> Yankees'}];
  try {
    const html=page.render();assert.match(html,/Successes/);assert.match(html,/Successfully matched events/);
    assert.match(html,/Mets &lt;vs&gt; Yankees/);assert.doesNotMatch(html,/<td>mlb:1<\/td>/);
    assert.match(html,/action="\/admin\/prowlarr-discovery\/reset-cooldown"/);
    assert.match(html,/name="indexerId" value="30"/);
    assert.match(html,/aria-label="Reset cooldown for RuTracker" disabled/);
    assert.doesNotMatch(html,/Test playback|\/stream\//);
  } finally {[discovery.getDefault,store.getEvents]=originals;}
});
test('spacing, failure cooldown and fixture retries survive restart and repeated queue clicks',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sss-prowlarr-queue-')),file=path.join(dir,'queue.sqlite');
  let calls=0;
  const {deps,advance}=setup({search:async(q,opts)=>{calls++;await opts.fetchImpl('http://mock/search',{});return {ok:false,partial:true,results:[]};}});
  let queue=discovery.createQueue(file,deps);
  try {
    await queue.run(); queue.enqueue(fixtures[0]); queue.close(); queue=discovery.createQueue(file,deps);
    assert.equal((await queue.run()).skipped,'spacing'); advance(120000);
    assert.equal((await queue.run()).skipped,'no-due-games'); assert.equal(calls,1);
    assert.equal(queue.status().indexers[0].failures,1);
    assert.equal(queue.status().jobs[0].status,'incomplete');
  } finally {queue.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
test('daily budget is durable and rolls over without resetting indexer cooldowns',async()=>{
  const {deps,advance}=setup({search:async(q,opts)=>{await opts.fetchImpl('http://mock/search',{});return {ok:true,partial:false,results:[]};},
    options:()=>({enabled:true,intervalSeconds:120,dailyRequests:1,lookbackDays:30,timeoutSeconds:120})});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run(); advance(2*HOUR); assert.equal((await queue.run()).skipped,'no-due-games');
    assert.equal(queue.status().indexers[0].requests,1);
    advance(24*HOUR); await queue.run(); assert.equal(queue.status().indexers[0].requests,1);
  } finally {queue.close();}
});
test('general and indexer alias policies filter planned background queries',async()=>{
  let selected;
  const {deps}=setup({review:source=>({filter:queries=>queries.filter(q=>source==='prowlarr'? !q.startsWith('MLB '): !q.includes(' vs '))}),
    search:async(q)=>{selected=q[0];return {ok:true,partial:false,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {await queue.run();assert.ok(selected.includes(' @ '));} finally {queue.close();}
});
test('broad query zero results are shared across fixtures rather than repeated',async()=>{
  const queries=[];
  const {deps,advance}=setup({search:async(q)=>{queries.push(q[0]);return {ok:true,partial:false,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {await queue.run();advance(120000);await queue.run();assert.equal(queries.length,2);assert.equal(queries[0],'MLB 2026.09.11');assert.notEqual(queries[0],queries[1]);}
  finally {queue.close();}
});

test('untouched games receive a first search before recent due retries',async()=>{
  const events=Array.from({length:3},(_,i)=>({id:'mlb:'+i,name:'Game '+i,date:'2026-09-'+String(11-i).padStart(2,'0')}));
  const selected=[];
  const {deps,advance}=setup({events:()=>events,search:async(q)=>{selected.push(q[0]);return {ok:true,partial:false,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run();advance(2*HOUR);await queue.run();advance(2*HOUR);await queue.run();
    assert.deepEqual(selected,['MLB 2026.09.11','MLB 2026.09.10','MLB 2026.09.09']);
    assert.equal(queue.status().progress.untouched,0);
  } finally {queue.close();}
});

test('preseason week queries include their phase',async()=>{
  let selected;
  const event={id:'nfl:phase',name:'Cowboys at Giants',date:'2026-09-11',seasonSpan:'2026-2027',seasonPhase:'preseason',week:2};
  const {deps,promo}=setup({events:()=>[event],search:async(q)=>{selected=q[0];return {ok:true,partial:false,results:[]};}});
  promo.id='nfl';
  const queue=discovery.createQueue(':memory:',deps);
  try {await queue.run();assert.equal(selected,'NFL 2026-2027 PS W02');} finally {queue.close();}
});

test('hydration filters out covered fixtures and exposes matching titles without usable torrent metadata',async()=>{
  let calls=0;
  const {deps,advance}=setup({search:async(q,opts)=>{
    calls++;
    const covered={title:'MLB Mets vs Yankees 1080p',infoHash:'a'.repeat(40),seeders:5};
    const missing={title:'MLB Mariners vs Rangers 1080p',downloadUrl:'http://prowlarr/download'};
    if(calls===1) return {ok:true,partial:false,results:[covered]};
    assert.equal(opts.filterResults(covered),false,'covered games cannot consume hydration requests');
    assert.equal(opts.filterResults(missing),true);
    opts.onRawResults([missing]);
    return {ok:true,partial:false,results:[]};
  }});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run();advance(120000);await queue.run();
    assert.match(queue.status().eventStates.find(e=>e.id==='mlb:2').state,/Matching titles found/);
    assert.equal(queue.status().retryJobs.some(j=>j.event==='mlb:1'),false);
  } finally {queue.close();}
});

test('a batch search saves separate exact-date releases for consecutive MLB series games',async()=>{
  const promo=require('../lib/promotions').all.find(p=>p.id==='mlb');
  const events=[11,12,13].map(day=>({id:'mlb:series-'+day,name:'Pittsburgh Pirates vs Chicago Cubs',date:'2026-09-'+day}));
  const results=events.map((e,i)=>({title:'MLB 2026 / RS / '+[11,12,13][i]+'.09.2026 / Pittsburgh Pirates @ Chicago Cubs ('+(i+1)+'/3) [Baseball, WEB-DL HD/720p/60fps, MKV/H.264, EN/SNP]',infoHash:String(i+1).repeat(40),seeders:5,indexer:'720pier'}));
  const {deps,advance}=setup({events:()=>events,promotion:()=>promo,search:async()=>({ok:true,partial:false,results})});
  advance(24*HOUR);
  const queue=discovery.createQueue(':memory:',deps);
  try {
    assert.equal((await queue.run()).matched,3);
    for(let i=0;i<events.length;i++) {
      assert.deepEqual(queue.candidates(events[i]).map(c=>c.infoHash),[String(i+1).repeat(40)]);
    }
    assert.equal(queue.status().retryJobs.length,0);
  } finally {queue.close();}
});
test('indexer internal failure cannot create successful zero-hit alias evidence',async()=>{
  const observations=[];
  const {deps}=setup({statuses:async()=>[{indexerId:30,disabledTill:'2026-09-13T14:00:00Z'}],
    review:()=>({filter:q=>q,record:(...args)=>observations.push(args)}),
    search:async(q,opts)=>{opts.queryReview.record(q[0],'success',[],10);return {ok:true,partial:false,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {assert.equal((await queue.run()).partial,true);assert.equal(observations[0][1],'error');assert.equal(queue.status().indexers[0].failures,1);}
  finally {queue.close();}
});
test('playback serves local Prowlarr matches without any live indexer search',async()=>{
  const settings=require('../lib/settings'),pw=require('../lib/sources/prowlarr'),tb=require('../lib/sources/torbox-resolver');
  const availability=require('../lib/availability-index'),streams=require('../lib/streams')._test;
  const originals=[settings.getProwlarrDiscovery,settings.getCompanion,settings.getBitmagnet,settings.getProwlarr,settings.getSportVideo,discovery.getDefault,pw.multiSearch,tb.checkCachedBatch,availability.getDefault];
  const index=availability.createAvailabilityIndex({file:':memory:',secret:process.env.SESSION_SECRET});
  const candidate={title:'MLB Mets Yankees 1080p',infoHash:'a'.repeat(40),seeders:5};
  let searches=0;
  settings.getProwlarrDiscovery=()=>({enabled:true});settings.getCompanion=()=>({enabled:false});settings.getBitmagnet=()=>({enabled:false});settings.getSportVideo=()=>({enabled:false});
  settings.getProwlarr=()=>({enabled:true,liveSearchEnabled:false,url:'http://mock',apiKey:'fixture'});
  discovery.getDefault=()=>({candidates:()=>[candidate]});pw.multiSearch=async()=>{searches++;return {ok:true,results:[]};};
  tb.checkCachedBatch=async hashes=>new Set(hashes);availability.getDefault=()=>index;
  try {
    const rows=await streams.pipelineTorrentTorbox({promo:{id:'mlb',isRelevantStreamTitle:()=>({ok:true})},event:fixtures[0],titles:['Mets Yankees'],torboxKey:'account',log:()=>{},discoveryBudgetMs:1000,
      urlCtx:{origin:'http://sss.invalid',userId:'user',apiToken:'token',showWarmRows:false}});
    assert.equal(rows.length,1);assert.equal(searches,0);assert.match(rows[0].url,/resolve/);
  } finally {[settings.getProwlarrDiscovery,settings.getCompanion,settings.getBitmagnet,settings.getProwlarr,settings.getSportVideo,discovery.getDefault,pw.multiSearch,tb.checkCachedBatch,availability.getDefault]=originals;index.close();}
});

test('live search switch blocks direct and companion searches outside queue promotions',async()=>{
  const settings=require('../lib/settings'),pw=require('../lib/sources/prowlarr'),companion=require('../lib/sources/companion-scraper');
  const streams=require('../lib/streams')._test;
  const originals=[settings.getProwlarrDiscovery,settings.getCompanion,settings.getBitmagnet,settings.getProwlarr,settings.getSportVideo,pw.multiSearch,companion.scrape];
  let searches=0;
  settings.getProwlarrDiscovery=()=>({enabled:false});
  settings.getCompanion=()=>({enabled:true,url:'http://mock-companion'});
  settings.getProwlarr=()=>({enabled:true,liveSearchEnabled:false,url:'http://mock',apiKey:'fixture'});
  settings.getBitmagnet=()=>({enabled:false});settings.getSportVideo=()=>({enabled:false});
  pw.multiSearch=companion.scrape=async()=>{searches++;throw new Error('unexpected live request');};
  try {
    await streams.discoverTorrentCandidates({promo:{id:'ucl'},event:{id:'ucl:1',name:'Celtic vs LASK',date:'2026-09-11'},titles:['Celtic LASK'],log:()=>{},discoveryBudgetMs:1000,liveProwlarr:true});
    assert.equal(searches,0,'playback must not search when live search is off');
    await require('../lib/admin-promotions').researchAliases({}, {name:'UEFA Champions League',eventName:'Celtic vs LASK',eventDate:'2026-09-11'}, {
      prowlarrSearch:pw.multiSearch,companionSearch:companion.scrape,intelligenceSearch:companion.scrape});
    assert.equal(searches,1,'explicit admin research still searches direct Prowlarr');
  } finally {[settings.getProwlarrDiscovery,settings.getCompanion,settings.getBitmagnet,settings.getProwlarr,settings.getSportVideo,pw.multiSearch,companion.scrape]=originals;}
});
test('research retains unmatched titles without treating them as playback matches or retaining URLs',async()=>{
  const {deps}=setup({search:async(q,opts)=>{opts.onRawResults([{title:'Unknown baseball release 1080p',downloadUrl:'http://private/?apikey=secret',guid:'private',size:100}]);return {ok:true,partial:false,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {await queue.run();assert.equal(queue.candidates(fixtures[0]).length,0);const rows=queue.researchCandidates(fixtures[0]);assert.equal(rows.length,1);assert.equal(rows[0].title,'Unknown baseball release 1080p');assert.doesNotMatch(JSON.stringify(rows),/secret|downloadUrl|guid/);}
  finally {queue.close();}
});
test('manual resource matching saves an event-specific override without exposing source URLs',async()=>{
  const unrelated={title:'Uploader shorthand release',infoHash:'f'.repeat(40),seeders:3,indexer:'Manual Indexer',downloadUrl:'http://private/?apikey=secret'};
  const {deps}=setup({
    provider:()=>({enabled:false}),
    bitmagnet:()=>({url:'http://bitmagnet:3333',enabled:true}),
    bitmagnetSearch:async()=>({ok:true,results:[unrelated]}),
    manualProwlarrSearch:async()=>{throw new Error('disabled Prowlarr must not be searched');},
  });
  const queue=discovery.createQueue(':memory:',deps);
  try {
    const searched=await queue.manualSearch(fixtures[0],'Uploader shorthand');
    assert.deepEqual(searched.providers.map(row=>row.name),['Bitmagnet']);
    assert.equal(searched.candidates.length,1);
    assert.equal(searched.candidates[0].automatic,false);
    assert.doesNotMatch(JSON.stringify(queue.researchCandidates(fixtures[0])),/apikey|downloadUrl|private/);
    assert.deepEqual(queue.confirmManual(fixtures[0],unrelated.infoHash),{saved:1});
    assert.equal(queue.candidates(fixtures[0])[0].manualConfirmedEvent,fixtures[0].id);
    assert.equal(queue.status().eventStates.find(row=>row.id===fixtures[0].id).matched,true);
  } finally {queue.close();}
});

test('manual matching page offers event search and explicit database confirmation',()=>{
  const html=require('../lib/admin-prowlarr-discovery').renderManual({events:fixtures,event:fixtures[0],candidates:[
    {title:'Unsafe <title>',infoHash:'a'.repeat(40),indexer:'RuTracker',seeders:2,automatic:false},
  ]});
  assert.match(html,/Manual resource matching/);
  assert.match(html,/action="\/admin\/discovery\/manual\/search"/);
  assert.match(html,/action="\/admin\/discovery\/manual\/save"/);
  assert.match(html,/Manual confirmation needed/);
  assert.match(html,/Unsafe &lt;title&gt;/);
});
test('Prowlarr source reuses recovered hashes without requesting metadata again',async()=>{
  const settings=require('../lib/settings'),source=require('../lib/sources/prowlarr'),{Response}=require('node-fetch');
  const original=settings.getProwlarr;
  settings.getProwlarr=()=>({url:'http://prowlarr.invalid',apiKey:'fixture'});
  const values=new Map(),hashCache={get:url=>values.get(url),set:(url,value)=>values.set(url,value)};
  let searches=0,downloads=0;
  const fetchImpl=async url=>{
    if (url.includes('/api/v1/search?')) {searches++;assert.ok(url.includes('indexerIds=30'));return new Response(JSON.stringify([{title:'MLB Mets Yankees',downloadUrl:'/download/one',seeders:10,indexer:'RuTracker'}]));}
    downloads++;return new Response(null,{status:302,headers:{location:'magnet:?xt=urn:btih:'+'a'.repeat(40)}});
  };
  try {
    for (let i=0;i<2;i++) assert.equal((await source.multiSearch(['Mets Yankees'],{detailed:true,indexerId:30,hashCache,fetchImpl,hydrationLimit:3,hydrationConcurrency:1})).results.length,1);
    assert.equal(searches,2);assert.equal(downloads,1);
  } finally {settings.getProwlarr=original;}
});

test('limited hash recovery saves matches without cooling down a healthy indexer',async()=>{
  const settings=require('../lib/settings'),source=require('../lib/sources/prowlarr'),{Response}=require('node-fetch');
  const original=settings.getProwlarr;
  settings.getProwlarr=()=>({url:'http://prowlarr.invalid',apiKey:'fixture'});
  let downloads=0;
  const {deps}=setup({search:async(q,opts)=>source.multiSearch(q,{...opts,fetchImpl:async url=>{
    if (url.includes('/api/v1/search?')) return new Response(JSON.stringify(Array.from({length:10},(_,i)=>({
      title:'MLB Mets vs Yankees 1080p',downloadUrl:'/download/'+i,seeders:10,indexer:'RuTracker'}))));
    downloads++;return new Response(null,{status:302,headers:{location:'magnet:?xt=urn:btih:'+String(downloads).repeat(40)}});
  }})});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    const result=await queue.run();
    assert.equal(downloads,3);assert.equal(result.matched,3);assert.equal(result.partial,false);
    assert.equal(queue.status().indexers[0].failures,0);
    assert.equal(queue.status().indexers[0].successes,1);
    assert.equal(queue.candidates(fixtures[0]).length,3);
  } finally {queue.close();settings.getProwlarr=original;}
});

test('real Prowlarr search and metadata failures still cool down the indexer',async()=>{
  const settings=require('../lib/settings'),source=require('../lib/sources/prowlarr'),{Response}=require('node-fetch');
  const original=settings.getProwlarr;
  settings.getProwlarr=()=>({url:'http://prowlarr.invalid',apiKey:'fixture'});
  try {
    for (const failure of ['search','metadata-http','metadata-timeout']) {
      const {deps}=setup({search:async(q,opts)=>source.multiSearch(q,{...opts,fetchImpl:async url=>{
        if (url.includes('/api/v1/search?')) {
          if (failure==='search') throw new Error('request timed out');
          return new Response(JSON.stringify([{title:'MLB Mets vs Yankees',downloadUrl:'/download/one',seeders:10,indexer:'RuTracker'}]));
        }
        if (failure==='metadata-timeout') throw new Error('request timed out');
        return new Response('unavailable',{status:503});
      }})});
      const queue=discovery.createQueue(':memory:',deps);
      try {
        assert.equal((await queue.run()).partial,true,failure);
        assert.equal(queue.status().indexers[0].failures,1,failure);
      } finally {queue.close();}
    }
  } finally {settings.getProwlarr=original;}
});

test('a healthy limited search resets previous consecutive failures',async()=>{
  let calls=0;
  const {deps,advance}=setup({search:async()=>++calls===1
    ? {ok:false,partial:true,upstreamFailed:true,results:[]}
    : {ok:true,partial:true,upstreamFailed:false,results:[]}});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run();assert.equal(queue.status().indexers[0].failures,1);
    advance(2*HOUR);assert.equal((await queue.run()).partial,false);
    assert.equal(queue.status().indexers[0].failures,0);
  } finally {queue.close();}
});

test('manual cooldown reset is durable and preserves budgets, successes and fixture retries',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sss-cooldown-reset-')),file=path.join(dir,'queue.sqlite');
  const {deps,advance}=setup({search:async(q,opts)=>{
    await opts.fetchImpl('http://mock/search',{});
    return {ok:true,partial:true,upstreamFailed:true,results:[{title:'MLB Mets vs Yankees',infoHash:'a'.repeat(40),seeders:5}]};
  }});
  let queue=discovery.createQueue(file,deps);
  try {
    await queue.run();const before=queue.status();
    assert.equal(before.indexers[0].failures,1);
    assert.throws(()=>queue.resetCooldown('invalid'),/valid indexer/);
    assert.throws(()=>queue.resetCooldown(999),/not found/);
    assert.deepEqual(queue.resetCooldown('30'),{reset:true});
    queue.close();queue=discovery.createQueue(file,deps);
    const after=queue.status();
    assert.equal(after.indexers[0].failures,0);assert.equal(after.indexers[0].next_at,0);
    assert.equal(after.indexers[0].requests,before.indexers[0].requests);
    assert.equal(after.indexers[0].day,before.indexers[0].day);
    assert.equal(after.indexers[0].successes,before.indexers[0].successes);
    assert.deepEqual(after.jobs,before.jobs);assert.equal(after.matches,before.matches);
    assert.deepEqual(queue.resetCooldown(30),{reset:false});
    assert.equal((await queue.run()).skipped,'spacing');
    advance(120000);await queue.run();assert.equal(queue.status().indexers[0].requests,2);
  } finally {queue.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('cooldown reset cannot bypass an exhausted daily budget',async()=>{
  let calls=0;
  const {deps,advance}=setup({
    options:()=>({enabled:true,intervalSeconds:120,dailyRequests:1,lookbackDays:30,timeoutSeconds:120}),
    search:async(q,opts)=>{calls++;await opts.fetchImpl('http://mock/search',{});return {ok:false,partial:true,results:[]};}
  });
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run();queue.resetCooldown(30);advance(120000);
    assert.equal((await queue.run()).skipped,'no-due-games');
    assert.equal(calls,1);assert.equal(queue.status().indexers[0].requests,1);
  } finally {queue.close();}
});

// Search now: the queue's pacing is skipped on request, its protections are not.
const finished = async (queue) => { for (let i = 0; i < 1000 && !(queue.status().sweep || {}).finishedAt; i++) await new Promise((r) => setImmediate(r)); return queue.status().sweep; };
const spread = [{id:'mlb:1',name:'Mets vs Yankees',date:'2026-09-11'},{id:'mlb:2',name:'Mariners vs Rangers',date:'2026-09-10'},{id:'nba:3',name:'Lakers vs Celtics',date:'2026-09-11'}];

test('Search now searches each missing game of a promotion once, straight away',async()=>{
  const searched=[];
  const {deps}=setup({events:()=>spread,sleep:async()=>{},indexers:async()=>[{id:30,name:'RuTracker'},{id:31,name:'720pier'}],
    search:async(queries,opts)=>{searched.push(opts.indexerId+':'+queries[0]);return {ok:true,partial:false,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run(); // the queue's own search: now every game and indexer is "waiting"
    assert.equal((await queue.run()).skipped,'spacing');
    const started=queue.searchNow({promotion:'mlb'});
    assert.equal(started.planned,2);
    const sweep=await finished(queue);
    assert.deepEqual(sweep.searches.map(s=>s.eventId),['mlb:2','mlb:1'],'one search per game, never-searched first, only MLB');
    assert.equal(searched.length,3);
    assert.ok(sweep.searches.every(s=>s.indexer==='RuTracker'),'the proven indexer is still preferred');
    assert.equal(sweep.note,'');
  } finally {queue.close();}
});

test('Search now for one game tries each indexer until it matches',async()=>{
  const {deps}=setup({events:()=>spread,sleep:async()=>{},indexers:async()=>[{id:30,name:'RuTracker'},{id:31,name:'720pier'},{id:32,name:'Knaben'}],
    search:async(_q,opts)=>({ok:true,partial:false,results:opts.indexerId===31?[{title:'MLB Mariners vs Rangers 1080p',infoHash:'a'.repeat(40),seeders:4}]:[]})});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    queue.searchNow({eventId:'mlb:2'});
    const sweep=await finished(queue);
    assert.deepEqual(sweep.searches.map(s=>s.indexer),['RuTracker','720pier'],'stops at the first match');
    assert.equal(sweep.matched,1);
    assert.throws(()=>queue.searchNow({eventId:'mlb:2'}),/already has a saved, seeded match/);
  } finally {queue.close();}
});

test('Search now keeps failure cooldowns and refuses what it cannot do',async()=>{
  let calls=0;
  const {deps}=setup({events:()=>spread,sleep:async()=>{},search:async()=>{calls++;return {ok:false,upstreamFailed:true,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    await queue.run(); // fails: the only indexer cools down
    assert.equal(calls,1);
    queue.searchNow({promotion:'mlb'});
    const sweep=await finished(queue);
    assert.equal(calls,1,'a failing indexer is not searched');
    assert.match(sweep.note,/cooling down or out of budget/);
    assert.throws(()=>queue.searchNow({promotion:'ucl'}),/Add this promotion to the Prowlarr queue first/);
    assert.throws(()=>queue.searchNow({eventId:'mlb:404'}),/Choose a selected past event/);
  } finally {queue.close();}
  const off=discovery.createQueue(':memory:',{...deps,options:()=>({enabled:false,intervalSeconds:120,dailyRequests:10,lookbackDays:30,timeoutSeconds:120})});
  try { assert.throws(()=>off.searchNow({}),/switched off/); } finally {off.close();}
});

test('only one Search now runs at a time',async()=>{
  let release;
  const {deps}=setup({events:()=>spread,sleep:async()=>{},search:()=>new Promise(r=>{release=()=>r({ok:true,partial:false,results:[]});})});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    queue.searchNow({promotion:'mlb'});
    assert.throws(()=>queue.searchNow({promotion:'nba'}),/already running/);
    for (let i=0;i<50 && !release;i++) await new Promise(r=>setImmediate(r));
    release(); await new Promise(r=>setImmediate(r));
    for (let i=0;i<50 && !(queue.status().sweep.searches.length>1);i++) { if (release) release(); await new Promise(r=>setImmediate(r)); }
    await finished(queue);
  } finally {queue.close();}
});

// Found on 2026-09-25: the queue's timer started a search between two of the
// sweep's, and the sweep stopped with "Prowlarr discovery was switched off".
test('Search now waits out an in-flight search, and the queue timer stands aside while it runs',async()=>{
  let release;const calls=[];
  const {deps}=setup({events:()=>spread,sleep:async()=>{await new Promise(r=>setImmediate(r));},
    search:(q,opts)=>{calls.push(opts.indexerId);return new Promise(r=>{release=()=>r({ok:true,partial:false,results:[]});});}});
  const queue=discovery.createQueue(':memory:',deps);
  try {
    const scheduled=queue.run();           // the timer's own search is in flight
    for (let i=0;i<20 && !release;i++) await new Promise(r=>setImmediate(r));
    queue.searchNow({promotion:'mlb'});    // its first attempt finds the queue busy
    for (let i=0;i<5;i++) await new Promise(r=>setImmediate(r));
    release(); release=null; await scheduled;
    assert.equal((await queue.run()).skipped,'sweep','the timer does not run while Search now is active');
    for (let i=0;i<200 && !(queue.status().sweep||{}).finishedAt;i++) { if (release) {release();release=null;} await new Promise(r=>setImmediate(r)); }
    const sweep=queue.status().sweep;
    assert.ok(sweep.finishedAt);
    assert.equal(sweep.searches.length,2,'both MLB games, after waiting for the timer');
    assert.doesNotMatch(sweep.note,/switched off/);
  } finally {queue.close();}
});
