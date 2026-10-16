import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { chunkDocument } from '../broker/knowledge-collections.ts';

test('M06 chunks keep their heading, overlap, and respect the size', () => {
  const text = '# Guide\n\nIntro.\n\n## Install\n\n' + 'Install step. '.repeat(200) + '\n\n## Usage\n\nRun it.';
  const chunks = chunkDocument(text, 600, 100);
  assert.ok(chunks.every(chunk => Array.from(chunk.text).length <= 600 + 20));
  assert.ok(chunks.some(chunk => chunk.heading === 'Install' && chunk.text.startsWith('§ Install\n')), 'a continued section keeps its heading');
  assert.equal(chunks.at(-1)!.heading, 'Usage');
});

async function fixture(t: any, realProviders = false) {
  const root = await mkdtemp(join(tmpdir(), 'cere-collections-')), docs = join(root, 'docs'), state = join(root, 'state');
  await mkdir(join(docs, '.hidden'), { recursive: true }); await mkdir(join(docs, 'node_modules'), { recursive: true }); await mkdir(join(docs, 'sub'), { recursive: true });
  await writeFile(join(docs, 'guide.md'), '# Orchid CLI\n\n## Install\n\nInstall the orchid CLI with `pipx install orchid-cli`. The zircon flag enables offline mode.\n\n## Usage\n\nRun orchid sync daily.');
  await writeFile(join(docs, 'sub', 'notes.txt'), 'Release cadence: every second Tuesday. The heliotrope build runs nightly.');
  await writeFile(join(docs, '.hidden', 'secret.md'), 'hidden passphrase marmalade');
  await writeFile(join(docs, 'node_modules', 'dep.md'), 'dependency readme quokka');
  await writeFile(join(root, 'outside.md'), 'outside the source walrus');
  await symlink(join(root, 'outside.md'), join(docs, 'link.md'));
  await writeFile(join(docs, 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await writeFile(join(docs, 'binary.md'), Buffer.from([0x61, 0, 0x62]));
  const core = new Core(new Store(state), realProviders ? undefined : () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  await core.updateSettings({ ollama: { host: 'http://127.0.0.1:9' } });
  await core.memory.ready;
  return { root, docs, state, core };
}
const indexed = async (core: Core, id: string) => { await core.rpc('collections.index', { id }); for (let index = 0; index < 400 && !core.collections.job?.done; index++) await new Promise(resolve => setTimeout(resolve, 10)); return core.collections.snapshot()!; };

test('M06 a collection indexes only the files it may, reindexes changes with erasure, and stays in its own scope', async t => {
  const { root, docs, state, core } = await fixture(t);
  let collection = await core.rpc('collections.create', { name: 'Project docs', grounding: 'strict' });
  await assert.rejects(core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: join(docs, '.hidden') }), /Hidden files/);
  await assert.rejects(core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: state }), /Cere’s own state/);
  await assert.rejects(core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: join(docs, 'binary.md').replace('.md', '.exe') }), /no such file|ENOENT/);
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: docs });
  const job = await indexed(core, collection.id);
  assert.equal(job.error, '');
  const listed = (await core.rpc('collections.list', {})).collections[0];
  assert.equal(listed.files, 4, 'guide, notes, and the two refused files are tracked; hidden, dependency and linked files are not');
  assert.deepEqual(listed.errors.map((error: any) => [error.path.split('/').at(-1), error.error]).sort(), [['big.md', 'Larger than 2 MB'], ['binary.md', 'Not a text file']]);
  const session = await core.create({ provider: 'codex', cwd: root, trusted: true });
  const excerpt = async (text: string, route: 'local' | 'cloud' = 'local') => core.collections.context(core.store.session(session.id), text, 2000, route, new AbortController().signal);
  assert.equal((await excerpt('zircon offline mode')).text, '', 'an unbound collection is never used');
  await core.rpc('collections.bind', { id: collection.id, target: 'session', sessionId: session.id, bound: true });
  const found = await excerpt('How does the zircon flag work?');
  assert.match(found.text, /^<cere_document_data>\n/);
  assert.match(found.text, /zircon flag enables offline mode/); assert.match(found.text, /"source":"guide\.md"/);
  assert.match(found.text, /Answer only from these excerpts/);
  for (const hidden of ['marmalade', 'quokka', 'walrus']) assert.equal((await excerpt(hidden)).text, '', `${hidden} must not be indexed`);
  // A cloud consumer sees the collection only once it allows that.
  assert.deepEqual([(await excerpt('zircon flag', 'cloud')).text, (await excerpt('zircon flag', 'cloud')).detail.withheld], ['', ['Project docs']]);
  collection = await core.rpc('collections.update', { id: collection.id, expectedRevision: (await core.rpc('collections.list', {})).collections[0].revision, allowCloud: true });
  assert.match((await excerpt('zircon flag', 'cloud')).text, /zircon/);
  // Project memory never sees collection text.
  await core.updateSettings({ memory: { enabled: true, allowCloudMemory: true } });
  const recalled = await core.memory.recall(core.store.session(session.id), 'zircon offline', new AbortController().signal);
  assert.ok(!JSON.stringify(recalled.items || []).includes('zircon'));
  await core.updateSettings({ memory: { enabled: false } });
  // A changed file is reindexed; its old chunks are erased, not merely hidden.
  await writeFile(join(docs, 'guide.md'), '# Orchid CLI\n\n## Install\n\nUse the obsidian installer now.');
  assert.equal((await core.rpc('collections.list', {})).collections[0].stale, 1);
  assert.equal((await indexed(core, collection.id)).changed, 1);
  assert.equal((await excerpt('zircon flag offline')).text, '');
  assert.match((await excerpt('obsidian installer')).text, /obsidian installer/);
  const scope = (core.collections as any).all()[0].scopeId;
  const live = async (word: string) => (await core.memory.service.call('retrieve', { scope_id: scope, text: word })).results.length;
  assert.equal(await live('zircon'), 0);
  // A file removed from disk leaves the index.
  await unlink(join(docs, 'sub', 'notes.txt'));
  assert.equal((await indexed(core, collection.id)).removed, 1);
  assert.equal(await live('heliotrope'), 0);
  // Deleting the collection erases every chunk and its bindings.
  const current = (await core.rpc('collections.list', {})).collections[0];
  await assert.rejects(core.rpc('collections.delete', { id: collection.id, expectedRevision: current.revision }), /Confirm deleting/);
  await core.rpc('collections.delete', { id: collection.id, expectedRevision: current.revision, confirmed: true });
  assert.equal(await live('obsidian'), 0);
  assert.deepEqual((await core.rpc('collections.list', {})).bindings.sessions[session.id], []);
});

