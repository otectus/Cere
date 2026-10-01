import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory, memoryScope } from '../broker/memory.ts';
import { Store } from '../broker/store.ts';
import type { Provider, Session, Settings } from '../broker/types.ts';

const signal = () => new AbortController().signal;

function session(provider: Provider, id: string, cwd: string, host?: string): Session {
  return {
    id, provider, nativeId: null, title: provider, cwd, mode: 'managed', status: 'idle',
    created: 1, updated: 1, draft: '', scroll: 0, model: provider === 'ollama' ? 'chat' : `${provider}-model`,
    ...(provider === 'ollama' ? { ollama: { host: host!, tools: true } } : {}),
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cere-shared-memory-'));
  const server = createServer(async (req, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ model: 'nomic-embed-text:latest', digest: 'embed-v1' }, { model: 'chat', digest: 'chat-v1' }] }));
    else if (req.url === '/api/show') res.end(JSON.stringify(body.model === 'chat' ? { capabilities: ['completion'] } : { capabilities: ['embedding'] }));
    else if (req.url === '/api/embed') res.end(JSON.stringify({ embeddings: body.input.map((text: string) => [/orchid/i.test(text) ? 1 : 0, /cedar/i.test(text) ? 1 : 0, 0]) }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new Store(directory);
  let settings: Settings = { ...store.settings(), ollama: { host, model: 'chat' }, memory: { enabled: true, model: 'nomic-embed-text', allowCloudMemory: true, allowCloudExtraction: false } };
  const memory = new Memory(store, () => settings);
  await memory.ready;
  t.after(async () => {
    await memory.close(); store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, host, store, memory, settings: () => settings, update: async (patch: Partial<Settings['memory']>) => {
    settings = { ...settings, memory: { ...settings.memory, ...patch } };
    await memory.configure();
  } };
}

test('Codex, Claude, and Ollama share the existing host/project scope while projects stay isolated', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const ollama = session('ollama', 'ollama-session', project, f.host);
  const codex = session('codex', 'codex-session', project);
  const claude = session('claude', 'claude-session', project);
  for (const value of [ollama, codex, claude]) f.store.saveSession(value);

  assert.equal(memoryScope(ollama), memoryScope(codex, f.host), 'native providers retain the existing Ollama scope key');
  assert.equal(await f.memory.scope(ollama), await f.memory.scope(codex));
  assert.equal(await f.memory.scope(ollama), await f.memory.scope(claude));

  const legacy = await f.memory.save(ollama, 'The release orchid is violet.');
  assert.ok((await f.memory.list(claude)).rows.some((row: any) => row.id === legacy.id));
  const recalled = await f.memory.recall(codex, 'Which orchid is used for the release?', signal());
  assert.ok(recalled.results.some((row: any) => row.id === legacy.id));

  const otherDirectory = join(f.directory, 'other-project');
  await mkdir(otherDirectory);
  const other = session('codex', 'other-codex-session', otherDirectory);
  f.store.saveSession(other);
  assert.notEqual(await f.memory.scope(other), await f.memory.scope(codex));
  assert.equal((await f.memory.list(other)).total, 0);
});

test('native-provider recall is always cloud-routed and honors explicit cloud-memory consent', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const ollama = session('ollama', 'ollama-session', project, f.host);
  const codex = session('codex', 'codex-session', project);
  const saved = await f.memory.save(ollama, 'Orchid deployment requires approval.');

  await f.update({ allowCloudMemory: false });
  const denied = await f.memory.recall(codex, 'orchid deployment', signal(), 4000, 'local');
  assert.equal(denied.results.length, 0);
  assert.ok(denied.coverage.includes('cloud_memory_denied'));
  await assert.rejects(f.memory.inspectForModel(codex, saved.id, signal()), (error: any) => error.code === 'POLICY_DENIED');

  await f.update({ allowCloudMemory: true });
  const allowed = await f.memory.recall(codex, 'orchid deployment', signal());
  assert.ok(allowed.results.some((row: any) => /requires approval/u.test(row.text)));
  assert.equal((await f.memory.inspectForModel(codex, saved.id, signal())).record.id, saved.id);

  const localOnly = await f.memory.service.call('observe_text', {
    scope_id: await f.memory.scope(ollama), text: 'Local-only cedar detail.', role: 'user',
    session_id: ollama.id, source_event_id: 'local-only-source', kind: 'saved', sensitivity: 'local_only',
  });
  await assert.rejects(f.memory.inspectForModel(codex, localOnly.id, signal()), (error: any) => error.code === 'POLICY_DENIED');
});

test('erasure from one provider removes shared memory and scrubs every managed provider transcript in the same scope', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const ollama = session('ollama', 'ollama-session', project, f.host);
  const codex = session('codex', 'codex-session', project);
  const claude = session('claude', 'claude-session', project);
  for (const value of [ollama, codex, claude]) {
    f.store.saveSession(value);
    f.store.message({ id: `message-${value.id}`, sessionId: value.id, role: 'user', text: 'Shared secret orchid marker.', time: 1 });
  }
  const temporary = { ...session('codex', 'temporary-session', project), temporary: true };
  f.store.saveSession(temporary);
  f.store.set(`ollama:${ollama.id}`, [{ role: 'user', content: 'Shared secret orchid marker.' }]);
  const saved = await f.memory.save(codex, 'Shared secret orchid marker.');

  await f.memory.forget(claude, saved.id);

  for (const value of [ollama, codex, claude]) assert.equal(f.store.messages(value.id)[0].text, '[Content removed by memory erasure]');
  assert.equal(f.store.get<any[]>(`ollama:${ollama.id}`, [])[0].content, '[Content removed by memory erasure]');
  assert.equal((await f.memory.list(ollama)).total, 0);
});
