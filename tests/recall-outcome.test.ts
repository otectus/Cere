import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { recallOutcomeKey } from '../broker/memory.ts';

// qml/ContextExplain.js turns the broker's outcome codes and search traces into the Context drawer's text.
const library: any = vm.createContext({});
vm.runInContext(readFileSync(new URL('../qml/ContextExplain.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), library);
const memorySource = readFileSync(new URL('../broker/memory.ts', import.meta.url), 'utf8') + readFileSync(new URL('../broker/core.ts', import.meta.url), 'utf8');

test('Q04 every outcome and reason the broker can record has plain-language text', () => {
  const reasons = new Set<string>(library.knownReasons());
  // Each set('outcome','reason') / {outcome:'x',reason:'y'} pair in the broker must be described.
  const pairs = new Set<string>();
  for (const match of memorySource.matchAll(/set\('([a-z_]+)',\s*'([a-z_]+)'\)/g)) pairs.add(`${match[1]}/${match[2]}`);
  for (const match of memorySource.matchAll(/outcome:\s*'([a-z_]+)',\s*reason:\s*'([a-z_]+)'/g)) pairs.add(`${match[1]}/${match[2]}`);
  for (const code of ['temporary_conversation', 'setting_off', 'paused', 'remote_scope', 'unavailable']) pairs.add('disabled/' + code);
  pairs.add('timed_out/recall_deadline'); pairs.add('degraded/memory_changed'); pairs.add('degraded/unavailable');
  for (const pair of pairs) if (!pair.startsWith('included/')) assert.ok(reasons.has(pair), `${pair} has no text`);
  for (const code of ['semantic_degraded', 'graph_degraded', 'deadline_partial', 'token_budget_trimmed', 'cloud_memory_denied']) assert.ok(library.knownCoverage().includes(code), code);
  const now = Date.parse('2026-10-15T12:00:00Z');
  const included = library.describe({ outcome: 'included', reason: 'partial_coverage', items: 3, held: 1, estimatedTokens: 410, coverage: ['semantic_degraded'], memoryState: 'degraded', time: now - 5 * 60000 }, now);
  assert.equal(included.title, 'Included 3 memories (about 410 tokens).');
  assert.match(included.detail, /1 match was already supplied earlier\. Coverage: the semantic index was unavailable or behind\. Memory was degraded then\./);
  assert.equal(included.when, 'Recorded 5 minutes ago; current memory health may differ.');
  assert.equal(library.describe(null).title, 'No recall has been recorded for this conversation yet.');
  // Disabled, no match and timeout read differently.
  const titles = ['disabled/setting_off', 'no_match/nothing_cleared_relevance', 'timed_out/recall_deadline'].map(pair => { const [outcome, reason] = pair.split('/'); return library.describe({ outcome, reason }).title; });
  assert.equal(new Set(titles).size, 3);
});

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });

test('Q04 outcomes are bounded per conversation, per turn, content-free and readable without recalling', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-recall-outcome-'));
  const core = new Core(new Store(dir), idle);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.memory.ready;
  // No embedding server: semantic recall is unavailable, as it is when Ollama is down.
  await core.updateSettings({ ollama: { host: 'http://127.0.0.1:9' } });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  const secret = 'the launch code is tangerine-7';
  // Memory off: a native turn records "disabled" for its own turn, with no message text.
  core.updateSession(session.id, { turnId: 'turn-1' });
  core.memory.recordOutcome(session.id, { outcome: 'disabled', reason: core.memoryOffReason(session.id), route: 'cloud' });
  assert.equal(core.memory.outcomes(session.id)[0].reason, 'setting_off');
  // Memory on but cloud sharing off: a Codex turn is a cloud route, so nothing is eligible.
  await core.updateSettings({ memory: { enabled: true } });
  core.updateSession(session.id, { turnId: 'turn-2' });
  const calls: string[] = [], service = core.memory.service.call.bind(core.memory.service);
  core.memory.service.call = (async (method: string, ...rest: any[]) => { calls.push(method); return (service as any)(method, ...rest); }) as any;
  assert.equal(await core.memory.context(core.store.session(session.id), secret, new AbortController().signal, 4000, 'cloud'), '');
  const [latest] = core.memory.outcomes(session.id);
  assert.deepEqual([latest.turnId, latest.outcome, latest.reason], ['turn-2', 'no_eligible_sources', 'cloud_memory_not_allowed']);
  assert.ok(!calls.includes('retrieve'), 'a cloud turn without consent never retrieves');
  // A topic-free message is skipped, distinct from a search that matched nothing.
  await core.updateSettings({ memory: { allowCloudMemory: true } });
  core.updateSession(session.id, { turnId: 'turn-3' });
  await core.memory.context(core.store.session(session.id), 'ok, continue', new AbortController().signal, 4000, 'cloud');
  assert.deepEqual([core.memory.outcomes(session.id)[0].outcome, core.memory.outcomes(session.id)[0].reason], ['skipped', 'no_topic_words']);
  // With the semantic index down, finding nothing is reported as partial coverage, not as no match.
  core.updateSession(session.id, { turnId: 'turn-4' });
  await core.memory.context(core.store.session(session.id), 'Which database migration tooling did we choose?', new AbortController().signal, 4000, 'cloud');
  assert.deepEqual([core.memory.outcomes(session.id)[0].outcome, core.memory.outcomes(session.id)[0].reason], ['degraded', 'no_match_partial_coverage']);
  assert.ok(core.memory.outcomes(session.id)[0].coverage.includes('semantic_degraded'));
  // A complete search that matched nothing is a plain no match.
  core.updateSession(session.id, { turnId: 'turn-4b' });
  core.memory.service.call = (async (method: string, ...rest: any[]) => method === 'retrieve' ? { items: [], results: [], coverage: [], budget: { estimated_tokens: 0, trimmed_items: 0 }, metrics: { candidates: 3 }, snapshot: { revision: 7 } } : (service as any)(method, ...rest)) as any;
  await core.memory.context(core.store.session(session.id), 'Which database migration tooling did we choose?', new AbortController().signal, 4000, 'cloud');
  assert.deepEqual([core.memory.outcomes(session.id)[0].outcome, core.memory.outcomes(session.id)[0].reason, core.memory.outcomes(session.id)[0].candidates, core.memory.outcomes(session.id)[0].memoryRevision], ['no_match', 'nothing_cleared_relevance', 3, 7]);
  core.memory.service.call = service as any;
  // A recall that outlives its deadline is recorded as timed out, not as a missing match.
  core.updateSession(session.id, { turnId: 'turn-5' });
  core.memory.recallDeadlineMs = 1;
  core.memory.service.call = (async (method: string, ...rest: any[]) => method === 'retrieve' ? new Promise(() => {}) : (service as any)(method, ...rest)) as any;
  await core.memory.context(core.store.session(session.id), 'Which database migration tooling did we choose?', new AbortController().signal, 4000, 'cloud');
  assert.deepEqual([core.memory.outcomes(session.id)[0].outcome, core.memory.outcomes(session.id)[0].reason], ['timed_out', 'recall_deadline']);
  core.memory.service.call = service as any; core.memory.recallDeadlineMs = 8000;
  // Records never hold the message text, and a turn's later record replaces its earlier one.
  assert.doesNotMatch(JSON.stringify(core.store.get(recallOutcomeKey(session.id), [])), /tangerine|database migration/);
  core.memory.recordOutcome(session.id, { outcome: 'degraded', reason: 'unavailable' });
  assert.equal(core.memory.outcomes(session.id).filter(row => row.turnId === 'turn-5').length, 1);
  for (let turn = 0; turn < 30; turn++) { core.updateSession(session.id, { turnId: 'bulk-' + turn }); core.memory.recordOutcome(session.id, { outcome: 'no_match', reason: 'nothing_cleared_relevance' }); }
  assert.equal(core.memory.outcomes(session.id).length, 20, 'the history is bounded');
  // Opening the explanation reads the stored record and never retrieves again.
  calls.length = 0;
  core.memory.service.call = (async (method: string, ...rest: any[]) => { calls.push(method); return (service as any)(method, ...rest); }) as any;
  const context = await core.rpc('session.context', { id: session.id });
  const explained = await core.rpc('memoryReview.recalled', { sessionId: session.id });
  assert.equal(context.recallOutcome.turnId, 'bulk-29');
  assert.equal(explained.outcome.turnId, 'bulk-29');
  assert.ok(!calls.includes('retrieve'), `explanations ran ${calls.join(', ')}`);
  // Deleting the conversation removes its outcome history.
  await core.rpc('session.delete', { id: session.id, confirmed: true });
  assert.deepEqual(core.store.get(recallOutcomeKey(session.id), null), null);
});

