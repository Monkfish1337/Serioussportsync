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
    assert.equal(await page.locator('#sv-rows tr:visible').count(),15);
    await page.getByRole('button',{name:'Next',exact:true}).click();
    assert.equal(await page.locator('#sv-rows tr:visible').count(),15);
    await page.locator('#sv-search').fill('game 30');
    assert.equal(await page.locator('#sv-rows tr:visible').count(),1);
    assert.match(await page.locator('#sv-rows tr:visible').textContent(),/game 30/);
    await page.locator('#sv-search').fill('');
    assert.equal(await page.locator('#sv-rows tr:visible').count(),15);
    const settings=page.locator('form[action="/admin/sport-video/settings"]');
    assert.equal(await settings.isVisible(),false);
    await page.getByRole('button',{name:'Show',exact:true}).first().click();
    assert.equal(await settings.isVisible(),true);
    const events=Array.from({length:31},(_,i)=>({id:'mlb:'+i,name:'Game '+i,date:'2026-09-12',state:'Not searched yet'}));
    const status={options:{enabled:true,promotions:['mlb'],intervalSeconds:120,dailyRequests:100,lookbackDays:7,timeoutSeconds:120},
      progress:{eligible:31,searched:0,matched:0,outstanding:31,untouched:31,firstPassEstimateMs:null,byPromotion:[]},
      eventStates:events,indexers:[],jobs:[],retryJobs:[],matchedEvents:[],matches:0};
    await page.setContent('<div id="discovery-content">'+require('../lib/admin-prowlarr-discovery').render(status)+'</div>');
    await page.addScriptTag({path:path.join(__dirname,'../public/discovery-controls.js')});
    assert.equal(await page.locator('form[action="/admin/prowlarr-discovery"]').isVisible(),false);
    assert.equal(await page.getByText('Catch-up progress',{exact:true}).isVisible(),true);
    await page.locator('summary').filter({hasText:'Event discovery status'}).click();
    assert.equal(await page.locator('details').filter({has:page.locator('summary').filter({hasText:'Event discovery status'})}).locator('tbody tr:visible').count(),15);
    await page.setContent('<div id="discovery-content">'+require('../lib/admin-database').renderBody({discovery:true})+'</div>');
    await page.addScriptTag({path:path.join(__dirname,'../public/discovery-controls.js')});
    const bitSettings=page.locator('form[action="/admin/database/settings"]');
    assert.equal(await bitSettings.isVisible(),false);
    await page.locator('.card').filter({has:page.locator('h3').filter({hasText:'Bitmagnet preparation settings'})}).getByRole('button',{name:'Show',exact:true}).click();
    assert.equal(await bitSettings.isVisible(),true);
    assert.deepEqual(errors,[]);
    console.log('OK — all three source tabs, pagination, Sport-Video filters and settings folds verified in Chromium.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
