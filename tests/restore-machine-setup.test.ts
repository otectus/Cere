import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { activatePendingRecovery } from '../broker/recovery.ts';
import { RemoteStore } from '../broker/remote/store.ts';
import { ProviderCredentials } from '../broker/credentials.ts';

test('restore keeps this machine’s keys, phones, voices and preferences while the backup supplies content',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cere-restore-setup-'));
  const core=new Core(new Store(dir),()=>({async send(){},async interrupt(){},async close(){}}));
  let previous='';
  t.after(async()=>{if(!core.closed)await core.close();await rm(dir,{recursive:true,force:true});if(previous)await rm(previous,{recursive:true,force:true});});
  await core.memory.ready;
  core.credentials.update('openai','sk-test-machine-key');
  await mkdir(join(dir,'remote-identity'),{mode:0o700});
  await writeFile(join(dir,'remote-identity','identity.pem'),'identity key',{mode:0o600});
  await writeFile(join(dir,'remote-identity','tls.crt'),'certificate',{mode:0o600});
  const remote=new RemoteStore(core.store),cursorKey=core.store.get('remoteCursorKey','');
  remote.saveDevice({id:'00000000-0000-4000-8000-000000000001',name:'Kept phone',connectionKey:'c',actionKey:'a',keyVersion:1,scopeVersion:'3',createdAt:1,expiresAt:Date.now()+86400000,projects:[{id:'p',name:'Project',path:dir}],caps:['chat.read'],categories:[],scriptIds:[],ollamaHosts:[]});
  remote.configure({enabled:true,addresses:['127.0.0.1'],port:8443,name:'Cere'});
  core.store.set('indextts.voices',[{id:'voice-1',name:'Kept voice',version:'2.5'}]);
  core.store.set('transcriptEpoch','old-epoch');
  const session=await core.create({provider:'codex',cwd:dir,trusted:true,title:'Restored conversation'});core.draft(session.id,'Draft from the backup');
  core.store.set('settings',{...core.store.get('settings',{}),personality:'Keep this personality',ollama:{host:'http://127.0.0.1:9',model:''},speechEnabled:true,scale:1,
    grants:[{category:'files',cwd:dir,expires:Date.now()+100000}]});
  core.settings=core.store.settings();
  const backup=await core.rpc('recovery.backup',{includeContent:true});
  for(const name of ['profile.json','manifest.json'])assert.doesNotMatch(await readFile(join(backup.directory,name),'utf8'),/sk-test-machine-key|Keep this personality|Kept phone/);
  // Changes made after the backup are this machine's current setup and must survive.
  core.store.set('settings',{...core.store.get('settings',{}),personality:'Keep this personality',scale:1.5});
  const review=await core.rpc('recovery.preview',{directory:backup.directory,includeContent:true});
  assert.match(review.kept,/API keys, paired phones, voice profiles, personality/);assert.match(review.replaced,/Conversations, drafts, notes/);
  const activation=await core.rpc('recovery.activate',{id:review.id,digest:review.digest});previous=activation.previous;await core.close();
  assert.equal(activatePendingRecovery(dir),true);
  const restored=new Store(dir);
  try{
    const settings=restored.settings();
    assert.equal(restored.session(session.id).draft,'Draft from the backup');
    assert.equal(settings.personality,'Keep this personality');assert.equal(settings.ollama.host,'http://127.0.0.1:9');assert.equal(settings.speechEnabled,true);
    assert.equal(settings.scale,1,'display preferences come from the backup');
    assert.equal(settings.paused,true);assert.deepEqual(settings.grants,[]);
    assert.deepEqual(restored.get('indextts.voices',[]),[{id:'voice-1',name:'Kept voice',version:'2.5'}]);
    assert.equal(restored.get('remoteCursorKey',''),cursorKey);assert.equal(restored.get<any>('remoteConfig',{}).enabled,true);
    assert.notEqual(restored.get('transcriptEpoch','old-epoch'),'old-epoch');
    assert.equal(new RemoteStore(restored).device('00000000-0000-4000-8000-000000000001')?.name,'Kept phone');
  }finally{restored.close();}
  assert.equal(new ProviderCredentials(join(dir,'credentials')).key('openai'),'sk-test-machine-key');
  assert.equal((await stat(join(dir,'credentials','provider-credentials.json'))).mode&0o777,0o600);
  assert.equal(await readFile(join(dir,'remote-identity','identity.pem'),'utf8'),'identity key');
});
