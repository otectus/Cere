import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPriority, tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { Transcription, backgroundNice } from '../broker/transcription.ts';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'cere-jobs-'));
  const core = new Core(new Store(join(root, 'state')), idle);
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  return { root, core };
}
const until = async (check: () => boolean) => { for (let index = 0; index < 400 && !check(); index++) await new Promise(resolve => setTimeout(resolve, 10)); };

test('A04 background work is listed together, cancels through the list, and yields to a reply for a bounded time', async t => {
  const { root, core } = await broker(t);
  let cancelled = 0;
  const done = core.jobs.add('collection-index', 'Indexing docs', () => { cancelled++; }, () => ({ done: 1, total: 4 }));
  const [job] = core.snapshot().jobs;
  assert.deepEqual([job.kind, job.label, job.progress], ['collection-index', 'Indexing docs', { done: 1, total: 4 }]);
  assert.equal(await core.rpc('jobs.cancel', { id: job.id }), true); assert.equal(cancelled, 1);
  done(); assert.deepEqual(core.snapshot().jobs, []);
  await assert.rejects(core.rpc('jobs.cancel', { id: job.id }), /already ended/);
  // A reply in progress holds background work back; it resumes when the reply ends, or after the limit.
  const session = await core.create({ provider: 'codex', cwd: root, trusted: true });
  core.updateSession(session.id, { status: 'working' });
  const waiting = core.jobs.yieldToForeground(new AbortController().signal);
  setTimeout(() => core.updateSession(session.id, { status: 'idle' }), 300);
  assert.ok(await waiting >= 250);
  core.updateSession(session.id, { status: 'working' });
  assert.ok(await core.jobs.yieldToForeground(new AbortController().signal, 100) < 1000, 'bounded: work is never starved');
  const controller = new AbortController(); setTimeout(() => controller.abort(new Error('Indexing cancelled')), 50);
  await assert.rejects(core.jobs.yieldToForeground(controller.signal), /Indexing cancelled/);
});

test('A04 indexing waits while a reply is generated, and a download is listed and cancelled from the list', async t => {
  const { root, core } = await broker(t);
  await core.updateSettings({ ollama: { host: 'http://127.0.0.1:9' } });
  await core.memory.ready;
  const docs = join(root, 'docs'); await mkdir(docs);
  for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(join(docs, name), `# ${name}\n\nSome notes about ${name}.`);
  let collection = await core.rpc('collections.create', { name: 'Docs' });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: docs });
  const session = await core.create({ provider: 'codex', cwd: root, trusted: true });
  core.updateSession(session.id, { status: 'working' });
  await core.rpc('collections.index', { id: collection.id });
  await until(() => (core.collections.job?.total || 0) === 3);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(core.collections.job!.processed, 0, 'no file was indexed while the reply was being generated');
  assert.deepEqual(core.snapshot().jobs.map((job: any) => [job.kind, job.progress]), [['collection-index', { done: 0, total: 3 }]]);
  core.updateSession(session.id, { status: 'idle' });
  await until(() => !!core.collections.job?.done);
  assert.deepEqual([core.collections.snapshot()!.processed, core.collections.snapshot()!.error], [3, '']);
  assert.deepEqual(core.snapshot().jobs, [], 'a finished job leaves the list');
  // A model download that never finishes on its own is cancelled from the list.
  const server = createServer((req, res) => {
    if (req.url === '/api/pull') { res.setHeader('Content-Type', 'application/x-ndjson'); res.write(JSON.stringify({ status: 'pulling', completed: 10, total: 100 }) + '\n'); return; }
    res.end(JSON.stringify({ models: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  await core.updateSettings({ ollama: { host: `http://127.0.0.1:${(server.address() as any).port}` } });
  await core.rpc('models.pull', { model: 'tiny-model' });
  await until(() => core.snapshot().jobs.some((job: any) => job.kind === 'model-pull' && job.progress?.done === 10));
  const pull = core.snapshot().jobs.find((job: any) => job.kind === 'model-pull')!;
  assert.equal(pull.label, 'Downloading tiny-model');
  await core.rpc('jobs.cancel', { id: pull.id });
  await until(() => core.localModels.snapshot()?.done === true);
  assert.equal(core.localModels.snapshot()!.status, 'cancelled');
  assert.deepEqual(core.snapshot().jobs, []);
});

test('A04 transcribing a file runs whisper at background priority; dictation keeps normal priority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cere-jobs-nice-')); t.after(() => rm(root, { recursive: true, force: true }));
  // A whisper stand-in whose transcript is its own CPU priority.
  const whisper = join(root, 'whisper.mjs');
  await writeFile(whisper, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { getPriority } from 'node:os';\nconst args = process.argv.slice(2);\nwriteFileSync(args[args.indexOf('--output-file') + 1] + '.txt', 'priority ' + getPriority());\n`, { mode: 0o755 });
  const model = join(root, 'model.bin'); await writeFile(model, 'model');
  const samples = 1600, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await writeFile(join(root, 'meeting.wav'), wav);
  const recorder = join(root, 'recorder.mjs');
  await writeFile(recorder, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv.at(-1), Buffer.alloc(256, 7));\nfor (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const transcription = new Transcription({ settings: () => ({ executable: whisper, model }), changed: () => {}, runtimeDirectory: join(root, 'runtime'), ffmpeg: '', recorder: output => ({ command: recorder, args: [output] }) });
  t.after(() => transcription.close());
  // A system tuner may already run this process nicer (CachyOS's ananicy-cpp renices node to 16); a child
  // is never made higher priority than its parent, so the expectation follows the test process.
  const result = await transcription.importFile({ sessionId: 'session-a', path: join(root, 'meeting.wav') });
  assert.equal(result.text, `priority ${Math.max(backgroundNice, getPriority())}`);
  await transcription.start({ sessionId: 'session-a' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await transcription.finish()).text, `priority ${getPriority()}`, 'dictation is interactive and keeps the broker’s priority');
});
