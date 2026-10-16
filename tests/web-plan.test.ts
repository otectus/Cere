import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { WebSearch, webDefinitions, type SearchTrace } from '../broker/web.ts';
import { SearchCache, compile, dedupeKey, validConstraints } from '../broker/web-plan.ts';

const signal = () => new AbortController().signal;
const searxng = { enabled: true, provider: 'searxng' as const, searxngUrl: 'http://127.0.0.1:8888' };
const page = (results: { title: string; url: string }[]) => (url: string) => ({ url, status: 200, contentType: 'application/json', text: JSON.stringify({ results: results.map(item => ({ ...item, content: 'snippet' })) }) });

test('M12 constraints validate domains and compile to what each provider supports, labelling the rest', () => {
  assert.deepEqual(validConstraints({ sites: ['https://www.Docs.Python.org/3/', 'docs.python.org'], recency: 'week' }), { sites: ['docs.python.org'], recency: 'week' });
  assert.deepEqual(validConstraints({ sites: 'a.example, b.example' }), { sites: ['a.example', 'b.example'] });
  for (const [value, error] of [[{ sites: ['not a domain'] }, /not a site domain/], [{ sites: Array.from({ length: 6 }, (_, i) => `s${i}.example`) }, /up to 5/],
    [{ sites: ['a.example'], exclude: ['a.example'] }, /both required and excluded/], [{ recency: 'hour' }, /day, week, month or year/], [{ operators: 'x' }, /Unknown search constraint/]] as [unknown, RegExp][])
    assert.throws(() => validConstraints(value), error);
  const ddg = compile('duckduckgo', 'asyncio timeouts', { sites: ['docs.python.org'], exclude: ['w3schools.com'], recency: 'month' });
  assert.equal(ddg.query, 'asyncio timeouts site:docs.python.org -site:w3schools.com');
  assert.deepEqual(ddg.params, { df: 'm' });
  assert.match(ddg.approximated[0], /past month requested from duckduckgo \(df=m\); result dates are not checked/);
  assert.equal(compile('duckduckgo', 'x', { sites: ['a.example', 'b.example'] }).query, 'x (site:a.example OR site:b.example)');
  assert.deepEqual(compile('brave', 'x', { recency: 'day' }).params, { tf: 'pd' });
  assert.deepEqual(compile('searxng', 'x', { recency: 'year' }).params, { time_range: 'year' });
  const mojeek = compile('mojeek', 'x', { recency: 'week' });
  assert.deepEqual(mojeek.params, {}); assert.match(mojeek.approximated[0], /mojeek has no date filter; results are not limited to the past week/);
  assert.equal(dedupeKey('https://www.Example.org/page/?utm_source=x#top'), dedupeKey('https://example.org/page'));
  const tool = webDefinitions.find(item => item.name === 'web.search')!;
  assert.deepEqual(tool.required, ['query'], 'constraints are optional for the model');
});

