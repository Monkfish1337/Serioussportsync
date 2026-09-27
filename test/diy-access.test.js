'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {playbackConfig, usenetPlayback} = require('../lib/diy-access');
test('stored DIY settings cannot enable server playback after demotion and do not affect fast providers', () => {
  const user = {role:'admin',config:{diyUsenetEnabled:true,nativeNntpEnabled:true,diyNativeSearchEnabled:true,easynewsEnabled:true,torboxApiKey:'fixture',
    nntpHost:'news.example',nntpUsername:'u',nntpPassword:'p',usenetPlayback:'nntp'}};
  assert.equal(playbackConfig(user).nativeNntpEnabled,true);
  assert.equal(playbackConfig(user).usenetPlayback,'nntp');
  const config = playbackConfig({...user,role:'user'});
  // Built-in Usenet search stays, but only TorBox may play it: native NNTP
  // would stream every byte through this server.
  assert.equal(config.usenetPlayback,'torbox');
  assert.equal(config.nativeNntpEnabled,false);
  assert.equal(config.nntpHost,'');
  assert.equal(config.nntpPassword,'');
  assert.equal(config._publicNetworkOnly,true,'their indexer and NZB links must be public addresses');
  assert.equal(config.easynewsEnabled,true);
  assert.equal(config.torboxApiKey,'fixture');
  assert.equal(user.config.diyUsenetEnabled,true,'role checks must not mutate stored credentials');
  assert.equal(user.config.nntpHost,'news.example');
});
test('admins choose how built-in Usenet plays; existing admins keep native NNTP', () => {
  assert.equal(usenetPlayback({role:'admin',config:{}}),'nntp');
  assert.equal(usenetPlayback({role:'admin',config:{usenetPlayback:'both'}}),'both');
  assert.equal(usenetPlayback({role:'user',config:{usenetPlayback:'nntp'}}),'torbox');
  assert.equal(playbackConfig({role:'admin',config:{}})._publicNetworkOnly,undefined);
});
