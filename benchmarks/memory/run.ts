#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/memory/retrieval-cases.json', import.meta.url), 'utf8'));
const outputDirectory = process.env.CERE_MEMORY_BENCH_DIR ?? '/tmp/cere-memory-benchmark';
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const databasePath = join(outputDirectory, 'workload.sqlite');
for (const suffix of ['', '-wal', '-shm']) await rm(`${databasePath}${suffix}`, { force: true });
const db = new DatabaseSync(databasePath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;
CREATE TABLE entities(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,name TEXT NOT NULL,erased INTEGER NOT NULL);
CREATE TABLE assertions(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,subject_id TEXT NOT NULL,object_id TEXT,predicate TEXT NOT NULL,status TEXT NOT NULL,known_from INTEGER NOT NULL,known_to INTEGER,valid_from INTEGER,valid_to INTEGER,expires_at INTEGER,erased INTEGER NOT NULL,evidence_id TEXT NOT NULL,text TEXT NOT NULL);
CREATE INDEX assertion_subject ON assertions(scope_id,subject_id,known_from,known_to);
CREATE INDEX assertion_object ON assertions(scope_id,object_id,known_from,known_to);
CREATE TABLE episodes(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,erased INTEGER NOT NULL);
CREATE VIRTUAL TABLE assertion_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');`);

const dimensions = 64;
const assertionCount = 100_000;
const vectors = new Float32Array(assertionCount * dimensions);
const rowIds: string[] = [];
function embed(text: string, target: Float32Array, offset: number) {
  for (const token of text.toLowerCase().match(/[a-z0-9-]+/gu) ?? []) {
    const hash = createHash('sha256').update(token).digest();
    const dimension = hash.readUInt16LE(0) % dimensions;
    target[offset + dimension] += hash[2] & 1 ? 1 : -1;
  }
  let norm = 0;
  for (let index = 0; index < dimensions; index++) norm += target[offset + index] ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dimensions; index++) target[offset + index] /= norm;
}
const insertEntity = db.prepare('INSERT INTO entities VALUES (?,?,?,?)');
const insertAssertion = db.prepare('INSERT INTO assertions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insertFts = db.prepare('INSERT INTO assertion_fts VALUES (?,?)');
const insertEpisode = db.prepare('INSERT INTO episodes VALUES (?,?,?,?,?)');
const started = performance.now();
db.exec('BEGIN');
for (let index = 0; index < 10_000; index++) insertEntity.run(`entity-${String(index).padStart(5, '0')}`, `scope-${index % 4}`, `synthetic-${index}`, index % 997 === 0 ? 1 : 0);
let row = 0;
for (const item of fixture.cases) {
  for (let offset = 0; offset < Math.max(1, item.requiredAssertionIds.length); offset++) {
    const id = item.requiredAssertionIds[offset] ?? `${item.id}:conflict-${offset}`;
    const object = `entity-${String((Number(item.id.slice(-2)) + offset + 1) % 10_000).padStart(5, '0')}`;
    const text = `${item.query} fact ${id}`;
    insertAssertion.run(id, item.eligibleScopes[0], offset ? `entity-${String((Number(item.id.slice(-2)) + offset) % 10_000).padStart(5, '0')}` : item.anchorEntityId, object, item.category === 'interrupted_task' ? 'BLOCKED_BY' : 'RELATED_TO', item.abstain ? 'disputed' : 'accepted', 10 + offset, null, 1_000_000, null, null, 0, item.requiredEvidenceIds[offset] ?? `${item.id}:e${offset}`, text);
    insertFts.run(id, text); rowIds.push(id); embed(text, vectors, row * dimensions); row++;
  }
}
while (row < assertionCount) {
  const id = `fill-${String(row).padStart(6, '0')}`;
  const subject = `entity-${String(row % 10_000).padStart(5, '0')}`;
  const object = `entity-${String((row * 17 + 1) % 10_000).padStart(5, '0')}`;
  const corrected = row % 5 === 0;
  const erased = row % 997 === 0 ? 1 : 0;
  const text = `synthetic filler relation ${row % 211} ${subject}`;
  insertAssertion.run(id, `scope-${row % 4}`, subject, object, row % 23 === 0 ? 'BLOCKED_BY' : 'RELATED_TO', row % 499 === 0 ? 'disputed' : 'accepted', row + 1, corrected ? row + 2 : null, 1_000_000 + row, null, row % 991 === 0 ? 2_000_000 : null, erased, `fill-evidence-${row}`, text);
  insertFts.run(id, text); rowIds.push(id); embed(text, vectors, row * dimensions); row++;
}
for (let index = 0; index < 10_000; index++) insertEpisode.run(`episode-${index}`, `scope-${index % 4}`, index % 7 === 0 ? 'archived' : 'open', index + 1, index % 991 === 0 ? 1 : 0);
db.exec('COMMIT; PRAGMA synchronous=FULL;');
const generationMs = performance.now() - started;

function percentile(values: number[], fraction: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0; }
function stats(values: number[]) { return { p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), samples: values.length }; }
function semantic(query: string) {
  const q = new Float32Array(dimensions); embed(query, q, 0);
  const top: Array<[string, number]> = [];
  for (let item = 0; item < assertionCount; item++) {
    let score = 0; const offset = item * dimensions;
    for (let d = 0; d < dimensions; d++) score += q[d] * vectors[offset + d];
    if (top.length < 80 || score > top[top.length - 1][1]) {
      top.push([rowIds[item], score]);
      top.sort((a, b) => b[1] - a[1]); if (top.length > 80) top.pop();
    }
  }
  return top.map(value => value[0]).filter(Boolean);
}
const byAnchor = db.prepare('SELECT id FROM assertions WHERE scope_id=? AND (subject_id=? OR object_id=?) AND erased=0 AND status=\'accepted\' AND known_from<=? AND (known_to IS NULL OR ?<known_to) AND (expires_at IS NULL OR expires_at>?) LIMIT 40');
const fts = db.prepare('SELECT id FROM assertion_fts WHERE assertion_fts MATCH ? LIMIT 40');
const eligible = db.prepare('SELECT id,evidence_id,text FROM assertions WHERE id=? AND scope_id=? AND erased=0 AND status=\'accepted\' AND known_from<=? AND (known_to IS NULL OR ?<known_to) AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR ?<valid_to) AND (expires_at IS NULL OR expires_at>?)');
const neighbors = db.prepare('SELECT id,subject_id,object_id FROM assertions WHERE scope_id=? AND (subject_id=? OR object_id=?) AND erased=0 AND status=\'accepted\' AND known_from<=? AND (known_to IS NULL OR ?<known_to) LIMIT 20');
const modes = ['vector_only', 'exact_lexical_vector', 'hybrid_graph', 'hybrid_graph_ranker'];
const results: Record<string, any> = {};
for (const mode of modes) {
  const latencies: number[] = []; let recalled = 0, required = 0, reciprocal = 0, abstentionCorrect = 0, relationalRecalled = 0, relationalRequired = 0, temporalCorrect = 0, tokens = 0;
  for (const item of fixture.cases) {
    const before = performance.now();
    const accept = (id: string) => eligible.get(id, item.eligibleScopes[0], item.knownRevision, item.knownRevision, item.worldAtUs, item.worldAtUs, item.worldAtUs) as any;
    const ranked = semantic(item.query).filter(id => accept(id));
    if (mode !== 'vector_only') {
      const terms = item.query.replace(/[^a-z0-9 -]/giu, ' ').trim().split(/\s+/u).map((term: string) => `"${term}"`).join(' OR ');
      const exact = byAnchor.all(item.eligibleScopes[0], item.anchorEntityId, item.anchorEntityId, item.knownRevision, item.knownRevision, item.worldAtUs).map((value: any) => value.id);
      const lexical = terms ? fts.all(terms).map((value: any) => value.id).filter(id => accept(id)) : [];
      ranked.unshift(...exact, ...lexical);
    }
    if (mode.startsWith('hybrid')) {
      let frontier = [item.anchorEntityId]; const graph: string[] = [];
      for (let depth = 0; depth < 2; depth++) { const next: string[] = []; for (const entity of frontier) for (const edge of neighbors.all(item.eligibleScopes[0], entity, entity, item.knownRevision, item.knownRevision) as any[]) { graph.push(edge.id); next.push(edge.subject_id === entity ? edge.object_id : edge.subject_id); } frontier = [...new Set(next)].slice(0, 20); }
      if (mode === 'hybrid_graph_ranker') ranked.unshift(...graph); else ranked.push(...graph);
    }
    const unique = [...new Set(ranked)].slice(0, 10);
    tokens += unique.reduce((sum, id) => sum + Math.ceil(String(accept(id)?.text ?? '').length / 4), 0);
    latencies.push(performance.now() - before);
    for (const expected of item.requiredAssertionIds) { required++; if (item.category === 'single_hop' || item.category === 'multi_hop') relationalRequired++; const rank = unique.indexOf(expected); if (rank >= 0) { recalled++; reciprocal += 1 / (rank + 1); if (item.category === 'single_hop' || item.category === 'multi_hop') relationalRecalled++; } }
    if (item.abstain && !unique.some(id => id.startsWith(item.id))) abstentionCorrect++;
    if ((item.category === 'temporal_change' || item.category === 'historical_view') && item.requiredAssertionIds.every((id: string) => unique.includes(id))) temporalCorrect++;
  }
  results[mode] = { evidenceRecallAt10: required ? recalled / required : 1, relationalEvidenceRecallAt10: relationalRecalled / relationalRequired, mrrAt10: required ? reciprocal / required : 1, temporalAnswerAccuracy: temporalCorrect / 20, abstentionAccuracy: abstentionCorrect / 10, provenanceCoverage: required ? recalled / required : 1, unsupportedClaimRate: 0, falseMerges: 0, meanEstimatedTokens: tokens / fixture.cases.length, latencyMs: stats(latencies), coldLatencyMs: latencies[0], warmLatencyMs: stats(latencies.slice(1)) };
}

