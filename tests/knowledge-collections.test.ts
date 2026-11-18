import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, symlink, unlink, utimes } from 'node:fs/promises';
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
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

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

test('RC-01 collection Markdown follows the vault privacy rules, and notes indexed under older rules are checked again', async t => {
  const { root, core } = await fixture(t);
  const notes = join(root, 'notes'), then = new Date(2026, 0, 1);
  await mkdir(notes);
  await writeFile(join(notes, 'public.md'), '---\r\ntitle: Lab\r\n---\r\nThe kestrel sensor reads hourly.');
  await writeFile(join(notes, 'private.md'), '﻿---\r\nprivate: yes\r\n---\r\nThe marmot code is 4417.');
  await writeFile(join(notes, 'plain.txt'), '---\nprivate: true\n---\nPlain text has no front matter rules: the ibex note.');
  await writeFile(join(notes, 'held.md'), '---\nprivate: no\n---\nThe walrus vault opens at dawn.'); await utimes(join(notes, 'held.md'), then, then);
  let collection = await core.rpc('collections.create', { name: 'Notes' });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: notes });
  await indexed(core, collection.id);
  let listed = (await core.rpc('collections.list', {})).collections[0];
  assert.deepEqual([listed.files, listed.private, listed.errors], [4, 1, []], 'a private note is counted as private, not as unreadable');
  const session = await core.create({ provider: 'codex', cwd: root, trusted: true });
  await core.rpc('collections.bind', { id: collection.id, target: 'session', sessionId: session.id, bound: true });
  const excerpt = async (text: string) => (await core.collections.context(core.store.session(session.id), text, 2000, 'local', new AbortController().signal)).text;
  assert.match(await excerpt('kestrel sensor'), /kestrel sensor/);
  assert.equal(await excerpt('marmot code 4417'), '');
  assert.match(await excerpt('ibex note'), /ibex note/, 'only Markdown carries front matter privacy');
  assert.match(await excerpt('walrus vault'), /walrus vault/);
  // A record written before these rules carries no privacy revision, so even an unchanged size and time is read again.
  await writeFile(join(notes, 'held.md'), '---\nprivate: on\n---\nThe walrus vault opens at dawn.'); await utimes(join(notes, 'held.md'), then, then);
  const stored = core.store.get<any[]>('knowledge:collections', []);
  for (const file of stored[0].files) delete file.privacy;
  core.store.set('knowledge:collections', stored);
  await indexed(core, collection.id);
  listed = (await core.rpc('collections.list', {})).collections[0];
  assert.equal(listed.private, 2);
  assert.equal(await excerpt('walrus vault'), '', 'its old passages were erased');
  assert.match(await excerpt('kestrel sensor'), /kestrel sensor/);
});

