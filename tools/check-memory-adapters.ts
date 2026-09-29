#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { Neo4jGraphRepository, GraphRevisionGapError } from '../broker/graph-memory/adapters/neo4j.ts';
import { artifactPointId, QdrantVectorRepository } from '../broker/graph-memory/adapters/qdrant.ts';
import type { GraphProjectionMutation, VectorArtifact, VectorArtifactMetadata, VectorQuery } from '../broker/graph-memory/adapters/contracts.ts';

interface CheckState {
  schemaVersion: 1;
  generation: number;
  revision: number;
  scopeId: string;
  ownerId: string;
  entityId: string;
  oldAssertionId: string;
  oldEvidenceId: string;
  oldSubjectEdgeId: string;
  oldEvidenceEdgeId: string;
  newAssertionId: string;
  newEvidenceId: string;
  newSubjectEdgeId: string;
  newEvidenceEdgeId: string;
  artifactId: string;
  fingerprint: string;
}

const phaseArgument = process.argv.indexOf('--phase');
const stateArgument = process.argv.indexOf('--state');
const phase = phaseArgument >= 0 ? process.argv[phaseArgument + 1] : '';
const statePath = stateArgument >= 0 ? process.argv[stateArgument + 1] : '';
if (!['prepare', 'verify'].includes(phase) || !statePath) {
  throw new Error('usage: node tools/check-memory-adapters.ts --phase {prepare|verify} --state PRIVATE_STATE_FILE');
}

const neo4jConfig = {
  uri: process.env.CERE_NEO4J_URI ?? `bolt://127.0.0.1:${process.env.NEO4J_BOLT_PORT ?? '7687'}`,
  username: process.env.CERE_NEO4J_USER ?? 'neo4j',
  password: process.env.CERE_NEO4J_PASSWORD ?? process.env.NEO4J_PASSWORD ?? '',
  database: process.env.CERE_NEO4J_DATABASE ?? 'neo4j',
};
const qdrantConfig = {
  endpoint: process.env.CERE_QDRANT_URL ?? `http://127.0.0.1:${process.env.QDRANT_HTTP_PORT ?? '6333'}`,
  apiKey: process.env.CERE_QDRANT_API_KEY ?? process.env.QDRANT_API_KEY ?? '',
  collectionPrefix: 'cere_adapter_check',
  dimension: 3,
  distance: 'Cosine' as const,
};
if (!neo4jConfig.password || !qdrantConfig.apiKey) throw new Error('Neo4j and Qdrant credentials are required');

function baseMutation(state: CheckState): GraphProjectionMutation {
  return {
    revision: state.revision,
    erasureEpoch: 1,
    generation: state.generation,
    nodes: [
      { id: state.entityId, kind: 'MemoryEntity', properties: { scope_id: state.scopeId, state_code: 'initial' } },
      { id: state.oldAssertionId, kind: 'MemoryAssertion', properties: { scope_id: state.scopeId, state_code: 'historical', valid_to_us: null } },
      { id: state.oldEvidenceId, kind: 'MemoryEvidence', properties: { scope_id: state.scopeId, witness_code: 'synthetic' } },
    ],
    edges: [
      { id: state.oldSubjectEdgeId, from: state.oldAssertionId, to: state.entityId, kind: 'ABOUT', properties: { scope_id: state.scopeId } },
      { id: state.oldEvidenceEdgeId, from: state.oldAssertionId, to: state.oldEvidenceId, kind: 'SUPPORTED_BY', properties: { scope_id: state.scopeId } },
    ],
    deletedIds: [],
  };
}

function metadata(state: CheckState, contentRevision: number, generation = state.generation, fingerprint = state.fingerprint): VectorArtifactMetadata {
  return {
    ownerId: state.ownerId,
    scopeId: state.scopeId,
    artifactKind: 'assertion',
    artifactId: state.artifactId,
    contentRevision,
    embeddingFingerprint: fingerprint,
    generation,
    sensitivity: 'private',
    validFromUs: null,
    validToUs: null,
    sourceGeneration: 1,
    erasureEpoch: 1,
    expiresAtUs: null,
  };
}

function artifact(meta: VectorArtifactMetadata, vector: readonly number[]): VectorArtifact {
  return { pointId: artifactPointId(meta), vector, metadata: meta };
}

function query(state: CheckState, generation = state.generation, fingerprint = state.fingerprint, vector: readonly number[] = [1, 0, 0]): VectorQuery {
  return {
    vector,
    ownerId: state.ownerId,
    scopeIds: [state.scopeId],
    artifactKinds: ['assertion'],
    embeddingFingerprint: fingerprint,
    generation,
    currentErasureEpoch: 1,
    nowUs: Date.now() * 1_000,
    limit: 20,
  };
}

async function writeState(state: CheckState) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

