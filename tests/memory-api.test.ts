import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiExtractionAdapter, googleEmbeddings } from '../broker/graph-memory/adapters/api.ts';
import { MemoryService } from '../broker/graph-memory/service.ts';

const source = { sourceRecordId: 'source:1', sourceRevision: 1, sourceRole: 'user' as const, modelRoute: 'cloud_allowed' as const, text: 'Use Ruff.' };
const empty = { entities: [], assertions: [] };
const response = (value: unknown) => new Response(JSON.stringify(value));
for (const provider of ['google', 'anthropic'] as const) test(`${provider} extraction gates, repair, evidence validation and credentials`, async () => {
  const calls: any[] = [];
  let output: unknown = empty, malformed = true;
  const access = { key: () => 'fixture-secret', fetch: (async (url, init) => {
    calls.push({ url: String(url), ...init, body: JSON.parse(String(init?.body)) });
    const text = malformed ? 'invalid' : JSON.stringify(output); malformed = false;
    return response(provider === 'google' ? { modelVersion: 'resolved-model', candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] } : { model: 'resolved-model', stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  }) as typeof fetch };
  const adapter = new ApiExtractionAdapter({ provider, model: 'test-model', allowCloud: false }, access);
  await assert.rejects(adapter.extract(source), { code: 'CLOUD_EXTRACTION_DISABLED' });
  adapter.config.allowCloud = true;
  await assert.rejects(adapter.extract({ ...source, modelRoute: 'local_only' }), { code: 'LOCAL_ONLY_CLOUD_ROUTE' });
  assert.equal(calls.length, 0);
  const result = await adapter.extract(source);
  assert.equal(calls.length, 2); assert.equal(result.model, 'resolved-model');
  assert.equal(result.endpointClass, provider === 'google' ? 'google_api' : 'anthropic_api');
  assert.equal(calls[0].headers[provider === 'google' ? 'x-goog-api-key' : 'x-api-key'], 'fixture-secret');
  assert.equal(calls[0].redirect, 'error');
  output = { entities: [], assertions: [{ subjectRef: 'user', predicate: 'PREFERS_TOOL', object: { entityRef: 'tool' }, qualifiers: {}, polarity: 'positive', modality: 'actual', epistemicType: 'explicit_user', operation: 'asserts', temporal: { expression: null, interpretation: null, uncertain: true }, quotes: [{ sourceRecordId: source.sourceRecordId, quote: 'invented', occurrenceIndex: 0 }], durabilityHint: 0.8, importanceHint: 0.7 }] };
  await assert.rejects(adapter.extract(source), /fabricated/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(adapter.extract(source, abort.signal), { name: 'AbortError' });
  const missing = new ApiExtractionAdapter(adapter.config, { ...access, key: () => '' });
  await assert.rejects(missing.extract(source), /key/);
});

test('Gemini embedding request uses retrieval tasks and fixed authenticated endpoint', async () => {
  const calls: any[] = [];
  const access = { key: () => 'fixture-key', fetch: (async (url, init) => { calls.push({ url: String(url), ...init, body: JSON.parse(String(init?.body)) }); return response({ embeddings: [{ values: [3, 4] }] }); }) as typeof fetch };
  assert.deepEqual(await googleEmbeddings(access, 'models/gemini-embedding-001', ['hello'], 'query', new AbortController().signal), [[3, 4]]);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
  assert.equal(calls[0].body.requests[0].taskType, 'RETRIEVAL_QUERY');
  await googleEmbeddings(access, 'gemini-embedding-001', ['hello'], 'document', new AbortController().signal);
  assert.equal(calls[1].body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
});

test('API memory service works without Ollama and excludes local-only embedding backlog', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-api-memory-'));
  const service = new MemoryService(dir); clearInterval(service.timer);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  service.credentials.key = () => 'fixture-key';
  const original = globalThis.fetch, sent: any[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.ok(String(url).startsWith('https://generativelanguage.googleapis.com/'));
    const body = JSON.parse(String(init?.body)); sent.push(body);
    if (String(url).endsWith(':batchEmbedContents')) return response({ embeddings: body.requests.map(() => ({ values: [3, 4] })) });
    return response({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(empty) }] } }] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  await service.configure({ ...service.configuration, enabled: true, embedding_provider: 'google', embedding_model: 'gemini-embedding-001', extraction_provider: 'google', extraction_model: 'gemini-2.5-flash', allow_cloud_embedding: false });
  await assert.rejects(service.embed('http://127.0.0.1:1', ['secret'], 'query', new AbortController().signal), /Enable cloud/);
  assert.equal(sent.length, 0);
  await service.configure({ ...service.configuration, allow_cloud_embedding: true });
  assert.deepEqual(await service.embed('http://127.0.0.1:1', ['query'], 'query', new AbortController().signal), [[0.6, 0.8]]);
  const scope = await service.call('scope', { key: JSON.stringify([service.configuration.host, '/project']), label: 'Test' });
  for (const sensitivity of ['local_only', 'cloud_allowed']) await service.call('observe_text', { scope_id: scope.id, source_event_id: sensitivity, role: 'user', text: sensitivity, sensitivity });
  const backlog = await service.canonical.call('vector_backlog', { host: service.configuration.host, fingerprint: 'new', cloud: true });
  assert.ok(backlog.length > 0); assert.ok(backlog.every((a: any) => a.text !== 'local_only'));
  const pending = await service.canonical.call('pending_artifacts', { scope_id: scope.id, fingerprint: 'new', cloud: true });
  assert.ok(pending.length > 0); assert.ok(pending.every((a: any) => a.sensitivity === 'cloud_allowed'));
  await service.extraction(); await service.extraction();
  assert.ok(service.extractor instanceof ApiExtractionAdapter);
  assert.ok(sent.every(body => !JSON.stringify(body).includes('local_only')));
});
