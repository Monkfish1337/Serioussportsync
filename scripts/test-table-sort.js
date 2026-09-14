'use strict';
const assert=require('node:assert/strict'),path=require('path');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.SSS_TEST_BROWSER_CHANNEL?{channel:process.env.SSS_TEST_BROWSER_CHANNEL}:{})});
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(`<table><thead><tr><th>Event</th><th>Count</th><th>Date</th><th>Size</th><th>Latency</th><th>Action</th></tr></thead><tbody>
      <tr id="a"><td>Game 12</td><td>120</td><td>12/09/2026, 14:00:00</td><td>1 GiB</td><td>0.2 s</td><td><button id="action">Keep action</button></td></tr>
      <tr id="b"><td>Game 2</td><td>2</td><td>2026-09-13 12:00:00</td><td>400 MiB</td><td>120 ms</td><td></td></tr>
      <tr id="c"><td>Game 30</td><td>9</td><td>01/10/2026, 12:00:00</td><td>1.5 GB</td><td>1 min</td><td></td></tr>
      <tr id="empty"><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td></td></tr></tbody></table>`);
    await page.evaluate(()=>{window.actions=0;document.getElementById('action').addEventListener('click',()=>window.actions++);});
    await page.addScriptTag({path:path.join(__dirname,'../public/table-sort.js')});
    const ids=()=>page.locator('tbody tr').evaluateAll(rows=>rows.map(row=>row.id));
    await page.getByRole('button',{name:'Sort Count',exact:true}).click();assert.deepEqual(await ids(),['b','c','a','empty']);
    await page.getByRole('button',{name:'Sort Count',exact:true}).click();assert.deepEqual(await ids(),['a','c','b','empty']);
    assert.equal(await page.locator('th').nth(1).getAttribute('aria-sort'),'descending');
    await page.getByRole('button',{name:'Sort Event',exact:true}).focus();await page.keyboard.press('Enter');assert.deepEqual(await ids(),['b','a','c','empty']);
    await page.getByRole('button',{name:'Sort Date',exact:true}).click();assert.deepEqual(await ids(),['a','b','c','empty']);
    await page.getByRole('button',{name:'Sort Size',exact:true}).click();assert.deepEqual(await ids(),['b','a','c','empty']);
    await page.getByRole('button',{name:'Sort Latency',exact:true}).click();assert.deepEqual(await ids(),['b','a','c','empty']);
    await page.getByRole('button',{name:'Keep action',exact:true}).click();assert.equal(await page.evaluate(()=>window.actions),1);
    assert.equal(await page.getByRole('button',{name:'Sort Action',exact:true}).count(),0);
    await page.getByRole('button',{name:'Sort Count',exact:true}).click();
    await page.evaluate(()=>{document.querySelector('#a td:nth-child(2)').textContent='1';});
    await page.waitForFunction(()=>document.querySelector('tbody tr').id==='a');
    assert.deepEqual(await ids(),['a','b','c','empty']);
    assert.deepEqual(errors,[]);console.log('OK — numeric, date, size, latency and keyboard sorting; live updates and row actions verified.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
