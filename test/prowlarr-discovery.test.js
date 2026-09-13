'use strict';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'query-queue-test-secret-0000000000000000000000000000';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const discovery = require('../lib/prowlarr-discovery');
const HOUR = 3600000;
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
    queue.enqueue(fixtures[0]); advance(120000);
    assert.equal((await queue.run()).skipped,'no-due-games'); assert.equal(calls,1);
  } finally {queue.close();}
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
  settings.getProwlarr=()=>({enabled:true,url:'http://mock',apiKey:'fixture'});
  discovery.getDefault=()=>({candidates:()=>[candidate]});pw.multiSearch=async()=>{searches++;return {ok:true,results:[]};};
  tb.checkCachedBatch=async hashes=>new Set(hashes);availability.getDefault=()=>index;
  try {
    const rows=await streams.pipelineTorrentTorbox({promo:{id:'mlb',isRelevantStreamTitle:()=>({ok:true})},event:fixtures[0],titles:['Mets Yankees'],torboxKey:'account',log:()=>{},discoveryBudgetMs:1000,
      urlCtx:{origin:'http://sss.invalid',userId:'user',apiToken:'token',showWarmRows:false}});
    assert.equal(rows.length,1);assert.equal(searches,0);assert.match(rows[0].url,/resolve/);
  } finally {[settings.getProwlarrDiscovery,settings.getCompanion,settings.getBitmagnet,settings.getProwlarr,settings.getSportVideo,discovery.getDefault,pw.multiSearch,tb.checkCachedBatch,availability.getDefault]=originals;index.close();}
});
test('research retains unmatched titles without treating them as playback matches or retaining URLs',async()=>{
  const {deps}=setup({search:async(q,opts)=>{opts.onRawResults([{title:'Unknown baseball release 1080p',downloadUrl:'http://private/?apikey=secret',guid:'private',size:100}]);return {ok:true,partial:false,results:[]};}});
  const queue=discovery.createQueue(':memory:',deps);
  try {await queue.run();assert.equal(queue.candidates(fixtures[0]).length,0);const rows=queue.researchCandidates(fixtures[0]);assert.equal(rows.length,1);assert.equal(rows[0].title,'Unknown baseball release 1080p');assert.doesNotMatch(JSON.stringify(rows),/secret|downloadUrl|guid/);}
  finally {queue.close();}
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
