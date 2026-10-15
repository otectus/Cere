import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { CodexAdapter, ClaudeAdapter, CliCompatibilityError, claudeRestrictedHelp, claudeTranscriptTitle, cliStartError, cliVersionCheck, providerExecutable } from '../broker/providers.ts';
import { ensureUserPath } from '../broker/paths.ts';
import type { Hooks } from '../broker/providers.ts';
import type { Session } from '../broker/types.ts';
import { defaultPersonality } from '../broker/personality.ts';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-permissions-'));
  const executable = resolve('tests/fixtures/permissions-cli.mjs'), log = join(directory, 'requests.jsonl');
  for (const [key, value] of Object.entries({ CERE_CODEX_BIN: executable, CERE_CLAUDE_BIN: executable, CERE_PERMISSION_TEST_LOG: log })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = { id: 'fixture', provider: 'codex', cwd: directory, nativeId: null, model: '' } as Session;
  const messages = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { directory, executable, log, session, messages };
}

test('Codex applies bypass per turn and restores the configured sandbox on disable and resume', async t => {
  const f = await fixture(t); let bypass = false;const phases:string[]=[];
  const hooks: Hooks = { token: 'fixture', event() {}, native() {}, async approve() { return { choice: 'allow' }; }, bypassCliPermissions: () => bypass };
  const adapter = new CodexAdapter(f.session, hooks); t.after(() => adapter.close());
  await adapter.send('normal',[],{beforeAccept:()=>phases.push('authorized'),onDispatched:()=>phases.push('dispatched'),onAccepted:()=>phases.push('accepted')}); bypass = true;
  await adapter.send('full access'); bypass = false;
  await adapter.send('restricted again');
  const turns = (await f.messages()).filter(m => m.method === 'turn/start').map(m => m.params);
  assert.equal(turns[0].approvalPolicy, 'on-request'); assert.equal(turns[0].sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(phases,['authorized','dispatched','accepted']);
  assert.equal(turns[1].approvalPolicy, 'never'); assert.deepEqual(turns[1].sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(turns[1].approvalsReviewer, 'user');
  assert.deepEqual(turns[2].sandboxPolicy, turns[0].sandboxPolicy);
  assert.equal(turns[2].approvalPolicy, 'on-request');
  await adapter.close();
  const resumed = new CodexAdapter(f.session, hooks); t.after(() => resumed.close());
  await resumed.send('after restart');
  const params = (await f.messages()).find(m => m.method === 'thread/resume').params;
  assert.equal(params.approvalPolicy, 'on-request'); assert.equal(params.sandbox, 'workspace-write');
});

test('Codex resumes a large saved conversation without downloading its history', async t => {
  const f = await fixture(t), events: any[] = [];
  const previous = process.env.CERE_PERMISSION_TEST_HISTORY_BYTES;
  process.env.CERE_PERMISSION_TEST_HISTORY_BYTES = String(9 * 1024 * 1024);
  t.after(() => { if (previous === undefined) delete process.env.CERE_PERMISSION_TEST_HISTORY_BYTES; else process.env.CERE_PERMISSION_TEST_HISTORY_BYTES = previous; });
  const adapter = new CodexAdapter({ ...f.session, nativeId: 'permission-thread' }, {
    token: 'fixture', event: event => events.push(event), native() {}, async approve() { return { choice: 'deny' }; }
  });
  t.after(() => adapter.close());
  let accepted = false;
  await adapter.send('Continue the saved conversation', [], { onAccepted: () => { accepted = true; } });
  assert.equal(accepted, true);
  assert.equal(adapter.session.nativeId, 'permission-thread');
  assert.ok(events.every(event => event.type !== 'error'));
  const requests = await f.messages(), resume = requests.find(message => message.method === 'thread/resume').params;
  assert.equal(resume.threadId, 'permission-thread');
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.history, undefined);
  assert.equal(requests.filter(message => message.method === 'turn/start').length, 1);
});

test('Codex reports only confirmed success as complete and preserves terminal failures', async t => {
  const f=await fixture(t),events:any[]=[];
  const hooks:Hooks={token:'fixture',event:event=>events.push(event),native(){},async approve(){return{choice:'deny'};}};
  const adapter=new CodexAdapter(f.session,hooks);t.after(()=>adapter.close());await adapter.ready;
  for(const status of ['completed','succeeded','failed','interrupted','cancelled','stopped','mystery']){
    await adapter.handle({method:'turn/completed',params:{turn:{status,error:status==='failed'?{message:'Provider failure'}:undefined}}});
  }
  assert.deepEqual(events.slice(-7).map(event=>event.type),['complete','complete','error','interrupted','interrupted','interrupted','error']);
  assert.equal(events.at(-5).text,'Provider failure');assert.match(events.at(-1).text,/mystery/);
});

test('Codex enables input APIs and normalizes question metadata without replying after external resolution', async t => {
  const f=await fixture(t),approvals:any[]=[],events:any[]=[],writes:any[]=[];
  let finish:(answer:any)=>void=()=>{};
  const hooks:Hooks={token:'fixture',event:event=>events.push(event),native(){},approve:value=>{approvals.push(value);return new Promise(resolve=>{finish=resolve;});}};
  const adapter=new CodexAdapter(f.session,hooks);t.after(()=>adapter.close());await adapter.ready;
  const originalWrite=adapter.process.write.bind(adapter.process);adapter.process.write=(message:any)=>writes.push(message);
  const pending=adapter.handle({id:41,method:'item/tool/requestUserInput',params:{threadId:'child-thread',questions:[
    {id:'scope',header:'Scope',question:'Which areas?',options:[{label:'UI',description:'Desktop UI'}],multiSelect:true,isOther:false},
    {id:'token',header:'Secret',question:'Token?',isSecret:true,isOther:false,required:false}
  ]}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(approvals[0].nativeThreadId,'child-thread');
  assert.deepEqual(approvals[0].questions,[
    {id:'scope',header:'Scope',question:'Which areas?',options:[{label:'UI',description:'Desktop UI'}],multiSelect:true,isSecret:false,allowOther:false,required:true},
    {id:'token',header:'Secret',question:'Token?',multiSelect:false,isSecret:true,allowOther:true,required:false}
  ]);
  await adapter.handle({method:'serverRequest/resolved',params:{threadId:'child-thread',requestId:'41'}});
  await adapter.handle({method:'serverRequest/resolved',params:{threadId:'other-thread',requestId:41}});
  assert.equal(adapter.externallyResolved.size,0);
  await adapter.handle({method:'serverRequest/resolved',params:{threadId:'child-thread',requestId:41}});
  finish({choice:'deny',answers:{},resolved:true});await pending;
  assert.equal(writes.length,0);assert.deepEqual(events.at(-1),{type:'approvalResolved',data:{threadId:'child-thread',requestId:41}});
  assert.equal(adapter.externallyResolved.size,0);assert.equal(adapter.pendingRequests.size,0);
  adapter.process.write=originalWrite;
  const initialize=(await f.messages()).find(message=>message.method==='initialize');
  assert.equal(initialize.params.capabilities.experimentalApi,true);
  assert.ok(initialize.params.capabilities.optOutNotificationMethods.includes('item/commandExecution/outputDelta'));
});

test('Codex maps MCP form requirements and omits unanswered optional scalar values',async t=>{
  const f=await fixture(t),approvals:any[]=[],writes:any[]=[];
  const hooks:Hooks={token:'fixture',event(){},native(){},async approve(value){approvals.push(value);return{choice:'answer',answers:{level:{answers:['2']},enabled:{answers:[]},count:{answers:[]},note:{answers:['ready']},tags:{answers:['fast','safe']}}};}};
  const adapter=new CodexAdapter(f.session,hooks);t.after(()=>adapter.close());await adapter.ready;
  const originalWrite=adapter.process.write.bind(adapter.process);adapter.process.write=(message:any)=>writes.push(message);
  await adapter.handle({id:'form-1',method:'mcpServer/elicitation/request',params:{threadId:'permission-thread',serverName:'fixture',mode:'form',message:'Configure',requestedSchema:{type:'object',required:['level'],properties:{
    level:{type:'number',title:'Level',enum:[1,2]},enabled:{type:'boolean',title:'Enabled'},count:{type:'integer',title:'Count'},note:{type:'string',title:'Note'},tags:{type:'array',title:'Tags',items:{type:'string',enum:['fast','safe']}}
  }}}});
  const questions=approvals[0].questions;
  assert.deepEqual(questions.map((q:any)=>[q.id,q.required,q.allowOther,q.multiSelect]),[['level',true,false,false],['enabled',false,false,false],['count',false,true,false],['note',false,true,false],['tags',false,false,true]]);
  assert.deepEqual(questions[0].options,[{label:'1'},{label:'2'}]);
  assert.deepEqual(writes,[{id:'form-1',result:{action:'accept',content:{level:2,note:'ready',tags:['fast','safe']}}}]);
  adapter.process.write=originalWrite;
});

test('Codex presents safe MCP sign-in links for explicit approval and rejects other URL schemes',async t=>{
  const f=await fixture(t),approvals:any[]=[],events:any[]=[],writes:any[]=[];
  const adapter=new CodexAdapter(f.session,{token:'fixture',event:event=>events.push(event),native(){},async approve(value){approvals.push(value);return{choice:'allow'};}});t.after(()=>adapter.close());await adapter.ready;
  const originalWrite=adapter.process.write.bind(adapter.process);adapter.process.write=(message:any)=>writes.push(message);
  await adapter.handle({id:'url-safe',method:'mcpServer/elicitation/request',params:{threadId:'permission-thread',serverName:'accounts',mode:'url',message:'Sign in to continue',url:'https://example.com/login',elicitationId:'e-1'}});
  await adapter.handle({id:'url-bad',method:'mcpServer/elicitation/request',params:{threadId:'permission-thread',serverName:'accounts',mode:'url',message:'Sign in',url:'javascript:alert(1)',elicitationId:'e-2'}});
  await adapter.handle({id:'empty-form',method:'mcpServer/elicitation/request',params:{threadId:'permission-thread',serverName:'fixture',mode:'form',message:'Choose',requestedSchema:{type:'object',required:['choice'],properties:{choice:{type:'string',enum:[]}}}}});
  assert.equal(approvals.length,1);assert.equal(approvals[0].kind,'question');assert.equal(approvals[0].url,'https://example.com/login');assert.deepEqual(approvals[0].choices,['allow','deny']);
  assert.deepEqual(writes,[{id:'url-safe',result:{action:'accept'}},{id:'url-bad',result:{action:'decline'}},{id:'empty-form',result:{action:'decline'}}]);
  assert.equal(events.some(event=>event.type==='message'&&/unsupported sign-in URL/.test(event.text)),true);
  assert.equal(events.some(event=>event.type==='message'&&/form Cere cannot display/.test(event.text)),true);
  adapter.process.write=originalWrite;
});

test('Codex emits subagent lifecycle while keeping child output out of the parent transcript', async t => {
  const f=await fixture(t),events:any[]=[];
  const hooks:Hooks={token:'fixture',event:event=>events.push(event),native(){},async approve(){return{choice:'deny'};}};
  const adapter=new CodexAdapter(f.session,hooks);t.after(()=>adapter.close());await adapter.ready;
  await adapter.handle({method:'thread/started',params:{thread:{id:'compact-1',parentThreadId:'permission-thread',status:{type:'active'},source:{subAgent:'compact'}}}});
  await adapter.handle({method:'thread/status/changed',params:{threadId:'compact-1',status:{type:'idle'}}});
  await adapter.handle({method:'thread/started',params:{thread:{id:'child-1',parentThreadId:'permission-thread',agentNickname:'Scout',status:{type:'active'},source:{subAgent:{thread_spawn:{parent_thread_id:'permission-thread',depth:1}}}}}});
  await adapter.handle({method:'item/started',params:{threadId:'permission-thread',item:{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'permission-thread',receiverThreadIds:['child-1'],agentsStates:{'child-1':{status:'running'}},prompt:'Inspect protocol',status:'completed'}}});
  await adapter.handle({method:'item/agentMessage/delta',params:{threadId:'child-1',itemId:'child-message',delta:'private child progress'}});
  await adapter.handle({method:'item/completed',params:{threadId:'child-1',item:{id:'child-message',type:'agentMessage',text:'child final report'}}});
  await adapter.handle({method:'turn/completed',params:{threadId:'child-1',turn:{status:'completed'}}});
  const childEvents=events.filter(event=>event.type==='agent'&&event.id==='child-1');
  assert.equal(events.some(event=>event.type==='agent'&&event.id==='compact-1'),false);
  assert.equal(events.some(event=>event.type==='activity'&&event.text==='compacting'),true);
  assert.equal(childEvents[0].data.name,'Scout');assert.equal(childEvents.at(-1).data.status,'completed');
  assert.equal(childEvents.some(event=>event.data.task==='Inspect protocol'),true);
  assert.equal(events.some(event=>['delta','message','tool','complete'].includes(event.type)&&JSON.stringify(event).includes('child')),false);
  assert.equal(events.some(event=>event.type==='activity'&&event.text==='delegating'),true);
  await adapter.handle({method:'turn/started',params:{threadId:'child-1',turn:{id:'child-turn-2'}}});
  assert.equal(events.filter(event=>event.type==='agent'&&event.id==='child-1').at(-1).data.status,'running');
  const interrupted:any[]=[];const originalRequest=adapter.process.request.bind(adapter.process);
  adapter.process.request=async(method:string,params:any)=>{interrupted.push({method,params});return{};};
  await adapter.interrupt();adapter.process.request=originalRequest;
  assert.deepEqual(interrupted,[{method:'turn/interrupt',params:{threadId:'child-1',turnId:'child-turn-2'}}]);
});

test('provider reasoning signals thinking without exposing private reasoning as tool activity', async t => {
  const f=await fixture(t),codexEvents:any[]=[];
  const hooks:Hooks={token:'fixture',event:event=>codexEvents.push(event),native(){},async approve(){return{choice:'deny'};}};
  const codex=new CodexAdapter(f.session,hooks);t.after(()=>codex.close());await codex.ready;
  await codex.handle({method:'item/started',params:{item:{id:'reasoning',type:'reasoning',text:'private chain'}}});
  await codex.handle({method:'item/completed',params:{item:{id:'reasoning',type:'reasoning',text:'private chain'}}});
  await codex.handle({method:'item/started',params:{item:{id:'command',type:'commandExecution',command:'printf test'}}});
  assert.deepEqual(codexEvents.slice(-3).map(event=>event.type),['activity','activity','tool']);
  assert.ok(!codexEvents.some(event=>event.type==='tool'&&event.id==='reasoning'));
  assert.ok(!JSON.stringify(codexEvents).includes('private chain'));

  const claudeEvents:any[]=[];
  const claude=new ClaudeAdapter({...f.session,provider:'claude'},{...hooks,event:event=>claudeEvents.push(event)});t.after(()=>claude.close());
  await claude.send('Think privately');const proc=claude.process!;
  proc.emit('message',{type:'stream_event',event:{type:'content_block_start',content_block:{type:'thinking',thinking:'hidden thought'}}});
  proc.emit('message',{type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'hidden continuation'}}});
  proc.emit('message',{type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'observed result'}]}});
  assert.deepEqual(claudeEvents.slice(0,4).map(event=>event.type),['activity','activity','tool','activity']);
  assert.ok(!JSON.stringify(claudeEvents).includes('hidden thought'));assert.ok(!JSON.stringify(claudeEvents).includes('hidden continuation'));
  await once(proc,'exit');
});

