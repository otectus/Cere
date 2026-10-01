import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Core} from '../broker/core.ts';
import {Store} from '../broker/store.ts';

test('idle energy defaults to Lively, persists Calm, and rejects unknown profiles',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cere-motion-'));
 const store=new Store(directory),core=new Core(store);
 t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
 assert.equal(core.settings.idleEnergy,'lively');
 await core.rpc('settings.update',{idleEnergy:'calm'});
 assert.equal(store.settings().idleEnergy,'calm');
 const reopened=new Store(directory);assert.equal(reopened.settings().idleEnergy,'calm');reopened.db.close();reopened.volatile.close();
 await assert.rejects(core.rpc('settings.update',{idleEnergy:'frantic'}),/Idle energy/);
 assert.equal(store.settings().idleEnergy,'calm');
});

test('settled tone shares attention transport without overriding activity or accepting a second authority',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'cere-mood-'));
 const core=new Core(new Store(directory));
 t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
 const session={id:'mood-session',provider:'ollama' as const,nativeId:'',title:'Mood',cwd:directory,mode:'managed' as const,status:'idle' as const,created:Date.now(),updated:Date.now(),draft:'',scroll:0,model:''};
 core.store.saveSession(session);core.panels.ui=true;
 const mood={mood:'concerned',moodConfidence:.8,reactive:true,messageId:'reply'};
 await core.rpc('ui.attention',{owner:'ui',sessionId:session.id,listening:false,mood});
 assert.equal(core.snapshot().attention.ui.mood?.mood,'concerned');
 await core.rpc('ui.attention',{owner:'ui',sessionId:session.id,listening:true});
 assert.equal(core.snapshot().attention.ui.mood?.mood,'concerned');
 await core.rpc('ui.attention',{owner:'ui',sessionId:session.id,listening:false,mood:{...mood,mood:'curious'}});
 assert.equal(core.snapshot().attention.ui.listening,true,'tone cannot overwrite composer attention');
 await assert.rejects(core.rpc('ui.attention',{owner:'overlay',sessionId:session.id,listening:false,mood}),/active expression host/);
 await assert.rejects(core.rpc('ui.attention',{owner:'ui',sessionId:session.id,listening:false,mood:{...mood,mood:'invented'}}),/Invalid settled mood/);
 assert.equal(core.store.session(session.id).status,'idle');
});
