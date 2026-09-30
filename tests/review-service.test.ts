import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { GraphMemory } from '../broker/graph-memory/client.ts';
import { MemoryService } from '../broker/graph-memory/service.ts';
import { QdrantVectorRepository } from '../broker/graph-memory/adapters/qdrant.ts';
import { HyprlandCollector } from '../broker/graph-memory/adapters/hyprland.ts';
import { LiveObservationFactory } from '../broker/graph-memory/adapters/live.ts';
import { inspectGitCheckout } from '../broker/graph-memory/adapters/workspace.ts';
import { CollectorRpc } from '../broker/graph-memory/collector-rpc.ts';
import { LiveWorkspaceState } from '../broker/graph-memory/adapters/live.ts';
import { ollamaModels, workingContext, messageTokens } from '../broker/ollama.ts';
import type { OllamaMessage } from '../broker/ollama.ts';

const run = promisify(execFile);
async function until(check: () => boolean | Promise<boolean>, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
function chat(res: ServerResponse, content: string, calls?: any[]) {
  res.end(JSON.stringify({ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls.map(c => ({ function: c })) } : {}) }, done: true }) + '\n');
}

/** A loopback Ollama with switchable model metadata; records every chat and embed body. */
async function ollama(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-review-service-'));
  const f = {
    directory, host: '', chats: [] as any[], embeds: [] as any[],
    models: [
      { model: 'chat', capabilities: ['completion', 'tools'], digest: 'a'.repeat(64) },
      { model: 'remote-alias', capabilities: ['completion', 'tools'], digest: 'b'.repeat(64), remote_host: 'https://ollama.com' },
      { model: 'nomic-embed-text:latest', capabilities: ['embedding'], digest: 'c'.repeat(64) },
      { model: 'embed-alias', capabilities: ['embedding'], digest: 'd'.repeat(64), remote_host: 'https://ollama.com' },
    ] as any[],
    show: {} as Record<string, any>,
    onChat: (_body: any, res: ServerResponse) => chat(res, 'Answer'),
    core: null as unknown as Core,
  };
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk; const body = text ? JSON.parse(text) : {};
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: f.models }));
    else if (req.url === '/api/show') { const m = f.show[body.model] === null ? undefined : f.models.find(m => m.model === body.model); res.statusCode = m ? 200 : 404; res.end(JSON.stringify(m ? { ...m, ...(f.show[body.model] || {}) } : { error: 'model manifest is missing' })); }
    else if (req.url === '/api/embed') { f.embeds.push(body); res.end(JSON.stringify({ embeddings: body.input.map((t: string) => [/orchid/i.test(t) ? 1 : 0, 1, 0]) })); }
    else if (req.url === '/api/chat') { f.chats.push(body); f.onChat(body, res); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  f.host = 'http://127.0.0.1:' + (server.address() as any).port;
  const store = new Store(directory); store.set('settings', { ollama: { host: f.host, model: 'chat' } });
  f.core = new Core(store);
  await f.core.refreshProviderModels('ollama');
  t.after(async () => { await f.core.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); });
  return f;
}
const finished = async (core: Core, id: string) => { await until(() => ['idle', 'error', 'interrupted'].includes(core.store.session(id).status)); core.flush(); };