test('Claude launches in bypass mode only when selected and disables its optional sandbox', async t => {
  const f = await fixture(t); let bypass = true;
  const adapter = new ClaudeAdapter({ ...f.session, provider: 'claude' }, { token: 'fixture', event() {}, native() {}, async approve() {}, bypassCliPermissions: () => bypass });
  t.after(() => adapter.close());
  await adapter.send('bypass'); await once(adapter.process!, 'exit');
  bypass = false; await adapter.send('normal again'); await once(adapter.process!, 'exit');
  const [first, second] = (await f.messages()).filter(m => m.args).map(m => m.args);
  assert.ok(first.includes('--dangerously-skip-permissions'));
  assert.equal(JSON.parse(first[first.indexOf('--settings') + 1]).sandbox.enabled, false);
  assert.ok(!second.includes('--dangerously-skip-permissions')); assert.ok(!second.includes('--settings'));
  assert.equal(second[second.indexOf('--permission-mode') + 1], 'manual');
  assert.equal(second[second.indexOf('--resume') + 1], 'claude-permission-thread');
});

test('Claude never starts a second print process while the previous turn is still exiting', async t => {
  const f = await fixture(t); const previous = process.env.CERE_FIXTURE_LINGER_MS; process.env.CERE_FIXTURE_LINGER_MS = '600';
  t.after(() => { if (previous === undefined) delete process.env.CERE_FIXTURE_LINGER_MS; else process.env.CERE_FIXTURE_LINGER_MS = previous; });
  const events: any[] = [];
  const adapter = new ClaudeAdapter({ ...f.session, provider: 'claude' }, { token: 'fixture', event: event => events.push(event), native() {}, async approve() {} });
  t.after(() => adapter.close());
  await adapter.send('first'); const first = adapter.process!;
  while (!events.some(e => e.type === 'complete')) await new Promise(r => setTimeout(r, 10));
  assert.equal(first.closed, false, 'the fixture is still exiting after its result');
  await adapter.send('second'); await once(adapter.process!, 'exit');
  const lifecycle = (await f.messages()).filter(m => m.lifecycle).map(m => m.lifecycle);
  assert.deepEqual(lifecycle, ['start', 'exit', 'start', 'exit']);
});

