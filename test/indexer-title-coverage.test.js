'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const espn = require('../lib/sources/espn');
const transform = require('../lib/transform');
const promotion = id => promotions.all.find(p => p.id === id);

test('observed MLB nickname and @ releases retain exact fixture date checks', () => {
  const event = {name:'New York Yankees at New York Mets',date:'2026-05-16'};
  const title = 'MLB.RS.16.05.2026.Yankees@Mets.FOX.IPTV.720p.60fps.EN.mkv';
  assert.equal(promotion('mlb').isRelevantStreamTitle(title,event).ok,true);
  assert.equal(promotion('mlb').isRelevantStreamTitle(title,{...event,date:'2026-05-20'}).ok,false);
  assert.equal(promotion('mlb').isRelevantStreamTitle(title,{...event,name:'New York Yankees at Boston Red Sox'}).ok,false);
});

test('observed NFL preseason titles cannot masquerade as regular-season week matches', () => {
  const event = {name:'Tennessee Titans at San Francisco 49ers',date:'2026-09-13',week:1,seasonSpan:'2026-2027'};
  const title = 'NFL.2026-2027.PS.W01.Titans-49ers.mkv';
  assert.equal(promotion('nfl').isRelevantStreamTitle(title,event).ok,false);
  assert.equal(promotion('nfl').isRelevantStreamTitle('NFL.W01.Titans-49ers.mkv',event).ok,false);
  assert.equal(promotion('nfl').isRelevantStreamTitle('NFL.2026-2027.W01.Titans-49ers.mkv',event).ok,true);
  assert.equal(promotion('nfl').isRelevantStreamTitle(title,{...event,seasonPhase:'preseason'}).ok,true);
  const dated = {name:'San Francisco 49ers at Las Vegas Raiders',date:'2026-08-27'};
  assert.equal(promotion('nfl').isRelevantStreamTitle('NFL Pre Season 2026 08 27 49ers Vs Raiders 1080p HDTV H264-DARKSPORT',dated).ok,true);
});

test('ESPN season phase survives refresh without guessing preseason release weeks', () => {
  const input = {season:{type:1,year:2026},week:{number:2}};
  assert.equal(espn.seasonPhaseOf(input),'preseason');
  assert.equal(espn.weekOf(input),null);
  const event = transform.fromWiki({sourceId:'phase',name:'Titans at 49ers',date:'2026-08-13',seasonPhase:'preseason'},promotion('nfl'));
  assert.equal(event.seasonPhase,'preseason');
});

test('NBA Finals prefix matches while Summer League and sample files stay excluded', () => {
  const event = {name:'Miami Heat at Boston Celtics',date:'2023-05-29'};
  assert.equal(promotion('nba').isRelevantStreamTitle('sportsnet-nba east conference finals 2023 05 29 miami heat vs boston celtics 1080p web h264',event).ok,true);
  const summer = {name:'Golden State Warriors at Memphis Grizzlies',date:'2026-07-19'};
  assert.equal(promotion('nba').isRelevantStreamTitle('NBA Summer League 2026 07 19 Golden State Warriors vs Memphis Grizzlies 1080p WEB h264-BILLIE',summer).ok,false);
  const sample = 'NFL Pre Season 2026 08 27 49ers Vs Raiders 1080p HDTV H264 DARKSPORT sample.mkv';
  assert.equal(promotion('nfl').isRelevantStreamTitle(sample,{name:'49ers at Raiders',date:'2026-08-27'}).reason,'excluded:sample');
});
