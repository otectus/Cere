import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, rm, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jGraphRepository, GraphRevisionGapError } from '../broker/graph-memory/adapters/neo4j.ts';
import { artifactPointId, QdrantVectorRepository } from '../broker/graph-memory/adapters/qdrant.ts';
import { OllamaEmbeddingAdapter, OllamaExtractionAdapter } from '../broker/graph-memory/adapters/ollama.ts';
import { parseHyprlandEvent } from '../broker/graph-memory/adapters/hyprland.ts';
import { parseKittySnapshot } from '../broker/graph-memory/adapters/kitty.ts';
import { LiveObservationFactory, LiveWorkspaceState } from '../broker/graph-memory/adapters/live.ts';
import { inspectGitCheckout } from '../broker/graph-memory/adapters/workspace.ts';
import { pointId as servicePointId } from '../broker/graph-memory/client.ts';
import type { GraphProjectionMutation, VectorArtifactMetadata } from '../broker/graph-memory/adapters/contracts.ts';

const execFileAsync = promisify(execFile);

function record(values: Record<string, unknown>) { return { get(key: string) { return values[key]; } }; }

function graphFixture() {
  let watermark: number | undefined, digest = '';
  const queries: Array<{ query: string; parameters: any }> = [];
  const transaction = { async run(query: string, parameters: any = {}) {
    queries.push({ query, parameters });
    if (query.includes('RETURN s.watermark')) { watermark ??= Number(parameters.revision) - 1; return { records: [record({ watermark, digest })] }; }
    if (query.includes('RETURN count(edge)')) return { records: [record({ count: parameters.rows.length })] };
    if (query.includes('SET s.watermark')) { watermark = Number(parameters.revision); digest = parameters.digest; }
    return { records: [] };
  } };
  const session = { executeWrite(callback: any) { return callback(transaction); }, async close() {}, async run() {} };
  const driver = { session() { return session; }, async verifyConnectivity() {}, async close() {}, async getServerInfo() { return { agent: 'fixture' }; } };
  return { driver: driver as any, queries, get watermark() { return watermark ?? 0; } };
}

const graphMutation = (revision: number): GraphProjectionMutation => ({
  revision, erasureEpoch: 2, generation: 1,
  nodes: [{ id: 'project:one', kind: 'MemoryEntity', properties: { scope_id: 'scope:one', displayName: 'One' } }],
  edges: [], deletedIds: [],
});

