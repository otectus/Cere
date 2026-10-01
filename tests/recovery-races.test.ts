import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,appendFile,readFile,readdir,writeFile,mkdir } from 'node:fs/promises';
import { join,dirname,basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { activatePendingRecovery } from '../broker/recovery.ts';
import { GraphMemory } from '../broker/graph-memory/client.ts';
import { Canonical } from '../broker/graph-memory/canonical.ts';

test('worker backup immediately restores a consistent snapshot without the SQLite callback stall',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-worker-restore-')),memory=new GraphMemory(dir);
  t.after(async()=>{await memory.close();await rm(dir,{recursive:true,force:true});});
  const scope=(await memory.call('scope',{key:'restore-test',label:'Restore test'})).id;
  const kept=await memory.call('save_text',{scope_id:scope,text:'Preserve this reviewed project decision.'});
  const forgotten=await memory.call('save_text',{scope_id:scope,text:'Erase this obsolete private note.'});
  const output=join(dir,"snapshot's.sqlite"),staging=join(dir,'staging'),start=performance.now();
  await memory.call('backup',{output});
  await memory.call('forget',{scope_id:scope,id:forgotten.id});
  const result=await memory.call('restore',{input:output,staging});
  assert.ok(performance.now()-start<5000,'Consecutive worker snapshots must not wait for the 30-second idle timeout');
  assert.equal(result.integrity,'ok');assert.equal(result.serving,false);
  assert.equal(await readFile(join(staging,'erasure-registry.jsonl'),'utf8'),await readFile(join(dir,'graph-memory','erasure-registry.jsonl'),'utf8'));
  const restored=new Canonical(staging);
  try{assert.match(JSON.stringify(restored.inspect({scope_id:scope,id:kept.id})),/Preserve this reviewed/);assert.throws(()=>restored.inspect({scope_id:scope,id:forgotten.id}),/erased|not found|Unknown/i);}
  finally{restored.close();}
});

test('backup discards payloads if forgetting advances after the conversation snapshot',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-backup-race-')),core=new Core(new Store(dir));
  t.after(async()=>{await core.close();await rm(dir,{recursive:true,force:true});});await core.memory.ready;
  const session=await core.create({provider:'codex',cwd:dir,trusted:true});core.draft(session.id,'Old text must not be paired with a new registry');
  const original=core.memory.graph.bind(core.memory);let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  core.memory.graph=async(...args)=>{if(args[1]==='backup'){entered();await waiting;}return original(...args);};
  const backup=core.rpc('recovery.backup',{includeContent:true});await started;
  await appendFile(join(dir,'graph-memory','erasure-registry.jsonl'),'\n');release();
  await assert.rejects(backup,/Forgetting records changed during backup/);
  assert.deepEqual(await readdir(join(dir,'backups')),[]);
});

test('stale activation is rejected once while the intact current profile remains bootable',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-activation-race-')),stage=dir+'-restore-'+randomUUID(),previous=dir+'-previous-'+randomUUID();
  const journal=join(dirname(dir),'.'+basename(dir)+'-recovery.json');
  t.after(async()=>{await rm(dir,{recursive:true,force:true});await rm(stage,{recursive:true,force:true});for(const name of await readdir(dirname(dir)))if(name.startsWith(basename(journal)))await rm(join(dirname(dir),name),{force:true});});
  await mkdir(join(dir,'graph-memory'));await mkdir(stage,{mode:0o700});await writeFile(join(dir,'graph-memory','erasure-registry.jsonl'),'advanced');
  await writeFile(journal,JSON.stringify({stage,previous,registryDigest:'old'}),{mode:0o600});
  assert.equal(activatePendingRecovery(dir),false);assert.equal(activatePendingRecovery(dir),false);
  assert.equal(await readFile(join(dir,'graph-memory','erasure-registry.jsonl'),'utf8'),'advanced');
  assert.match(await readFile(join(dir,'recovery-warning.json'),'utf8'),/current profile is intact/);
});

test('restore refuses an in-flight acknowledged mutation before reserving the profile',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-restore-reserve-')),core=new Core(new Store(dir));
  t.after(async()=>{await core.close();await rm(dir,{recursive:true,force:true});});await core.memory.ready;
  const backup=await core.rpc('recovery.backup'),review=await core.rpc('recovery.preview',{directory:backup.directory});
  let release!:()=>void;const pending=core.withMutation(()=>new Promise<void>(r=>release=r));
  await assert.rejects(core.rpc('recovery.activate',{id:review.id,digest:review.digest}),/current changes/);
  assert.equal(core.recovery.pending,false);release();await pending;
  core.memory.service.busy=true;
  await assert.rejects(core.rpc('recovery.activate',{id:review.id,digest:review.digest}),/memory maintenance/);
  core.memory.service.busy=false;
  core.store.timer({id:'due',due:Date.now()-1000,label:'Do not deliver while restoring'});
  core.recovery.pending=true;await core.checkTimers();assert.equal(core.store.timers().length,1);core.recovery.pending=false;
});
