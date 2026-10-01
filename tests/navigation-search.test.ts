import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function fixture(t:test.TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'cere-navigation-search-')),project=join(directory,'special-project');await mkdir(project);
  const core=new Core(new Store(join(directory,'state')),()=>({async send(){},async interrupt(){},async close(){}}));
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true})});
  const current=await core.create({provider:'codex',cwd:project,title:'Current conversation',trusted:true});
  return {core,current,project};
}

test('unified navigation search hydrates old sessions, current transcript, bookmarks, capsules, and projects',async t=>{
  const {core,current,project}=await fixture(t);
  for(let index=0;index<220;index++)core.store.saveSession({...current,id:`history-${index}`,title:`History ${index}`,updated:index+10});
  core.store.saveSession({...current,id:'archived-old',title:'Ancient launch journal',archived:true,updated:1});
  core.putMessage({id:'bookmark-message',sessionId:current.id,role:'user',text:'Keep the violet deployment note',time:20});
  core.putMessage({id:'reply-message',sessionId:current.id,role:'assistant',text:'The current transcript mentions an orchid failure mode',time:21});
  await core.rpc('message.bookmark',{sessionId:current.id,messageId:'bookmark-message',bookmarked:true});
  core.store.set('capsule:'+project,{cwd:project,revision:'1',updated:1,goal:'',decisions:['Use the sapphire release train'],constraints:['Never publish from a recipe'],questions:[],nextSteps:[],relevantSessionIds:[],sources:[]});

  let result:any=await core.rpc('navigation.search',{query:'Ancient launch',tag:'first',limit:80});
  assert.equal(result.tag,'first');assert.ok(result.entries.some((entry:any)=>entry.kind==='session'&&entry.value==='archived-old'&&/Archived/.test(entry.detail)));
  result=await core.rpc('navigation.search',{query:'orchid failure',tag:'transcript',limit:80});
  const transcript=result.entries.find((entry:any)=>entry.kind==='transcript');assert.equal(transcript.sessionId,current.id);assert.match(transcript.detail,/assistant/);assert.match(transcript.detail,/opens conversation/);
  result=await core.rpc('navigation.search',{query:'violet deployment',tag:'bookmark',limit:80});
  assert.ok(result.entries.some((entry:any)=>entry.kind==='bookmark'&&entry.navigationId===`session:${current.id}`));
  result=await core.rpc('navigation.search',{query:'sapphire release',tag:'capsule',limit:80});
  assert.ok(result.entries.some((entry:any)=>entry.kind==='capsule'&&entry.cwd===project&&entry.navigationId===`project:${project}`));
  result=await core.rpc('navigation.search',{query:'special-project',tag:'project',limit:80});
  assert.ok(result.entries.some((entry:any)=>entry.kind==='project'&&entry.cwd===project));

  core.putMessage({id:'reply-message',sessionId:current.id,role:'assistant',text:'[Forgotten]',time:21});
  assert.ok(!(await core.rpc('navigation.search',{query:'orchid failure',limit:80}) as any).entries.some((entry:any)=>entry.id==='message:reply-message'));
  core.store.set('capsule:'+project,{cwd:project,revision:'2',updated:2,goal:'',decisions:['Use the amber release train'],constraints:[],questions:[],nextSteps:[],relevantSessionIds:[],sources:[]});
  assert.ok(!(await core.rpc('navigation.search',{query:'sapphire release',limit:80}) as any).entries.some((entry:any)=>entry.kind==='capsule'));
});

test('blank navigation search is bounded and restores stable older destinations',async t=>{
  const {core,current}=await fixture(t);
  core.store.saveSession({...current,id:'favorite-old',title:'Favorite archived session',archived:true,updated:1});
  core.putMessage({id:'saved-message',sessionId:current.id,role:'assistant',text:'A saved current answer',time:1});
  await core.rpc('message.bookmark',{sessionId:current.id,messageId:'saved-message',bookmarked:true});
  await core.rpc('navigation.favorite',{id:'session:favorite-old',favorite:true});
  const result:any=await core.rpc('navigation.search',{query:'',tag:'blank',limit:5});
  assert.equal(result.query,'');assert.equal(result.tag,'blank');assert.ok(result.entries.length<=5);
  assert.ok(result.entries.some((entry:any)=>entry.kind==='session'&&entry.value==='favorite-old'));
  assert.ok(result.entries.some((entry:any)=>entry.kind==='bookmark'&&entry.sessionId===current.id));
  await assert.rejects(core.rpc('navigation.search',{query:'x',limit:101}),/limit/);
});