test('Claude remote sessions use the enforceable restricted CLI boundary', async t => {
  const f=await fixture(t);let verified=false;
  const adapter=new ClaudeAdapter({...f.session,provider:'claude'},{token:'fixture',event(){},native(){},async approve(){return{choice:'deny'};},restrictive:true,policy:value=>{verified=value;},bypassCliPermissions:()=>true});
  const image=join(f.directory,'uploaded.image');await writeFile(image,Buffer.from([137,80,78,71,13,10,26,10]));
  t.after(()=>adapter.close());await adapter.send('remote request',[image]);await once(adapter.process!,'exit');
  const args=(await f.messages()).find(m=>m.args).args;
  assert.equal(verified,true);assert.ok(args.includes('--restricted'));assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode')+1],'manual');
  assert.ok(!args.includes('--dangerously-skip-permissions'));assert.ok(!args.includes('--settings'));
  assert.ok(args.includes('--permission-prompt-tool'));assert.equal(args[args.indexOf('--permission-prompt-tool')+1],'mcp__cere__approve');
  const mediaDirectory=args[args.indexOf('--add-dir')+1];assert.ok(mediaDirectory.endsWith('/media'));await assert.rejects(stat(mediaDirectory),{code:'ENOENT'});
  assert.equal(claudeRestrictedHelp('flags --restricted --strict-mcp-config choices: "manual"'),true);
  assert.equal(claudeRestrictedHelp('flags --strict-mcp-config choices: "manual"'),false);
});