test('F-004 memory text never reaches a cloud-backed embedding model, even with cloud permissions', async t => {
  const f = await ollama(t);
  const s = await f.core.create({ provider: 'ollama', model: 'chat', cwd: f.directory });
  await f.core.updateSettings({ memory: { enabled: true, model: 'embed-alias', allowCloudExtraction: false, allowCloudMemory: false } });
  const scope = await f.core.memory.scope(s);
  await f.core.memory.service.call('observe_text', { scope_id: scope, text: 'Local orchid passage.', role: 'user', sensitivity: 'local_only' });
  let recalled = await f.core.memory.recall(s, 'orchid', new AbortController().signal);
  assert.equal(recalled.mode, 'keyword', 'lexical recall remains available');
  assert.ok(recalled.results.some((r: any) => /orchid/.test(r.text)));
  await f.core.memory.service.project('vector');
  await f.core.updateSettings({ memory: { allowCloudExtraction: true, allowCloudMemory: true } });
  recalled = await f.core.memory.recall(s, 'orchid', new AbortController().signal);
  await f.core.memory.service.project('vector');
  assert.equal(f.embeds.length, 0, 'no embedding request was dispatched to the cloud-backed alias');
  assert.match(recalled.warning, /semantic_route_denied/);
  // A local embedding model continues to work for the same memory.
  await f.core.updateSettings({ memory: { model: 'nomic-embed-text' } });
  recalled = await f.core.memory.recall(s, 'orchid', new AbortController().signal);
  assert.equal(recalled.mode, 'semantic');
  assert.ok(f.embeds.length > 0);
});

test('F-005 recall and chat prompts follow the verified route, not the alias spelling', async t => {
  const f = await ollama(t);
  await f.core.updateSettings({ memory: { enabled: true, allowCloudMemory: false } });
  const s = await f.core.create({ provider: 'ollama', model: 'remote-alias', cwd: f.directory });
  assert.equal(f.core.capabilities.ollama.models.find((m: any) => m.id === 'remote-alias').cloud, true);
  const scope = await f.core.memory.scope(s);
  await f.core.memory.service.call('observe_text', { scope_id: scope, text: 'Local orchid passage.', role: 'user', sensitivity: 'local_only' });
  await f.core.memory.save(s, 'My orchid note is private.');
  assert.equal((await f.core.memory.recall(s, 'orchid', new AbortController().signal)).results.length, 0);
  await f.core.send({ id: s.id, text: 'Tell me about orchid' }); await finished(f.core, s.id);
  assert.equal(f.core.store.session(s.id).status, 'idle', f.core.store.session(s.id).error);
  let body = JSON.stringify(f.chats.at(-1));
  assert.ok(!body.includes('orchid note is private') && !body.includes('Local orchid passage'));
  // Cloud recall permitted: cloud-allowed notes may flow, local-only sources never do.
  await f.core.updateSettings({ memory: { allowCloudMemory: true } });
  const allowed = await f.core.memory.recall(s, 'orchid', new AbortController().signal);
  assert.ok(allowed.results.some((r: any) => /orchid note/.test(r.text)));
  assert.ok(!allowed.results.some((r: any) => /Local orchid/.test(r.text)));
  await f.core.send({ id: s.id, text: 'Tell me about orchid again' }); await finished(f.core, s.id);
  body = JSON.stringify(f.chats.at(-1));
  assert.ok(body.includes('orchid note is private')); assert.ok(!body.includes('Local orchid passage'));
  // Route metadata only in /show, and a route change on an existing local session.
  await f.core.updateSettings({ memory: { allowCloudMemory: false } });
  const local = await f.core.create({ provider: 'ollama', model: 'chat', cwd: f.directory });
  assert.ok((await f.core.memory.recall(local, 'orchid', new AbortController().signal)).results.some((r: any) => /Local orchid/.test(r.text)));
  f.show.chat = { remote_host: 'https://ollama.com' };
  assert.equal((await f.core.memory.recall(local, 'orchid', new AbortController().signal)).results.length, 0);
  await f.core.send({ id: local.id, text: 'Orchid once more' }); await finished(f.core, local.id);
  body = JSON.stringify(f.chats.at(-1));
  assert.ok(!body.includes('orchid note is private') && !body.includes('Local orchid passage'));
});

