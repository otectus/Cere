import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { Hooks } from '../broker/providers.ts';
import { mobilePage } from '../broker/remote/transcript.ts';

async function fixture(t:any) {
  const directory=await mkdtemp(join(tmpdir(),'cere-queue-')), sent:string[]=[],hooks=new Map<string,Hooks>();
  const core=new Core(new Store(directory),(s,h)=>{hooks.set(s.id,h);return{async send(text,_images,options){options?.beforeAccept?.();sent.push(text);options?.onAccepted?.();options?.acknowledged?.();},async interrupt(){h.event({type:'interrupted'});},async close(){}};});
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  core.capabilities.ollama={modelsStatus:'ready',models:[{id:'fixture',displayName:'Fixture',description:'',efforts:[],defaultEffort:'',isDefault:true}]};
  await core.updateSettings({memory:{enabled:false}});
  const session=await core.create({provider:'ollama',cwd:directory,model:'fixture',tools:false});
  return {core,session,directory,sent,hooks};
}
const tick=()=>new Promise(r=>setTimeout(r,25));
test('busy Ollama accepts FIFO follow-ups durably and preserves newer drafts without duplicate user rows',async t=>{
  const {core,session,sent,hooks,directory}=await fixture(t);
  await core.send({id:session.id,text:'first'});
  const approval=core.approval(session.id,{kind:'question',title:'Choose',detail:'',choices:['answer'],questions:[{id:'q',question:'Which?',allowOther:true}]});
  const draft=core.draft(session.id,'second');
  const queued=await core.send({id:session.id,text:'second',expectedDraftRevision:draft.draftRevision});assert.equal((queued as any).queued,true);
  await core.send({id:session.id,text:'third'});
  assert.deepEqual(sent,['first']);assert.equal(core.store.session(session.id).queuedCount,2);
  assert.equal(mobilePage(core.store,session.id).items.filter(m=>m.kind==='queued').length,2);
  assert.equal(mobilePage(core.store,session.id).items.some(m=>m.kind==='question'),true);
  const disk=new Store(directory);assert.equal(disk.get<any[]>('sendQueue:'+session.id,[]).length,2);disk.close();
  core.draft(session.id,'a newer unsent draft');
  core.answer({id:[...core.approvals.keys()][0],choice:'answer',answers:{q:{answers:['yes']}}});await approval;
  hooks.get(session.id)!.event({type:'complete'});await tick();assert.deepEqual(sent,['first','second']);
  assert.equal(core.store.session(session.id).draft,'a newer unsent draft');
  hooks.get(session.id)!.event({type:'complete'});await tick();assert.deepEqual(sent,['first','second','third']);
  hooks.get(session.id)!.event({type:'complete'});await tick();assert.equal(core.store.session(session.id).queuedCount,0);
  assert.equal(core.store.messages(session.id).filter(m=>m.role==='user'&&m.kind!=='answer').length,3);
});
test('Stop cancels queued sends visibly, retains their text, and never starts another turn',async t=>{
  const {core,session,sent}=await fixture(t);await core.send({id:session.id,text:'first'});await core.send({id:session.id,text:'keep me'});
  await core.stop(session.id);await tick();assert.deepEqual(sent,['first']);assert.equal(core.store.session(session.id).queuedCount,0);
  assert.match(core.store.messages(session.id).find(m=>m.kind==='queue-cancelled')!.text,/keep me/);
});
test('queue admission serializes CAS, rejects stale drafts, and cancels in-flight admission on Stop',async t=>{
  const {core,session}=await fixture(t);await core.send({id:session.id,text:'first'});
  const draft=core.draft(session.id,'same revision');
  const params={id:session.id,text:'same revision',expectedDraftRevision:draft.draftRevision};
  const outcomes=await Promise.allSettled([core.send(params),core.send(params)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(core.store.session(session.id).queuedCount,1);
  const pending=core.send({id:session.id,text:'racing stop'});await core.stop(session.id);await assert.rejects(pending,/cancelled/);
});
test('provider failure and changed configuration leave follow-ups visible and unsent',async t=>{
  const {core,session,sent,hooks}=await fixture(t);await core.send({id:session.id,text:'first'});await core.send({id:session.id,text:'second'});
  core.updateSession(session.id,{model:'different-model'});hooks.get(session.id)!.event({type:'complete'});await tick();
  assert.deepEqual(sent,['first']);assert.equal(core.store.session(session.id).queuedCount,0);
  assert.match(core.store.messages(session.id).find(m=>m.kind==='queue-cancelled')!.text,/settings changed/);
});
test('remote CLI bypass approves only authorized permission requests, keeps launch restrictions, and never answers questions',async t=>{
  const {core,session,directory}=await fixture(t);
  const execution={deviceId:'phone',projectId:'project',scopeVersion:'1',expiresAt:Date.now()+60000,caps:['chat.write','providers.execute','approvals.provider'],categories:[],scriptIds:[]};
  core.remoteAuthority=()=>true;core.updateSession(session.id,{remote:execution,effectivePolicy:'restricted'});
  const child=await core.create({provider:'codex',cwd:directory,trusted:true});core.updateSession(child.id,{parentId:session.id,remote:execution,effectivePolicy:'restricted'});
  const pending=core.approval(child.id,{kind:'provider',title:'Command',detail:'printf safe',choices:['allow','deny']});
  await core.updateSettings({bypassCliPermissions:true});assert.deepEqual(await pending,{id:(await pending).id,choice:'allow',automatic:true});
  assert.equal(core.settingsFor(child.id).bypassCliPermissions,false);
  assert.deepEqual(await core.approval(child.id,{kind:'permissions',title:'Permission',detail:'',choices:['allow','deny']}),{choice:'allow',automatic:true});
  assert.equal(core.automaticallyApprove(child.id,{kind:'question',choices:['allow','deny']}),false);
  assert.equal(core.automaticallyApprove(child.id,{kind:'desktop',choices:['allow','deny']}),false);
  core.updateSession(child.id,{remote:{...execution,caps:['providers.execute']}});assert.equal(core.automaticallyApprove(child.id,{kind:'provider',choices:['allow']}),false);
  core.updateSession(child.id,{remote:execution});await core.updateSettings({paused:true});assert.equal(core.automaticallyApprove(child.id,{kind:'provider',choices:['allow']}),false);
  core.remoteAuthority=()=>false;await core.updateSettings({quiet:true});assert.equal(core.automaticallyApprove(child.id,{kind:'provider',choices:['allow']}),false);
});

test('restart recovery marks a dispatched queued message uncertain and never replays it',async t=>{
  const {core,session,sent}=await fixture(t);await core.send({id:session.id,text:'first'});await core.send({id:session.id,text:'possibly sent'});
  const [entry]=core.sendQueue.entries(session.id);
  core.store.set('sendQueueDispatch:'+session.id,entry);core.store.set('sendQueue:'+session.id,[]);
  core.sendQueue.recover(session.id);await tick();assert.deepEqual(sent,['first']);
  assert.match(core.store.messageById(entry.messageId)!.text,/Delivery uncertain after restart/);
});
test('revoked remote authority cancels an accepted queue before dispatch',async t=>{
  const {core,session,sent,hooks}=await fixture(t);let authorized=true;core.remoteAuthority=()=>authorized;
  const execution={deviceId:'phone',projectId:'project',scopeVersion:'1',expiresAt:Date.now()+60000,caps:['chat.write'],categories:[],scriptIds:[]};
  core.updateSession(session.id,{remote:execution,effectivePolicy:'restricted'});await core.send({id:session.id,text:'first'});
  const current=core.store.session(session.id);
  await core.sendRemote({id:session.id,text:'second',expectedDraftRevision:current.draftRevision||'0',expectedConfigRevision:current.configRevision||'0'},execution);
  authorized=false;hooks.get(session.id)!.event({type:'complete'});await tick();assert.deepEqual(sent,['first']);
  assert.equal(core.store.session(session.id).queuedCount,0);assert.match(core.store.messages(session.id).at(-1)!.text,/Delivery failed/);
});
