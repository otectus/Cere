import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AntigravityAdapter, antigravityModels } from '../broker/antigravity.ts';
import { discoverProviderModels } from '../broker/models.ts';
import type { Session } from '../broker/types.ts';

async function fixture(t:any) {
  const directory=await mkdtemp(join(tmpdir(),'cere-agy-')),log=join(directory,'argv');
  const old=process.env.CERE_ANTIGRAVITY_BIN,oldLog=process.env.CERE_AGY_TEST_LOG;
  process.env.CERE_ANTIGRAVITY_BIN=resolve('tests/fixtures/antigravity.mjs');process.env.CERE_AGY_TEST_LOG=log;
  const session:Session={id:'agy',provider:'antigravity',nativeId:null,title:'Test',cwd:directory,mode:'managed',status:'idle',created:0,updated:0,draft:'',scroll:0,model:'fixture-model',effort:'high'};
  const events:any[]=[],native:string[]=[];let bypass=false;
  const adapter=new AntigravityAdapter(session,{token:'test',event:e=>events.push(e),native:id=>native.push(id),approve:async()=>({choice:'deny'}),bypassCliPermissions:()=>bypass});
  t.after(async()=>{await adapter.close();if(old===undefined)delete process.env.CERE_ANTIGRAVITY_BIN;else process.env.CERE_ANTIGRAVITY_BIN=old;if(oldLog===undefined)delete process.env.CERE_AGY_TEST_LOG;else process.env.CERE_AGY_TEST_LOG=oldLog;await rm(directory,{recursive:true,force:true});});
  return{adapter,session,events,native,log,setBypass:()=>{bypass=true;}};
}
test('AntiGravity streams distinct replies, resumes only its ID, and honors explicit CLI bypass',async t=>{
  const f=await fixture(t);await f.adapter.send('hello');await f.adapter.task;
  assert.equal(f.events.at(-1).type,'complete');assert.deepEqual(f.events.filter(e=>e.type==='message').map(e=>e.text),['Hello there','Finished']);
  assert.equal(f.native[0],'fixture-conversation');
  f.setBypass();await f.adapter.send('again');await f.adapter.task;
  const args=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(!args[0].includes('--dangerously-skip-permissions'));assert.ok(!args[0].includes('--continue'));
  assert.ok(args[1].includes('--dangerously-skip-permissions'));assert.ok(args[1].includes('fixture-conversation'));assert.ok(args[1].includes('--disable-slash-commands'));
});
test('AntiGravity stop and error results never report success; unsupported images fail before dispatch',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.adapter.send('image',['/some/image']),/text attachments/);
  await f.adapter.send('fail');await f.adapter.task;assert.equal(f.events.at(-1).type,'error');assert.match(f.events.at(-1).text,/provider failure/);
  await f.adapter.send('hang');await f.adapter.interrupt();assert.equal(f.events.at(-1).type,'interrupted');
});
test('AntiGravity catalog uses the actual tab-separated CLI format',async t=>{
  await fixture(t);const models=await discoverProviderModels('antigravity');assert.equal(models[0].id,'fixture-model');assert.equal(models[0].displayName,'Fixture Model');
  assert.deepEqual(antigravityModels('Fetching available models...\n'),[]);
});
test('AntiGravity model slugs offer only their pinned effort',()=>{
  const models=antigravityModels('gemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
  assert.deepEqual(models.map(m=>m.efforts.map(e=>e.id)),[['high'],['low'],['medium'],['low','medium','high']]);
  assert.deepEqual(models.map(m=>m.defaultEffort),['high','low','medium','']);
});
test('AntiGravity rejects saved conflicting effort before dispatch and accepts model default or matching effort',async t=>{
  const f=await fixture(t);f.session.model='gemini-3.1-pro-high';f.session.effort='medium';
  let dispatched=false;
  await assert.rejects(f.adapter.send('hello',[],{onDispatched:()=>{dispatched=true;}}),/selects high effort.*cannot use medium.*Open Model/);
  assert.equal(dispatched,false);assert.equal(f.adapter.process,undefined);assert.equal(f.events.length,0);
  for(const effort of ['','high']){f.session.effort=effort;await f.adapter.send('hello');await f.adapter.task;assert.equal(f.events.at(-1).type,'complete');}
  const args=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(args.length,2);
  for(const argv of args){assert.equal(argv[argv.indexOf('--model')+1],'gemini-3.1-pro-high');assert.ok(!argv.includes('--effort'));}
});
test('AntiGravity provider errors retain useful details, redact credentials and tolerate missing details',async t=>{
  const f=await fixture(t);
  await f.adapter.send('fail-details');await f.adapter.task;
  assert.equal(f.events.at(-1).type,'error');
  assert.match(f.events.at(-1).text,/model conflicts with effort/);
  assert.ok(!/test-secret|test-key|\x1b/.test(f.events.at(-1).text));
  await f.adapter.send('fail-empty');await f.adapter.task;
  assert.match(f.events.at(-1).text,/no error details/);
});