test('F-016 a memory policy rejection or outage never blocks chat or fails a delivered reply', async t => {
  const f = await ollama(t);
  await f.core.updateSettings({ memory: { enabled: true } });
  const s = await f.core.create({ provider: 'ollama', model: 'chat', cwd: f.directory });
  f.onChat = (_b, res) => chat(res, 'Here: const password = "placeholder";');
  await f.core.send({ id: s.id, text: 'Show an example JavaScript declaration.' }); await finished(f.core, s.id);
  assert.equal(f.core.store.session(s.id).status, 'idle', f.core.store.session(s.id).error);
  assert.match(f.core.store.messages(s.id).at(-1)!.text, /placeholder/);
  const before = f.chats.length;
  await f.core.send({ id: s.id, text: 'Explain const password = "placeholder";' }); await finished(f.core, s.id);
  assert.equal(f.chats.length, before + 1, 'chat was dispatched');
  assert.equal(f.core.store.session(s.id).status, 'idle', f.core.store.session(s.id).error);
  const listing = await f.core.memory.list(s, 'conversation');
  assert.ok(!JSON.stringify(listing).includes('placeholder'), 'rejected content is not persisted');
  assert.match(f.core.memory.summary().warning, /not remembered/);
  // A backend failure degrades memory and still completes the turn.
  const call = f.core.memory.service.call.bind(f.core.memory.service);
  f.core.memory.service.call = async (method: string, p: any = {}, signal?: AbortSignal) => {
    if (method === 'observe_text' || method === 'record_response') throw Object.assign(new Error('memory backend down'), { code: 'BACKEND_UNAVAILABLE' });
    return call(method, p, signal);
  };
  f.onChat = (_b, res) => chat(res, 'Still here.');
  await f.core.send({ id: s.id, text: 'Hello again' }); await finished(f.core, s.id);
  assert.equal(f.core.store.session(s.id).status, 'idle');
  assert.equal(f.core.memory.summary().state, 'degraded');
});

test('F-040 one unusable model is omitted without hiding healthy ones', async t => {
  const f = await ollama(t);
  f.models.push({ model: 'broken' }); f.show.broken = null;
  const models = await ollamaModels(f.host);
  assert.deepEqual(models.map(m => m.id), ['chat', 'remote-alias']);
  assert.equal(models.omitted?.[0].id, 'broken');
  assert.deepEqual((await ollamaModels(f.host, 'embedding')).map(m => m.id), ['embed-alias', 'nomic-embed-text:latest']);
  await f.core.refreshProviderModels('ollama');
  assert.equal(f.core.capabilities.ollama.available, true);
  assert.match(f.core.capabilities.ollama.modelsWarning, /broken/);
  const s = await f.core.create({ provider: 'ollama', model: 'chat', cwd: f.directory });
  await f.core.configureSession({ id: s.id, model: 'chat', tools: false });
  f.models.splice(0, f.models.length, { model: 'broken' }, { model: 'also-broken' }); f.show['also-broken'] = null;
  await assert.rejects(ollamaModels(f.host), /could not be inspected/);
});

test('F-039 a synthetic capture image stays inside the real turn with its tool pairs', () => {
  const task: OllamaMessage = { role: 'user', content: 'Look at my screen and list my timers.' };
  const calls: OllamaMessage = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'screenshot_capture', arguments: {} } }, { function: { name: 'timer_list', arguments: {} } }] };
  const shot: OllamaMessage = { role: 'tool', tool_name: 'screenshot_capture', content: '{"path":"/tmp/x.png"}' };
  const image: OllamaMessage = { role: 'user', content: 'The user approved sharing this screen capture.', images: ['aGVsbG8='], synthetic: 'capture' };
  const timers: OllamaMessage = { role: 'tool', tool_name: 'timer_list', content: '[]' };
  const old: OllamaMessage[] = [{ role: 'user', content: 'Old '.repeat(900) }, { role: 'assistant', content: 'Old reply' }];
  const turn = [task, calls, shot, image, timers];
  const budget = turn.reduce((sum, m) => sum + messageTokens(m), 0) + 20;
  const selected = workingContext([...old, ...turn], budget);
  assert.deepEqual(selected.messages.map(m => m.content), turn.map(m => m.content));
  assert.equal(selected.omitted, 2);
  // Legacy history without the marker is recognized only beside its screenshot result.
  const legacy = { ...image }; delete legacy.synthetic;
  assert.deepEqual(workingContext([...old, task, calls, shot, legacy, timers], budget).messages.length, 5);
  // When the complete turn cannot fit, no orphan tool result is produced.
  assert.throws(() => workingContext([...old, ...turn], 1100), /exceeds the model/);
});

