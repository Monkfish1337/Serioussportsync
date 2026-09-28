'use strict';
// Optional browser verification: requires Playwright and its Chromium runtime.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {renderBody}=require('../lib/admin-sport-video');
const path=require('path');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.SSS_TEST_BROWSER_CHANNEL?{channel:process.env.SSS_TEST_BROWSER_CHANNEL}:{})});
  try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const releases=Array.from({length:31},(_,i)=>({id:'release-'+i,title:'Baseball game '+i,date:'2026-09-12',category:'baseball',matches:[]}));
    await page.setContent('<div id="discovery-content">'+renderBody({config:{},status:{},releases,cached:new Set(),promotions:[],catalogTeams:[]})+'</div>');
    await page.addScriptTag({path:path.join(__dirname,'../public/discovery-controls.js')});
    await page.addScriptTag({path:path.join(__dirname,'../public/table-sort.js')});
    // Lists scroll inside their box instead of paging (issue #72).
    assert.equal(await page.locator('#sv-rows tr:visible').count(),31);
    assert.equal(await page.locator('#sv-rows').evaluate(b=>getComputedStyle(b.closest('.tbl-wrap')).overflowY),'auto');
    await page.getByRole('button',{name:'Sort Source release',exact:true}).click();
    await page.getByRole('button',{name:'Sort Source release',exact:true}).click();
    assert.match(await page.locator('#sv-rows tr:visible').first().textContent(),/game 30/);
    await page.locator('#sv-search').fill('game 30');
    assert.equal(await page.locator('#sv-rows tr:visible').count(),1);
    assert.match(await page.locator('#sv-rows tr:visible').textContent(),/game 30/);
    await page.locator('#sv-search').fill('');
    assert.equal(await page.locator('#sv-rows tr:visible').count(),31);
    const settings=page.locator('form[action="/admin/sport-video/settings"]');
    assert.equal(await settings.isVisible(),false);
    await page.locator('summary').filter({hasText:'Settings'}).first().click();
    assert.equal(await settings.isVisible(),true);
    const events=Array.from({length:31},(_,i)=>({id:'mlb:'+i,name:'Game '+i,date:'2026-09-12',state:'Not searched yet'}));
    const status={options:{enabled:true,promotions:['mlb'],intervalSeconds:120,dailyRequests:100,lookbackDays:7,timeoutSeconds:120},
      progress:{eligible:31,searched:0,matched:0,outstanding:31,untouched:31,firstPassEstimateMs:null,byPromotion:[]},
      eventStates:events,indexers:[],jobs:[],retryJobs:[],matchedEvents:[],matches:0};
    await page.setContent('<div id="discovery-content">'+require('../lib/admin-prowlarr-discovery').render(status)+'</div>');
    await page.addScriptTag({path:path.join(__dirname,'../public/discovery-controls.js')});
    assert.equal(await page.locator('form[action="/admin/prowlarr-discovery"]').isVisible(),false);
    assert.equal(await page.getByText('Search now',{exact:true}).isVisible(),true);
    assert.equal(await page.locator('details.fold details').count(),0,'native folds are not wrapped again');
    await page.locator('summary').filter({hasText:'Missing games'}).click();
    assert.equal(await page.locator('details').filter({has:page.locator('summary').filter({hasText:'Missing games'})}).locator('tbody tr:visible').count(),31);
    await page.setContent('<div id="discovery-content">'+require('../lib/admin-database').renderBody({discovery:true})+'</div>');
    await page.addScriptTag({path:path.join(__dirname,'../public/discovery-controls.js')});
    const bitSettings=page.locator('form[action="/admin/database/settings"]');
    assert.equal(await bitSettings.isVisible(),false);
    await page.locator('summary').filter({hasText:'Bitmagnet preparation settings'}).click();
    assert.equal(await bitSettings.isVisible(),true);
    const data={tab:'overview',events,promotions:[{id:'mlb',name:'MLB'}],queue:status,releases:[],indexTitles:[],relevant:()=>true};
    data.coverage=require('../lib/discovery-coverage').coverage(data,Date.parse('2026-09-14T12:00:00Z'));
    await page.setContent('<div>'+require('../lib/admin-discovery').render(data)+'</div>');
    await page.addScriptTag({path:path.join(__dirname,'../public/discovery-controls.js')});
    assert.equal(await page.getByText('Coverage by promotion',{exact:true}).isVisible(),true);
    await page.getByRole('searchbox',{name:'Filter table',exact:true}).fill('Game 30');
    assert.equal(await page.locator('table').last().locator('tbody tr:visible').count(),1);
    assert.deepEqual(errors,[]);
    console.log('OK — all Discovery tabs, scrolling lists, filters and settings folds verified in Chromium.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
