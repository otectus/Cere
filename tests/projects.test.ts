import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { ModelOption, ProjectDefaults } from '../broker/types.ts';

const defaults:ProjectDefaults={provider:'codex',model:'fixture',effort:'high',trusted:true,tools:false,temporary:false};
const models:ModelOption[]=[{id:'fixture',displayName:'Fixture',description:'',efforts:[{id:'high',displayName:'High'}],defaultEffort:'high',isDefault:true,capabilities:['tools']}];
async function setup(t:any){
  const directory=await mkdtemp(join(tmpdir(),'cere-projects-'));
  const core=new Core(new Store(join(directory,'state')),()=>({async send(){},async close(){},async interrupt(){}}),async()=>models);
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  const cwd=join(directory,'project');await mkdir(cwd);
  const save=(patch:any={})=>core.rpc('projects.save',{cwd,name:'My project',favorite:false,expectedRevision:'0',defaults,...patch});
  return {core,directory,cwd,save};
}
test('projects canonicalize paths, persist defaults and create named sessions without changing existing conversations',async t=>{
  const {core,directory,cwd,save}=await setup(t);
  const alias=join(directory,'alias');await symlink(cwd,alias);
  const existing=await core.create({provider:'claude',cwd,trusted:true,title:'Original'});
  const project=await save({cwd:alias,favorite:true});assert.equal(project.cwd,cwd);
  await assert.rejects(save(),/changed/);
  const session=await core.rpc('projects.createSession',{cwd,expectedRevision:project.revision,title:'  New task  ',provider:'claude',trusted:false,tools:true,temporary:true});
  assert.equal(session.title,'New task');assert.equal(session.provider,'codex');assert.equal(session.model,'fixture');assert.equal(session.effort,'high');assert.equal(session.cwd,cwd);assert.equal(session.temporary,undefined);
  assert.deepEqual(core.store.session(existing.id),existing);
  const persisted=new Store(join(directory,'state'));
  try{assert.deepEqual(JSON.parse(String(persisted.db.prepare('SELECT data FROM projects WHERE cwd=?').get(cwd)?.data)),project);}finally{persisted.close();}
  const rows=(await core.rpc('projects.list')).projects;assert.equal(rows.length,1);assert.equal(rows[0].favorite,true);assert.equal(rows[0].sessions,2);
});
test('discovery includes old and archived projects beyond snapshots, but never temporary-only paths or implicit trust',async t=>{
  const {core,cwd,directory}=await setup(t);
  const first=await core.create({...defaults,cwd,title:'Old'});
  core.updateSession(first.id,{archived:true,updated:1});
  for(let i=0;i<220;i++)core.store.saveSession({...first,id:'recent-'+i,cwd:directory,updated:100+i});
  const privatePath=join(directory,'private');await mkdir(privatePath);
  await core.create({...defaults,cwd:privatePath,temporary:true});
  assert.ok(!core.snapshot().sessions.some(s=>s.id===first.id));
  const rows=(await core.rpc('projects.list')).projects;
  assert.equal(rows.length,2);const old=rows.find((p:any)=>p.cwd===cwd);
  assert.equal(old.total,1);assert.equal(old.sessions,0);assert.equal(old.defaults.provider,'codex');assert.equal(old.defaults.trusted,false);assert.equal(old.configured,false);
  await assert.rejects(core.rpc('projects.createSession',{cwd,expectedRevision:'0',title:'Needs setup'}),/Save the project settings/);
});
test('project revisions reject stale saves and quick creation, including edits during async model validation',async t=>{
  const {core,cwd,save}=await setup(t);
  const project=await save({defaults:{...defaults,provider:'ollama',effort:''}});
  let resolve!:(models:ModelOption[])=>void,entered!:()=>void;
  const loading=new Promise<void>(done=>entered=done);
  core.modelLoader=()=>{entered();return new Promise(done=>resolve=done)};
  const opening=core.rpc('projects.createSession',{cwd,expectedRevision:project.revision,title:'Racing'});
  await loading;
  const next=await save({expectedRevision:project.revision,name:'Edited elsewhere'});
  resolve(models);await assert.rejects(opening,/changed/);assert.equal(core.store.sessionCount(),0);
  await assert.rejects(save({expectedRevision:project.revision}),/changed/);
  await assert.rejects(core.rpc('projects.createSession',{cwd,expectedRevision:project.revision,title:'Stale'}),/changed/);
  assert.equal((await core.rpc('projects.list')).projects[0].revision,next.revision);
});
test('quick creation enforces saved trust, current permission settings and available models',async t=>{
  const {core,cwd,save}=await setup(t);
  const project=await save({defaults:{...defaults,trusted:false}});
  const open=()=>core.rpc('projects.createSession',{cwd,expectedRevision:project.revision,title:'Check',trusted:true});
  await assert.rejects(open(),/trust/);assert.equal(core.store.sessionCount(),0);
  await core.updateSettings({bypassCliPermissions:true});assert.equal((await open()).provider,'codex');
  await core.updateSettings({bypassCliPermissions:false});await assert.rejects(open(),/trust/);
  const trusted=await save({expectedRevision:project.revision});
  core.capabilities.codex={modelsStatus:'ready',models:[]};
  await assert.rejects(core.rpc('projects.createSession',{cwd,expectedRevision:trusted.revision,title:'Unavailable'}),/no selectable models/);
  assert.equal(core.store.sessionCount(),1);
});
test('Ollama and API project defaults retain tool/temporary choices and leave conversations independent',async t=>{
  const {core,cwd,save}=await setup(t);
  const project=await save({defaults:{...defaults,provider:'ollama',effort:'',tools:true}});
  const first=await core.rpc('projects.createSession',{cwd,expectedRevision:project.revision,title:'Tools'});assert.equal(first.ollama.tools,true);
  const edited=await save({expectedRevision:project.revision,defaults:{...defaults,provider:'ollama',effort:'',temporary:true,tools:false}});
  const second=await core.rpc('projects.createSession',{cwd,expectedRevision:edited.revision,title:'Temporary'});assert.equal(second.temporary,true);assert.equal(second.ollama.tools,false);
  assert.equal((await core.rpc('projects.list')).projects[0].sessions,2);
  assert.equal(core.store.session(first.id).ollama?.tools,true);
  const api=await save({expectedRevision:edited.revision,defaults:{...defaults,provider:'openai',model:'custom-api-model',effort:'',tools:true}});
  await assert.rejects(core.rpc('projects.createSession',{cwd,expectedRevision:api.revision,title:'Missing key'}),/API key/);
  await core.rpc('provider.credentials',{provider:'openai',key:'fixture-key'});
  const third=await core.rpc('projects.createSession',{cwd,expectedRevision:api.revision,title:'API'});assert.equal(third.model,'custom-api-model');assert.equal(third.api.tools,true);
});
test('invalid settings and empty names fail without creating projects or sessions',async t=>{
  const {core,cwd,save}=await setup(t);
  for(const patch of [{cwd:'relative'},{name:'  '},{favorite:'true'},{defaults:{...defaults,trusted:'yes'}},{defaults:{...defaults,model:'bad\nmodel'}},{defaults:{...defaults,provider:'unknown'}},{defaults:{...defaults,provider:'ollama',effort:'high'}},{defaults:{...defaults,provider:'ollama',effort:'',tools:true,temporary:true}}])await assert.rejects(save(patch));
  assert.equal((await core.rpc('projects.list')).projects.length,0);
  const project=await save();
  for(const title of ['', '   ', 'bad\nname', 'x'.repeat(101)])await assert.rejects(core.rpc('projects.createSession',{cwd,expectedRevision:project.revision,title}),/session name/);
  assert.equal(core.store.sessionCount(),0);
  await rm(cwd,{recursive:true});await assert.rejects(core.rpc('projects.createSession',{cwd,expectedRevision:project.revision,title:'Missing folder'}),/ENOENT/);
});