test('F-039 adapter keeps the task with capture tools and strips internal metadata', async t => {
  const f = await ollama(t);
  f.models[0].capabilities = ['completion', 'tools', 'vision'];
  f.models[0].model_info = { 'general.architecture': 'llama', 'llama.context_length': 4096 };
  const image = join(f.directory, 'capture.png');
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const s = await f.core.create({ provider: 'ollama', model: 'chat', cwd: f.directory, tools: true, trusted: true });
  f.core.store.set('ollama:' + s.id, [{ role: 'user', content: 'Earlier '.repeat(1400) }, { role: 'assistant', content: 'Earlier reply' }]);
  f.core.toolsFor = () => ['screenshot_capture', 'timer_list'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } }));
  f.core.callTool = async (_id, name) => name === 'screenshot_capture' ? { path: image } : [];
  f.onChat = (body, res) => f.chats.length === 1 ? chat(res, '', [{ name: 'screenshot_capture', arguments: {} }, { name: 'timer_list', arguments: {} }]) : chat(res, 'Done');
  await f.core.send({ id: s.id, text: 'Capture my screen and list timers.' }); await finished(f.core, s.id);
  assert.equal(f.core.store.session(s.id).status, 'idle', f.core.store.session(s.id).error);
  const second = f.chats[1].messages;
  assert.ok(second.some((m: any) => m.role === 'user' && m.content === 'Capture my screen and list timers.'));
  assert.ok(second.some((m: any) => m.role === 'assistant' && m.tool_calls?.length === 2));
  assert.equal(second.filter((m: any) => m.role === 'tool').length, 2);
  assert.ok(!JSON.stringify(f.chats).includes('synthetic'));
  assert.ok(f.core.store.get<any[]>('ollama:' + s.id, []).some(m => m.synthetic === 'capture'), 'the marker is persisted');
});

test('F-030 vector purge needs only Qdrant, never the embedding model', async t => {
  const deleted: string[] = [], finished: any[] = [];
  const qdrant = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    if (req.url === '/') res.end('{"version":"fixture"}');
    else if (req.url === '/collections') res.end(JSON.stringify({ result: { collections: [{ name: 'cere_fingerprint0_1_abc' }] } }));
    else if (req.url?.includes('/points/delete')) { deleted.push(JSON.parse(text).filter.must[0].match.value); res.end('{"status":"ok"}'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => qdrant.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(r => { qdrant.closeAllConnections(); qdrant.close(() => r()); }));
  const env = { CERE_QDRANT_URL: 'http://127.0.0.1:' + (qdrant.address() as any).port, CERE_QDRANT_API_KEY: 'secret' };
  for (const [key, value] of Object.entries(env)) { const old = process.env[key]; process.env[key] = value; t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; }); }
  const service = (vectors = new Map()) => Object.assign(Object.create(MemoryService.prototype) as MemoryService, {
    vectors, controller: new AbortController(), configuration: { host: 'http://127.0.0.1:9' },
    identity: async () => { throw new Error('Embedding server unavailable'); },
    canonical: { call: async (method: string, p: any) => method === 'claim_job' ? { id: 'job' } : method === 'projection_data' ? { artifacts: [], deletedIds: ['forgotten'], generation: '1', erasureEpoch: 2 } : method === 'embedding_spaces' ? [{ fingerprint: 'fingerprint'.padEnd(64, '0'), dimension: 3 }] : method === 'finish_job' ? finished.push(p) : true },
  });
  await service().project('vector');
  assert.deepEqual(deleted, ['forgotten']);
  assert.deepEqual(finished.at(-1), { id: 'job' });
  process.env.CERE_QDRANT_URL = 'http://127.0.0.1:9';
  await service().project('vector');
  assert.equal(finished.at(-1).error, 'BACKEND_UNAVAILABLE', 'an unreachable Qdrant leaves the purge pending');
});

