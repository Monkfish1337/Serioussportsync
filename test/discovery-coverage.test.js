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
  assert.match(result.rows.find(e=>e.id==='mlb:3').reason,/not prepared/);
});
test('database candidates must pass relevance before contributing to coverage',()=>{
  assert.equal(coverage({...base,indexTitles:[{eventId:'mlb:1',title:'Wrong game',usable:1}],relevant:()=>false},now).matched,0);
});
test('missing reasons preserve recorded failure and mark incomplete database evidence',()=>{
  const queue={...base.queue,eventStates:[{id:'mlb:1',state:'Indexer failure — awaiting retry'}]};
  assert.match(coverage({...base,queue},now).rows[0].reason,/Indexer failure/);
  assert.match(coverage({...base,coverageError:'unavailable'},now).rows[0].reason,/Coverage incomplete/);
});
