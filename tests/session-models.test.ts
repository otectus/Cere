import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { Hooks } from '../broker/providers.ts';
import type { Session, ModelOption } from '../broker/types.ts';
import { antigravityModels } from '../broker/antigravity.ts';

const catalog:ModelOption[]=['original','next'].map((id,index)=>({id,displayName:id,description:'',efforts:[{id:index?'low':'high',displayName:index?'Low':'High'}],defaultEffort:index?'low':'high',isDefault:!index}));
async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'cere-switch-')),opened:Session[]=[],hooks:Hooks[]=[];
  let closes=0;
  const core=new Core(new Store(directory),(s,h)=>{
    opened.push(structuredClone(s));hooks.push(h);
    return{async send(){h.native(s.nativeId||'native-conversation');h.event({type:'message',text:'Reply using '+s.model});h.event({type:'complete',text:''});},async interrupt(){},async close(){closes++;h.event({type:'error',text:'stale close event'});}};
  },async()=>catalog);
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  return{directory,core,opened,hooks,closes:()=>closes};
}
for(const provider of ['codex','claude','antigravity'] as const)test(`${provider}: switches the next turn, preserving native conversation, transcript and draft`,async t=>{
  const f=await fixture(t),{core}=f;
  await core.refreshProviderModels(provider);
  const s=await core.create({provider,cwd:f.directory,model:'original',effort:'high',trusted:true});
  await core.send({id:s.id,text:'First turn'});core.flush();
  core.updateSession(s.id,{draft:'Keep my next message',scroll:123});
  const before=structuredClone(core.store.session(s.id)),messages=structuredClone(core.store.messages(s.id));
  await core.configureSession({id:s.id,model:'next',expectedConfigRevision:before.configRevision});
  const after=core.store.session(s.id);
  assert.equal(after.model,'next');assert.equal(after.effort,'');assert.equal(after.nativeId,before.nativeId);
  assert.equal(after.draft,before.draft);assert.equal(after.scroll,123);assert.equal(after.status,'idle');assert.equal(after.error,undefined);
  assert.notEqual(after.configRevision,before.configRevision);assert.equal(f.closes(),1);assert.deepEqual(core.store.messages(s.id),messages);
  f.hooks[0].event({type:'error',text:'late old callback'});assert.equal(core.store.session(s.id).status,'idle');
  const persisted=new Store(f.directory);try{assert.equal(persisted.session(s.id).model,'next');assert.equal(persisted.session(s.id).nativeId,before.nativeId);}finally{persisted.close();}
  await core.send({id:s.id,text:'Continue'});
  assert.equal(f.opened.length,2);assert.equal(f.opened[1].model,'next');assert.equal(f.opened[1].nativeId,before.nativeId);
  await core.configureSession({id:s.id,model:'',effort:''});assert.equal(core.store.session(s.id).model,'');
});
test('invalid selections, busy/linked conversations and stale configuration fail without changing history',async t=>{
  const f=await fixture(t),{core}=f;await core.refreshProviderModels('codex');
  const s=await core.create({provider:'codex',cwd:f.directory,model:'original',effort:'high',trusted:true});
  const before=structuredClone(core.store.session(s.id));
  await assert.rejects(core.configureSession({id:s.id,model:'missing'}),/available/);
  await assert.rejects(core.configureSession({id:s.id,model:'next',effort:'high'}),/effort/);
  await assert.rejects(core.configureSession({id:s.id,model:'next',expectedConfigRevision:'stale'}),/settings changed/);
  assert.deepEqual(core.store.session(s.id),before);
  await core.configureSession({id:s.id,model:'original',effort:'high'});assert.equal(f.closes(),0);
  for(const status of ['starting','working','waiting','stopping'] as const){
    core.updateSession(s.id,{status});await assert.rejects(core.configureSession({id:s.id,model:'next'}),/Stop/);
  }
  core.updateSession(s.id,{status:'idle',mode:'linked'});await assert.rejects(core.configureSession({id:s.id,model:'next'}),/Hand this session/);
  assert.equal(core.store.session(s.id).model,'original');
});
test('AntiGravity catalog prevents conflicting effort and repairs an existing session through model settings',async t=>{
  const f=await fixture(t),{core}=f;
  core.modelLoader=async()=>antigravityModels('gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n');
  await core.refreshProviderModels('antigravity');
  await assert.rejects(core.create({provider:'antigravity',cwd:f.directory,model:'gemini-3.1-pro-high',effort:'medium',trusted:true}),/effort available/);
  const s=await core.create({provider:'antigravity',cwd:f.directory,model:'gemini-3.1-pro-high',trusted:true});
  await assert.rejects(core.configureSession({id:s.id,model:s.model,effort:'medium'}),/effort available/);
  core.updateSession(s.id,{effort:'medium',status:'error',error:'Old generic error',nativeId:'existing-conversation',draft:'Keep my draft'});
  await core.configureSession({id:s.id,model:s.model,effort:''});
  const repaired=core.store.session(s.id);
  assert.equal(repaired.effort,'');assert.equal(repaired.error,undefined);assert.equal(repaired.nativeId,'existing-conversation');assert.equal(repaired.draft,'Keep my draft');
});
test('model loading serializes sends and rechecks configuration before applying',async t=>{
  const f=await fixture(t),{core}=f;
  const s=await core.create({provider:'claude',cwd:f.directory,model:'original',trusted:true});
  let resolve!:(models:ModelOption[])=>void;
  core.modelLoader=()=>new Promise(done=>resolve=done);
  const applying=core.configureSession({id:s.id,model:'next'});
  await assert.rejects(core.send({id:s.id,text:'Cannot race the switch'}),/busy/);
  await assert.rejects(core.configureSession({id:s.id,model:'original'}),/busy/);
  core.updateSession(s.id,{title:'Edited in another window'});resolve(catalog);
  await assert.rejects(applying,/settings changed/);assert.equal(core.store.session(s.id).model,'original');
  assert.equal(core.store.messages(s.id).length,0);assert.equal(f.opened.length,0);
  await core.configureSession({id:s.id,model:'next'});assert.equal(core.store.session(s.id).model,'next');
});
test('API model changes retain tool permissions, require trust when enabling them, and accept custom IDs',async t=>{
  const f=await fixture(t),{core}=f;await core.rpc('provider.credentials',{provider:'openai',key:'fixture'});
  const s=await core.create({provider:'openai',model:'original',cwd:f.directory});
  core.store.set('api:'+s.id,[{role:'assistant',content:'answer',providerData:[{type:'reasoning',encrypted_content:'opaque'}]}]);
  await assert.rejects(core.configureSession({id:s.id,model:'custom',tools:true}),/trust/);
  const permissionRevision=core.store.session(s.id).configRevision;
  await core.configureSession({id:s.id,model:'original',tools:true,trusted:true});
  assert.equal(core.store.session(s.id).api?.tools,true);
  assert.notEqual(core.store.session(s.id).configRevision,permissionRevision);
  assert.ok(JSON.stringify(core.store.get('api:'+s.id,[])).includes('opaque')); // Same model: keep continuation state.
  const before=core.store.session(s.id).configRevision;
  await core.configureSession({id:s.id,model:'custom-id'});
  assert.equal(core.store.session(s.id).api?.tools,true);assert.notEqual(core.store.session(s.id).configRevision,before);
  assert.ok(!JSON.stringify(core.store.get('api:'+s.id,[])).includes('opaque'));
  await assert.rejects(core.configureSession({id:s.id,model:''}),/Choose a model/);
  await assert.rejects(core.configureSession({id:s.id,model:'custom-id',effort:'high'}),/default reasoning/);
  const temporary=await core.create({provider:'openai',model:'original',temporary:true});
  await assert.rejects(core.configureSession({id:temporary.id,model:'custom',tools:true,trusted:true}),/temporary/);
});
test('an adapter that cannot close leaves the model and provider history unchanged',async t=>{
  const f=await fixture(t),{core}=f;await core.rpc('provider.credentials',{provider:'google',key:'fixture'});
  const s=await core.create({provider:'google',model:'original'}),history=[{role:'assistant',content:'answer',providerData:[{text:'answer',thoughtSignature:'retained'}]}];
  core.store.set('api:'+s.id,history);
  core.adapters.set(s.id,{async send(){},async interrupt(){},async close(){throw new Error('could not close');}});
  await assert.rejects(core.configureSession({id:s.id,model:'next'}),/could not close/);
  assert.equal(core.store.session(s.id).model,'original');assert.deepEqual(core.store.get('api:'+s.id,[]),history);
});