test('F-032 a cold Qdrant collection cannot outlive the retrieval deadline', async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async (_input, init = {}) => {
    requests++;
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 20); init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true }); });
    return new Response('{"result":{"config":{"params":{"vectors":{"size":3,"distance":"Cosine"}}}}}', { status: 200 });
  };
  const repo = new QdrantVectorRepository({ endpoint: 'http://127.0.0.1:6333', apiKey: 'k', dimension: 3, distance: 'Cosine', fetch });
  const started = performance.now();
  await assert.rejects(repo.query({ vector: [1, 0, 0], ownerId: 'o', scopeIds: ['s'], embeddingFingerprint: 'f'.repeat(64), generation: 1, currentErasureEpoch: 0, nowUs: 1, deadline: AbortSignal.timeout(25) }));
  assert.ok(performance.now() - started < 80, `took ${performance.now() - started} ms`);
  assert.ok(requests <= 2, `${requests} setup requests`);
});

test('F-031 Hyprland snapshots refresh workspace and class for a surviving window', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-hypr-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state.json'), hyprctl = join(directory, 'hyprctl');
  await writeFile(hyprctl, `#!${process.execPath}\nconst s=JSON.parse(require('fs').readFileSync(${JSON.stringify(state)}));console.log(JSON.stringify(process.argv.includes('clients')?s.clients:{address:'0xabc'}));\n`, { mode: 0o755 });
  const set = (workspace: number, cls: string, address = '0xabc') => writeFile(state, JSON.stringify({ clients: [{ address, class: cls, title: 'secret', workspace: { id: workspace } }] }));
  const seen: any[] = [];
  const collector = new HyprlandCollector({ hyprctl, instanceSignature: 'fixture', runtimeDirectory: directory, captureTitles: true, titleApplicationAllowlist: ['kitty'] });
  (collector as any).emit = (o: any) => seen.push(o); (collector as any).stopped = false;
  await set(1, 'firefox'); await collector.reconcile();
  await set(2, 'kitty'); await collector.reconcile();
  const snapshots = seen.filter(o => o.kind === 'WINDOW_SNAPSHOT');
  assert.deepEqual(snapshots.map(o => [o.properties.workspace, o.properties.appClass]), [['1', 'firefox'], ['2', 'kitty']]);
  assert.equal(snapshots[0].entityGeneration, snapshots[1].entityGeneration);
  assert.equal(snapshots[0].properties.title, undefined, 'an unlisted class never exposes its title');
  assert.equal(snapshots[1].properties.title, 'secret', 'the refreshed class decides title eligibility');
  await set(1, 'kitty', '0xdef'); await collector.reconcile(); await set(1, 'kitty'); await collector.reconcile();
  assert.notEqual(seen.filter(o => o.kind === 'WINDOW_SNAPSHOT' && o.properties.address === 'abc').at(-1).entityGeneration, snapshots[0].entityGeneration, 'a reopened window is a new generation');
  await collector.stop();
  const after = seen.length; await set(3, 'kitty'); await collector.reconcile();
  assert.equal(seen.length, after, 'a stopped collector publishes nothing');
});

test('F-033 titles are captured only with capture enabled and an allowlisted class', async () => {
  const seen: any[] = [];
  for (const [allow, app, expected] of [[['kitty'], 'kitty', 'Editor'], [['kitty'], 'firefox', undefined], [[], 'kitty', undefined]] as const) {
    const collector = new HyprlandCollector({ captureTitles: true, titleApplicationAllowlist: [...allow] });
    (collector as any).emit = (o: any) => seen.push(o);
    (collector as any).handle({ type: 'open', address: 'a', workspace: '1', appClass: app, title: 'Editor' });
    assert.equal(seen.at(-1).properties.title, expected);
  }
});

