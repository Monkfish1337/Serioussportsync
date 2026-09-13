'use strict';
process.env.SESSION_SECRET ||= 'query-review-test-secret-000000000000000000000000';
const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../lib/query-review');
const promo = {id:'mlb', name:'MLB', isRelevantStreamTitle: title => ({ok:title.includes('Mets')})};
test('query evidence separates outcomes, future fixtures and duplicate matches', () => {
  const db = review.createReview(':memory:', () => Date.parse('2026-09-13'));
  try {
    for (let i=0;i<5;i++) {
      const ctx = db.context('prowlarr',promo,{id:'mlb:'+i,date:'2026-09-01'});
      ctx.record('Mets Yankees 2026.09.01','success',[],100);
      ctx.record('Mets Yankees 2026.09.01','success',[],100);
    }
    const ctx = db.context('prowlarr',promo,{id:'mlb:future',date:'2099-01-01'});
    ctx.record('Mets Yankees 2099.01.01','success',[],100);
    ctx.record('Mets Yankees 2099.01.01','timeout',[],1000);
    ctx.record('Mets Yankees 2099.01.01','error',[],5);
    ctx.finish(['Mets Yankees 2099.01.01','never offered']);
    const row = db.rows('mlb').find(row => row.pattern==='mets yankees {date}');
    assert.equal(row.completed,11); assert.equal(row.zeros,11);
    assert.equal(row.timeouts,1); assert.equal(row.errors,1);
    assert.equal(row.pastFixtures,5); assert.equal(row.flag,'Repeated zero hits');
    assert.equal(db.rows('mlb').find(row => row.pattern==='never offered').unattempted,1);
    const matches = db.context('bitmagnet',promo,{id:'mlb:good',date:'2026-09-01'});
    matches.record('first','success',[{title:'Mets game'},{title:'unrelated'}],100);
    matches.record('second','success',[{title:'Mets game'}],100);
    const rows = db.rows('mlb');
    assert.equal(rows.find(r => r.pattern==='first').matched,1);
    assert.equal(rows.find(r => r.pattern==='first').uniqueMatches,1);
    assert.equal(rows.find(r => r.pattern==='second').uniqueMatches,0);
  } finally {db.close();}
});
test('query controls are source-specific, reversible and survive evidence expiry', () => {
  let now = Date.parse('2026-09-13');
  const db = review.createReview(':memory:', () => now);
  const event = {id:'mlb:one',date:'2026-09-01'};
  try {
    db.context('prowlarr',promo,event).record('Mets @ Yankees 01.09.2026','success',[],1);
    const row = db.rows('mlb')[0];
    assert.equal(row.coverage,'@ matchup');
    db.setPolicy('mlb',row.key,'disabled');
    assert.deepEqual(db.context('prowlarr',promo,event).filter(['Mets @ Yankees 02.09.2026']),[]);
    assert.equal(db.context('bitmagnet',promo,event).filter(['Mets @ Yankees 02.09.2026']).length,1);
    assert.throws(() => db.setPolicy('nfl',row.key,'disabled'),/not found/);
    now += 91*86400000;
    db.context('bitmagnet',promo,event).record('fresh','success',[],1);
    assert.equal(db.rows('mlb').find(r=>r.key===row.key).action,'disabled');
    db.setPolicy('mlb',row.key,'demoted');
    assert.deepEqual(db.context('prowlarr',promo,event).filter(['Mets @ Yankees 02.09.2026','first']),['first','Mets @ Yankees 02.09.2026']);
    db.setPolicy('mlb',row.key,'active');
    assert.equal(db.context('prowlarr',promo,event).filter(['Mets @ Yankees 02.09.2026']).length,1);
  } finally {db.close();}
});
test('review page renders controls and escapes provider query content', () => {
  const db=review.createReview(':memory:'); const old=review.getDefault;
  review.getDefault=()=>db;
  try {
    db.context('prowlarr',promo,{id:'mlb:one',date:'2026-09-01'}).record('<script>alert(1)</script>','success',[],10);
    const html=require('../lib/admin-query-review').render(promo);
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('value="disabled"')); assert.ok(html.includes('value="demoted"'));
  } finally {review.getDefault=old;db.close();}
});
test('Prowlarr records successful zero, timeout and never-started queries from actual attempts', async () => {
  const {Response}=require('node-fetch');
  const settings=require('../lib/settings'); const prowlarr=require('../lib/sources/prowlarr');
  const old=settings.getProwlarr; const db=review.createReview(':memory:');
  settings.getProwlarr=()=>({url:'http://example.invalid',apiKey:'fixture'});
  try {
    await prowlarr.multiSearch(['zero','slow','not started'], {deadlineMs:250,titlesOnly:true,
      queryReview:db.context('prowlarr',promo,{id:'mlb:one',date:'2026-09-01'}),
      fetchImpl:async url=>url.includes('query=zero') ? new Response('[]') : new Promise(()=>{})});
    const rows=db.rows('mlb');
    assert.equal(rows.find(r=>r.pattern==='zero').zeros,1);
    assert.equal(rows.find(r=>r.pattern==='slow').timeouts,1);
    assert.equal(rows.find(r=>r.pattern==='not started').unattempted,1);
    assert.equal(rows.find(r=>r.pattern==='slow').zeros,0);
  } finally {settings.getProwlarr=old;db.close();}
});