async function prepare() {
  const token = randomUUID();
  const state: CheckState = {
    schemaVersion: 1,
    generation: Date.now() * 1_000 + Math.floor(Math.random() * 1_000),
    revision: 37,
    scopeId: `scope:${token}`,
    ownerId: `owner:${randomUUID()}`,
    entityId: `entity:${randomUUID()}`,
    oldAssertionId: `assertion:${randomUUID()}`,
    oldEvidenceId: `evidence:${randomUUID()}`,
    oldSubjectEdgeId: `edge:${randomUUID()}`,
    oldEvidenceEdgeId: `edge:${randomUUID()}`,
    newAssertionId: `assertion:${randomUUID()}`,
    newEvidenceId: `evidence:${randomUUID()}`,
    newSubjectEdgeId: `edge:${randomUUID()}`,
    newEvidenceEdgeId: `edge:${randomUUID()}`,
    artifactId: `artifact:${randomUUID()}`,
    fingerprint: 'd'.repeat(64),
  };
  const graph = new Neo4jGraphRepository(neo4jConfig);
  const vectors = new QdrantVectorRepository(qdrantConfig);
  try {
    await Promise.all([graph.initialize(), vectors.initialize()]);
    const graphHealth = await graph.health();
    const vectorHealth = await vectors.health();
    assert.equal(graphHealth.ok, true);
    assert.equal(vectorHealth.ok, true);

    const mutation = baseMutation(state);
    assert.equal(await graph.apply(mutation), 'applied');
    assert.equal(await graph.apply(mutation), 'duplicate');
    const reconstructed = structuredClone(mutation);
    reconstructed.nodes[0].properties.state_code = 'newer_canonical_reconstruction';
    assert.equal(await graph.apply(reconstructed), 'duplicate');
    const expansion = await graph.expand({ seedIds: [state.entityId], generation: state.generation, scopeIds: [state.scopeId], depth: 2 });
    assert.equal(expansion.nodes.length, 3);
    assert.equal(expansion.nodes.find(node => node.id === state.entityId)?.properties.state_code, 'initial');

    const original = artifact(metadata(state, 1), [1, 0, 0]);
    await vectors.publish(original);
    await vectors.publish(original);
    const hits = await vectors.query(query(state));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].pointId, original.pointId);
    await writeState(state);
    process.stdout.write(`${JSON.stringify({
      phase: 'prepare',
      neo4jVersion: graphHealth.version,
      qdrantVersion: vectorHealth.version,
      arbitraryBaselineRevision: true,
      reconstructedReplayNoOp: true,
      graphNodes: expansion.nodes.length,
      vectorRetryCount: hits.length,
    })}\n`);
  } finally {
    await Promise.allSettled([graph.close(), vectors.close()]);
  }
}

async function deleteCollections(generations: Array<{ generation: number; fingerprint: string }>) {
  for (const item of generations) {
    const suffix = item.fingerprint.slice(0, 16).toLowerCase().replace(/[^a-f0-9]/gu, '');
    const name = `${qdrantConfig.collectionPrefix}_${item.generation}_${suffix}`;
    const response = await fetch(`${qdrantConfig.endpoint}/collections/${encodeURIComponent(name)}?timeout=30`, {
      method: 'DELETE',
      headers: { 'api-key': qdrantConfig.apiKey },
    });
    if (!response.ok && response.status !== 404) throw new Error(`Qdrant acceptance cleanup failed (${response.status})`);
  }
}

