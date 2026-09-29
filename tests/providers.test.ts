import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { CodexAdapter, ClaudeAdapter } from '../broker/providers.ts';
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
  const f = await fixture(t); let bypass = false;
  const hooks: Hooks = { token: 'fixture', event() {}, native() {}, async approve() { return { choice: 'allow' }; }, bypassCliPermissions: () => bypass };
  const adapter = new CodexAdapter(f.session, hooks); t.after(() => adapter.close());
  await adapter.send('normal'); bypass = true;
  await adapter.send('full access'); bypass = false;
  await adapter.send('restricted again');
  const turns = (await f.messages()).filter(m => m.method === 'turn/start').map(m => m.params);
  assert.equal(turns[0].approvalPolicy, 'on-request'); assert.equal(turns[0].sandboxPolicy.type, 'workspaceWrite');
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
  assert.equal(second[second.indexOf('--permission-mode') + 1], 'default');
  assert.equal(second[second.indexOf('--resume') + 1], 'claude-permission-thread');
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
  for(const a of args){assert.ok(!a.includes('--system-prompt'));assert.ok(!a.includes('--append-system-prompt'));assert.equal(a[a.indexOf('--permission-mode')+1],'default');}
  for(const prompt of prompts){assert.equal(prompt.mode,0o600);await assert.rejects(stat(prompt.path),{code:'ENOENT'});}
  assert.equal(args[1][args[1].indexOf('--resume')+1],'claude-permission-thread');
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
