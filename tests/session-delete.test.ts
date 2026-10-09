import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function fixture(t:any){
  const dir=await mkdtemp(join(tmpdir(),'cere-delete-'));
  const core=new Core(new Store(dir),()=>({async send(){},async interrupt(){},async close(){}}));
  t.after(async()=>{if(!core.closed)await core.close();await rm(dir,{recursive:true,force:true});});
  await core.memory.ready;return{core,dir};
}
const exists=(path:string)=>access(path).then(()=>true,()=>false);

test('deleting a conversation removes everything Cere kept only for it',async t=>{
  const {core,dir}=await fixture(t);
  const kept=await core.create({provider:'codex',cwd:dir,trusted:true,title:'Kept conversation'});
  const s=await core.create({provider:'codex',cwd:dir,trusted:true,title:'Delete me'});
  const child=await core.create({provider:'codex',cwd:dir,trusted:true,title:'Delegated child'});
  const note=join(dir,'note.txt');await writeFile(note,'attached');
  const asset=await core.attachments.import(s.id,note);core.draft(s.id,'Unsent draft',undefined,undefined,[asset.id]);
  core.putMessage({id:'delete-me-user',sessionId:s.id,role:'user',text:'Hello',time:Date.now()});
  core.putMessage({id:'delete-me-reply',sessionId:s.id,role:'assistant',text:'Hi',time:Date.now()});
  core.putMessage({id:'kept-reply',sessionId:kept.id,role:'assistant',text:'Still here',time:Date.now()});
  await core.rpc('message.bookmark',{sessionId:s.id,messageId:'delete-me-reply',bookmarked:true});assert.equal(core.store.bookmarks().length,1);
  core.queueCompletion(core.store.session(s.id),core.store.messageById('delete-me-reply'));
  core.store.set('submission:'+s.id,{text:'x',attachmentIds:[],turnId:'t',time:1,state:'uncertain'});
  core.store.set('ollama:'+s.id,[{role:'user',content:'x'}]);
  core.store.set('navigation',{favorites:['session:'+s.id,'session:'+kept.id],recents:['session:'+s.id]});
  core.updateSession(child.id,{parentId:s.id});
  await assert.rejects(core.rpc('session.delete',{id:s.id}),/Confirm/);
  assert.equal(await core.rpc('session.delete',{id:s.id,confirmed:true}),true);
  assert.throws(()=>core.store.session(s.id),/no longer exists/);
  assert.deepEqual(core.store.messages(s.id),[]);assert.equal(core.store.messageById('delete-me-reply'),undefined);
  assert.equal(await exists(asset.path),false);assert.equal(core.store.get('attachment:'+asset.id,'absent'),'absent');
  assert.equal(core.store.get('submission:'+s.id,'absent'),'absent');assert.equal(core.store.get('ollama:'+s.id,'absent'),'absent');
  assert.ok(!core.store.bookmarks().some(b=>b.sessionId===s.id));
  assert.ok(!core.completions.some(c=>c.sessionId===s.id));assert.ok(!core.snapshot().sessions.some((x:any)=>x.id===s.id));
  assert.deepEqual(core.store.get('navigation',{}),{favorites:['session:'+kept.id],recents:[]});
  assert.equal(core.store.session(child.id).parentId,undefined);
  assert.equal(core.store.messageById('kept-reply')?.text,'Still here');assert.equal(core.store.session(kept.id).title,'Kept conversation');
});

test('a conversation with work in progress cannot be deleted',async t=>{
  const {core,dir}=await fixture(t);
  const s=await core.create({provider:'codex',cwd:dir,trusted:true});
  core.updateSession(s.id,{status:'working'});
  await assert.rejects(core.rpc('session.delete',{id:s.id,confirmed:true}),/Stop this conversation/);
  core.updateSession(s.id,{status:'idle'});
  const temporary=await core.create({provider:'codex',cwd:dir,trusted:true,temporary:true});
  await assert.rejects(core.rpc('session.delete',{id:temporary.id,confirmed:true}),/Discard temporary/);
  assert.equal(core.store.session(s.id).id,s.id);
});
