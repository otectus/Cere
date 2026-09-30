import { createHash } from 'node:crypto';
import type {
  ArtifactKind, BackendHealth, VectorArtifact, VectorArtifactMetadata, VectorDistance, VectorHit, VectorQuery, VectorRepository,
} from './contracts.ts';

export interface QdrantVectorConfig {
  endpoint: string;
  apiKey: string;
  collectionPrefix?: string;
  dimension: number;
  distance: VectorDistance;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

function localEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Qdrant endpoint must use HTTP(S)');
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)) throw new TypeError('Qdrant must use a loopback endpoint');
  url.pathname = url.pathname.replace(/\/$/u, '');
  return url;
}

function safePrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(prefix)) throw new TypeError('Qdrant collection prefix must be a lowercase identifier');
  return prefix;
}

export function artifactPointId(metadata: Pick<VectorArtifactMetadata, 'artifactId' | 'contentRevision' | 'embeddingFingerprint' | 'generation'>): string {
  const bytes = createHash('sha1').update('cere-memory-vector-v1\0').update(JSON.stringify([
    metadata.artifactId, metadata.contentRevision, metadata.embeddingFingerprint, metadata.generation,
  ])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const METADATA_KEYS = new Set([
  'ownerId', 'scopeId', 'artifactKind', 'artifactId', 'contentRevision', 'embeddingFingerprint', 'generation', 'sensitivity',
  'validFromUs', 'validToUs', 'sourceGeneration', 'erasureEpoch', 'expiresAtUs',
]);
const ARTIFACT_KINDS = new Set<ArtifactKind>(['assertion', 'episode_summary', 'topic_summary', 'entity_description', 'conversation', 'saved', 'episode', 'topic']);

function validateMetadata(metadata: VectorArtifactMetadata) {
  for (const key of Object.keys(metadata)) if (!METADATA_KEYS.has(key)) throw new TypeError(`Unexpected vector payload field ${key}`);
  for (const key of ['ownerId', 'scopeId', 'artifactId', 'embeddingFingerprint', 'sensitivity'] as const) {
    if (!metadata[key] || metadata[key].length > 512) throw new TypeError(`${key} must be a nonempty bounded string`);
  }
  if (!ARTIFACT_KINDS.has(metadata.artifactKind)) throw new TypeError('Unsupported artifact kind');
  for (const key of ['contentRevision', 'generation', 'sourceGeneration', 'erasureEpoch'] as const) {
    if (!Number.isSafeInteger(metadata[key]) || metadata[key] < 0) throw new TypeError(`${key} must be a non-negative safe integer`);
  }
  for (const key of ['validFromUs', 'validToUs', 'expiresAtUs'] as const) {
    if (metadata[key] !== null && (!Number.isSafeInteger(metadata[key]) || metadata[key]! < 0)) throw new TypeError(`${key} must be null or a non-negative safe integer`);
  }
}

function payload(metadata: VectorArtifactMetadata): Record<string, unknown> {
  return {
    owner_id: metadata.ownerId, scope_id: metadata.scopeId, artifact_kind: metadata.artifactKind, artifact_id: metadata.artifactId,
    content_revision: metadata.contentRevision, embedding_fingerprint: metadata.embeddingFingerprint, generation: metadata.generation,
    sensitivity: metadata.sensitivity, valid_from_us: metadata.validFromUs, valid_to_us: metadata.validToUs,
    source_generation: metadata.sourceGeneration, erasure_epoch: metadata.erasureEpoch, expires_at_us: metadata.expiresAtUs,
  };
}

function metadata(value: Record<string, unknown>): VectorArtifactMetadata {
  const result: VectorArtifactMetadata = {
    ownerId: String(value.owner_id), scopeId: String(value.scope_id), artifactKind: String(value.artifact_kind) as ArtifactKind,
    artifactId: String(value.artifact_id), contentRevision: Number(value.content_revision), embeddingFingerprint: String(value.embedding_fingerprint),
    generation: Number(value.generation), sensitivity: String(value.sensitivity), validFromUs: value.valid_from_us === null ? null : Number(value.valid_from_us),
    validToUs: value.valid_to_us === null ? null : Number(value.valid_to_us), sourceGeneration: Number(value.source_generation),
    erasureEpoch: Number(value.erasure_epoch), expiresAtUs: value.expires_at_us === null ? null : Number(value.expires_at_us),
  };
  validateMetadata(result);
  return result;
}

export class QdrantVectorRepository implements VectorRepository {
  readonly config: QdrantVectorConfig;
  private endpoint: URL;
  private prefix: string;
  private fetchImpl: typeof globalThis.fetch;
  private prepared = new Set<string>();

  constructor(config: QdrantVectorConfig) {
    this.config = config;
    this.endpoint = localEndpoint(config.endpoint);
    if (!config.apiKey) throw new TypeError('Qdrant API key is required');
    if (!Number.isSafeInteger(config.dimension) || config.dimension <= 0) throw new TypeError('Qdrant vector dimension must be positive');
    this.prefix = safePrefix(config.collectionPrefix ?? 'cere_memory');
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  private collection(generation: number, fingerprint: string): string {
    return `${this.prefix}_${generation}_${fingerprint.slice(0, 16).toLowerCase().replace(/[^a-f0-9]/gu, '')}`;
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs ?? 5_000);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const url = new URL(this.endpoint);
    const relative = new URL(path, 'http://qdrant.local');
    url.pathname = `${this.endpoint.pathname.replace(/\/$/u, '')}${relative.pathname}`;
    url.search = relative.search;
    const response = await this.fetchImpl(url, {
      ...init, signal: combined,
      headers: { 'api-key': this.config.apiKey, 'content-type': 'application/json', ...init.headers },
    });
    const body = await response.text();
    let parsed: any = {};
    if (body) { try { parsed = JSON.parse(body); } catch { throw new Error(`Qdrant returned invalid JSON (${response.status})`); } }
    if (!response.ok) throw new Error(`Qdrant request failed (${response.status}): ${String(parsed.status?.error ?? parsed.status ?? response.statusText).slice(0, 300)}`);
    return parsed;
  }

  async initialize(signal?: AbortSignal): Promise<void> { const health = await this.health(signal); if (!health.ok) throw new Error(health.detail); }

  /** Setup honors the caller's deadline: every request carries it and no request starts after it expires. */
  private async ensureCollection(name: string, signal?: AbortSignal): Promise<void> {
    if (this.prepared.has(name)) return;
    signal?.throwIfAborted();
    let existing: any;
    try { existing = await this.request(`/collections/${encodeURIComponent(name)}`, {}, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!String(error).includes('(404)')) throw error;
      await this.request(`/collections/${encodeURIComponent(name)}`, {
        method: 'PUT', body: JSON.stringify({ vectors: { size: this.config.dimension, distance: this.config.distance }, on_disk_payload: true }),
      }, signal);
    }
    const vectors = existing?.result?.config?.params?.vectors;
    if (vectors && (Number(vectors.size) !== this.config.dimension || String(vectors.distance).toLowerCase() !== this.config.distance.toLowerCase())) {
      throw new Error(`Qdrant collection ${name} has an incompatible vector configuration`);
    }
    const indexes: Array<[string, string]> = [
      ['owner_id', 'keyword'], ['scope_id', 'keyword'], ['artifact_kind', 'keyword'], ['artifact_id', 'keyword'],
      ['embedding_fingerprint', 'keyword'], ['generation', 'integer'], ['erasure_epoch', 'integer'], ['expires_at_us', 'integer'],
    ];
    for (const [field_name, field_schema] of indexes) {
      signal?.throwIfAborted();
      try { await this.request(`/collections/${encodeURIComponent(name)}/index?wait=true`, { method: 'PUT', body: JSON.stringify({ field_name, field_schema }) }, signal); }
      catch (error) { signal?.throwIfAborted(); if (!String(error).toLowerCase().includes('already exists')) throw error; }
    }
    this.prepared.add(name);
  }

  async publish(artifact: VectorArtifact): Promise<void> {
    validateMetadata(artifact.metadata);
    if (artifact.pointId !== artifactPointId(artifact.metadata)) throw new TypeError('Vector point ID is not derived from the immutable artifact identity');
    if (artifact.vector.length !== this.config.dimension || artifact.vector.some(value => !Number.isFinite(value))) throw new TypeError('Vector has the wrong dimension or a non-finite component');
    const collection = this.collection(artifact.metadata.generation, artifact.metadata.embeddingFingerprint);
    await this.ensureCollection(collection);
    await this.request(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: 'PUT', body: JSON.stringify({ points: [{ id: artifact.pointId, vector: artifact.vector, payload: payload(artifact.metadata) }] }),
    });
  }

  async query(request: VectorQuery): Promise<VectorHit[]> {
    request.deadline?.throwIfAborted();
    if (request.vector.length !== this.config.dimension || request.vector.some(value => !Number.isFinite(value))) throw new TypeError('Query vector has the wrong dimension or a non-finite component');
    if (!request.scopeIds.length) return [];
    const collection = this.collection(request.generation, request.embeddingFingerprint);
    await this.ensureCollection(collection, request.deadline);
    const must: any[] = [
      { key: 'owner_id', match: { value: request.ownerId } }, { key: 'scope_id', match: { any: request.scopeIds } },
      { key: 'embedding_fingerprint', match: { value: request.embeddingFingerprint } }, { key: 'generation', match: { value: request.generation } },
      { key: 'erasure_epoch', range: { lte: request.currentErasureEpoch } },
    ];
    if (request.artifactKinds?.length) must.push({ key: 'artifact_kind', match: { any: request.artifactKinds } });
    const filter = { must, should: [
      { is_empty: { key: 'expires_at_us' } }, { key: 'expires_at_us', range: { gt: request.nowUs } },
    ], min_should: { conditions: [
      { is_empty: { key: 'expires_at_us' } }, { key: 'expires_at_us', range: { gt: request.nowUs } },
    ], min_count: 1 } };
    // Qdrant uses min_should; omit the redundant legacy should form.
    delete (filter as any).should;
    const response = await this.request(`/collections/${encodeURIComponent(collection)}/points/query`, {
      method: 'POST', body: JSON.stringify({ query: request.vector, filter, limit: Math.min(120, Math.max(1, request.limit ?? 40)), with_payload: true, with_vector: false }),
    }, request.deadline);
    const points = response.result?.points ?? response.result ?? [];
    return points.map((point: any) => ({ pointId: String(point.id), score: Number(point.score), metadata: metadata(point.payload) }));
  }

  async retire(pointIds: readonly string[]): Promise<void> {
    if (!pointIds.length) return;
    for (const name of await this.collections()) await this.request(`/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
      method: 'POST', body: JSON.stringify({ points: pointIds }),
    });
  }

  async deleteByArtifact(artifactId: string, maximumErasureEpoch?: number): Promise<void> {
    const must: any[] = [{ key: 'artifact_id', match: { value: artifactId } }];
    if (maximumErasureEpoch !== undefined) must.push({ key: 'erasure_epoch', range: { lte: maximumErasureEpoch } });
    for (const name of await this.collections()) await this.request(`/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
      method: 'POST', body: JSON.stringify({ filter: { must } }),
    });
  }

  private async collections(): Promise<string[]> {
    const response = await this.request('/collections');
    return (response.result?.collections ?? []).map((entry: any) => String(entry.name)).filter((name: string) => name.startsWith(`${this.prefix}_`));
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    try {
      const response = await this.request('/', {}, signal);
      return { ok: true, detail: 'connected', version: String(response.version ?? response.result?.version ?? '') || undefined };
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'connection failed' }; }
  }

  async close(): Promise<void> {}
}
