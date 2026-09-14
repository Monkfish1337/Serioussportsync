'use strict';
const fs=require('fs'),path=require('path');
const Database=require('better-sqlite3');
const {execFile}=require('child_process');
const {promisify}=require('util');
const run=promisify(execFile);
function check(signal) {if(signal?.aborted) throw new Error('Backup cancelled');}
function isDatabase(file) {
  if(!fs.existsSync(file)) return false;
  const handle=fs.openSync(file,'r'),header=Buffer.alloc(16);
  try {fs.readSync(handle,header,0,16,0);} finally {fs.closeSync(handle);}
  return header.toString()==='SQLite format 3\u0000' || /\.(?:sqlite|sqlite3|db)$/i.test(file);
}
async function createArchive(dataDir,options={}) {
  const sourceDir=path.resolve(dataDir);
  const staging=path.join(sourceDir,'.backup-staging');
  // /tmp is a small memory-backed filesystem in the hardened container.
  // Stage on the persistent volume and exclude staging from every backup.
  fs.mkdirSync(staging,{recursive:true,mode:0o700});
  if(fs.lstatSync(staging).isSymbolicLink()) throw new Error('Backup staging cannot be a symbolic link');
  const root=fs.mkdtempSync(path.join(staging,'sss-backup-'));
  const cleanup=async()=>{
    if(path.dirname(root)!==staging || !path.basename(root).startsWith('sss-backup-')) throw new Error('Invalid backup staging path');
    await fs.promises.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  };
  const snapshot=path.join(root,'data'),archive=path.join(root,'backup.tar.gz'),databases=[];
  try {
    fs.mkdirSync(snapshot,{mode:0o700});
    // Copy JSON and other ordinary files synchronously before allowing this
    // process's writers to run again. SQLite gets its own online snapshot.
    function copy(source,target) {
      for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
        check(options.signal);
        const input=path.join(source,entry.name),output=path.join(target,entry.name);
        if(input===staging) continue;
        if(entry.isSymbolicLink()) throw new Error('Backup data contains a symbolic link');
        if(entry.isDirectory()) {fs.mkdirSync(output,{mode:0o700});copy(input,output);}
        else if(entry.isFile()) {
          if(/-(?:wal|shm|journal)$/.test(entry.name) && isDatabase(input.replace(/-(?:wal|shm|journal)$/,''))) continue;
          if(isDatabase(input)) databases.push({input,output});
          else {fs.copyFileSync(input,output);fs.chmodSync(output,0o600);}
        } else throw new Error('Unsupported file in backup data');
      }
    }
    copy(sourceDir,snapshot);
    for(const file of databases) {
      check(options.signal);
      const source=new Database(file.input,{readonly:true,fileMustExist:true});
      try {await source.backup(file.output,{progress:()=>{check(options.signal);}});} finally {source.close();}
      const saved=new Database(file.output);
      try {
        saved.pragma('journal_mode = DELETE');
        if(saved.pragma('quick_check',{simple:true})!=='ok') throw new Error('Backup database integrity check failed');
      } finally {saved.close();}
      fs.chmodSync(file.output,0o600);
    }
    check(options.signal);
    await run('tar',['-czf',archive,'-C',snapshot,'.'],{signal:options.signal,timeout:120000,maxBuffer:1024*1024});
    await run('tar',['-tzf',archive],{signal:options.signal,timeout:60000,maxBuffer:8*1024*1024});
    fs.chmodSync(archive,0o600);
    return {archive,cleanup};
  } catch(error) {await cleanup();throw error;}
}
module.exports={createArchive};