test('Codex refreshes personality between turns while retaining thread, user input and configured instructions', async t => {
  const f=await fixture(t);let personality=defaultPersonality;
  const events:any[]=[];
  const hooks:Hooks={token:'fixture',event:e=>events.push(e),native(){},async approve(){},personality:()=>personality};
  const adapter=new CodexAdapter(f.session,hooks);t.after(()=>adapter.close());
  await adapter.send('First question');await adapter.send('Same voice');
  personality='Be calm and direct.\nNo sarcasm.';await adapter.send('Next question',['/tmp/attached.png']);
  personality='';await adapter.send('Neutral now');
  await adapter.close();
  const resumed=new CodexAdapter(f.session,hooks);t.after(()=>resumed.close());await resumed.send('After restart');
  const messages=await f.messages(),threads=messages.filter(m=>['thread/start','thread/resume'].includes(m.method));
  assert.equal(threads.length,4);assert.equal(threads[0].method,'thread/start');
  assert.ok(threads[0].params.developerInstructions.includes(defaultPersonality));
  assert.match(threads[1].params.developerInstructions,/Be calm and direct/);
  assert.ok(!threads[1].params.developerInstructions.includes(defaultPersonality));
  for(const thread of threads){
    assert.match(thread.params.developerInstructions,/Existing project guidance must survive/);
    assert.equal(thread.params.baseInstructions,undefined);
    assert.equal(thread.params.approvalPolicy,'on-request');
  }
  for(const thread of threads.slice(1))assert.equal(thread.params.threadId,'permission-thread');
  for(const thread of threads.slice(2))assert.match(thread.params.developerInstructions,/neutral voice/);
  const turns=messages.filter(m=>m.method==='turn/start');
  assert.deepEqual(turns.map(m=>m.params.input[0].text),['First question','Same voice','Next question','Neutral now','After restart']);
  assert.deepEqual(turns[2].params.input[1],{type:'localImage',path:'/tmp/attached.png'});
  assert.ok(events.every(e=>e.type!=='error'));
});

test('Codex refreshes a changed name without changing personality or interrupting a running process', async t => {
  const f = await fixture(t); let name = 'Cere';
  const adapter = new CodexAdapter(f.session, { token: 'fixture', event() {}, native() {}, async approve() {}, assistantName: () => name });
  t.after(() => adapter.close());
  await adapter.send('First'); const originalProcess = adapter.process;
  name = 'Daemona';
  assert.equal(adapter.process, originalProcess);
  assert.equal(adapter.appliedAssistantName, 'Cere');
  await adapter.send('Renamed');
  assert.notEqual(adapter.process, originalProcess);
  await adapter.send('Still Daemona');
  name = 'Cere'; await adapter.send('Reset name');
  const threads = (await f.messages()).filter(m => ['thread/start','thread/resume'].includes(m.method));
  assert.equal(threads.length, 3);
  assert.match(threads[1].params.developerInstructions, /You are Daemona,/);
  assert.doesNotMatch(threads[1].params.developerInstructions, /You are Cere,/);
  assert.match(threads[2].params.developerInstructions, /You are Cere,/);
  for (const thread of threads.slice(1)) assert.equal(thread.params.threadId, 'permission-thread');
});

test('Claude appends the current personality on each resumed turn without replacing its system prompt',async t=>{
  const f=await fixture(t);let personality=defaultPersonality;
  const adapter=new ClaudeAdapter({...f.session,provider:'claude'},{token:'fixture',event(){},native(){},async approve(){},personality:()=>personality});
  t.after(()=>adapter.close());
  for(const next of [defaultPersonality,'Be quietly encouraging.','']){
    personality=next;await adapter.send('User question');await once(adapter.process!,'exit');
  }
  const messages=await f.messages(),args=messages.filter(m=>m.args).map(m=>m.args);
  const prompts=messages.filter(m=>m.personality),instructions=prompts.map(m=>m.personality);
  assert.ok(instructions[0].includes(defaultPersonality));assert.match(instructions[1],/Be quietly encouraging/);
  assert.ok(!instructions[1].includes(defaultPersonality));assert.match(instructions[2],/neutral voice/);
  for(const a of args){assert.ok(!a.includes('--system-prompt'));assert.ok(!a.includes('--append-system-prompt'));assert.equal(a[a.indexOf('--permission-mode')+1],'manual');assert.equal(a[a.indexOf('--system-prompt-snapshot')+1],'off');}
  for(const prompt of prompts){assert.equal(prompt.mode,0o600);await assert.rejects(stat(prompt.path),{code:'ENOENT'});}
  assert.equal(args[1][args[1].indexOf('--resume')+1],'claude-permission-thread');
});

test('Claude picks up a new assistant name on the next resumed turn', async t => {
  const f = await fixture(t); let name = 'Cere';
  const adapter = new ClaudeAdapter({ ...f.session, provider: 'claude' }, { token: 'fixture', event() {}, native() {}, async approve() {}, assistantName: () => name });
  t.after(() => adapter.close());
  for (const next of ['Cere', 'Daemona']) { name = next; await adapter.send('Hello'); await once(adapter.process!, 'exit'); }
  const prompts = (await f.messages()).filter(m => m.personality);
  assert.match(prompts[0].personality, /You are Cere,/);
  assert.match(prompts[1].personality, /You are Daemona,/);
  assert.equal(prompts[1].mode, 0o600);
});