test('M06 a bound collection reaches an Ollama request as reference data and its plan lists the sources', async t => {
  const { docs, root, core } = await fixture(t, true);
  const requests: any[] = [];
  const server = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['completion'], model_info: { 'general.architecture': 'x', 'x.context_length': 32768 } })); return; }
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ model: 'm', name: 'm', capabilities: ['completion'] }] })); return; }
    if (req.url === '/api/embed') { res.statusCode = 404; res.end('{}'); return; }
    requests.push(JSON.parse(body)); res.end(JSON.stringify({ message: { role: 'assistant', content: 'Use pipx.' }, done: true }) + '\n');
  }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  await core.updateSettings({ ollama: { host: `http://127.0.0.1:${(server.address() as any).port}` } });
  let collection = await core.rpc('collections.create', { name: 'Docs' });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: join(docs, 'guide.md') });
  await indexed(core, collection.id);
  const session = await core.create({ provider: 'ollama', model: 'm', cwd: root });
  await core.rpc('collections.bind', { id: collection.id, target: 'project', sessionId: session.id, bound: true });
  await core.rpc('session.send', { id: session.id, text: 'How do I install the orchid CLI?' });
  for (let index = 0; index < 300 && core.store.session(session.id).status !== 'idle'; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(requests.length, `no request was sent: ${core.store.session(session.id).status} ${core.store.session(session.id).error || ''}`);
  const sent = JSON.stringify(requests.at(-1).messages);
  assert.match(sent, /<cere_document_data>/); assert.match(sent, /pipx install orchid-cli/);
  const plan = (await core.rpc('session.context', { id: session.id })).lastPlan;
  const layer = plan.layers.find((item: any) => item.id === 'documents');
  assert.equal(layer.included, true); assert.deepEqual(layer.detail.sources, ['guide.md']); assert.deepEqual(layer.detail.collections, ['Docs']);
  assert.doesNotMatch(JSON.stringify(plan), /pipx/, 'the plan stores sources, not their text');
});
