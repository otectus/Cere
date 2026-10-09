import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { calculate,convert } from '../broker/utilities.ts';
import { activatePendingRecovery } from '../broker/recovery.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
test('offline calculator and conversions do not evaluate code and preserve arithmetic rules',()=>{
  assert.equal(calculate('-(2+3)^2'),-25);assert.equal(calculate('2^3^2'),512);assert.equal(calculate('1e2 / 4'),25);
  assert.throws(()=>calculate('process.exit()'));assert.throws(()=>calculate('1/0'));assert.throws(()=>calculate('2 + NaN'));
  assert.equal(convert(32,'F','C'),0);assert.equal(convert(1,'MiB','KiB'),1024);assert.throws(()=>convert(1,'m','g'));assert.throws(()=>convert(-1,'K','C'));
});
async function fixture(t:any){const dir=await mkdtemp(join(tmpdir(),'cere-companion-'));const core=new Core(new Store(dir),()=>({async send(){},async interrupt(){},async close(){}}));await core.memory.ready;t.after(async()=>{if(!core.closed)await core.close();await rm(dir,{recursive:true,force:true})});return{core,dir};}
test('notes use revisions and reviewed routines consume exact previews once',async t=>{
  const {core}=await fixture(t);const note=await core.rpc('utility.save',{kind:'note',title:'Plan',text:'Work locally',done:false});
  await assert.rejects(core.rpc('utility.save',{...note,text:'Stale',expectedRevision:'0'}),/changed/);
  const preview=await core.rpc('routine.preview',{steps:[{name:'timer.start',args:{minutes:25,label:'Focus'}}]});
  await assert.rejects(core.rpc('routine.run',{id:preview.id,digest:'wrong'}),/Review/);
  const result=await core.rpc('routine.run',{id:preview.id,digest:preview.digest});assert.equal(result.state,'completed');assert.ok(result.results[0].undoTimerId);
  await assert.rejects(core.rpc('routine.run',{id:preview.id,digest:preview.digest}),/Review/);
  await core.rpc('timer.pause',{id:result.results[0].undoTimerId});assert.equal(core.store.timers()[0].paused,true);
});
test('desktop profiles restore preferences without changing permission grants',async t=>{
  const {core}=await fixture(t);await core.updateSettings({speechEnabled:true,quiet:false,hidden:false});const grants=structuredClone(core.settings.grants);
  await core.updateSettings({desktopProfile:'presentation'});assert.equal(core.settings.hidden,true);assert.equal(core.settings.quiet,true);assert.deepEqual(core.settings.grants,grants);
  await core.updateSettings({desktopProfile:'normal'});assert.equal(core.settings.hidden,false);assert.equal(core.settings.speechEnabled,true);
});
test('reviewed backup restores content without credentials or active authority and preserves forgetting registry',async t=>{
  const {core,dir}=await fixture(t);const session=await core.create({provider:'codex',cwd:dir,trusted:true});await core.draft(session.id,'Keep this draft');
  core.store.set('remoteCursorKey','secret-key');core.store.set('settings',{...core.settings,grants:[{category:'files',cwd:dir,expires:Date.now()+100000}]});
  const backup=await core.rpc('recovery.backup',{includeContent:true});assert.doesNotMatch(await readFile(join(backup.directory,'profile.json'),'utf8'),/secret-key/);
  const review=await core.rpc('recovery.preview',{directory:backup.directory,includeContent:true});assert.equal(review.sessions,1);
  const activating=core.rpc('recovery.activate',{id:review.id,digest:review.digest});
  assert.equal(core.recovery.pending,true);assert.equal(core.memory.service.recoveryFrozen,true);await assert.rejects(core.rpc('session.draft',{id:session.id,text:'Racing draft'}),/Recovery is pending/);
  await assert.rejects(core.rpc('memory.forget',{sessionId:session.id,id:'racing-forget'}),/Recovery is pending/);
  const activation=await activating;assert.equal(activation.restarting,true);await core.close();
  assert.equal(activatePendingRecovery(dir),true);const restored=new Store(dir);try{assert.equal(restored.session(session.id).draft,'Keep this draft');assert.equal(restored.session(session.id).nativeId,null);assert.equal(restored.settings().paused,true);assert.deepEqual(restored.settings().grants,[]);assert.equal(restored.get('remoteCursorKey','absent'),'secret-key','this machine keeps its own phone state; the backup never carried it');}finally{restored.close();}
  t.after(()=>rm(activation.previous,{recursive:true,force:true}));
});