test('Neo4j projection applies one ordered sanitized revision and safely ignores reconstructed replay payloads', async () => {
  const fixture = graphFixture(), repository = new Neo4jGraphRepository({ uri: 'bolt://127.0.0.1:7687', username: 'neo4j', password: 'secret' }, fixture.driver);
  assert.equal(await repository.apply(graphMutation(1)), 'applied');
  assert.equal(fixture.watermark, 1);
  assert.equal(await repository.apply(graphMutation(1)), 'duplicate');
  const duplicated = graphMutation(2); duplicated.nodes.push(structuredClone(duplicated.nodes[0]));
  assert.equal(await repository.apply(duplicated), 'applied');
  assert.equal(fixture.queries.findLast(entry => entry.query.includes('RETURN count(n)'))?.parameters.rows.length, 1);
  await assert.rejects(repository.apply(graphMutation(4)), GraphRevisionGapError);
  assert.equal(await repository.apply({ ...graphMutation(2), nodes: [{ id: 'changed', kind: 'PROJECT', properties: {} }] }), 'duplicate');
  await assert.rejects(repository.apply({ ...graphMutation(3), nodes: [{ id: 'unsafe', kind: 'DOCUMENT', properties: { source_text: 'private source' } }] }), /Raw source field/);
  assert.ok(fixture.queries.some(entry => entry.query.includes('MemoryProjectionGuard')));
  const rebuild = graphFixture(), rebuilt = new Neo4jGraphRepository({ uri: 'bolt://127.0.0.1:7687', username: 'neo4j', password: 'secret' }, rebuild.driver);
  assert.equal(await rebuilt.apply({ ...graphMutation(12), generation: 12 }), 'applied');
  assert.equal(rebuild.watermark, 12);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('Qdrant adapter creates filtered generations and publishes immutable text-free points', async () => {
  const requests: Array<{ url: URL; method: string; body: any }> = [], collections = new Set<string>();
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    const collectionMatch = url.pathname.match(/^\/collections\/([^/]+)$/u);
    if (url.pathname === '/') return jsonResponse({ version: '1.19.1' });
    if (url.pathname === '/collections') return jsonResponse({ result: { collections: [...collections].map(name => ({ name })) } });
    if (collectionMatch && method === 'GET') return collections.has(collectionMatch[1]) ? jsonResponse({ result: { config: { params: { vectors: { size: 3, distance: 'Cosine' } } } } }) : jsonResponse({ status: 'missing' }, 404);
    if (collectionMatch && method === 'PUT') { collections.add(collectionMatch[1]); return jsonResponse({ status: 'ok' }); }
    if (url.pathname.endsWith('/index')) return jsonResponse({ status: 'ok' });
    if (url.pathname.endsWith('/points') && method === 'PUT') return jsonResponse({ status: 'ok' });
    if (url.pathname.endsWith('/points/query')) return jsonResponse({ result: { points: [{ id: body.query[0] === 1 ? body.filter.must[0].match.value.padEnd(36, '0').slice(0, 36) : 'id', score: 0.9, payload: requests.find(entry => entry.url.pathname.endsWith('/points') && entry.method === 'PUT')!.body.points[0].payload }] } });
    return jsonResponse({ status: 'ok' });
  };
  const repository = new QdrantVectorRepository({ endpoint: 'http://127.0.0.1:6333', apiKey: 'secret', dimension: 3, distance: 'Cosine', fetch });
  const metadata: VectorArtifactMetadata = {
    ownerId: 'owner', scopeId: 'scope', artifactKind: 'assertion', artifactId: 'artifact', contentRevision: 4,
    embeddingFingerprint: 'a'.repeat(64), generation: 2, sensitivity: 'private', validFromUs: null, validToUs: null,
    sourceGeneration: 3, erasureEpoch: 5, expiresAtUs: null,
  };
  const pointId = artifactPointId(metadata);
  assert.equal(pointId, servicePointId(metadata.artifactId, metadata.contentRevision, metadata.embeddingFingerprint, metadata.generation));
  await repository.publish({ pointId, vector: [1, 0, 0], metadata });
  const publish = requests.find(entry => entry.url.pathname.endsWith('/points') && entry.method === 'PUT')!.body.points[0];
  assert.equal(publish.id, pointId); assert.equal(publish.payload.artifact_id, 'artifact');
  assert.ok(!JSON.stringify(publish.payload).includes('text')); assert.ok(!JSON.stringify(publish.payload).includes('source body'));
  const hits = await repository.query({ vector: [1, 0, 0], ownerId: 'owner', scopeIds: ['scope'], embeddingFingerprint: 'a'.repeat(64), generation: 2, currentErasureEpoch: 5, nowUs: 10 });
  assert.equal(hits.length, 1); assert.equal(hits[0].metadata.artifactId, 'artifact');
  const query = requests.find(entry => entry.url.pathname.endsWith('/points/query'))!.body;
  assert.ok(query.filter.must.some((condition: any) => condition.key === 'scope_id'));
  assert.ok(query.filter.must.some((condition: any) => condition.key === 'embedding_fingerprint'));
  await assert.rejects(repository.publish({ pointId: 'wrong', vector: [1, 0, 0], metadata }), /not derived/);
  await assert.rejects(repository.publish({ pointId, vector: [1, 0], metadata }), /dimension/);
});

test('Ollama cloud extraction requires both authorization gates, probes schema support, repairs once, and verifies exact quotes', async () => {
  const digest = 'a'.repeat(64), bodies: any[] = []; let extractionAttempts = 0;
  const valid = {
    entities: [{ temporaryRef: 'tool', kind: 'TOOL', aliases: ['Ruff'] }],
    assertions: [{ subjectRef: 'user', predicate: 'PREFERS_TOOL', object: { entityRef: 'tool' }, qualifiers: {}, polarity: 'positive', modality: 'actual', epistemicType: 'explicit_user', operation: 'asserts', temporal: { expression: null, interpretation: null, uncertain: false }, quotes: [{ sourceRecordId: 'source:1', quote: 'Use Ruff.', occurrenceIndex: 0 }], durabilityHint: 0.8, importanceHint: 0.7 }],
  };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined; if (body) bodies.push(body);
    if (path === '/api/tags') return jsonResponse({ models: [{ model: 'gpt-oss:20b-cloud', digest, remote_host: 'https://ollama.com' }] });
    if (path === '/api/show') return jsonResponse({ capabilities: ['completion', 'tools'] });
    if (path === '/api/chat' && body.messages[1].content.startsWith('Capability fixture:')) return jsonResponse({ message: { content: '{"entities":[],"assertions":[]}' } });
    if (path === '/api/chat') { extractionAttempts++; return jsonResponse({ message: { content: extractionAttempts === 1 ? '{"entities":[]}' : JSON.stringify(valid) } }); }
    throw new Error(`unexpected ${path}`);
  };
  const denied = new OllamaExtractionAdapter({ endpoint: 'http://localhost:11434', model: 'gpt-oss:20b-cloud', allowCloud: false, fetch });
  await assert.rejects(denied.probe(), /explicit allowCloud/);
  const adapter = new OllamaExtractionAdapter({ endpoint: 'http://localhost:11434', model: 'gpt-oss:20b-cloud', allowCloud: true, expectedDigest: digest, fetch });
  await adapter.probe();
  await assert.rejects(adapter.extract({ sourceRecordId: 'source:1', sourceRevision: 1, sourceRole: 'user', modelRoute: 'local_only', text: 'Use Ruff.' }), /Local-only/);
  const result = await adapter.extract({ sourceRecordId: 'source:1', sourceRevision: 1, sourceRole: 'user', modelRoute: 'cloud_allowed', text: 'Use Ruff.' });
  assert.equal(result.endpointClass, 'ollama_cloud'); assert.equal(result.modelDigest, digest); assert.equal(extractionAttempts, 2);
  assert.equal(result.proposals.assertions[0].quotes[0].quote, 'Use Ruff.');
  assert.ok(bodies.some(body => body.format?.additionalProperties === false));
});