test('M04 the drawer describes each recorded plan layer, keeps unknowns explicit and never shows text', () => {
  const plan = { schema: 1, provider: 'ollama', model: 'qwen', contextSize: 8192, rounds: 2, time: Date.parse('2026-10-15T12:00:00Z'), unknown: [],
    layers: [
      { id: 'personality', label: 'Personality block', trust: 'user', tokens: 120, included: true },
      { id: 'continuity', label: 'Earlier turns (excerpts)', trust: 'untrusted', tokens: 300, included: true, detail: { turns: 2, omittedBefore: 1, sources: ['a', 'b'] } },
      { id: 'history', label: 'Conversation history', trust: 'user', tokens: 2000, included: true, reason: 'older_turns_omitted', detail: { keptMessages: 6, omittedTurns: 3 } },
      { id: 'memory', label: 'Recalled memory', trust: 'untrusted', tokens: 0, included: false, reason: 'withheld_cloud_route' },
    ] };
  // QML provides Qt.locale(); a library script has no Locale type, so none is defined here either.
  library.Qt = { locale: () => undefined };
  const rows = library.planRows(plan);
  assert.deepEqual(rows.map((row: any) => [row.id, row.included]), [['personality', true], ['continuity', true], ['history', true], ['memory', false]]);
  assert.match(rows[1].status, /included · 2 earlier turns excerpted, 1 older not shown/);
  assert.match(rows[1].label, /\(reference data\)/);
  assert.match(rows[2].status, /included · older turns left out · 6 messages kept, 3 turns left out/);
  assert.equal(rows[3].status, 'withheld: the model routes to the cloud');
  assert.match(library.planSummary(plan), /^ollama · qwen · ≈2,420 tokens of 8,192 in the window · 2 tool rounds/);
  assert.equal(library.planRows(null).length, 0);
});