test('Codex carries the memory guidance only while Cere offers memory tools, and resumes when that changes', async t => {
  const f = await fixture(t); let memory = false;
  const adapter = new CodexAdapter(f.session, { token: 'fixture', event() {}, native() {}, async approve() {}, memoryGuidance: () => memory });
  t.after(() => adapter.close());
  await adapter.send('First'); memory = true; await adapter.send('Second'); await adapter.send('Third');
  const threads = (await f.messages()).filter(m => ['thread/start','thread/resume'].includes(m.method));
  assert.equal(threads.length, 2);
  assert.doesNotMatch(threads[0].params.developerInstructions, /Cere shared project memory/);
  assert.match(threads[1].params.developerInstructions, /Cere shared project memory/);
  assert.equal(threads[1].params.threadId, 'permission-thread');
});

test('Claude carries the memory guidance only on turns when Cere offers memory tools', async t => {
  const f = await fixture(t); let memory = false;
  const adapter = new ClaudeAdapter({ ...f.session, provider: 'claude' }, { token: 'fixture', event() {}, native() {}, async approve() {}, memoryGuidance: () => memory });
  t.after(() => adapter.close());
  for (const next of [false, true]) { memory = next; await adapter.send('Hello'); await once(adapter.process!, 'exit'); }
  const prompts = (await f.messages()).filter(m => m.personality);
  assert.doesNotMatch(prompts[0].personality, /Cere shared project memory/);
  assert.match(prompts[1].personality, /Cere shared project memory/);
});

test('Claude tracks foreground and background agents without leaking forwarded child messages',async t=>{
  const f=await fixture(t),events:any[]=[];
  const hooks:Hooks={token:'fixture',event:event=>events.push(event),native(){},async approve(){}};
  const adapter=new ClaudeAdapter({...f.session,provider:'claude'},hooks);t.after(()=>adapter.close());
  await adapter.send('Delegate');const proc=adapter.process!;
  proc.emit('message',{type:'assistant',parent_tool_use_id:null,message:{id:'root',content:[{type:'tool_use',id:'agent-tool',name:'Agent',input:{subagent_type:'researcher',description:'Investigate',run_in_background:true}}]}});
  proc.emit('message',{type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'task-1',task_type:'local_agent',description:'Investigate'}]});
  proc.emit('message',{type:'system',subtype:'task_started',task_id:'task-1',tool_use_id:'agent-tool',task_type:'local_agent',subagent_type:'researcher',description:'Investigate',prompt:'Read the sources',is_backgrounded:true});
  proc.emit('message',{type:'user',parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:'agent-tool',content:'Agent launched in background'}]}});
  proc.emit('message',{type:'assistant',parent_tool_use_id:'agent-tool',message:{id:'child',content:[{type:'text',text:'child-only report'}]}});
  proc.emit('message',{type:'tool_progress',tool_use_id:'child-tool',tool_name:'Read',parent_tool_use_id:'agent-tool',elapsed_time_seconds:2});
  proc.emit('message',{type:'result',session_id:'claude-thread',is_error:false});
  assert.equal(events.filter(event=>event.type==='agent'&&event.id==='agent-tool').at(-1).data.status,'running');
  assert.equal(events.some(event=>event.type==='message'&&JSON.stringify(event).includes('child-only')),false);
  assert.equal(events.some(event=>event.type==='activity'&&event.text==='waitingForAgents'),true);
  proc.emit('message',{type:'system',subtype:'task_notification',task_id:'task-1',tool_use_id:'agent-tool',status:'completed',summary:'Research done'});
  assert.equal(events.filter(event=>event.type==='agent'&&event.id==='agent-tool').at(-1).data.status,'completed');
  assert.equal(events.filter(event=>event.type==='agent'&&event.id==='task-1').length,0);
  proc.emit('message',{type:'assistant',parent_tool_use_id:null,message:{id:'root-2',content:[{type:'tool_use',id:'agent-failed',name:'Task',input:{subagent_type:'tester',description:'Run checks'}}]}});
  proc.emit('message',{type:'user',parent_tool_use_id:null,tool_use_result:{result:'Compilation failed'},message:{content:[{type:'tool_result',tool_use_id:'agent-failed',is_error:true,content:[{type:'text',text:'exit code 1'}]}]}});
  const failed=events.filter(event=>event.type==='agent'&&event.id==='agent-failed').at(-1);
  assert.equal(failed.data.status,'failed');assert.match(failed.data.detail,/exit code 1/);
  await once(proc,'exit');
  const args=(await f.messages()).find(message=>message.args).args;assert.ok(args.includes('--forward-subagent-text'));
});

test('Claude uses task lifecycle as authority and interrupts unresolved tasks when its process exits',async t=>{
  const f=await fixture(t),events:any[]=[];
  const adapter=new ClaudeAdapter({...f.session,provider:'claude'},{token:'fixture',event:event=>events.push(event),native(){},async approve(){}});t.after(()=>adapter.close());
  await adapter.send('Run background work');const proc=adapter.process!;
  proc.emit('message',{type:'system',subtype:'task_started',task_id:'bash-task',task_type:'local_bash',description:'Build',is_backgrounded:true});
  proc.emit('message',{type:'system',subtype:'task_progress',task_id:'bash-task',description:'Build',last_tool_name:'Bash',usage:{total_tokens:0,tool_uses:1,duration_ms:10}});
  proc.emit('message',{type:'result',session_id:'claude-thread',is_error:false});
  await once(proc,'exit');
  const taskEvents=events.filter(event=>event.type==='agent'&&event.id==='bash-task');
  assert.equal(taskEvents.some(event=>event.data.status==='running'),true);
  assert.equal(taskEvents.at(-1).data.status,'interrupted');
  assert.match(taskEvents.at(-1).data.detail,/process ended/i);
  const errorIndex=events.findIndex(event=>event.type==='error'&&/background tasks/.test(event.text));
  const interruptedIndex=events.findLastIndex(event=>event.type==='agent'&&event.id==='bash-task'&&event.data.status==='interrupted');
  assert.ok(errorIndex>=0&&errorIndex<interruptedIndex);
});

