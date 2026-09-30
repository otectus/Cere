// Explicit live check. Only synthetic facts and public search terms leave this
// isolated temporary project; the user's Cere settings/history are not opened.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { Session } from '../broker/types.ts';

type Recall = { mode: string; warning?: string; results: { id?: string; text: string }[] };
type MemoryApi = {
  save(session: Session, text: string): Promise<unknown>;
  recall(session: Session, query: string, signal: AbortSignal): Promise<Recall>;
};

/** Both saves commit, in order, before recall begins. */
export async function seedAndRecall(memory: MemoryApi, session: Session, query: string) {
  await memory.save(session, 'For this test project, my preferred morning beverage is a double espresso with oat milk.');
  await memory.save(session, 'The release checklist is stored in the copper notebook.');
  const recalled = await memory.recall(session, query, new AbortController().signal);
  // Degraded embedding or projection services are reported as such, not as a recall miss.
  if (recalled.mode !== 'semantic') throw new Error(`Semantic recall is degraded by a memory dependency: ${recalled.warning || recalled.mode}`);
  return recalled;
}

export async function run(argv: string[]) {
  const model = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const memoryOnly = argv.includes('--memory-only');
  const webOnly = argv.includes('--web-only');
  const directory = await mkdtemp(join(tmpdir(), 'cere-knowledge-live-')), project = join(directory, 'project');
  await mkdir(project);
  let core = new Core(new Store(join(directory, 'state')));
  const report: any = { directory, model: model || null, checks: [] };
  async function complete(id: string) {
    const deadline = Date.now() + 150000;
    while (['starting', 'working', 'waiting', 'stopping'].includes(core.store.session(id).status)) {
      if (Date.now() > deadline) { await core.stop(id); throw new Error('Live turn timed out'); }
      await new Promise(r => setTimeout(r, 150));
    }
    core.flush(); const session = core.store.session(id); assert.equal(session.status, 'idle', session.error);
    return core.store.messages(id);
  }
  try {
    await core.refreshProviderModels('ollama');
    await core.updateSettings({ memory: { enabled: true }, webSearch: { enabled: true }, onboarding: false, profile: 'manual' });
    const selected = model || core.capabilities.ollama.models[0]?.id;
    if (!memoryOnly && !webOnly) {
      const first = await core.create({ provider: 'ollama', model: selected, cwd: project });
      const check = await core.memory.check(); assert.equal(check.model, 'nomic-embed-text');
      const recalled = await seedAndRecall(core.memory, first, 'What caffeine drink do I like at breakfast?');
      assert.match(recalled.results[0]?.text || '', /espresso/);
      report.checks.push({ name: 'live nomic embeddings and semantic recall', passed: true, dimensions: check.dimensions, recall: recalled }); console.log('PASS live nomic embeddings and semantic recall');
      await core.close(); core = new Core(new Store(join(directory, 'state'))); await core.refreshProviderModels('ollama');
      const second = await core.create({ provider: 'ollama', model: selected, cwd: project });
      assert.ok((await core.memory.recall(second, 'Where is the release checklist?', new AbortController().signal)).results.some((r: { text: string }) => r.text.includes('copper notebook')));
      report.checks.push({ name: 'semantic recall after broker restart in another conversation', passed: true }); console.log('PASS recall after restart');
      const search = await core.webCall('web_search', { query: 'Ollama embeddings API official documentation' }, new AbortController().signal);
      assert.ok('results' in search && search.results.length); report.checks.push({ name: 'live automatic web search', passed: true, result: search }); console.log('PASS live web search');
      const page = await core.webCall('web_read', { url: 'https://docs.ollama.com/api/embed' }, new AbortController().signal);
      assert.ok('text' in page && page.text.includes('embed')); report.checks.push({ name: 'public source reading', passed: true }); console.log('PASS public source reading');
      if (model) {
        await core.send({ id: second.id, text: 'What do you remember about my preferred morning beverage in this project? Reply briefly.' });
        const messages = await complete(second.id); assert.match(messages.filter(m => m.role === 'assistant').at(-1)?.text || '', /espresso/i);
        report.checks.push({ name: 'model uses injected memory', passed: true, messages }); console.log('PASS model recall');
      }
    }
    if (model && !memoryOnly) {
      const web = await core.create({ provider: 'ollama', model, cwd: project });
      await core.send({ id: web.id, text: 'Use web_search to find official Ollama embedding API documentation. Cite the returned official URL and briefly name the endpoint. Do not use memory tools.' });
      const messages = await complete(web.id); assert.ok(messages.some(m => m.role === 'tool' && m.text.startsWith('web_search'))); assert.ok(messages.some(m => m.role === 'assistant' && m.sources?.length));
      report.checks.push({ name: 'model invokes web search and returns source links', passed: true, messages }); console.log('PASS model web tool');
    }
    if (model && !webOnly) {
      const remember = await core.create({ provider: 'ollama', model, cwd: project });
      await core.send({ id: remember.id, text: 'Remember this durable fact using memory_save: My project’s mascot is a silver otter. Use that exact text. Reply briefly.' });
      const messages = await complete(remember.id); report.memoryAttempt = messages;
      const saved = (await core.memory.list(remember)).rows as { text: unknown }[];
      assert.ok(saved.some(r => String(r.text).includes('silver otter')), 'The model did not save the requested fact');
      report.checks.push({ name: 'model saves a durable memory on request', passed: true, messages }); console.log('PASS model memory tool');
    }
  } catch (error: any) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
  finally { await core.close(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log('Evidence: ' + directory); }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await run(process.argv.slice(2));
