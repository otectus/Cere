import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { normalizeClaudeModels, normalizeCodexModels } from '../broker/models.ts';
import type { ModelOption } from '../broker/types.ts';

const model=(id:string):ModelOption=>({id,displayName:id,description:'',efforts:[{id:'low',displayName:'Low'}],defaultEffort:'low',isDefault:true});

test('provider catalogs preserve CLI model names and model-specific efforts',()=>{
  assert.deepEqual(normalizeCodexModels([{id:'gpt-test',displayName:'GPT Test',description:'Current',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'},{reasoningEffort:'high',description:'Deep'}]}]),[
    {id:'gpt-test',displayName:'GPT Test',description:'Current',isDefault:true,defaultEffort:'high',efforts:[{id:'low',displayName:'Low',description:'Quick'},{id:'high',displayName:'High',description:'Deep'}]},
  ]);
  assert.deepEqual(normalizeClaudeModels([{value:'default',resolvedModel:'claude-test',displayName:'Default',description:'Configured',supportedEffortLevels:['low','xhigh']}]),[
    {id:'default',resolvedModel:'claude-test',displayName:'Default',description:'Configured',isDefault:true,defaultEffort:'',efforts:[{id:'low',displayName:'Low'},{id:'xhigh',displayName:'Extra high'}]},
  ]);
});

test('newer model refresh wins and failures retain the last usable catalog',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'cere-models-'));
  const pending:{resolve:(models:ModelOption[])=>void;reject:(error:Error)=>void}[]=[];
  const core=new Core(new Store(directory),()=>({async send(){},async interrupt(){},async close(){}}),()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true})});
  core.capabilities.codex={available:true,models:[model('old')],modelsStatus:'ready'};
  const first=core.refreshProviderModels('codex'),second=core.refreshProviderModels('codex');
  pending[1].resolve([model('new')]);await second;
  pending[0].resolve([model('stale')]);await first;
  assert.equal(core.capabilities.codex.models[0].id,'new');
  const failed=core.refreshProviderModels('codex');pending[2].reject(new Error('offline'));
  await assert.rejects(failed,/offline/);assert.equal(core.capabilities.codex.models[0].id,'new');assert.equal(core.capabilities.codex.modelsStatus,'error');
  const retried=core.refreshProviderModels('codex');pending[3].resolve([model('retry')]);await retried;
  assert.equal(core.capabilities.codex.models[0].id,'retry');assert.equal(core.capabilities.codex.modelsStatus,'ready');
});
