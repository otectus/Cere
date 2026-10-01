import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from '../broker/graph-memory/service.ts';
import { Neo4jGraphRepository } from '../broker/graph-memory/adapters/neo4j.ts';
import { QdrantVectorRepository } from '../broker/graph-memory/adapters/qdrant.ts';

function artifact(id: string, host?: string) {
  return {
    id,
    text: `text for ${id}`,
    scope_id: 'scope',
    kind: 'saved',
    content_revision: 1,
    source_generation: 1,
    erasure_epoch: 2,
    sensitivity: 'private',
    expires_us: null,
    ...(host ? { embedding_host: host } : {}),
  };
}

test('vector projection batches embeddings by host and keeps pre/post publication eligibility fences', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const published: any[] = [];
  const identityHosts: string[] = [];
  const embedBatches: Array<{ host: string; texts: string[] }> = [];
  const service = Object.assign(Object.create(MemoryService.prototype) as MemoryService, {
    configuration: { host: 'http://default', embedding_model: 'embed' },
    controller: new AbortController(),
    vectors: new Map(),
    canonical: {
      call: async (method: string, params: any = {}) => {
        calls.push({ method, params });
        if (method === 'claim_job') return { id: 'job' };
        if (method === 'projection_data') return {
          artifacts: [artifact('a'), artifact('b'), artifact('c', 'http://other')],
          deletedIds: [], generation: '3', erasureEpoch: 2, owner_id: 'owner',
        };
        return true;
      },
    },
    identity: async (host: string) => {
      identityHosts.push(host);
      return { key: `identity:${host}`, digest: 'digest' };
    },
    embed: async (host: string, texts: string[]) => {
      embedBatches.push({ host, texts });
      return texts.map((_, index) => [1, index + 1, 1]);
    },
    vectorRepo: async () => ({
      publish: async (value: any) => { published.push(value); },
      retire: async () => {},
    }),
  });

  await service.project('vector');

  assert.deepEqual(identityHosts, ['http://default', 'http://other']);
  assert.deepEqual(embedBatches.map(batch => [batch.host, batch.texts.length]), [
    ['http://default', 2], ['http://other', 1],
  ]);
  assert.equal(published.length, 3);
  assert.equal(calls.filter(call => call.method === 'embedding_save').length, 6);
  assert.deepEqual(calls.at(-1), { method: 'finish_job', params: { id: 'job' } });
});

test('graph projection reuses one initialized repository for apply and cross-generation erasure', async () => {
  let acquisitions = 0, applies = 0, erasures = 0;
  const graph = {
    apply: async () => { applies++; },
    eraseAllGenerations: async (ids: string[], epoch: number) => {
      erasures++;
      assert.deepEqual([ids, epoch], [['gone'], 4]);
    },
  };
  const service = Object.assign(Object.create(MemoryService.prototype) as MemoryService, {
    canonical: { call: async (method: string) => {
      if (method === 'claim_job') return { id: 'job' };
      if (method === 'projection_data') return {
        artifacts: [], owner_id: 'owner', nodes: [], edges: [], deletedIds: ['gone'],
        revision: 1, generation: '1', erasureEpoch: 4,
      };
      return true;
    } },
    graphRepo: async () => { acquisitions++; return graph; },
  });

  await service.project('graph');
  assert.deepEqual({ acquisitions, applies, erasures }, { acquisitions: 1, applies: 1, erasures: 1 });
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

test('Qdrant erasure lists collections once and deletes deduplicated artifact chunks', async () => {
  const requests: Array<{ path: string; body?: any }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/collections') return response({ result: { collections: [
      { name: 'cere_memory_1_aaaaaaaaaaaaaaaa' },
      { name: 'cere_memory_2_aaaaaaaaaaaaaaaa' },
      { name: 'another_owner_1_aaaaaaaaaaaaaaaa' },
    ] } });
    return response({ status: 'ok' });
  };
  const repository = new QdrantVectorRepository({
    endpoint: 'http://127.0.0.1:6333', apiKey: 'secret', dimension: 3, distance: 'Cosine', fetch,
  });
  const ids = Array.from({ length: 300 }, (_, index) => `artifact-${index}`);
  await repository.deleteByArtifacts([...ids, ids[0]], 7);

  assert.equal(requests.filter(request => request.path === '/collections').length, 1);
  const deletes = requests.filter(request => request.path.endsWith('/points/delete'));
  assert.equal(deletes.length, 4, 'two chunks are applied to two matching collections');
  assert.deepEqual(deletes.map(request => request.body.filter.must[0].match.any.length), [256, 256, 44, 44]);
  assert.ok(deletes.every(request => request.body.filter.must[1].range.lte === 7));
});

test('Neo4j expansion addresses seed nodes through the unique generation key', async () => {
  const queries: string[] = [];
  const driver = {
    executeQuery: async (query: string) => { queries.push(query); return { records: [] }; },
    close: async () => {},
  };
  const repository = new Neo4jGraphRepository(
    { uri: 'bolt://127.0.0.1:7687', username: 'neo4j', password: 'secret' },
    driver as any,
  );
  await repository.expand({ seedIds: ['entity'], scopeIds: ['scope'], generation: 2, depth: 1 });
  assert.match(queries[0], /MemoryNode \{key:toString\(\$generation\) \+ ':' \+ seedId,deleted:false\}/u);
});
