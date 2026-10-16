import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { WebSearch } from '../broker/web.ts';

// Q07: deterministic work and payload bounds for the slice 1 surfaces. They count operations and
// bytes, never wall-clock time, so a slow machine cannot make them flaky.
const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'cere-work-budget-'));
  const core = new Core(new Store(dir), idle);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.memory.ready;
  return { core, dir };
}
function countCalls(core: Core) {
  const calls: string[] = [], original = core.memory.service.call.bind(core.memory.service);
  core.memory.service.call = (async (method: string, ...rest: any[]) => { calls.push(method); return (original as any)(method, ...rest); }) as any;
  return calls;
}

test('Q07 recording a recall outcome adds no memory-worker work to the turn', async t => {
  const { core, dir } = await broker(t);
  await core.updateSettings({ memory: { enabled: true, allowCloudMemory: true }, ollama: { host: 'http://127.0.0.1:9' } });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  core.updateSession(session.id, { turnId: 'budget-turn' });
  await core.memory.scope(core.store.session(session.id));
  const calls = countCalls(core);
  await core.memory.context(core.store.session(session.id), 'Which release checklist did we agree on?', new AbortController().signal, 4000, 'cloud');
  // One observation and one retrieval, bracketed by the foreground hints that already existed.
  assert.deepEqual(calls.filter(method => method !== 'foreground').sort(), ['observe_text', 'retrieve']);
  assert.equal(core.memory.outcomes(session.id).length, 1);
  // Explaining that turn afterwards reads stored records only.
  calls.length = 0;
  await core.rpc('session.context', { id: session.id });
  assert.deepEqual(calls, []);
});

test('Q07 snapshots stay small however many saved styles exist', async t => {
  const { core } = await broker(t);
  const size = () => Buffer.byteLength(JSON.stringify(core.snapshot()));
  const empty = size();
  for (let index = 0; index < 50; index++) await core.rpc('presets.save', { label: 'Style ' + index, text: 'x'.repeat(8000), expectedRevision: core.presets.catalog().revision });
  // 400 KB of style text never rides along in the state every client receives.
  assert.ok(size() - empty < 64, `snapshot grew by ${size() - empty} bytes`);
});

test('Q07 the Context payload is bounded by fixed per-conversation histories', async t => {
  const { core, dir } = await broker(t);
  core.web = new WebSearch(async url => ({ url, status: 200, contentType: 'text/html', text: '<div data-type="web"><a href="https://example.org"><div class="title">Result</div></a></div>' }));
  await core.updateSettings({ webSearch: { enabled: true, provider: 'brave' } });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  for (let index = 0; index < 40; index++) await core.webCall('web_search', { query: 'q'.repeat(400) + index }, new AbortController().signal, session.id);
  for (let index = 0; index < 40; index++) { core.updateSession(session.id, { turnId: 'turn-' + index }); core.memory.recordOutcome(session.id, { outcome: 'included', reason: 'partial_coverage', coverage: Array(30).fill('semantic_degraded'), items: 8 }); }
  const context = await core.rpc('session.context', { id: session.id });
  assert.equal(context.webSearches.length, 10);
  assert.ok(context.webSearches.every((trace: any) => trace.query.length <= 120));
  assert.ok(context.recallOutcome.coverage.length <= 12);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 16 * 1024, `context payload is ${Buffer.byteLength(JSON.stringify(context))} bytes`);
  // A preview is bounded by the personality limits it validates.
  const preview = await core.rpc('personality.preview', { personality: 'y'.repeat(8000), assistantName: 'n'.repeat(64) });
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 2 * (8000 + 2000));
});

test('M04 memory packing keeps whole items inside the budget, even when the best match alone is too large', async t => {
  const { Canonical } = await import('../broker/graph-memory/canonical.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const directory = mkdtempSync(join(tmpdir(), 'cere-packing-'));
  const c = new Canonical(directory);
  t.after(() => { c.close(); rmSync(directory, { recursive: true, force: true }); });
  const scope = c.registerScope({ key: 'packing', label: 'Packing' }).id;
  // The best match is far larger than the whole budget; a smaller one still fits.
  c.observeText({ scope_id: scope, text: 'orchid deployment ' + 'orchid deployment checklist step. '.repeat(400), role: 'user', session_id: 'past' });
  c.observeText({ scope_id: scope, text: 'The orchid deployment ships on Friday.', role: 'user', session_id: 'past' });
  const result = c.retrieve({ scope_id: scope, text: 'orchid deployment', token_budget: 300 });
  assert.ok(result.budget.estimated_tokens <= result.budget.limit, `${result.budget.estimated_tokens} of ${result.budget.limit}`);
  assert.ok(result.budget.trimmed_items >= 1, 'the oversized item is counted as trimmed');
  assert.ok(result.coverage.includes('token_budget_trimmed'));
  assert.ok(result.items.every((item: any) => !String(item.text).includes('step. orchid deployment checklist step.'.repeat(50))), 'no partial copy of the oversized item');
  assert.ok(result.items.some((item: any) => /ships on Friday/.test(item.text)), 'the item that fits is still supplied');
});