test('terminal wrapper inherits the saved CLI bypass setting for both providers', async t => {
  const f = await fixture(t); let bypass = false;
  // Use an isolated broker socket and executable PATH; no real terminal or provider is touched.
  const { symlink } = await import('node:fs/promises');
  await symlink(f.executable, join(f.directory, 'codex')); await symlink(f.executable, join(f.directory, 'claude'));
  const server = net.createServer(socket => {
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const result = m.method === 'windows.list' ? [] : m.method === 'session.link' ? { id: 'linked' } : m.method === 'state' ? { settings: { bypassCliPermissions: bypass } } : true;
        socket.write(JSON.stringify({ id: m.id, result }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(f.directory, 'broker.sock'), resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  for (const provider of ['codex', 'claude']) for (const setting of [false, true]) {
    bypass = setting;
    const child = spawn(process.execPath, ['broker/terminal.ts', provider, '--fixture'], { env: { ...process.env, CERE_RUNTIME_DIR: f.directory, PATH: f.directory + ':' + process.env.PATH }, stdio: 'pipe' });
    assert.equal((await once(child, 'close'))[0], 0);
    const args = (await f.messages()).filter(m => m.args).at(-1).args;
    assert.equal(args.includes(provider === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions'), setting);
    assert.ok(args.includes('--fixture'));
  }
});


test('Codex revalidates automatic approval immediately before writing native permissions', async t => {
  const f=await fixture(t),writes:any[]=[];let valid=true;
  const hooks:Hooks={token:'fixture',event(){},native(){},async approve(){return{choice:'allow',automatic:true};},automaticApprovalValid:()=>valid};
  const adapter=new CodexAdapter(f.session,hooks);t.after(()=>adapter.close());await adapter.ready;
  const original=adapter.process.write.bind(adapter.process);adapter.process.write=(value:any)=>writes.push(value);
  const pending=adapter.handle({id:501,method:'item/commandExecution/requestApproval',params:{command:'printf test'}});valid=false;await pending;
  assert.equal(writes.at(-1).result.decision,'decline');
  valid=true;
  const permissions=adapter.handle({id:502,method:'item/permissions/requestApproval',params:{permissions:{network:true}}});valid=false;await permissions;
  assert.deepEqual(writes.at(-1).result.permissions,{});
  valid=true;await adapter.handle({id:503,method:'item/commandExecution/requestApproval',params:{command:'printf test'}});
  assert.equal(writes.at(-1).result.decision,'accept');adapter.process.write=original;
});

test('Claude coalesces a subagent\'s streamed detail and reports status changes at once',async t=>{
  const f=await fixture(t),events:any[]=[];
  const adapter=new ClaudeAdapter({...f.session,provider:'claude'},{token:'fixture',event:event=>events.push(event),native(){},async approve(){}});t.after(()=>adapter.close());
  await adapter.send('Delegate');const proc=adapter.process!;
  const agentEvents=()=>events.filter(event=>event.type==='agent'&&event.id==='agent-tool');
  proc.emit('message',{type:'assistant',parent_tool_use_id:null,message:{id:'root',content:[{type:'tool_use',id:'agent-tool',name:'Agent',input:{subagent_type:'researcher',description:'Investigate'}}]}});
  assert.equal(agentEvents().length,1);assert.equal(agentEvents()[0].data.status,'starting');
  proc.emit('message',{type:'tool_progress',tool_use_id:'child-tool',tool_name:'Read',parent_tool_use_id:'agent-tool',elapsed_time_seconds:1});
  assert.equal(agentEvents().length,2); // starting → running goes out at once
  // Virtual time: the fixture process must not exit between these steps.
  t.mock.timers.enable({apis:['setTimeout']});
  for(let n=0;n<40;n++)proc.emit('message',{type:'stream_event',parent_tool_use_id:'agent-tool',event:{type:'content_block_delta',delta:{type:'text_delta',text:'token '+n}}});
  assert.equal(agentEvents().length,2); // forty tokens: nothing yet
  t.mock.timers.tick(300);
  assert.equal(agentEvents().length,3);assert.match(agentEvents().at(-1).data.detail,/token 39$/);
  proc.emit('message',{type:'stream_event',parent_tool_use_id:'agent-tool',event:{type:'content_block_delta',delta:{type:'text_delta',text:' more'}}});
  proc.emit('message',{type:'user',parent_tool_use_id:null,message:{content:[{type:'tool_result',tool_use_id:'agent-tool',content:'finished'}]}});
  assert.equal(agentEvents().at(-1).data.status,'completed');assert.match(agentEvents().at(-1).data.detail,/finished/);
  t.mock.timers.tick(300);
  assert.equal(agentEvents().at(-1).data.status,'completed'); // superseded detail never follows the terminal status
  t.mock.timers.reset();
  proc.emit('message',{type:'result',session_id:'claude-thread',is_error:false});await once(proc,'exit');
});

function withEnv(t: any, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test('Claude holds a result while background work runs and ends the turn with that work', async t => {
  const f = await fixture(t); withEnv(t, { CERE_FIXTURE_LINGER_MS: '500' });
  const events: any[] = [], natives: string[] = [];
  const adapter = new ClaudeAdapter({ ...f.session, provider: 'claude' }, { token: 'fixture', event: event => events.push(event), native: id => natives.push(id), async approve() {} });
  t.after(() => adapter.close());
  await adapter.send('Build in the background'); const proc = adapter.process!;
  proc.emit('message', { type: 'system', subtype: 'task_started', task_id: 'build', task_type: 'local_bash', description: 'Build', is_backgrounded: true });
  proc.emit('message', { type: 'result', session_id: 'claude-thread', is_error: false });
  // The fixture's own result arrives as well; neither ends the turn while the build runs.
  while (!natives.includes('claude-permission-thread')) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.some(event => event.type === 'complete'), false);
  assert.equal(events.some(event => event.type === 'activity' && event.text === 'waitingForAgents'), true);
  proc.emit('message', { type: 'system', subtype: 'task_notification', task_id: 'build', status: 'completed', summary: 'Build passed' });
  proc.emit('message', { type: 'assistant', parent_tool_use_id: null, message: { id: 'follow-up', content: [{ type: 'text', text: 'The build passed.' }] } });
  assert.equal(events.some(event => event.type === 'complete'), false);
  await once(proc, 'exit');
  const completes = events.filter(event => event.type === 'complete');
  assert.equal(completes.length, 1);
  assert.ok(events.findIndex(event => event.type === 'message' && event.text === 'The build passed.') < events.indexOf(completes[0]));
  assert.equal(events.some(event => event.type === 'error'), false);
});

test('Claude ignores a replaced process and cancels a turn stopped before it starts', async t => {
  const f = await fixture(t); withEnv(t, { CERE_FIXTURE_LINGER_MS: '3000' });
  const events: any[] = [];
  const adapter = new ClaudeAdapter({ ...f.session, provider: 'claude' }, { token: 'fixture', event: event => events.push(event), native() {}, async approve() {} });
  t.after(() => adapter.close());
  await adapter.send('first'); const first = adapter.process!;
  while (!events.some(event => event.type === 'complete')) await new Promise(resolve => setTimeout(resolve, 10));
  const second = adapter.send('second');
  first.emit('message', { type: 'result', session_id: 'claude-thread', is_error: true, errors: ['late failure from the replaced process'] });
  await adapter.interrupt(); await second;
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.deepEqual(events.filter(event => event.type === 'interrupted').map(event => event.text), ['Stopped before Claude started this turn']);
  assert.equal((await f.messages()).filter(message => message.lifecycle === 'start').length, 1);
  assert.equal(adapter.process, undefined);
});

test('Codex approvals show announced diffs, network destinations, terminal input and offered decisions', async t => {
  const f = await fixture(t), approvals: any[] = [], writes: any[] = [];
  const adapter = new CodexAdapter(f.session, { token: 'fixture', event() {}, native() {}, async approve(value) { approvals.push(value); return { choice: 'deny' }; } });
  t.after(() => adapter.close()); await adapter.ready;
  const original = adapter.process.write.bind(adapter.process); adapter.process.write = (value: any) => writes.push(value);
  const base = { threadId: 'permission-thread', turnId: 'turn', startedAtMs: 1 };
  await adapter.handle({ method: 'item/started', params: { threadId: 'permission-thread', turnId: 'turn', item: { id: 'patch-1', type: 'fileChange', status: 'inProgress', changes: [{ path: 'src/app.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }] } } });
  await adapter.handle({ id: 'fc-1', method: 'item/fileChange/requestApproval', params: { ...base, itemId: 'patch-1', reason: 'Update the greeting' } });
  await adapter.handle({ method: 'item/fileChange/patchUpdated', params: { threadId: 'permission-thread', turnId: 'turn', itemId: 'patch-2', changes: [{ path: 'README.md', kind: { type: 'add' }, diff: '+hello' }] } });
  await adapter.handle({ id: 'fc-2', method: 'item/fileChange/requestApproval', params: { ...base, itemId: 'patch-2' } });
  await adapter.handle({ id: 'fc-3', method: 'item/fileChange/requestApproval', params: { ...base, itemId: 'never-announced' } });
  await adapter.handle({ id: 'net-1', method: 'item/commandExecution/requestApproval', params: { ...base, itemId: 'cmd-1', command: 'curl https://example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' }, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } });
  await adapter.handle({ id: 'stdin-1', method: 'item/commandExecution/requestApproval', params: { ...base, itemId: 'cmd-2', kind: 'writeStdin', command: 'python3 repl.py', availableDecisions: ['decline', 'cancel'] } });
  await adapter.handle({ id: 'cmd-3', method: 'item/commandExecution/requestApproval', params: { ...base, itemId: 'cmd-3', command: 'cat notes.txt', cwd: '/work', commandActions: [{ type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: '/work/notes.txt' }] } });
  const [diff, patched, missing, network, stdin, command] = approvals;
  assert.equal(diff.title, 'Allow file changes?'); assert.equal(diff.detail, 'Update the greeting\n\nupdate src/app.ts\n@@ -1 +1 @@\n-old\n+new'); assert.equal(diff.remoteAllow, true);
  assert.equal(patched.detail, 'add README.md\n+hello'); assert.equal(patched.remoteAllow, true);
  assert.equal(missing.remoteAllow, false); assert.match(missing.detail, /unavailable/);
  assert.equal(network.title, 'Allow network access to example.com?'); assert.equal(network.detail, 'https · example.com\nRequested by: curl https://example.com'); assert.deepEqual(network.choices, ['allow', 'deny', 'cancel']);
  assert.equal(stdin.title, 'Allow input to a running command?'); assert.deepEqual(stdin.choices, ['deny', 'cancel']);
  assert.equal(command.title, 'Allow this command?'); assert.equal(command.detail, 'cat notes.txt\nReads notes.txt\n/work');
  assert.deepEqual(writes.map(write => write.result.decision), ['decline', 'decline', 'decline', 'decline', 'decline', 'decline']);
  adapter.process.write = original;
});

test('Codex answers time reads and maps compaction, v2 sub-agents, notices and async questions', async t => {
  const f = await fixture(t), events: any[] = [], writes: any[] = [];
  const adapter = new CodexAdapter(f.session, { token: 'fixture', event: event => events.push(event), native() {}, async approve() { return { choice: 'deny' }; } });
  t.after(() => adapter.close()); await adapter.ready;
  const original = adapter.process.write.bind(adapter.process); adapter.process.write = (value: any) => writes.push(value);
  const before = Math.floor(Date.now() / 1000);
  await adapter.handle({ id: 'time-1', method: 'currentTime/read', params: { threadId: 'permission-thread' } });
  assert.equal(writes[0].id, 'time-1'); assert.ok(writes[0].result.currentTimeAt >= before); assert.equal(events.some(event => event.type === 'message'), false);
  await adapter.handle({ method: 'item/started', params: { threadId: 'permission-thread', item: { id: 'compact', type: 'contextCompaction' } } });
  await adapter.handle({ method: 'item/completed', params: { threadId: 'permission-thread', item: { id: 'compact', type: 'contextCompaction' } } });
  assert.equal(events.some(event => event.type === 'tool' && event.id === 'compact'), false);
  assert.equal(events.some(event => event.type === 'activity' && event.text === 'compacting'), true);
  await adapter.handle({ method: 'item/started', params: { threadId: 'permission-thread', item: { id: 'sa-1', type: 'subAgentActivity', agentThreadId: 'child-9', kind: 'started', agentPath: '/root/reviewer', model: 'gpt-test', reasoningEffort: 'low' } } });
  await adapter.handle({ method: 'item/completed', params: { threadId: 'permission-thread', item: { id: 'sa-2', type: 'subAgentActivity', agentThreadId: 'child-9', kind: 'interacted', agentPath: '/root/reviewer' } } });
  await adapter.handle({ method: 'item/completed', params: { threadId: 'permission-thread', item: { id: 'sa-3', type: 'subAgentActivity', agentThreadId: 'child-9', kind: 'completed', agentPath: '/root/reviewer' } } });
  const agent = events.filter(event => event.type === 'agent' && event.id === 'child-9');
  assert.deepEqual(agent[0].data, { name: 'reviewer', status: 'running', detail: 'gpt-test · low' }); assert.equal(agent.at(-1).data.status, 'completed');
  assert.equal(events.some(event => event.type === 'tool' && String(event.id).startsWith('sa-')), false);
  assert.equal(events.some(event => event.type === 'activity' && event.text === 'delegating'), true);
  await adapter.handle({ method: 'item/completed', params: { threadId: 'permission-thread', item: { id: 'list', type: 'collabAgentToolCall', tool: 'listAgents', senderThreadId: 'permission-thread', receiverThreadIds: [], agentsStates: { 'old-agent': { status: 'completed' } }, status: 'completed' } } });
  assert.equal(events.some(event => event.type === 'agent' && event.id === 'old-agent'), false);
  await adapter.handle({ method: 'model/rerouted', params: { threadId: 'permission-thread', turnId: 'turn', fromModel: 'gpt-a', toModel: 'gpt-b', reason: 'highRiskCyberActivity' } });
  await adapter.handle({ method: 'configWarning', params: { summary: 'Unknown key', details: 'tui.foo is not recognized' } });
  await adapter.handle({ method: 'warning', params: { threadId: 'child-9', message: 'Only for the child' } });
  const notices = events.filter(event => event.type === 'tool' && event.data?.notice === true);
  assert.deepEqual(notices.map(event => event.text), ['Codex notice: Codex switched from gpt-a to gpt-b (highRiskCyberActivity).', 'Codex notice: Unknown key\ntui.foo is not recognized']);
  await adapter.handle({ method: 'item/completed', params: { threadId: 'permission-thread', item: { id: 'reply', type: 'agentMessage', text: 'Working on it.', delivery: 'async', questions: [{ title: 'Which branch?', options: ['main', 'dev'] }, { title: 'Working on it.' }] } } });
  assert.equal(events.at(-1).text, 'Working on it.\n\n- Which branch? (main / dev)');
  adapter.process.write = original;
});

test('CLI detection requires supported versions and finds launchers a service PATH misses', async t => {
  assert.deepEqual(cliVersionCheck('claude', '2.1.296 (Claude Code)'), { version: '2.1.296' });
  assert.deepEqual(cliVersionCheck('claude', '2.2.0 (Claude Code)'), { version: '2.2.0' });
  assert.deepEqual(cliVersionCheck('codex', 'codex-cli 0.162.1'), { version: '0.162.1' });
  assert.deepEqual(cliVersionCheck('codex', 'codex-ui-fixture'), {});
  assert.throws(() => cliVersionCheck('claude', '2.1.258 (Claude Code)'), (error: any) => error instanceof CliCompatibilityError && error.message === 'Update Claude Code to 2.1.259 or newer; Cere found 2.1.258.');
  assert.throws(() => cliVersionCheck('codex', 'codex-cli 0.157.9'), /Update Codex to 0\.158\.0 or newer/);
  assert.equal(cliStartError('codex', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })), 'Codex was not found on PATH or in ~/.local/bin. Install it, or set CERE_CODEX_BIN to its path.');
  assert.equal(cliStartError('claude', { killed: true, signal: 'SIGTERM' }), 'Claude Code did not answer within 10 seconds.');
  assert.equal(cliStartError('claude', Object.assign(new Error('Command failed'), { code: 2 })), 'Claude Code did not start (exit status 2).');
  const home = await mkdtemp(join(tmpdir(), 'cere-home-')), empty = join(home, 'empty');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.local/bin'), { recursive: true }); await mkdir(empty);
  const launcher = join(home, '.local/bin/claude'); await writeFile(launcher, '#!/bin/sh\n', { mode: 0o755 });
  withEnv(t, { HOME: home, PATH: empty, CERE_CLAUDE_BIN: undefined });
  assert.equal(providerExecutable('claude'), launcher);
  const env: NodeJS.ProcessEnv = { PATH: '/opt/tools' }, expected = [join(home, '.local/bin'), '/opt/tools', '/usr/local/bin', '/usr/bin'].join(':');
  assert.equal(ensureUserPath(env), expected); assert.equal(ensureUserPath(env), expected);
});

test('Claude history titles skip command, caveat and memory records', () => {
  assert.equal(claudeTranscriptTitle([
    { type: 'user', isMeta: true, message: { content: '<local-command-caveat>Caveat</local-command-caveat>' } },
    { type: 'user', message: { content: '<command-name>/model</command-name>' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'Fix the login bug' }] } },
  ]), 'Fix the login bug');
  assert.equal(claudeTranscriptTitle([{ type: 'user', message: { content: 'First prompt' } }, { type: 'ai-title', aiTitle: 'Old' }, { type: 'ai-title', aiTitle: 'Login fix' }]), 'Login fix');
  assert.equal(claudeTranscriptTitle([{ type: 'user', message: { content: '<cere_memory_data>\n{"episodes":[]}\n</cere_memory_data>\n\nWhat changed?' } }]), 'What changed?');
  assert.equal(claudeTranscriptTitle([{ type: 'summary' }]), '');
});
