'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {coverage,recentEvents}=require('../lib/discovery-coverage');
const now=Date.parse('2026-09-14T12:00:00Z');
const events=[1,2,3,4].map(id=>({id:'mlb:'+id,name:'Game '+id,date:'2026-09-12'}));
const base={events,promotions:[{id:'mlb',enabled:true}],queue:{options:{enabled:true,promotions:['mlb']},eventStates:[],matchedEvents:[]},releases:[],indexTitles:[],relevant:()=>true};
test('seven-day coverage deduplicates events and excludes future, cancelled and out-of-window fixtures',()=>{
  assert.equal(recentEvents([...events,events[0],{id:'mlb:old',date:'2026-09-01'},{id:'mlb:future',date:'2026-09-15'},{id:'mlb:cancel',date:'2026-09-12',status:'cancelled'}],now).length,4);
});
test('coverage counts usable identities once and leaves title-only matches missing',()=>{
  const result=coverage({...base,queue:{...base.queue,eventStates:[{id:'mlb:1',matched:true,seeded:true,state:'Matched'}]},
    releases:[{infoHash:'a'.repeat(40),matches:[{eventId:'mlb:1'},{eventId:'mlb:2'}]},{matches:[{eventId:'mlb:3'}]}],
    indexTitles:[{eventId:'mlb:2',title:'Usable title',usable:1},{eventId:'mlb:4',title:'Metadata only',usable:0}]},now);
  assert.equal(result.total,4);assert.equal(result.matched,2);assert.equal(result.missing,2);assert.equal(result.titleOnly,2);
  assert.equal(result.promotions[0].matched,2);
  assert.match(result.rows.find(e=>e.id==='mlb:3').reason,/torrent hash not retained/);
});
test('database candidates must pass relevance before contributing to coverage',()=>{
  assert.equal(coverage({...base,indexTitles:[{eventId:'mlb:1',title:'Wrong game',usable:1}],relevant:()=>false},now).matched,0);
});

test('removed and disabled promotions cannot inflate coverage totals, matches or missing-event lists',()=>{
  const retired=[...require('../lib/sources/release-ingest').RETIRED_PROMOTIONS];
  const stale=[...retired,'deleted-custom'].map(id=>({id:id+':old',name:'Stored old event',date:'2026-09-12'}));
  const current=[...events,{id:'custom:1',date:'2026-09-12'},{id:'disabled:1',date:'2026-09-12'},
    {id:'mlb-nym:1',date:'2026-09-12'},
    {id:'discovered-football:1',date:'2026-09-12'}];
  const promotions=[...base.promotions,{id:'custom'},{id:'disabled',enabled:false},
    {id:'mlb-nym',enabled:true,autoTeam:true},
    {id:'discovered-football',enabled:true,releaseDerived:true}];
  const excluded=[...stale,...current.filter(e=>e.id.startsWith('disabled:')
    || e.id.startsWith('discovered-') || e.id.startsWith('mlb-nym:'))];
  const result=coverage({...base,events:[...current,...stale],promotions,
    releases:[{infoHash:'a'.repeat(40),matches:excluded.map(e=>({eventId:e.id}))}],
    queue:{...base.queue,eventStates:excluded.map(e=>({id:e.id,matched:true,seeded:true})),
      matchedEvents:excluded.map(e=>({event:e.id,warmable:true}))},
    indexTitles:excluded.map(e=>({eventId:e.id,title:'Old match',usable:1}))},now);
  assert.equal(result.total,5);assert.equal(result.matched,0);assert.equal(result.missing,5);
  assert.equal(result.titleOnly,0);
  assert.deepEqual(result.promotions.map(p=>p.id),['custom','mlb']);
  assert.deepEqual(result.rows.map(e=>e.id),current.filter(e=>!e.id.startsWith('disabled:')
    && !e.id.startsWith('discovered-') && !e.id.startsWith('mlb-nym:')).map(e=>e.id));
  assert.deepEqual(recentEvents([...current,...stale],now,promotions).map(e=>e.id),result.rows.map(e=>e.id));
});

