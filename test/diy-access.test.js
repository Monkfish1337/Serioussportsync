'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {playbackConfig} = require('../lib/diy-access');
test('stored DIY settings cannot enable playback after demotion and do not affect fast providers', () => {
  const user = {role:'admin',config:{diyUsenetEnabled:true,nativeNntpEnabled:true,diyNativeSearchEnabled:true,easynewsEnabled:true,torboxApiKey:'fixture'}};
  assert.equal(playbackConfig(user).nativeNntpEnabled,true);
  const config = playbackConfig({...user,role:'user'});
  for(const flag of ['diyUsenetEnabled','nativeNntpEnabled','diyNativeSearchEnabled']) assert.equal(config[flag],false);
  assert.equal(config.easynewsEnabled,true);
  assert.equal(config.torboxApiKey,'fixture');
  assert.equal(user.config.diyUsenetEnabled,true,'role checks must not mutate stored credentials');
});
