'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readyAt,retryDelay,retryAfter}=require('../lib/discovery-cadence');
const HOUR=3600000;
test('playing and publication allowance varies by sport and unknown times remain conservative',()=>{
  const event={id:'mlb:1',date:'2026-09-14',time:'12:00:00'};
  const start=Date.parse('2026-09-14T12:00:00Z');
  assert.equal(readyAt(event),start+4*HOUR);
  assert.equal(readyAt({...event,id:'nba:1'}),start+3.5*HOUR);
  assert.equal(readyAt({...event,id:'ucl:1'}),start+3*HOUR);
  assert.equal(readyAt({...event,time:null}),Date.parse('2026-09-15T05:59:59Z'));
});
test('missing recent events retry sooner while older gaps consume less budget',()=>{
  const event={id:'mlb:1',date:'2026-09-14',time:'12:00:00'},ready=readyAt(event);
  assert.equal(retryDelay(event,ready+HOUR,false),HOUR);
  assert.equal(retryDelay(event,ready+HOUR,true),6*HOUR);
  assert.equal(retryDelay(event,ready+48*HOUR,false),2*HOUR);
  assert.equal(retryDelay(event,ready+120*HOUR,true),24*HOUR);
});
test('upstream retry delays support seconds, dates and malformed values',()=>{
  const now=Date.parse('2026-09-14T12:00:00Z');
  assert.equal(retryAfter('7200',now),2*HOUR);
  assert.equal(retryAfter('Mon, 14 Sep 2026 15:00:00 GMT',now),3*HOUR);
  assert.equal(retryAfter('invalid',now),0);
});
// Real MLB record, 2026-09-23: a 7:10pm Pacific game is dated on the local day
// with a UTC clock time from the next day. date+time put it 24 hours early, so
// discovery searched every evening game west of Eastern before it was played.
test('a late game opens discovery after it is played, not a day before',()=>{
  const {startAt}=require('../lib/discovery-cadence');
  const game={id:'mlb:1',date:'2026-09-23',time:'02:10:00',timestamp:'2026-09-24T02:10:00Z'};
  assert.equal(startAt(game),Date.parse('2026-09-24T02:10:00Z'));
  assert.equal(readyAt(game),Date.parse('2026-09-24T06:10:00Z'));
  // TheSportsDB timestamps carry no zone designator and are UTC.
  assert.equal(startAt({date:'2026-09-21',timestamp:'2026-09-22T00:00:00'}),Date.parse('2026-09-22T00:00:00Z'));
  const coverage=require('../lib/discovery-coverage');
  const now=Date.parse('2026-09-23T12:00:00Z');
  assert.equal(coverage.recentEvents([game],now).length,0,'not counted missing before first pitch');
  assert.equal(require('../lib/prowlarr-discovery').eligible([game],now,7).length,0);
  assert.equal(coverage.recentEvents([{...game,id:'mlb:2',status:'Postponed',timestamp:'2026-09-20T02:10:00Z',date:'2026-09-19'}],now).length,0);
});
test('MLB and ESPN game status reaches the event so postponed games are skipped',()=>{
  const transform=require('../lib/transform'),promotions=require('../lib/promotions'),mlb=require('../lib/sources/mlb');
  const promo=promotions.all.find(p=>p.id==='mlb');
  const raw=mlb.toRaw({gamePk:1,officialDate:'2026-09-20',gameDate:'2026-09-20T23:05:00Z',status:{detailedState:'Postponed'},
    teams:{away:{team:{id:1,name:'Texas Rangers'}},home:{team:{id:2,name:'New York Mets'}}}});
  assert.equal(transform.fromWiki(raw,promo).status,'Postponed');
  assert.equal(transform.fromWiki({sourceId:'9',name:'A at B',date:'2026-09-20',source:{type:'espn',status:'STATUS_POSTPONED'}},promo).status,'STATUS_POSTPONED');
});
// Live Prowlarr log, 2026-09-24: "Orioles Blue Jays 22.09.2026" for a game on
// the 23rd. MLB stores the local date; the day-before form is for ESPN's UTC one.
test('MLB searches never ask for the day before; ESPN night games still do',()=>{
  const promotions=require('../lib/promotions');
  const mlb=promotions.all.find(p=>p.id==='mlb'),nfl=promotions.all.find(p=>p.id==='nfl');
  const game={id:'mlb:824784',name:'Toronto Blue Jays vs Baltimore Orioles',date:'2026-09-23',time:'22:35:00',timestamp:'2026-09-23T22:35:00Z',
    teamNames:{away:['Toronto Blue Jays','Blue Jays'],home:['Baltimore Orioles','Orioles']}};
  assert.equal(mlb.searchTitles(game).some(q=>/22\.09\.2026|2026\.09\.22/.test(q)),false);
  assert.ok(mlb.searchTitles(game).includes('Orioles Blue Jays 23.09.2026'));
  const night={id:'nfl:1',name:'Arizona Cardinals at Green Bay Packers',date:'2026-08-29',time:'00:00',timestamp:'2026-08-29T00:00Z'};
  assert.ok(nfl.searchTitles(night).some(q=>/28\.08\.2026|2026\.08\.28/.test(q)));
});