test('Ollama embedding identity fingerprints templates and always disables truncation', async () => {
  const digest = 'b'.repeat(64), requests: any[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (body) requests.push(body);
    if (path === '/api/tags') return jsonResponse({ models: [{ model: 'nomic-embed-text', digest }] });
    if (path === '/api/show') return jsonResponse({ capabilities: ['embedding'] });
    if (path === '/api/embed') return jsonResponse({ embeddings: body.input.map(() => [0.1, 0.2, 0.3]) });
    throw new Error(`unexpected ${path}`);
  };
  const adapter = new OllamaEmbeddingAdapter({ endpoint: 'http://localhost:11434', model: 'nomic-embed-text', expectedDigest: digest, dimension: 3, normalization: 'unit', distance: 'Cosine', queryTemplate: 'search_query: {text}', documentTemplate: 'search_document: {text}', chunkingVersion: 'v1', fetch });
  const identity = await adapter.identity();
  assert.equal(identity.fingerprint.length, 64);
  assert.deepEqual(await adapter.embed('query', ['hello']), [[0.1, 0.2, 0.3]]);
  assert.ok(requests.filter(body => body.input).every(body => body.truncate === false));
  assert.equal(requests.at(-1).input[0], 'search_query: hello');
});

test('desktop parsers preserve delimiter-heavy titles while immediately discarding Kitty secrets', () => {
  assert.deepEqual(parseHyprlandEvent('openwindow>>abc,2,kitty,title, with, commas'), { type: 'open', address: 'abc', workspace: '2', appClass: 'kitty', title: 'title, with, commas' });
  assert.deepEqual(parseHyprlandEvent('activewindowv2>>'), { type: 'focus', address: null });
  const panes = parseKittySnapshot([{ id: 1, is_focused: true, tabs: [{ id: 2, is_active: true, title: 'secret tab', windows: [{ id: 3, is_focused: true, cwd: '/work/a,b\nユ', title: 'secret', cmdline: ['secret'], env: { TOKEN: 'secret' } }] }] }]);
  assert.deepEqual(panes, [{ osWindowId: '1', tabId: '2', paneId: '3', osWindowFocused: true, tabActive: true, paneFocused: true, cwd: '/work/a,b\nユ' }]);
  assert.ok(!JSON.stringify(panes).includes('TOKEN')); assert.ok(!JSON.stringify(panes).includes('secret'));
});

test('live workspace rejects out-of-order observations and expires current state by monotonic time', () => {
  let mono = 100;
  const clock = { wallNow: () => new Date('2026-09-29T19:00:00Z'), monotonicNowMs: () => mono };
  const factory = new LiveObservationFactory('fish', 10_000, clock, 'epoch');
  const state = new LiveWorkspaceState(() => mono);
  const first = factory.observation('shell:1', 'generation', 'CWD', { cwd: '/tmp' });
  assert.equal(state.apply(first), true); assert.equal(state.apply(first), false);
  mono = 10_101;
  assert.equal(state.snapshot().observations[0].freshness, 'stale');
});

