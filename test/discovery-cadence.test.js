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
