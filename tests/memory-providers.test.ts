import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { Hooks } from '../broker/providers.ts';
import type { Provider } from '../broker/types.ts';

async function fixture(t: any, provider: Provider = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'cere-provider-memory-'));
  const sent: string[] = [];
  let hooks: Hooks;
  const core = new Core(new Store(directory), (_session, h) => {
    hooks = h;
    return {
      async send(text, _images, options) { options?.beforeAccept?.(); sent.push(text); },
      async interrupt() { h.event({type:'interrupted'}); },
      async close() {},
    };
  });
  await core.memory.ready;
  clearInterval(core.memory.service.timer);
  await core.updateSettings({memory:{enabled:true, allowCloudMemory:true}, speechEnabled:false});
  // Await configuration before introducing deterministic per-turn fixtures.
  await core.memory.configure();
  const session = await core.create({provider, cwd:directory, trusted:true});
  core.tokens.set('test-token', session.id);
  t.after(async () => { await core.close(); await rm(directory, {recursive:true, force:true}); });
  return {core, session, sent, hooks:() => hooks!};
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} receives bounded shared context and captures only successful replies`, async t => {
    const f = await fixture(t, provider), captured: any[] = [], prepared: any[] = [];
    f.core.memory.context = async (session, text, _signal, budget, route) => {
      prepared.push({provider:session.provider, text, budget, route});
      return '<cere_memory_data>shared project decision</cere_memory_data>';
    };
    f.core.memory.capture = async (_session, text, answer, _signal, authorize) => {
      authorize?.(); captured.push({text, answer}); return {outcome:'captured'};
    };
    await f.core.send({id:f.session.id, text:'Continue the work'});
    assert.deepEqual(prepared, [{provider, text:'Continue the work', budget:4000, route:'cloud'}]);
    assert.match(f.sent[0], /^<cere_memory_data>shared project decision/);
    assert.ok(f.sent[0].endsWith('Continue the work'));
    assert.equal(f.core.store.messages(f.session.id).find(m => m.role === 'user')?.text, 'Continue the work');
    f.hooks().event({type:'message', id:'reply', text:'A completed reply'});
    f.hooks().event({type:'complete'});
    await Promise.all(f.core.memoryCaptures);
    assert.deepEqual(captured, [{text:'Continue the work', answer:'A completed reply'}]);
    await f.core.send({id:f.session.id, text:'Stop this one'});
    f.hooks().event({type:'message', id:'partial', text:'Unfinished work'});
    await f.core.stop(f.session.id);
    assert.equal(captured.length, 1);
    assert.equal(f.core.nativeMemoryTurns.size, 0);
  });
}

test('native MCP exposes shared memory only with current cloud and remote authority', async t => {
  const {core, session} = await fixture(t);
  let tools = await core.rpc('mcp.tools', {token:'test-token'});
  assert.ok(tools.some((d:any) => d.name === 'memory.search'));
  assert.ok(tools.some((d:any) => d.name === 'memory.save'));
  let query = '';
  core.memory.recall = async (_session, text) => { query = String(text); return {results:[{text:'shared fact'}]}; };
  assert.deepEqual(await core.rpc('mcp.call', {token:'test-token', name:'memory.search', args:{query:'earlier decisions'}}), {results:[{text:'shared fact'}]});
  assert.equal(query, 'earlier decisions');
  await assert.rejects(core.rpc('mcp.call', {token:'wrong', name:'memory.search', args:{query:'x'}}), /expired/);
  await core.updateSettings({memory:{allowCloudMemory:false}});
  assert.ok(!(await core.rpc('mcp.tools', {token:'test-token'})).some((d:any) => d.category === 'memory'));
  await assert.rejects(core.rpc('mcp.call', {token:'test-token', name:'memory.search', args:{query:'x'}}), /disabled/);
  await core.updateSettings({memory:{allowCloudMemory:true}});
  const remote = {deviceId:'device', projectId:'project', scopeVersion:'1', expiresAt:Date.now()+60000,
    caps:['memory.read'], categories:[], scriptIds:[], memoryHosts:[core.settings.ollama.host]};
  core.remoteAuthority = () => true;
  core.updateSession(session.id, {remote});
  tools = await core.rpc('mcp.tools', {token:'test-token'});
  assert.ok(tools.some((d:any) => d.name === 'memory.search'));
  assert.ok(!tools.some((d:any) => d.name === 'memory.save'));
  core.updateSession(session.id, {remote:{...remote, memoryHosts:[]}});
  assert.ok(!(await core.rpc('mcp.tools', {token:'test-token'})).some((d:any) => d.category === 'memory'));
});

test('Stop cancels native memory preparation before any provider dispatch', async t => {
  const {core, session, sent} = await fixture(t);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  core.memory.context = async (_session, _text, signal) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  };
  const sending = core.send({id:session.id, text:'Recall something'});
  const rejected = assert.rejects(sending);
  await started;
  await core.stop(session.id);
  await rejected;
  assert.deepEqual(sent, []);
  assert.equal(core.nativeMemoryTurns.size, 0);
});

test('Stop cancels native MCP memory calls', async t => {
  const {core, session} = await fixture(t);
  core.updateSession(session.id, {status:'working'});
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  core.memory.recall = async (_session, _text, signal) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  };
  const call = core.rpc('mcp.call', {token:'test-token', name:'memory.search', args:{query:'decision'}});
  const rejected = assert.rejects(call);
  await started;
  await core.stop(session.id);
  await rejected;
  assert.equal(core.actionControllers.size, 0);
});

test('memory policy changes before provider acceptance reject stale native context', async t => {
  const {core, session, sent} = await fixture(t);
  core.memory.context = async () => '<cere_memory_data>private evidence</cere_memory_data>';
  core.factory = (_session, _hooks) => ({
    async send(_text, _images, options) {
      await core.updateSettings({memory:{allowCloudMemory:false}});
      options?.beforeAccept?.();
      sent.push('unsafe dispatch');
    }, async interrupt() {}, async close() {},
  });
  await assert.rejects(core.send({id:session.id, text:'Recall private context'}));
  assert.deepEqual(sent, []);
  assert.ok(![...core.tokens.values()].includes(session.id), 'failed adapters lose their MCP capabilities');
});

for (const method of ['search', 'inspect'] as const) {
  test(`native memory ${method} does not return a delayed result after cloud permission is revoked`, async t => {
    const {core} = await fixture(t);
    let entered!: () => void, release!: (value:any) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const read = async () => { entered(); return new Promise<any>(resolve => { release = resolve; }); };
    if (method === 'search') core.memory.recall = read;
    else core.memory.inspectForModel = read;
    const call = core.rpc('mcp.call', {token:'test-token', name:`memory.${method}`, args:method==='search'?{query:'private note'}:{id:'note'}});
    const rejected = assert.rejects(call);
    await started;
    await core.updateSettings({memory:{allowCloudMemory:false}});
    release({text:'must not reach the model'});
    await rejected;
  });
}

test('native reply capture cannot switch memory servers after a mid-turn settings change', async t => {
  const {core, session, hooks} = await fixture(t);
  let captures = 0;
  core.memory.context = async () => '';
  core.memory.capture = async () => { captures++; return {outcome:'captured'}; };
  await core.send({id:session.id, text:'Original server turn'});
  await core.updateSettings({ollama:{host:'http://127.0.0.1:11435'}});
  hooks().event({type:'message', id:'reply', text:'Reply from that turn'});
  hooks().event({type:'complete'});
  await Promise.all(core.memoryCaptures);
  assert.equal(captures, 0);
});