async function verify() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as CheckState;
  assert.equal(state.schemaVersion, 1);
  const graph = new Neo4jGraphRepository(neo4jConfig);
  const vectors = new QdrantVectorRepository(qdrantConfig);
  const nextGeneration = state.generation + 1;
  const nextFingerprint = 'e'.repeat(64);
  let graphRestartVerified = false;
  let vectorRestartVerified = false;
  try {
    await Promise.all([graph.initialize(), vectors.initialize()]);
    const graphHealth = await graph.health();
    const vectorHealth = await vectors.health();
    assert.equal(await graph.watermark(state.generation), state.revision);
    const afterRestart = await graph.expand({ seedIds: [state.entityId], generation: state.generation, scopeIds: [state.scopeId], depth: 2 });
    assert.equal(afterRestart.nodes.find(node => node.id === state.entityId)?.properties.state_code, 'initial');
    graphRestartVerified = true;
    const originalHits = await vectors.query(query(state));
    assert.equal(originalHits.length, 1);
    vectorRestartVerified = true;

    const correction: GraphProjectionMutation = {
      revision: state.revision + 1,
      erasureEpoch: 1,
      generation: state.generation,
      nodes: [
        { id: state.oldAssertionId, kind: 'MemoryAssertion', properties: { scope_id: state.scopeId, state_code: 'historical', valid_to_us: 2 } },
        { id: state.newAssertionId, kind: 'MemoryAssertion', properties: { scope_id: state.scopeId, state_code: 'current', valid_from_us: 2 } },
        { id: state.newEvidenceId, kind: 'MemoryEvidence', properties: { scope_id: state.scopeId, witness_code: 'synthetic' } },
      ],
      edges: [
        { id: state.newSubjectEdgeId, from: state.newAssertionId, to: state.entityId, kind: 'ABOUT', properties: { scope_id: state.scopeId } },
        { id: state.newEvidenceEdgeId, from: state.newAssertionId, to: state.newEvidenceId, kind: 'SUPPORTED_BY', properties: { scope_id: state.scopeId } },
      ],
      deletedIds: [],
    };
    assert.equal(await graph.apply(correction), 'applied');
    const historical = await graph.expand({ seedIds: [state.entityId], generation: state.generation, scopeIds: [state.scopeId], depth: 2 });
    assert.equal(historical.nodes.some(node => node.id === state.oldAssertionId), true);
    assert.equal(historical.nodes.some(node => node.id === state.newAssertionId), true);

    const erase: GraphProjectionMutation = {
      revision: state.revision + 2,
      erasureEpoch: 2,
      generation: state.generation,
      nodes: [], edges: [],
      deletedIds: [state.oldAssertionId, state.oldEvidenceId, state.oldSubjectEdgeId, state.oldEvidenceEdgeId],
    };
    assert.equal(await graph.apply(erase), 'applied');
    assert.equal(await graph.apply({ ...erase, nodes: [{ id: state.entityId, kind: 'MemoryEntity', properties: { scope_id: state.scopeId, state_code: 'changed_reconstruction' } }] }), 'duplicate');
    const erased = await graph.expand({ seedIds: [state.entityId], generation: state.generation, scopeIds: [state.scopeId], depth: 2 });
    assert.equal(erased.nodes.some(node => node.id === state.oldAssertionId || node.id === state.oldEvidenceId), false);
    assert.equal(erased.nodes.some(node => node.id === state.newAssertionId), true);

    const staged = baseMutation({ ...state, generation: nextGeneration, revision: state.revision + 100 });
    staged.nodes[0].properties.state_code = 'staged_generation';
    assert.equal(await graph.apply(staged), 'applied');
    const servingGeneration = await graph.expand({ seedIds: [state.entityId], generation: state.generation, scopeIds: [state.scopeId], depth: 2 });
    const stagedGeneration = await graph.expand({ seedIds: [state.entityId], generation: nextGeneration, scopeIds: [state.scopeId], depth: 2 });
    assert.equal(servingGeneration.nodes.find(node => node.id === state.entityId)?.properties.state_code, 'initial');
    assert.equal(stagedGeneration.nodes.find(node => node.id === state.entityId)?.properties.state_code, 'staged_generation');
    await assert.rejects(graph.apply({ ...staged, revision: staged.revision + 2 }), GraphRevisionGapError);

    const corrected = artifact(metadata(state, 2), [0.8, 0.2, 0]);
    await vectors.publish(corrected);
    assert.equal((await vectors.query(query(state))).length, 2);
    await vectors.retire([artifactPointId(metadata(state, 1))]);
    const currentHits = await vectors.query(query(state));
    assert.equal(currentHits.length, 1);
    assert.equal(currentHits[0].metadata.contentRevision, 2);
    const stagedVector = artifact(metadata(state, 2, nextGeneration, nextFingerprint), [0, 1, 0]);
    await vectors.publish(stagedVector);
    assert.equal((await vectors.query(query(state))).length, 1);
    assert.equal((await vectors.query(query(state, nextGeneration, nextFingerprint, [0, 1, 0]))).length, 1);
    await vectors.deleteByArtifact(state.artifactId);
    assert.equal((await vectors.query(query(state))).length, 0);
    assert.equal((await vectors.query(query(state, nextGeneration, nextFingerprint, [0, 1, 0]))).length, 0);

    process.stdout.write(`${JSON.stringify({
      phase: 'verify',
      neo4jVersion: graphHealth.version,
      qdrantVersion: vectorHealth.version,
      dependencyRestartPersistence: graphRestartVerified && vectorRestartVerified,
      correctionRetainedHistory: true,
      erasureRemovedHistory: true,
      generationIsolation: true,
      revisionGapRejected: true,
      vectorCorrectionAndRetirement: true,
      vectorCrossGenerationErasure: true,
    })}\n`);
  } finally {
    await Promise.allSettled([
      graph.driver.executeQuery(
        'MATCH (n:MemoryNode) WHERE n.generation IN $generations DETACH DELETE n',
        { generations: [state.generation, nextGeneration] },
        { database: neo4jConfig.database },
      ).then(async () => {
        await graph.driver.executeQuery(
          'MATCH (n) WHERE (n:MemoryProjectionGuard OR n:MemoryProjectionState) AND n.generation IN $generations DETACH DELETE n',
          { generations: [state.generation, nextGeneration] },
          { database: neo4jConfig.database },
        );
      }),
      deleteCollections([
        { generation: state.generation, fingerprint: state.fingerprint },
        { generation: nextGeneration, fingerprint: nextFingerprint },
      ]),
    ]);
    await Promise.allSettled([graph.close(), vectors.close()]);
    await rm(statePath, { force: true });
  }
}

if (phase === 'prepare') await prepare();
else await verify();
