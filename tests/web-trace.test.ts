import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { WebSearch, sanitizeReason, type SearchTrace } from '../broker/web.ts';

const brave = '<div data-type="web"><a href="https://example.org"><div class="title">Result</div></a></div>';
const auto = { enabled: true, provider: 'auto' as const, searxngUrl: '' };
const signal = () => new AbortController().signal;

test('Q05 a search trace records the real attempts, timings and sanitized reasons without changing the model result', async () => {
  const traces: SearchTrace[] = [];
  const web = new WebSearch(async url => {
    if (url.includes('duckduckgo')) throw new Error('blocked at https://html.duckduckgo.com/html/?q=my+private+question#frag\nretry later');
    return { url, status: 200, contentType: 'text/html', text: brave };
  });
  const result = await web.search('my private question', auto, signal(), trace => traces.push(trace));
  assert.deepEqual(Object.keys(result).sort(), ['fallback', 'note', 'provider', 'query', 'results', 'retrieved'], 'the model sees the same result as before');
  assert.equal(traces.length, 1);
  const [trace] = traces;
  assert.equal(trace.outcome, 'ok'); assert.equal(trace.provider, 'brave'); assert.equal(trace.requested, 'auto'); assert.equal(trace.results, 1);
  assert.deepEqual(trace.attempts.map(attempt => [attempt.provider, attempt.outcome, attempt.results]), [['duckduckgo', 'failed', 0], ['brave', 'ok', 1]]);
  assert.equal(trace.attempts[0].reason, 'blocked at https://html.duckduckgo.com/html/ retry later', 'reasons drop URL queries, fragments and line breaks');
  assert.ok(trace.attempts.every(attempt => Number.isInteger(attempt.durationMs) && attempt.durationMs >= 0));
  // Every provider failing is recorded once, as a failure.
  traces.length = 0;
  await assert.rejects(new WebSearch(async () => { throw new Error('offline'); }).search('anything', auto, signal(), trace => traces.push(trace)), /Web search unavailable/);
  assert.deepEqual(traces.map(trace => [trace.outcome, trace.attempts.length, trace.provider]), [['failed', 3, '']]);
  // Stop ends the search and its trace says it was stopped, not that every provider failed.
  traces.length = 0;
  const controller = new AbortController();
  await assert.rejects(new WebSearch(async () => { controller.abort(new Error('Stopped')); throw new Error('offline'); }).search('anything', auto, controller.signal, trace => traces.push(trace)), /Stopped/);
  assert.deepEqual(traces.map(trace => trace.outcome), ['cancelled']);
  assert.equal(sanitizeReason('x'.repeat(500)).length, 240);
  assert.equal(sanitizeReason('key in https://user:pw@host.example/path?token=abc'), 'key in https://host.example/path');
});

test('Q05 traces are bounded per conversation, shown read-only in Context, never exported, and dropped with the conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-web-trace-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  let loads = 0;
  core.web = new WebSearch(async url => { loads++; return { url, status: 200, contentType: 'text/html', text: brave }; });
  await core.updateSettings({ webSearch: { enabled: true, provider: 'brave' } });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true }), other = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  for (let index = 0; index < 14; index++) await core.webCall('web_search', { query: 'query number ' + index }, signal(), session.id);
  await core.webCall('web_search', { query: 'a secret search about tangerines' }, signal(), other.id);
  const before = loads;
  const context = await core.rpc('session.context', { id: session.id });
  assert.equal(loads, before, 'opening Context fetches nothing');
  assert.equal(context.webSearches.length, 10, 'ten searches per conversation');
  assert.equal(context.webSearches[0].query, 'query number 13', 'newest first');
  assert.ok(context.webSearches.every((trace: SearchTrace) => trace.provider === 'brave' && trace.outcome === 'ok'));
  assert.deepEqual((await core.rpc('session.context', { id: other.id })).webSearches.map((trace: SearchTrace) => trace.query), ['a secret search about tangerines'], 'traces stay with their conversation');
  const exported = JSON.stringify(await core.rpc('diagnostics.preview', {}));
  assert.doesNotMatch(exported, /tangerines|query number/, 'support exports never include search traces');
  await core.rpc('session.delete', { id: other.id, confirmed: true });
  assert.equal(core.webTraces.has(other.id), false);
  // The drawer's text comes from the same records.
  const library: any = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../qml/ContextExplain.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), library);
  assert.match(library.searchLine(context.webSearches[0]), /^Brave · 1 result · \d+ ms · “query number 13”$/);
  assert.equal(library.searchDetail({ outcome: 'ok', requested: 'auto', attempts: [{ provider: 'duckduckgo', outcome: 'failed', reason: 'rate limited' }, { provider: 'brave', outcome: 'ok' }] }), 'Fell back after: DuckDuckGo (rate limited)');
});