test('AUD-005 collection packets carry a revocation witness and retrieval publishes only current authority', async t => {
  const { root, docs, core } = await fixture(t);
  let first = await core.rpc('collections.create', { name: 'First', allowCloud: true });
  first = await core.rpc('collections.addSource', { id: first.id, expectedRevision: first.revision, path: join(docs, 'guide.md') });
  await indexed(core, first.id);
  let second = await core.rpc('collections.create', { name: 'Second', allowCloud: true });
  second = await core.rpc('collections.addSource', { id: second.id, expectedRevision: second.revision, path: join(docs, 'sub', 'notes.txt') });
  await indexed(core, second.id);
  const session = await core.create({ provider: 'codex', cwd: root, trusted: true });
  await core.rpc('collections.bind', { id: first.id, target: 'session', sessionId: session.id, bound: true });
  await core.rpc('collections.bind', { id: second.id, target: 'session', sessionId: session.id, bound: true });

  const packet = await core.collections.context(core.store.session(session.id), 'zircon heliotrope', 3000, 'cloud', new AbortController().signal);
  assert.match(packet.text, /zircon/); assert.match(packet.text, /heliotrope/);
  assert.ok(packet.authorization); assert.equal(core.collections.authorizeContext(core.store.session(session.id), packet.authorization, 'cloud'), true);
  assert.equal(core.collections.revalidateContext(core.store.session(session.id), packet, 'local').text, '', 'a local proof cannot cross a cloud/local route boundary in either direction');

  const original = core.memory.service.call.bind(core.memory.service);
  const entered = deferred(), release = deferred(); let held = false;
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    if (method === 'retrieve' && p.scope_id === (core.store.get<any[]>('knowledge:collections', []).find(row => row.id === first.id)?.scopeId) && !held) {
      held = true; entered.resolve(); await release.promise;
    }
    return original(method, p, signal);
  }) as typeof core.memory.service.call;
  const pending = core.collections.context(core.store.session(session.id), 'zircon heliotrope', 3000, 'cloud', new AbortController().signal);
  await entered.promise;
  const current = (await core.rpc('collections.list', {})).collections.find((row: any) => row.id === first.id);
  await core.rpc('collections.update', { id: first.id, expectedRevision: current.revision, allowCloud: false });
  release.resolve();
  const afterRevocation = await pending;
  assert.doesNotMatch(afterRevocation.text, /zircon/, 'revoked text retrieved in flight is discarded');
  assert.match(afterRevocation.text, /heliotrope/, 'an unrelated still-authorized collection remains usable');
  assert.equal(core.collections.revalidateContext(core.store.session(session.id), packet, 'cloud').text, '', 'an already prepared packet is invalid after consent changes');

  const latest = (await core.rpc('collections.list', {})).collections.find((row: any) => row.id === first.id);
  await core.rpc('collections.update', { id: first.id, expectedRevision: latest.revision, allowCloud: true });
  const reboundPacket = await core.collections.context(core.store.session(session.id), 'zircon', 2000, 'cloud', new AbortController().signal);
  await core.rpc('collections.bind', { id: first.id, target: 'session', sessionId: session.id, bound: false });
  assert.equal(core.collections.revalidateContext(core.store.session(session.id), reboundPacket, 'cloud').text, '', 'unbind invalidates a prepared packet');
  await core.rpc('collections.bind', { id: first.id, target: 'session', sessionId: session.id, bound: true });
  const sourcePacket = await core.collections.context(core.store.session(session.id), 'zircon', 2000, 'cloud', new AbortController().signal);
  const sourceRevision = (await core.rpc('collections.list', {})).collections.find((row: any) => row.id === first.id).revision;
  await core.rpc('collections.removeSource', { id: first.id, expectedRevision: sourceRevision, path: join(docs, 'guide.md') });
  assert.equal(core.collections.revalidateContext(core.store.session(session.id), sourcePacket, 'cloud').text, '', 'source removal invalidates a prepared packet');

  let restored = (await core.rpc('collections.list', {})).collections.find((row: any) => row.id === first.id);
  restored = await core.rpc('collections.addSource', { id: first.id, expectedRevision: restored.revision, path: join(docs, 'guide.md') });
  restored = await core.rpc('collections.update', { id: first.id, expectedRevision: restored.revision, allowCloud: false });
  const localPacket = await core.collections.context(core.store.session(session.id), 'zircon', 2000, 'local', new AbortController().signal);
  assert.match(localPacket.text, /zircon/);
  assert.equal(core.collections.revalidateContext(core.store.session(session.id), localPacket, 'cloud').text, '', 'a packet prepared for a local route cannot follow a later cloud route');
  restored = await core.rpc('collections.update', { id: first.id, expectedRevision: restored.revision, allowCloud: true });

  const deleteEntered = deferred(), deleteRelease = deferred(); let deleteHeld = false;
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    if (method === 'retrieve' && p?.scope_id === core.store.get<any[]>('knowledge:collections', []).find(row => row.id === first.id)?.scopeId && !deleteHeld) {
      deleteHeld = true; deleteEntered.resolve(); await deleteRelease.promise;
    }
    return original(method, p, signal);
  }) as typeof core.memory.service.call;
  const duringDelete = core.collections.context(core.store.session(session.id), 'zircon', 2000, 'cloud', new AbortController().signal);
  await deleteEntered.promise;
  await core.rpc('collections.delete', { id: first.id, expectedRevision: restored.revision, confirmed: true });
  deleteRelease.resolve();
  assert.equal((await duringDelete).text, '', 'collection deletion during retrieval prevents late publication');
});

test('AUD-005 cancellation cannot publish a late collection packet', async t => {
  const { root, docs, core } = await fixture(t);
  let collection = await core.rpc('collections.create', { name: 'Cancelled', allowCloud: true });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: join(docs, 'guide.md') });
  await indexed(core, collection.id);
  const session = await core.create({ provider: 'codex', cwd: root, trusted: true });
  await core.rpc('collections.bind', { id: collection.id, target: 'session', sessionId: session.id, bound: true });
  const original = core.memory.service.call.bind(core.memory.service), entered = deferred(), release = deferred();
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    if (method === 'retrieve') { entered.resolve(); await release.promise; }
    return original(method, p, signal);
  }) as typeof core.memory.service.call;
  const controller = new AbortController();
  const pending = core.collections.context(core.store.session(session.id), 'zircon', 2000, 'cloud', controller.signal);
  await entered.promise; controller.abort(new Error('stopped')); release.resolve();
  await assert.rejects(pending, /stopped|aborted/i);
});