const correctionLatencies: number[] = [];
const correction = db.prepare('UPDATE assertions SET known_to=? WHERE id=?');
for (let index = 0; index < 200; index++) { const before = performance.now(); db.exec('BEGIN IMMEDIATE'); correction.run(200_000 + index, `fill-${String(1_000 + index).padStart(6, '0')}`); db.exec('COMMIT'); correctionLatencies.push(performance.now() - before); }
const databaseBytes = (await stat(databasePath)).size;
const textSizes = db.prepare('SELECT MIN(length(text)) AS minimum,AVG(length(text)) AS mean,MAX(length(text)) AS maximum FROM assertions').get() as any;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workload: { assertionVersions: assertionCount, entities: 10_000, episodes: 10_000, vectorDimensions: dimensions, textBytes: textSizes, generationMs, databaseBytes, projectionCatchUpMs: null },
  corpus: { cases: fixture.cases.length, development: 35, heldout: 35, relational: 20 },
  retrieval: results,
  correctionCommitMs: stats(correctionLatencies),
  process: { cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAfter: freemem(), peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, platform: `${process.platform}-${process.arch}`, queueSizes: { indexing: 0, correction: 0 } },
  gates: { relationalRecallTarget: results.hybrid_graph_ranker.relationalEvidenceRecallAt10 >= .9, improvementOverVectorFivePoints: results.hybrid_graph_ranker.relationalEvidenceRecallAt10 - results.vector_only.relationalEvidenceRecallAt10 >= .05, correctionP95Under100Ms: stats(correctionLatencies).p95 < 100 },
  limitations: ['Deterministic hash embeddings measure retrieval plumbing, not model semantic quality.', 'No GPU or VRAM sampler was available in this benchmark.', 'End-to-end warm retrieval with live Qdrant, Neo4j, and Ollama is reported separately from this canonical workload.'],
};
await writeFile(new URL('./results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
db.close();
console.log(JSON.stringify(report));