test('release-derived catalogs are excluded while independent fixture promotions remain',()=>{
  const sourceOnly={id:'discovered-rugby:one',name:'Imported title',date:'2026-09-12'};
  const fixture={id:'rugby:one',name:'Scheduled game',date:'2026-09-12'};
  const data={...base,events:[sourceOnly,fixture],promotions:[
    {id:'discovered-rugby',enabled:true,releaseDerived:true},
    {id:'rugby',enabled:true,releaseDerived:false}],
    releases:[{infoHash:'a'.repeat(40),matches:[{eventId:sourceOnly.id},{eventId:fixture.id}]}]};
  const result=coverage(data,now);
  assert.equal(result.total,1);
  assert.equal(result.matched,1);
  assert.deepEqual(result.promotions.map(p=>p.id),['rugby']);
  assert.deepEqual(result.rows.map(e=>e.id),[fixture.id]);
});
test('missing reasons preserve recorded failure and mark incomplete database evidence',()=>{
  const queue={...base.queue,eventStates:[{id:'mlb:1',state:'Indexer failure — awaiting retry'}]};
  assert.match(coverage({...base,queue},now).rows[0].reason,/Indexer failure/);
  assert.match(coverage({...base,coverageError:'unavailable'},now).rows[0].reason,/Coverage incomplete/);
});

// Issue #65: a saved hash is not playback. Diamondbacks @ Rockies (23 Sept)
// was saved from 720pier and not cached on TorBox.
test('playable coverage splits saved events into cached, not cached and not checked',()=>{
  const h=(c)=>c.repeat(40);
  const states=new Map([[h('a'),'cached'],[h('b'),'not-cached']]);
  let asked=[];
  const result=coverage({...base,
    queue:{...base.queue,eventStates:[{id:'mlb:1',matched:true,seeded:true,state:'Matched'}]},
    queueHashes:(event)=>event.id==='mlb:1' ? [h('a')] : [],
    releases:[{infoHash:h('b'),matches:[{eventId:'mlb:2'}]}],
    indexTitles:[{eventId:'mlb:3',title:'Usable',usable:1,hash:h('c')}],
    torboxStates:(hashes)=>{asked=hashes;return states;}},now);
  assert.deepEqual(asked.sort(),[h('a'),h('b'),h('c')],'every saved hash is asked about once');
  assert.deepEqual(result.rows.map(e=>[e.id,e.torbox]),[['mlb:1','cached'],['mlb:2','not-cached'],['mlb:3','unchecked'],['mlb:4',null]]);
  assert.deepEqual(result.playable,{cached:1,notCached:1,unchecked:1});
  const group=result.promotions[0];
  assert.deepEqual([group.matched,group.cached,group.notCached,group.unchecked],[3,1,1,1]);
});

test('without TorBox data, coverage behaves as before',()=>{
  const result=coverage({...base,releases:[{infoHash:'a'.repeat(40),matches:[{eventId:'mlb:1'}]}]},now);
  assert.equal(result.playable,null);
  assert.equal(result.rows[0].torbox,null);
});

test('TorBox states come from any account and only count recent checks',()=>{
  const {createAvailabilityIndex}=require('../lib/availability-index');
  let clock=now;
  const index=createAvailabilityIndex({file:':memory:',secret:'coverage-test-secret-000000000000000000000000',now:()=>clock});
  try {
    const c=(x)=>({infoHash:x.repeat(40),title:'MLB '+x});
    index.observe({provider:'torbox',scope:'account-1',state:'cached',candidate:c('a')});
    index.observe({provider:'torbox',scope:'account-2',state:'unavailable',candidate:c('b')});
    index.observe({provider:'torbox',scope:'account-1',state:'cached',candidate:c('d'),observedAt:now-72*3600000});
    const states=index.torboxStates(['a','b','c','d'].map(x=>x.repeat(40)));
    assert.equal(states.get('a'.repeat(40)),'cached');
    assert.equal(states.get('b'.repeat(40)),'not-cached');
    assert.equal(states.has('c'.repeat(40)),false,'never checked');
    assert.equal(states.has('d'.repeat(40)),false,'checked too long ago');
  } finally {index.close();}
});