test('AUD-013 serialized commits preserve concurrent catalog changes and enforce revisions after awaits', async t => {
  const { docs, core } = await fixture(t);
  const original = core.memory.service.call.bind(core.memory.service), entered = deferred(), release = deferred(); let scopes = 0;
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    if (method === 'scope' && ++scopes === 1) { entered.resolve(); await release.promise; }
    return original(method, p, signal);
  }) as typeof core.memory.service.call;
  const slow = core.rpc('collections.create', { name: 'Slow' });
  await entered.promise;
  const fast = await core.rpc('collections.create', { name: 'Fast' });
  release.resolve(); const slowResult = await slow;
  assert.deepEqual(new Set((await core.rpc('collections.list', {})).collections.map((row: any) => row.id)), new Set([fast.id, slowResult.id]));

  const add = core.rpc('collections.addSource', { id: fast.id, expectedRevision: fast.revision, path: join(docs, 'guide.md') });
  const revoked = await core.rpc('collections.update', { id: fast.id, expectedRevision: fast.revision, allowCloud: false });
  await assert.rejects(add, (error: any) => error.code === 'REVISION_CONFLICT');
  const persisted = (await core.rpc('collections.list', {})).collections.find((row: any) => row.id === fast.id);
  assert.equal(persisted.allowCloud, false); assert.equal(persisted.revision, revoked.revision);
});

test('AUD-013 an index manifest cannot overwrite a concurrent consent revision', async t => {
  const { docs, core } = await fixture(t);
  let collection = await core.rpc('collections.create', { name: 'Index conflict', allowCloud: true });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: join(docs, 'guide.md') });
  const scope = core.store.get<any[]>('knowledge:collections', [])[0].scopeId;
  const original = core.memory.service.call.bind(core.memory.service), entered = deferred(), release = deferred(); let held = false;
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    if (method === 'observe_text' && p?.scope_id === scope && !held) { held = true; entered.resolve(); await release.promise; }
    return original(method, p, signal);
  }) as typeof core.memory.service.call;
  await core.rpc('collections.index', { id: collection.id }); await entered.promise;
  const revoked = await core.rpc('collections.update', { id: collection.id, expectedRevision: collection.revision, allowCloud: false });
  release.resolve();
  for (let index = 0; index < 200 && !core.collections.job?.done; index++) await new Promise(resolve => setTimeout(resolve, 5));
  const snapshot = core.collections.snapshot()!;
  assert.equal(snapshot.done, true, JSON.stringify(snapshot)); assert.match(snapshot.error, /changed in another window/);
  const current = (await core.rpc('collections.list', {})).collections[0];
  assert.equal(current.allowCloud, false); assert.equal(current.revision, revoked.revision); assert.equal(current.chunks, 0);
  assert.equal((await original('retrieve', { scope_id: scope, text: 'zircon' })).results.length, 0, 'the conflicted staged generation is erased');
  assert.deepEqual(core.store.get<any[]>('knowledge:collection-ingestions', []), []);
});

test('AUD-006/AUD-014 generations account for cancellation and make A-to-B-to-A recallable', async t => {
  const { docs, core } = await fixture(t);
  const path = join(docs, 'guide.md');
  let collection = await core.rpc('collections.create', { name: 'Generations' });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path });
  await writeFile(path, 'alpha generation ' + 'orchid '.repeat(500));
  assert.equal((await indexed(core, collection.id)).error, '');
  const first = core.store.get<any[]>('knowledge:collections', [])[0].files[0];
  await writeFile(path, 'beta generation ' + 'violet '.repeat(500)); await indexed(core, collection.id);
  await writeFile(path, 'alpha generation ' + 'orchid '.repeat(500)); assert.equal((await indexed(core, collection.id)).error, '');
  const third = core.store.get<any[]>('knowledge:collections', [])[0].files[0];
  assert.equal(third.sha256, first.sha256); assert.notEqual(third.generation, first.generation, 'a reverted document receives a fresh non-tombstoned identity');
  const scope = core.store.get<any[]>('knowledge:collections', [])[0].scopeId;
  assert.ok((await core.memory.service.call('retrieve', { scope_id: scope, text: 'alpha orchid' })).results.length);

  const raw = core.memory.service.call.bind(core.memory.service);
  await writeFile(path, 'duplicate delivery generation ' + 'sapphire '.repeat(500));
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    if (method !== 'observe_text') return raw(method, p, signal);
    await raw(method, p, signal); return raw(method, p, signal);
  }) as typeof core.memory.service.call;
  assert.equal((await indexed(core, collection.id)).error, '', 'a duplicate receipt for the same generation is idempotent');
  assert.ok((await raw('retrieve', { scope_id: scope, text: 'duplicate sapphire' })).results.length);

  await writeFile(path, 'cancelled generation ' + 'topaz '.repeat(1000));
  let accepted = false;
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    const receipt = await raw(method, p, signal);
    if (method === 'observe_text' && !accepted) { accepted = true; core.collections.cancel(); }
    return receipt;
  }) as typeof core.memory.service.call;
  const cancelled = await indexed(core, collection.id);
  assert.equal(cancelled.error, 'Indexing was cancelled'); assert.equal(accepted, true);
  assert.deepEqual(core.store.get<any[]>('knowledge:collection-ingestions', []), [], 'accepted staging data is reconciled from the durable journal');
  assert.equal((await core.memory.service.call('retrieve', { scope_id: scope, text: 'cancelled topaz' })).results.length, 0);
  assert.ok((await core.memory.service.call('retrieve', { scope_id: scope, text: 'duplicate sapphire' })).results.length, 'the previously committed generation survives cancelled replacement');

  await writeFile(path, 'rejected generation ' + 'garnet '.repeat(500));
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => method === 'observe_text' ? { id: 'tombstoned', duplicate: true, erased: true } : raw(method, p, signal)) as typeof core.memory.service.call;
  assert.equal((await indexed(core, collection.id)).error, '');
  const rejected = (await core.rpc('collections.list', {})).collections[0];
  assert.equal(rejected.chunks, 0); assert.match(rejected.errors[0].error, /rejected an indexed document chunk/);
});