test('repository inspection assigns an opaque stable runtime UUID to verified checkout metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-checkout-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet', directory]);
  const first = await inspectGitCheckout(directory), second = await inspectGitCheckout(directory);
  assert.match(first.checkoutId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.equal(first.checkoutId, second.checkoutId); assert.equal(first.checkoutRoot, await realpath(directory));
  assert.ok(!first.checkoutId.includes(directory));
});

test('Fish emitter serializes hostile paths without commands and fails quietly when the daemon is absent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-emitter-')), socketPath = join(directory, 'memory.sock');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let received = '';
  const server = createServer(socket => socket.on('data', chunk => { received += chunk; }));
  await new Promise<void>(resolveListen => server.listen(socketPath, resolveListen));
  t.after(() => new Promise<void>(resolveClose => server.close(() => resolveClose())));
  const emitter = resolve('broker/graph-memory/adapters/fish/cere-memory-emitter.py');
  const cwd = '/tmp/a, "quote"\nユニコード';
  const child = spawn(emitter, ['--event', 'posterror', '--session-id', '00000000-0000-4000-8000-000000000001', '--sequence', '2', '--cwd', cwd, '--status', '17', '--pipeline-status', '0', '--pipeline-status', '17', '--socket', socketPath]);
  assert.equal((await once(child, 'close'))[0], 0);
  await new Promise(resolveWait => setTimeout(resolveWait, 10));
  const message = JSON.parse(received.trim());
  assert.equal(message.params.cwd, cwd); assert.deepEqual(message.params.pipeline_status, [0, 17]); assert.equal(message.params.command, undefined);
  const absent = spawn(emitter, ['--event', 'cwd', '--session-id', '00000000-0000-4000-8000-000000000001', '--sequence', '3', '--cwd', cwd, '--socket', join(directory, 'absent.sock')]);
  assert.equal((await once(absent, 'close'))[0], 0);
});

test('dependency profile pins registry digests, authentication, persistence, health, and loopback publication', async () => {
  const compose = await readFile('packaging/memory-compose.yml', 'utf8');
  assert.match(compose, /neo4j:5\.26\.31-community@sha256:[a-f0-9]{64}/u);
  assert.match(compose, /qdrant\/qdrant:v1\.19\.1@sha256:[a-f0-9]{64}/u);
  assert.match(compose, /127\.0\.0\.1:\$\{NEO4J_BOLT_PORT/u); assert.match(compose, /127\.0\.0\.1:\$\{QDRANT_HTTP_PORT/u);
  assert.match(compose, /NEO4J_AUTH/u); assert.match(compose, /QDRANT__SERVICE__API_KEY/u); assert.match(compose, /healthcheck:/u);
  assert.match(compose, /neo4j-data:\/data/u); assert.match(compose, /qdrant-data:\/qdrant\/storage/u);
});

test('extraction resolves registered cloud aliases and preserves explicit model IDs and policy gates', async () => {
  for (const [selected, registered] of [['glm-5.3-flash', 'glm-5.3-flash:cloud'], ['gpt-oss:20b', 'gpt-oss:20b-cloud'], ['custom-extractor', 'custom-extractor']]) {
    const requests: any[] = [];
    const fetch: typeof globalThis.fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (body) requests.push({ path, ...body });
      if (path === '/api/tags') return jsonResponse({ models: [{ model: registered, digest: 'a'.repeat(64), remote_host: 'https://ollama.com' }] });
      assert.equal(body.model, registered);
      if (path === '/api/show') return jsonResponse({ capabilities: ['completion'] });
      if (path === '/api/chat') return jsonResponse({ message: { content: '{"entities":[],"assertions":[]}' } });
      throw new Error(`Unexpected ${path}`);
    };
    const denied = new OllamaExtractionAdapter({ endpoint: 'http://localhost:11434', model: selected, allowCloud: false, fetch });
    await assert.rejects(denied.probe(), /explicit allowCloud/);
    assert.equal(requests.filter(r => r.path === '/api/chat').length, 0);
    const adapter = new OllamaExtractionAdapter({ endpoint: 'http://localhost:11434', model: selected, allowCloud: true, fetch });
    const result = await adapter.extract({ sourceRecordId: 'source', sourceRevision: 1, sourceRole: 'user', modelRoute: 'cloud_allowed', text: 'Use Ruff.' });
    assert.equal(result.model, registered);
    assert.equal(result.endpointClass, 'ollama_cloud');
    assert.equal(requests.filter(r => r.path === '/api/chat').length, 2);
  }
});
