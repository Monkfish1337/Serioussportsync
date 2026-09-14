'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const Database=require('better-sqlite3');
const {execFileSync}=require('child_process');
const {createArchive}=require('../lib/data-backup');
test('online backup restores both WAL databases standalone and preserves ordinary files',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sss-backup-test-'));
  const data=path.join(root,'data'),restore=path.join(root,'restore');fs.mkdirSync(data);fs.mkdirSync(restore);
  fs.writeFileSync(path.join(data,'users.json'),JSON.stringify({users:[{username:'test-admin',role:'admin'}]}));
  const files=['availability.sqlite','prowlarr-state.custom'];
  const writers=files.map(file=>new Database(path.join(data,file)));
  let archive,timer;
  try {
    for(const db of writers) {db.pragma('journal_mode = WAL');db.pragma('wal_autocheckpoint = 0');db.exec('CREATE TABLE evidence(id INTEGER PRIMARY KEY, value TEXT)');db.prepare('INSERT INTO evidence(value) VALUES (?)').run('committed in WAL');}
    timer=setInterval(()=>{for(const db of writers) db.prepare('INSERT INTO evidence(value) VALUES (?)').run('concurrent write');},5);
    archive=await createArchive(data);
    assert.equal(path.dirname(path.dirname(archive.archive)),path.join(data,'.backup-staging'));
    clearInterval(timer);
    execFileSync('tar',['-xzf',archive.archive,'-C',restore]);
    assert.equal(fs.existsSync(path.join(restore,'.backup-staging')),false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(restore,'users.json'))).users[0].role,'admin');
    for(const file of files) {
      assert.equal(fs.existsSync(path.join(restore,file+'-wal')),false);
      const db=new Database(path.join(restore,file),{readonly:true,fileMustExist:true});
      try {assert.equal(db.pragma('quick_check',{simple:true}),'ok');assert.ok(db.prepare('SELECT COUNT(*) n FROM evidence').get().n>=1);} finally {db.close();}
    }
  } finally {clearInterval(timer);writers.forEach(db=>db.close());if(archive) await archive.cleanup();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
test('damaged SQLite data fails the backup instead of returning a misleading archive',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sss-backup-test-'));
  try {fs.writeFileSync(path.join(root,'broken.sqlite'),'not a database');await assert.rejects(createArchive(root));}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('cancelled backup stops preparation without an archive',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sss-backup-test-'));
  try {fs.writeFileSync(path.join(root,'users.json'),'{}');await assert.rejects(createArchive(root,{signal:AbortSignal.abort()}),/cancelled/);}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});
