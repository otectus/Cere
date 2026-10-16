import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function ollama(t: any) {
  const calls: { url: string; method: string; body: any }[] = [];
  let release: (() => void) | undefined;
  const models = [
    { model: 'chat:latest', name: 'chat:latest', size: 4_000_000_000, digest: 'a', details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' }, capabilities: ['completion', 'tools'] },
    { model: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest', size: 270_000_000, digest: 'e1', details: { family: 'nomic-bert' }, capabilities: ['embedding'] },
    { model: 'other-embed:latest', name: 'other-embed:latest', size: 300_000_000, digest: 'e2', details: { family: 'bert' }, capabilities: ['embedding'] },
    { model: 'spare:latest', name: 'spare:latest', size: 1_000_000, digest: 's', details: {}, capabilities: ['completion'] },
  ];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', async () => {
      const parsed = body ? JSON.parse(body) : undefined; calls.push({ url: req.url!, method: req.method!, body: parsed });
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models })); return; }
      if (req.url === '/api/ps') { res.end(JSON.stringify({ models: [{ model: 'chat:latest', size_vram: 5_000_000_000, expires_at: '2026-10-15T23:00:00Z' }] })); return; }
      if (req.url === '/api/show') { const entry = models.find(m => m.model === parsed.model || m.name === parsed.model); res.end(JSON.stringify({ capabilities: entry?.capabilities || ['completion'], model_info: { 'general.architecture': 'x', 'x.context_length': 8192 } })); return; }
      if (req.url === '/api/embed') { const width = parsed.model.startsWith('other') ? 4 : 3; res.end(JSON.stringify({ embeddings: parsed.input.map(() => Array(width).fill(0).map((_, i) => i + 1)) })); return; }
      if (req.url === '/api/generate') { res.end(JSON.stringify({ done: true })); return; }
      if (req.url === '/api/delete') { res.end('{}'); return; }
      if (req.url === '/api/pull') {
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 40 }) + '\n');
        if (parsed.model === 'slow') await new Promise<void>(resolve => { release = resolve; });
        res.end(JSON.stringify({ status: 'success', total: 100, completed: 100 }) + '\n'); return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release?.(); server.closeAllConnections(); server.close(); });
  return { host: `http://127.0.0.1:${(server.address() as any).port}`, calls, release: () => release?.() };
}
async function settled(core: Core) { for (let index = 0; index < 200 && !core.localModels.job?.done; index++) await new Promise(resolve => setTimeout(resolve, 10)); }

test('M09 lists models with what uses them, pulls one at a time with progress, and cancels cleanly', async t => {
  const fixture = await ollama(t), dir = await mkdtemp(join(tmpdir(), 'cere-local-models-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.updateSettings({ ollama: { host: fixture.host } });
  await core.refreshProviderModels('ollama');
  await core.updateSettings({ ollama: { model: 'chat:latest' }, memory: { model: 'nomic-embed-text' } });
  const listed = await core.rpc('models.local', {});
  const row = (name: string) => listed.models.find((model: any) => model.name === name);
  assert.match(row('chat:latest').inUse.join(' '), /default Ollama chat model/);
  assert.equal(row('chat:latest').loaded, true);
  assert.match(row('nomic-embed-text:latest').inUse.join(' '), /memory embedding model/);
  assert.deepEqual(row('spare:latest').inUse, []);
  await core.rpc('models.pull', { model: 'qwen3:8b' }); await settled(core);
  assert.deepEqual([core.snapshot().modelPull!.status, core.snapshot().modelPull!.completed, core.snapshot().modelPull!.done], ['success', 100, true]);
  await core.rpc('models.dismissPull', {});
  await core.rpc('models.pull', { model: 'slow' });
  for (let index = 0; index < 100 && core.localModels.job?.completed !== 40; index++) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(core.rpc('models.pull', { model: 'another' }), /Already pulling slow/);
  await core.rpc('models.cancelPull', {}); await settled(core);
  assert.equal(core.snapshot().modelPull!.status, 'cancelled');
  await assert.rejects(core.rpc('models.pull', { model: 'bad name!' }), /Enter an Ollama model name/);
});

test('M09 deletion needs confirmation and is refused for a model in use; load and unload use keep_alive', async t => {
  const fixture = await ollama(t), dir = await mkdtemp(join(tmpdir(), 'cere-local-models-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.updateSettings({ ollama: { host: fixture.host } });
  await core.refreshProviderModels('ollama');
  await core.updateSettings({ ollama: { model: 'chat:latest' } });
  await assert.rejects(core.rpc('models.delete', { model: 'chat:latest', confirmed: true }), /default Ollama chat model/);
  const session = await core.create({ provider: 'ollama', model: 'spare:latest', cwd: dir });
  core.updateSession(session.id, { status: 'working' });
  await assert.rejects(core.rpc('models.delete', { model: 'spare:latest', confirmed: true }), /using it right now/);
  core.updateSession(session.id, { status: 'idle' });
  await assert.rejects(core.rpc('models.delete', { model: 'spare:latest' }), /Confirm deleting/);
  assert.deepEqual(await core.rpc('models.delete', { model: 'spare:latest', confirmed: true }), { deleted: 'spare:latest', conversations: 1 });
  assert.ok(fixture.calls.some(call => call.url === '/api/delete' && call.method === 'DELETE' && call.body.model === 'spare:latest'));
  await core.rpc('models.load', { model: 'chat:latest' }); await core.rpc('models.unload', { model: 'spare:latest' });
  assert.deepEqual(fixture.calls.filter(call => call.url === '/api/generate').map(call => [call.body.model, call.body.keep_alive]), [['chat:latest', '10m'], ['spare:latest', 0]]);
});

test('M09 an embedding switch is measured with the candidate model first; spaces never mix', async t => {
  const fixture = await ollama(t), dir = await mkdtemp(join(tmpdir(), 'cere-local-models-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.updateSettings({ ollama: { host: fixture.host }, memory: { enabled: true, model: 'nomic-embed-text' } });
  await core.memory.ready;
  const same = await core.rpc('memory.embeddingImpact', { model: 'nomic-embed-text' });
  assert.equal(same.unchanged, true);
  const other = await core.rpc('memory.embeddingImpact', { model: 'other-embed' });
  assert.equal(other.unchanged, false);
  assert.notEqual(other.current.fingerprint, other.next.fingerprint);
  assert.deepEqual([other.current.dimension, other.next.dimension], [3, 4]);
  assert.equal(core.settings.memory.model, 'nomic-embed-text', 'measuring changes nothing');
  await assert.rejects(core.rpc('memory.embeddingImpact', { model: '../bad' }), /embedding model name/);
});
