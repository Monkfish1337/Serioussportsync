'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sss-store-safety-'));
process.env.SESSION_SECRET = 'account-store-safety-test-secret-0000000000000000000000';
process.env.USERS_FILE = path.join(dir,'users.json');
process.env.SETTINGS_FILE = path.join(dir,'settings.json');
process.env.DATA_FILE = path.join(dir,'events.json');
process.env.AVAILABILITY_DB_FILE = path.join(dir,'availability.sqlite');
const users = require('../lib/users');
const {createApp} = require('../addon');
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('simultaneous first-admin requests create exactly one administrator',async()=>{
  const results = await Promise.allSettled(['first-admin','second-admin'].map(username=>users.createUser({username,password:'test-password-123',role:'admin',initialAdminOnly:true})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(users.countAdmins(),1);
});
test('corrupt and invalid account stores refuse reads, writes and setup without replacing data',async()=>{
  const original = fs.readFileSync(process.env.USERS_FILE,'utf8');
  const server = createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
    for (const broken of ['{broken','{}','{"users":[{}]}','{"users":[],"accessRequests":{}}']) {
      fs.writeFileSync(process.env.USERS_FILE,broken);
      assert.throws(()=>users.userCount(),{code:'ACCOUNT_STORE_UNAVAILABLE'});
      await assert.rejects(users.createUser({username:'replacement',password:'test-password-123',role:'admin'}),{code:'ACCOUNT_STORE_UNAVAILABLE'});
      const response = await fetch('http://127.0.0.1:'+server.address().port+'/setup');
      assert.equal(response.status,503);
      assert.match(await response.text(),/Restore or repair users.json/);
      assert.equal(fs.readFileSync(process.env.USERS_FILE,'utf8'),broken);
    }
  } finally { fs.writeFileSync(process.env.USERS_FILE,original); await new Promise(resolve=>server.close(resolve)); }
});
test('expired requests cannot be approved and closed requests cannot be submitted',async()=>{
  await users.requestAccess({username:'expiry-test',password:'test-password-123'});
  const state = JSON.parse(fs.readFileSync(process.env.USERS_FILE,'utf8'));
  const request = state.accessRequests[0];
  request.createdAt = '2000-01-01T00:00:00Z';
  fs.writeFileSync(process.env.USERS_FILE,JSON.stringify(state));
  assert.throws(()=>users.reviewAccessRequest(request.id,true),/not found/);
  assert.equal(users.findByUsername('expiry-test'),null);
  users.setAccessPolicy({enabled:false,expiryDays:7});
  await assert.rejects(users.requestAccess({username:'closed-test',password:'test-password-123'}),/closed/);
  assert.throws(()=>users.setAccessPolicy({enabled:true,expiryDays:0}));
});
