import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function setup(t:any,fail=false){
  const directory=await mkdtemp(join(tmpdir(),'cere-workspace-'));
  const core=new Core(new Store(directory),()=>({async send(){if(fail)throw new Error('Provider unavailable');},async interrupt(){},async close(){}}));
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  const session=await core.create({provider:'codex',cwd:directory,trusted:true});
  return {core,directory,session};
}
test('folders preserve conversations, authorization and project identity across rename and removal',async t=>{
  const {core,session}=await setup(t);
  const folder=await core.rpc('folders.save',{name:'Work'});
  const organized=await core.rpc('session.organize',{id:session.id,folderId:folder.id,pinned:true});
  assert.equal(organized.cwd,session.cwd);assert.equal(organized.provider,session.provider);
  assert.equal(core.settings.grants.length,0);
  await assert.rejects(core.rpc('folders.save',{name:'work'}),/already exists/);
  const renamed=await core.rpc('folders.save',{id:folder.id,name:'Projects',expectedRevision:folder.revision});
  await assert.rejects(core.rpc('folders.delete',{id:folder.id,expectedRevision:folder.revision}),/changed/);
  await core.rpc('folders.delete',{id:folder.id,expectedRevision:renamed.revision});
  assert.equal(core.store.session(session.id).folderId,undefined);
  assert.equal(core.store.session(session.id).pinned,true);
});
test('bounded session pages have stable cursors, explicit archive filters and selected snapshot inclusion',async t=>{
  const {core,session}=await setup(t);
  for(let i=0;i<250;i++)core.store.saveSession({...session,id:'paged-'+String(i).padStart(3,'0'),updated:1,title:'Page '+i});
  const first=core.store.sessionPage({limit:100});
  const second=core.store.sessionPage({limit:100,before:first.next});
  assert.equal(new Set([...first.sessions,...second.sessions].map(s=>s.id)).size,200);
  assert.equal(core.snapshot().sessions.length,200);
  await core.rpc('session.organize',{id:'paged-000',archived:true});
  assert.equal(core.store.sessionPage({archived:true}).sessions[0].id,'paged-000');
  await core.rpc('ui.attention',{owner:'ui',sessionId:'paged-000',listening:false});
  assert.ok(core.snapshot().sessions.some(s=>s.id==='paged-000'));
});
test('attachment drafts are revisioned, owned and immutable across source changes and restarts',async t=>{
  const {core,session,directory}=await setup(t),source=join(directory,'example.txt');
  await writeFile(source,'Original reference');
  const attachment=await core.rpc('attachments.import',{sessionId:session.id,path:source});
  await writeFile(source,'Changed reference');
  const saved=await core.rpc('session.draft',{id:session.id,text:'Read this',attachmentIds:[attachment.id],expectedRevision:core.store.session(session.id).draftRevision});
  const other=await core.create({provider:'codex',cwd:directory,trusted:true});
  await assert.rejects(core.rpc('session.draft',{id:other.id,text:'No',attachmentIds:[attachment.id]}),/another session/);
  await assert.rejects(core.rpc('session.draft',{id:session.id,text:'Stale',attachmentIds:[],expectedRevision:session.draftRevision}),/changed/);
  const content=await core.attachments.content(session.id,[attachment.id]);assert.match(content.text,/Original reference/);
  const reopened=new Store(directory);try{assert.equal(reopened.session(session.id).draftAttachments?.[0].id,attachment.id);}finally{reopened.close();}
  await writeFile(attachment.path,'Tampered copy');await assert.rejects(core.attachments.content(session.id,[attachment.id]),/changed/);
  assert.equal(saved.draftRevision,'2');
});
test('failed local submissions preserve recoverable text without replaying a provider call',async t=>{
  const {core,session}=await setup(t,true);
  const draft=await core.rpc('session.draft',{id:session.id,text:'A valuable draft',attachmentIds:[]});
  await assert.rejects(core.send({id:session.id,text:draft.draft,expectedDraftRevision:draft.draftRevision}),/unavailable/);
  assert.equal(core.store.session(session.id).draft,'A valuable draft');
  assert.equal((await core.rpc('session.recovery',{id:session.id})).state,'uncertain');
});
test('removed attachments are deleted, while running turns retain files until completion',async t=>{
  const {core,session,directory}=await setup(t),source=join(directory,'reference.txt');await writeFile(source,'A reference document');
  const first=await core.rpc('attachments.import',{sessionId:session.id,path:source});
  assert.equal(core.store.session(session.id).draftAttachments?.[0].id,first.id);
  core.draft(session.id,'Removed',undefined,0,[]);assert.equal(core.store.get('attachment:'+first.id,null),null);
  const second=await core.rpc('attachments.import',{sessionId:session.id,path:source});
  await core.send({id:session.id,text:'Read it',attachmentIds:[second.id]});
  assert.ok(core.store.get('attachment:'+second.id,null));core.event(session.id,{type:'complete'});
  assert.equal(core.store.get('attachment:'+second.id,null),null);
});
test('confirmed forced stops release attachment copies and record interrupted results',async t=>{
  const {core,directory}=await setup(t),source=join(directory,'stop-reference.txt');await writeFile(source,'A reference retained only while the provider needs it');
  for(const stop of ['force','power']){
    const session=await core.create({provider:'codex',cwd:directory,trusted:true});
    const asset=await core.rpc('attachments.import',{sessionId:session.id,path:source});
    await core.send({id:session.id,text:'Read the reference',attachmentIds:[asset.id]});
    assert.ok(core.store.get('attachment:'+asset.id,null));
    if(stop==='force'){core.updateSession(session.id,{status:'stopping'});await core.forceStop(session.id);}else await core.stopAndClose(session.id);
    assert.equal(core.store.session(session.id).status,'interrupted');
    assert.equal(core.store.get('attachment:'+asset.id,null),null);
    assert.ok(![...core.tokens.values()].includes(session.id));
    const results=await core.rpc('results.list',{sessionId:session.id});
    assert.equal(results[0].providerOutcome,'interrupted');assert.equal(results[0].verification,'not-run');
  }
});
test('bookmarks and transcript search resolve current text instead of retaining forgotten copies',async t=>{
  const {core,session}=await setup(t);
  core.putMessage({id:'searchable',sessionId:session.id,role:'user',text:'Remember purple orchards',time:1});
  await core.rpc('message.bookmark',{sessionId:session.id,messageId:'searchable',bookmarked:true});
  assert.equal((await core.rpc('session.search',{query:'purple'})).length,1);
  core.putMessage({id:'searchable',sessionId:session.id,role:'user',text:'[Forgotten]',time:1});
  assert.equal((await core.rpc('session.search',{query:'purple'})).length,0);
  assert.equal((await core.rpc('bookmarks.list',{}))[0].text,'[Forgotten]');
});
test('temporary conversations never write transcript, drafts or submission recovery to the persistent database',async t=>{
  const {core,directory}=await setup(t);
  const s=await core.create({provider:'codex',cwd:directory,trusted:true,temporary:true});
  await core.rpc('session.draft',{id:s.id,text:'temporary secret',attachmentIds:[]});
  await core.send({id:s.id,text:'temporary secret'});
  assert.ok(core.store.messages(s.id).length);
  assert.equal(core.store.db.prepare('SELECT count(*) AS n FROM sessions WHERE id=?').get(s.id)!.n,0);
  assert.equal(core.store.db.prepare('SELECT count(*) AS n FROM messages WHERE session_id=?').get(s.id)!.n,0);
  assert.equal(core.store.db.prepare('SELECT count(*) AS n FROM meta WHERE key LIKE ?').get('%'+s.id+'%')!.n,0);
  assert.equal(core.settingsFor(s.id).memory.enabled,false);
  await core.rpc('session.discardTemporary',{id:s.id});assert.throws(()=>core.store.session(s.id));
});
test('memory review binds the supporting passage and preserves local-only confirmation',async t=>{
  const {core,session}=await setup(t);await core.memory.ready;
  core.putMessage({id:'proposal-source',sessionId:session.id,role:'assistant',text:'Perhaps use the violet release channel.',time:1});
  const proposal=await core.rpc('memoryReview.propose',{sessionId:session.id,messageId:'proposal-source',kind:'decision'});
  const listing=await core.rpc('memoryReview.list',{sessionId:session.id});assert.equal(listing.rows[0].sourceLabel,'Model suggestion');
  await assert.rejects(core.rpc('memoryReview.resolve',{sessionId:session.id,id:proposal.id,expectedRevision:'stale',choice:'confirm',text:'Use violet.'}),/changed/);
  const result=await core.rpc('memoryReview.resolve',{sessionId:session.id,id:proposal.id,expectedRevision:listing.rows[0].currentRevision,choice:'local',text:'Use the violet release channel.'});
  const inspected=await core.memory.graph(session,'inspect',{id:result.id});assert.ok(JSON.stringify(inspected).includes('local_only'));
  assert.equal((await core.rpc('memoryReview.list',{sessionId:session.id})).rows.length,0);
});
test('forgetting scrubs derived drafts, submissions, attachments and capsule copies',async t=>{
  const {core,session,directory}=await setup(t);await core.memory.ready;const text='The orchid release password phrase is not a real credential.';
  const source=join(directory,'source.txt');await writeFile(source,text);const asset=await core.attachments.import(session.id,source);
  await core.draft(session.id,text,undefined,0,[asset.id]);core.store.set('submission:'+session.id,{text,attachmentIds:[asset.id]});core.store.set('capsule:'+session.cwd,{goal:text});
  core.putMessage({id:'erasure-source',sessionId:session.id,role:'user',text,time:1});
  const saved=await core.memory.save(session,text);await core.memory.forget(session,saved.id);
  assert.doesNotMatch(core.store.session(session.id).draft,/orchid/);assert.equal(core.store.session(session.id).draftAttachments?.length,0);
  assert.doesNotMatch(JSON.stringify(core.store.get('submission:'+session.id,{})),/orchid/);assert.doesNotMatch(JSON.stringify(core.store.get('capsule:'+session.cwd,{})),/orchid/);
  await assert.rejects(core.attachments.content(session.id,[asset.id]),/no longer available/);
});
test('diagnostics omit raw errors, secrets and paths and require the exact preview',async t=>{
  const {core,session}=await setup(t);core.capabilities={codex:{available:true,version:'codex 1.2.3 secret-token',error:'authentication failed for secret-token at '+session.cwd}};
  const preview=await core.rpc('diagnostics.preview');assert.doesNotMatch(preview.text,/secret-token/);assert.ok(!preview.text.includes(session.cwd));assert.match(preview.text,/authentication/);
  await assert.rejects(core.rpc('diagnostics.export',{id:preview.id,digest:'wrong'}),/Review/);
  assert.ok((await core.rpc('diagnostics.export',{id:preview.id,digest:preview.digest})).path.endsWith('.json'));
});
test('manual executable review is invalidated by a changed definition',async t=>{
  const {core,directory}=await setup(t);const script={id:'review',name:'Review',executable:'/usr/bin/true',args:[],cwd:directory,timeout:1000};
  await core.updateSettings({scripts:[script]});await core.updateSettings({scripts:[{...script,args:['changed']}]});
  await assert.rejects(core.rpc('action.run',{name:'script.run',args:{id:'review'},expectedScript:script}),/changed/);
});
test('native branching uses the provider fork and rejects unsupported forks without copying history',async t=>{
  const {core,session,directory}=await setup(t),executable=join(directory,'fork-cli.mjs'),previous=process.env.CERE_CODEX_BIN;
  await writeFile(executable,`#!/usr/bin/env node
import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const reply=m.method==='thread/fork'?(m.params.threadId==='original'?{result:{thread:{id:'forked-native'}}}:{error:{message:'Fork unsupported'}}):{result:{}};process.stdout.write(JSON.stringify({id:m.id,...reply})+'\\n');}
`,{mode:0o700});process.env.CERE_CODEX_BIN=executable;
  t.after(()=>{if(previous===undefined)delete process.env.CERE_CODEX_BIN;else process.env.CERE_CODEX_BIN=previous;});
  core.updateSession(session.id,{nativeId:'original'});const branch=await core.rpc('session.nativeFork',{id:session.id});
  assert.equal(branch.nativeId,'forked-native');assert.notEqual(branch.id,session.id);assert.equal(branch.draft,'');assert.equal(core.store.messages(branch.id).length,0);
  core.updateSession(session.id,{nativeId:'unsupported'});await assert.rejects(core.rpc('session.nativeFork',{id:session.id}),/Fork unsupported/);
  assert.equal(core.store.sessions().length,2);
});
test('result verification records actual reviewed check exits and rejects changed definitions',async t=>{
  const {core,session,directory}=await setup(t),script={id:'test-check',name:'Focused check',executable:'/usr/bin/true',args:[],cwd:directory,timeout:1000};
  await core.updateSettings({scripts:[script]});const result=core.workflows.observeResult(session,undefined,'completed')!;
  const params={sessionId:session.id,resultId:result.id,scriptId:script.id,expectedScript:script,reviewed:true};
  const passed=await core.rpc('results.runVerification',params);assert.equal(passed.verification,'passed');assert.equal(passed.observed.at(-1).exitCode,0);
  const changed={...script,executable:'/usr/bin/false'};await core.updateSettings({scripts:[changed]});
  await assert.rejects(core.rpc('results.runVerification',params),/Review the exact saved check/);
  const failed=await core.rpc('results.runVerification',{...params,expectedScript:changed});assert.equal(failed.verification,'failed');assert.equal(failed.observed.at(-1).exitCode,1);
});
test('recipe validation rejects unreviewed search and edits before creating send side effects',async t=>{
  const {core,directory}=await setup(t);
  core.modelLoader=async()=>[{id:'fixture',displayName:'Fixture',description:'Local test',isDefault:true,efforts:[],defaultEffort:''}];
  const session=await core.create({provider:'ollama',model:'fixture',cwd:directory,trusted:true});await core.updateSettings({webSearch:{enabled:true}});
  const recipe=await core.rpc('recipes.save',{expectedRevision:'0',name:'Check',description:'',inputs:[],instructions:'Inspect only.',expectedOutput:'Findings.',permissions:{nativeAccess:[],description:'Read only.'},runtime:{maxSeconds:30,maxTurns:1}});
  const preview=await core.rpc('recipes.prepare',{sessionId:session.id,recipeId:recipe.id,inputs:{}});
  const created=await core.rpc('recipes.createDraft',{previewToken:preview.token,reviewed:true}),id=created.session.id;
  await assert.rejects(core.rpc('session.send',{id,text:created.session.draft,webSearch:true}),/public web search/);
  await assert.rejects(core.rpc('session.send',{id,text:created.session.draft+' unreviewed change'}),/draft changed/);
  assert.equal(core.store.session(id).status,'idle');assert.equal(core.store.messages(id).length,0);assert.equal(core.store.get('submission:'+id,null),null);
});
