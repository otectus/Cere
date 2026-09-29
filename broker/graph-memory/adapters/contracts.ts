export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface GraphProjectionNode {
  id: string;
  kind: string;
  properties: Record<string, JsonValue>;
}

export interface GraphProjectionEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  properties: Record<string, JsonValue>;
}

/** Sanitized projection work. Source bodies and evidence quotations never belong here. */
export interface GraphProjectionMutation {
  revision: number;
  erasureEpoch: number;
  generation: number;
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
  deletedIds: string[];
}

export interface GraphExpansionRequest {
  seedIds: string[];
  generation: number;
  scopeIds: string[];
  kinds?: string[];
  depth?: number;
  nodeLimit?: number;
  edgeLimit?: number;
  deadline?: AbortSignal;
}

export interface GraphExpansion {
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
  truncated: boolean;
}

export interface BackendHealth {
  ok: boolean;
  detail: string;
  version?: string;
}

export interface GraphRepository {
  initialize(): Promise<void>;
  apply(mutation: GraphProjectionMutation): Promise<'applied' | 'duplicate'>;
  watermark(generation: number): Promise<number>;
  expand(request: GraphExpansionRequest): Promise<GraphExpansion>;
  health(): Promise<BackendHealth>;
  close(): Promise<void>;
}

export type ArtifactKind = 'assertion' | 'episode_summary' | 'topic_summary' | 'entity_description' | 'conversation' | 'saved' | 'episode' | 'topic';
export type VectorDistance = 'Cosine' | 'Dot' | 'Euclid' | 'Manhattan';

/** The payload is deliberately text-free; Cere hydrates text from canonical storage. */
export interface VectorArtifactMetadata {
  ownerId: string;
  scopeId: string;
  artifactKind: ArtifactKind;
  artifactId: string;
  contentRevision: number;
  embeddingFingerprint: string;
  generation: number;
  sensitivity: string;
  validFromUs: number | null;
  validToUs: number | null;
  sourceGeneration: number;
  erasureEpoch: number;
  expiresAtUs: number | null;
}

export interface VectorArtifact {
  pointId: string;
  vector: readonly number[];
  metadata: VectorArtifactMetadata;
}

export interface VectorQuery {
  vector: readonly number[];
  ownerId: string;
  scopeIds: string[];
  artifactKinds?: ArtifactKind[];
  embeddingFingerprint: string;
  generation: number;
  currentErasureEpoch: number;
  nowUs: number;
  limit?: number;
  deadline?: AbortSignal;
}

export interface VectorHit {
  pointId: string;
  score: number;
  metadata: VectorArtifactMetadata;
}

export interface VectorRepository {
  initialize(): Promise<void>;
  publish(artifact: VectorArtifact): Promise<void>;
  query(request: VectorQuery): Promise<VectorHit[]>;
  retire(pointIds: readonly string[]): Promise<void>;
  deleteByArtifact(artifactId: string, maximumErasureEpoch?: number): Promise<void>;
  health(): Promise<BackendHealth>;
  close(): Promise<void>;
}

export type ProposalPolarity = 'positive' | 'negative';
export type ProposalModality = 'actual' | 'planned' | 'hypothetical' | 'reported' | 'inferred';
export type ProposalEpistemicType = 'explicit_user' | 'instrumented' | 'document_claim' | 'inference' | 'derived_summary';

export interface ProposalQuote {
  sourceRecordId: string;
  quote: string;
  occurrenceIndex: number;
}

export interface MutationProposalBatch {
  entities: Array<{ temporaryRef: string; kind: string; aliases: string[] }>;
  assertions: Array<{
    subjectRef: string;
    predicate: string;
    object: { entityRef: string } | { literal: JsonValue };
    qualifiers: Record<string, JsonValue>;
    polarity: ProposalPolarity;
    modality: ProposalModality;
    epistemicType: ProposalEpistemicType;
    operation: 'asserts' | 'changes' | 'corrects' | 'reports';
    temporal: { expression: string | null; interpretation: string | null; uncertain: boolean };
    quotes: ProposalQuote[];
    durabilityHint: number;
    importanceHint: number;
  }>;
}

export interface ExtractionSource {
  sourceRecordId: string;
  sourceRevision: number;
  sourceRole: 'user' | 'assistant' | 'tool' | 'document';
  modelRoute: 'local_only' | 'cloud_allowed';
  text: string;
}

export interface ExtractionRun {
  proposals: MutationProposalBatch;
  model: string;
  modelDigest: string;
  endpointClass: 'local' | 'ollama_cloud';
  promptVersion: string;
  schemaVersion: number;
  parserVersion: string;
}

export interface ExtractionAdapter {
  probe(signal?: AbortSignal): Promise<{ model: string; digest: string; capabilities: string[] }>;
  extract(source: ExtractionSource, signal?: AbortSignal): Promise<ExtractionRun>;
}

export interface EmbeddingIdentity {
  provider: 'ollama';
  model: string;
  modelDigest: string;
  dimension: number;
  normalization: 'unit' | 'none';
  distance: VectorDistance;
  queryTemplate: string;
  documentTemplate: string;
  chunkingVersion: string;
  fingerprint: string;
}

export interface EmbeddingAdapter {
  identity(signal?: AbortSignal): Promise<EmbeddingIdentity>;
  embed(kind: 'query' | 'document', texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export type LiveFreshness = 'fresh' | 'stale' | 'unknown';
export interface LiveObservation<T extends Record<string, JsonValue> = Record<string, JsonValue>> {
  source: 'hyprland' | 'fish' | 'kitty' | 'editor' | 'filesystem' | 'repository';
  sourceEpoch: string;
  sourceSequence: number;
  entityId: string;
  entityGeneration: string;
  kind: string;
  observedAt: string;
  observedMonotonicMs: number;
  lastVerifiedAt: string;
  expiresAt: string;
  freshness: LiveFreshness;
  properties: T;
}

export interface LiveCollector {
  start(emit: (observation: LiveObservation) => void): Promise<void>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}
