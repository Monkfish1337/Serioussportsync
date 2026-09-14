'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {render}=require('../lib/admin-discovery');
const base={tab:'events',selected:null,promotions:[{id:'mlb',name:'MLB'},{id:'nfl',name:'NFL'}],
  events:[{id:'mlb:1',name:'Pirates vs Cubs',date:'2026-09-12'}],
  queue:{eventStates:[{id:'mlb:1',name:'Pirates vs Cubs',date:'2026-09-12',matched:true,state:'Saved match'}]},
  releases:[{matches:[{eventId:'mlb:1'},{eventId:'mlb:1'}]}]};
test('Discovery merges source provenance into one event row without claiming playback availability',()=>{
  const html=render(base);
  assert.equal(html.split('Pirates vs Cubs').length-1,1);
  assert.match(html,/Prowlarr, Sport-Video/);
  assert.match(html,/does not guarantee playable links/);
});
test('Discovery promotion filter excludes other events and escapes flash text',()=>{
  const html=render({...base,promotion:'nfl',flash:'<script>unsafe</script>'});
  assert.doesNotMatch(html,/Pirates vs Cubs/);
  assert.match(html,/&lt;script&gt;/);
});
test('saved Prowlarr coverage remains visible when the event leaves the active queue',()=>{
  const html=render({...base,releases:[],queue:{eventStates:[],matchedEvents:[{id:'mlb:1'}]}});
  assert.match(html,/Pirates vs Cubs/);
  assert.match(html,/<td>Prowlarr<\/td>/);
});
test('source promotion selection preserves empty selections and Overview is removed',()=>{
  const empty=render({...base,tab:'preparation',selection:{source:'bitmagnet',ids:[]}});
  assert.doesNotMatch(empty,/ checked/);
  assert.match(empty,/0 selected/);
  assert.match(empty,/\/admin\/discovery\/bitmagnet\/promotions/);
  assert.match(render({...base,tab:'preparation',selection:{source:'bitmagnet',ids:null}}),/ checked/);
  assert.doesNotMatch(render({...base,tab:'overview'}),/>Overview</);
});