test('AUD-006 delete fences ingestion and erases a chunk accepted before cancellation', async t => {
  const { docs, core } = await fixture(t);
  const path = join(docs, 'guide.md'); await writeFile(path, 'delete during ingestion ' + 'citrine '.repeat(1000));
  let collection = await core.rpc('collections.create', { name: 'Delete active' });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path });
  const scope = core.store.get<any[]>('knowledge:collections', [])[0].scopeId;
  const original = core.memory.service.call.bind(core.memory.service), accepted = deferred(), release = deferred(); let held = false;
  core.memory.service.call = (async (method: string, p?: any, signal?: AbortSignal) => {
    const receipt = await original(method, p, signal);
    if (method === 'observe_text' && !held) { held = true; accepted.resolve(); await release.promise; }
    return receipt;
  }) as typeof core.memory.service.call;
  await core.rpc('collections.index', { id: collection.id }); await accepted.promise;
  const deleting = core.rpc('collections.delete', { id: collection.id, expectedRevision: collection.revision, confirmed: true });
  release.resolve(); const deleted = await deleting;
  assert.deepEqual([deleted.erasure.suppressed, deleted.erasure.purge_complete], [true, false], 'deletion reports canonical suppression without claiming asynchronous physical purge');
  assert.equal((await core.memory.service.call('retrieve', { scope_id: scope, text: 'citrine' })).results.length, 0);
  assert.deepEqual(core.store.get<any[]>('knowledge:collection-ingestions', []), []);
  assert.equal((await core.rpc('collections.list', {})).collections.length, 0);
});

test('AUD-006 restart reconciliation erases an accepted chunk whose manifest was never committed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cere-collections-restart-')), state = join(root, 'state'), path = join(root, 'orphan.md');
  await writeFile(path, 'restart boundary amber document');
  const firstCore = new Core(new Store(state), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  await firstCore.memory.ready;
  const collection = await firstCore.rpc('collections.create', { name: 'Restart journal' });
  const generation = 'durable-test-generation', documentSource = 'file-revision:' + JSON.stringify([path, generation]);
  const receipt = await firstCore.memory.service.call('observe_text', { scope_id: collection.scopeId, text: 'restart boundary amber document', role: 'document', kind: 'document', session_id: documentSource, source_event_id: generation + '#0' });
  assert.ok(receipt.id);
  firstCore.store.set('knowledge:collection-ingestions', [{ id: 'interrupted-run', collectionId: collection.id, scopeId: collection.scopeId, baseRevision: collection.revision, created: Date.now(), phase: 'ingesting', cleanupSources: [], files: [{ path, generation, documentSource, sha256: 'test', chunks: 1, accepted: [generation + '#0'] }] }]);
  await firstCore.close();

  const core = new Core(new Store(state), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  await core.memory.ready;
  await core.rpc('collections.list', {});
  assert.deepEqual(core.store.get<any[]>('knowledge:collection-ingestions', []), []);
  assert.equal((await core.memory.service.call('retrieve', { scope_id: collection.scopeId, text: 'amber' })).results.length, 0);
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