test('M12 site rules are enforced on results, the trace shows what was sent, and the cache is bounded, keyed and honest', async () => {
  const sent: string[] = [], traces: SearchTrace[] = [];
  let results = [{ title: 'Asyncio', url: 'https://docs.python.org/3/library/asyncio.html' }, { title: 'Copy', url: 'https://docs.python.org/3/library/asyncio.html?utm_source=feed' }, { title: 'Off site', url: 'https://blog.example/asyncio' }];
  const web = new WebSearch(async url => { sent.push(url); return page(results)(url); });
  const search = (constraints?: unknown) => web.search('Asyncio  timeouts', searxng, signal(), trace => traces.push(trace), constraints);
  const first: any = await search({ sites: ['docs.python.org'], recency: 'week' });
  assert.deepEqual(first.results.map((item: any) => item.url), ['https://docs.python.org/3/library/asyncio.html'], 'off-site results and duplicates are removed');
  const request = new URL(sent[0]);
  assert.deepEqual([request.searchParams.get('q'), request.searchParams.get('time_range')], ['Asyncio  timeouts site:docs.python.org', 'week']);
  assert.match(traces[0].attempts[0].sent!, /site:docs\.python\.org · time_range=week/);
  assert.deepEqual(traces[0].constraints!.applied, ['only docs.python.org (query operator and result filter)']);
  assert.match(first.constraints.approximated[0], /result dates are not checked/);
  // The same normalized query and constraints come from the cache, labelled as such.
  const again: any = await web.search('asyncio timeouts', searxng, signal(), trace => traces.push(trace), { recency: 'week', sites: ['docs.python.org'] });
  assert.equal(sent.length, 1); assert.equal(again.cached, true); assert.ok(Number.isInteger(again.cachedSeconds));
  assert.deepEqual([traces[1].cached, traces[1].attempts[0].outcome], [true, 'cached']);
  // Fresh, different constraints or different provider settings never reuse it.
  await search({ sites: ['docs.python.org'], recency: 'week', fresh: true }); assert.equal(sent.length, 2);
  await search({ sites: ['docs.python.org'], recency: 'month' }); assert.equal(sent.length, 3);
  await web.search('asyncio timeouts', { ...searxng, searxngUrl: 'http://127.0.0.1:9999' }, signal(), undefined, { sites: ['docs.python.org'], recency: 'week' }); assert.equal(sent.length, 4);
  // Past-day results are never cached; a private address never becomes a result, so it is never cached.
  await search({ recency: 'day' }); await search({ recency: 'day' }); assert.equal(sent.length, 6);
  results = [{ title: 'Intranet', url: 'http://192.168.1.20/wiki' }];
  await assert.rejects(web.search('wiki', searxng, signal()), /No usable results/);
  assert.equal(web.cache.entries.size, 3, 'a fresh search refreshes its entry; past-day and failed searches add none');
  // When every result falls outside the requested sites, the search says so instead of returning them.
  results = [{ title: 'Off site', url: 'https://blog.example/x' }];
  await assert.rejects(search({ sites: ['docs.python.org'], fresh: true }), /No results from the requested sites/);
  // The Context drawer explains the constraints and the cache from the same trace.
  const library: any = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../qml/ContextExplain.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), library);
  assert.equal(library.searchDetail(traces[0]), 'only docs.python.org (query operator and result filter)\npast week requested from searxng (time_range=week); result dates are not checked\nSent to SearXNG: Asyncio  timeouts site:docs.python.org · time_range=week');
  assert.match(library.searchLine(traces[1]), /^SearXNG · 1 result · from Cere’s cache · /);
  // The cache is a bounded LRU that expires entries.
  let now = 0; const cache = new SearchCache<number>(2, 1000, () => now);
  cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.deepEqual([...cache.entries.keys()], ['a', 'c'], 'the least recently used entry goes first');
  now = 1001; assert.equal(cache.get('a'), undefined);
});

test('M12 constraints reach the search from a tool call and a composer message, and only with a web search', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-web-plan-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.updateSettings({ webSearch: searxng });
  const calls: unknown[] = [];
  core.web.search = (async (_query: unknown, _settings: unknown, _signal: AbortSignal, _trace: unknown, constraints: unknown) => { calls.push(constraints); return { results: [] }; }) as any;
  await core.webCall('web_search', { query: 'x', sites: ['docs.python.org'], recency: 'week' }, signal());
  await core.webCall('web_search', { query: 'y' }, signal());
  assert.deepEqual(calls, [{ sites: ['docs.python.org'], recency: 'week' }, undefined]);
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  await assert.rejects(core.rpc('session.send', { id: session.id, text: 'hello', webConstraints: { recency: 'week' } }), /only to a message that searches the web/);
  await assert.rejects(core.rpc('session.send', { id: session.id, text: 'hello', webSearch: true, webConstraints: { sites: ['bad domain'] } }), /not a site domain/);
});