test('F-014 revocation removes live metadata, fences late callbacks and honors canonical enablement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-collectors-')), approved = join(directory, 'approved');
  await mkdir(approved);
  const runtime = process.env.CERE_RUNTIME_DIR; process.env.CERE_RUNTIME_DIR = join(directory, 'runtime');
  const service = new MemoryService(directory);
  t.after(async () => { if (runtime === undefined) delete process.env.CERE_RUNTIME_DIR; else process.env.CERE_RUNTIME_DIR = runtime; await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.canonical.call('policy_update', { policy: { filesystem_enabled: true, approved_roots: [approved] } });
  await service.configure({ enabled: true, paused: false, host: 'http://127.0.0.1:9', embedding_model: 'nomic-embed-text', extraction_model: '', allow_cloud_extraction: false, allow_cloud_memory: false });
  const real = await realpath(approved), factory = new LiveObservationFactory('filesystem');
  service.live.apply(factory.observation('path:' + real, 'g', 'FILESYSTEM_METADATA', { root: real, path: join(real, 'private.txt'), exists: true }));
  assert.ok(JSON.stringify(service.workspace()).includes('private.txt'));
  const staleGeneration = service.collectorGeneration;
  await service.call('policy_update', { policy: { filesystem_enabled: false, approved_roots: [] } });
  for (const view of [service.workspace(), (await service.call('health')).workspace, (await service.call('doctor')).workspace])
    assert.ok(!JSON.stringify(view).includes('private.txt'));
  assert.ok(!JSON.stringify(service.live.snapshot()).includes('private.txt'), 'revoked observations are deleted, not only hidden');
  assert.notEqual(service.collectorGeneration, staleGeneration, 'a late callback from the stopped generation is discarded');
  await service.call('policy_update', { policy: { filesystem_enabled: true, approved_roots: [approved] } });
  assert.ok(service.collectors.length > 0);
  await service.call('policy_update', { policy: { enabled: false } });
  assert.equal(service.collectors.length, 0, 'canonical policy disable stops every collector');
});

test('F-015 nested and linked-worktree CWDs resolve their real checkout', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cere-git-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo'), nested = join(repo, 'a', 'b'), linked = join(directory, 'linked');
  await mkdir(nested, { recursive: true });
  await run('git', ['init', '--quiet', repo]);
  await run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  await run('git', ['-C', repo, 'worktree', 'add', '--quiet', linked]);
  await mkdir(join(linked, 'x', 'y'), { recursive: true });
  const root = await inspectGitCheckout(repo), deep = await inspectGitCheckout(nested);
  assert.deepEqual({ ...deep }, { ...root });
  const tree = await inspectGitCheckout(linked), treeDeep = await inspectGitCheckout(join(linked, 'x', 'y'));
  assert.deepEqual({ ...treeDeep }, { ...tree });
  assert.equal(tree.checkoutRoot, linked);
  assert.equal(tree.commonDirectory, root.commonDirectory);
  assert.notEqual(tree.gitDirectory, root.gitDirectory);
  const live = new LiveWorkspaceState();
  const rpc = new CollectorRpc(join(directory, 'runtime'), live, async () => ({ policy: { enabled: true, fish_enabled: true, approved_roots: [repo] } }));
  const session = '00000000-0000-4000-8000-000000000001';
  await rpc.ingest(JSON.stringify({ protocol_version: 1, request_id: '00000000-0000-4000-8000-000000000002', method: 'collector.emit',
    params: { source: 'fish', source_epoch: session, source_sequence: 1, event: 'cwd', shell_session_id: session, cwd: nested } }));
  const verified = live.snapshot().observations.find(o => o.kind === 'CHECKOUT_VERIFIED');
  assert.equal(verified?.properties.checkoutRoot, repo);
});

test('F-035 a dead worker rejects current and future calls promptly and still closes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-worker-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const memory = new GraphMemory(directory);
  await memory.ready;
  const pending = memory.call('health');
  await memory.worker.terminate();
  await assert.rejects(pending, { code: 'BACKEND_UNAVAILABLE' });
  const started = performance.now();
  await assert.rejects(memory.call('health'), { code: 'BACKEND_UNAVAILABLE' });
  assert.ok(performance.now() - started < 50);
  assert.equal(memory.pending.size, 0);
  await memory.close();
  await memory.close();
});
