#!/usr/bin/env node
// Disposable 100k-row SQL microbenchmark. It measures retrieval plumbing with hash
// vectors; it is not the canonical memory engine (see canonical-run.ts for that).
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { rrf, relationalRank } from '../../broker/graph-memory/ranking.ts';

type Case = Record<string, any>;
type Row = { id: string; fact_id: string; evidence_id: string; subject_id: string; object_id: string | null; text: string };
type View = { name: string; worldAtUs: number; knownRevision: number; requiredAssertionIds: string[]; requiredEvidenceIds: string[] };
const dimensions = 64;
export const modes = ['vector_only', 'exact_lexical_vector_rrf', 'hybrid_graph_rrf', 'hybrid_graph_relational_ranker'] as const;

function embed(text: string, target: Float32Array, offset: number) {
  for (const token of text.toLowerCase().match(/[a-z0-9-]+/gu) ?? []) {
    const hash = createHash('sha256').update(token).digest();
    target[offset + hash.readUInt16LE(0) % dimensions] += hash[2] & 1 ? 1 : -1;
  }
  let norm = 0;
  for (let index = 0; index < dimensions; index++) norm += target[offset + index] ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dimensions; index++) target[offset + index] /= norm;
}
function percentile(values: number[], fraction: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0; }
function stats(values: number[]) { return { p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), samples: values.length }; }
const gate = (target: string, value: number | null, passed: boolean | null) => ({ target, value, status: passed === null ? 'unmeasured' : passed ? 'passed' : 'failed' });

/**
 * Builds the workload from the corpus timelines: temporal corrections with closed
 * knowledge intervals, planted ineligible "forbidden" rows of several kinds (future-bound,
 * expired, erased, out-of-scope, not-yet-known, disputed), deleted copies, other-scope
 * copies and repeated sources. Every route and the final top 10 then pass through one
 * complete eligibility predicate. `eligibility: false` is a negative control that must
 * be caught by the unsupported-claim metric.
 */
export async function runMicrobenchmark(options: { assertionCount?: number; directory?: string; eligibility?: boolean; cases?: Case[]; trace?: boolean } = {}) {
  const assertionCount = options.assertionCount ?? 100_000, eligibility = options.eligibility ?? true;
  const fixture = options.cases ? { cases: options.cases } : JSON.parse(await readFile(new URL('../../tests/fixtures/memory/retrieval-cases.json', import.meta.url), 'utf8'));
  const outputDirectory = options.directory ?? process.env.CERE_MEMORY_BENCH_DIR ?? '/tmp/cere-memory-benchmark';
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const databasePath = join(outputDirectory, 'workload.sqlite');
  for (const suffix of ['', '-wal', '-shm']) await rm(`${databasePath}${suffix}`, { force: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;
CREATE TABLE entities(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,name TEXT NOT NULL,erased INTEGER NOT NULL);
CREATE TABLE assertions(id TEXT PRIMARY KEY,fact_id TEXT NOT NULL,scope_id TEXT NOT NULL,subject_id TEXT NOT NULL,object_id TEXT,predicate TEXT NOT NULL,status TEXT NOT NULL,known_from INTEGER NOT NULL,known_to INTEGER,valid_from INTEGER,valid_to INTEGER,expires_at INTEGER,erased INTEGER NOT NULL,evidence_id TEXT NOT NULL,text TEXT NOT NULL);
CREATE INDEX assertion_subject ON assertions(scope_id,subject_id,known_from,known_to);
CREATE INDEX assertion_object ON assertions(scope_id,object_id,known_from,known_to);
CREATE TABLE episodes(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,erased INTEGER NOT NULL);
CREATE VIRTUAL TABLE assertion_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');`);
  const vectors = new Float32Array(assertionCount * dimensions);
  const rowIds: string[] = [];
  const insertEntity = db.prepare('INSERT INTO entities VALUES (?,?,?,?)');
  const insertAssertion = db.prepare('INSERT INTO assertions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertFts = db.prepare('INSERT INTO assertion_fts VALUES (?,?)');
  const insertEpisode = db.prepare('INSERT INTO episodes VALUES (?,?,?,?,?)');
  let row = 0;
  const add = (values: { id: string; fact?: string; scope: string; subject: string; object: string | null; predicate?: string; status?: string; knownFrom: number; knownTo?: number | null; validFrom?: number | null; validTo?: number | null; expires?: number | null; erased?: number; evidence: string; text: string }) => {
    insertAssertion.run(values.id, values.fact ?? values.id, values.scope, values.subject, values.object, values.predicate ?? 'RELATED_TO', values.status ?? 'accepted', values.knownFrom,
      values.knownTo ?? null, values.validFrom ?? 1_000_000, values.validTo ?? null, values.expires ?? null, values.erased ?? 0, values.evidence, values.text);
    insertFts.run(values.id, values.text); rowIds.push(values.id);
    if (row < assertionCount) embed(values.text, vectors, row * dimensions);
    row++;
  };
  const started = performance.now();
  db.exec('BEGIN');
  for (let index = 0; index < 10_000; index++) insertEntity.run(`entity-${String(index).padStart(5, '0')}`, `scope-${index % 4}`, `synthetic-${index}`, index % 997 === 0 ? 1 : 0);
  const forbiddenKinds = ['future_bound', 'expired', 'erased', 'other_scope', 'not_yet_known', 'disputed'] as const;
  for (const [number, item] of (fixture.cases as Case[]).entries()) {
    const scope = item.eligibleScopes[0], anchor = item.anchorEntityId, other = `scope-${(Number(scope.slice(-1)) + 1) % 4}`;
    const neighbor = (offset: number) => `entity-${String((number + offset + 1) % 10_000).padStart(5, '0')}`;
    const predicate = item.category === 'interrupted_task' ? 'BLOCKED_BY' : 'RELATED_TO';
    const text = (id: string) => `${item.query} fact ${id}`;
    if (item.abstain) {
      for (const [offset, side] of ['left', 'right'].entries())
        add({ id: `${item.id}:conflict-${offset}`, fact: `${item.id}:${side}`, scope, subject: anchor, object: neighbor(offset), predicate, status: 'disputed', knownFrom: 10 + offset, evidence: `${item.id}:e${offset}`, text: text(`${item.id}:${side}`) });
    }
    for (const [offset, id] of (item.requiredAssertionIds as string[]).entries()) {
      // Multi-hop cases chain anchor -> first object -> second object.
      const subject = offset ? neighbor(offset - 1) : anchor;
      const historical = item.category === 'historical_view';
      add({ id, scope, subject, object: neighbor(offset), predicate, knownFrom: 10 + offset, knownTo: historical ? 60 : null, evidence: item.requiredEvidenceIds[offset], text: text(id) });
      if (historical) add({ id: `${id}@bounded`, fact: id, scope, subject, object: neighbor(offset), predicate, knownFrom: 60, validTo: 2_000_000, evidence: item.requiredEvidenceIds[offset], text: text(id) });
    }
    // Timelines: earlier and later versions with the corpus's knowledge and validity bounds.
    for (const [index, event] of (item.sourceTimeline as any[]).filter(e => e.validFromUs !== undefined).entries())
      add({ id: `${event.event}@${index}`, fact: event.event, scope, subject: anchor, object: neighbor(9), predicate, knownFrom: event.revision, knownTo: event.knownToRevision,
        validFrom: event.validFromUs, validTo: event.validToUs, evidence: event.evidenceId, text: text(event.event) });
    // A repeated source supports the same fact and follows that fact's own timeline.
    for (const repeat of item.repeatedSourceIds as string[]) {
      if (!item.requiredAssertionIds[0]) continue;
      const historical = item.category === 'historical_view', fact = item.requiredAssertionIds[0];
      add({ id: repeat, fact, scope, subject: anchor, object: neighbor(0), predicate, knownFrom: 12, knownTo: historical ? 60 : null, evidence: repeat, text: text(fact) + ' repeated' });
      if (historical) add({ id: `${repeat}@bounded`, fact, scope, subject: anchor, object: neighbor(0), predicate, knownFrom: 60, validTo: 2_000_000, evidence: repeat, text: text(fact) + ' repeated' });
    }
    for (const deletion of item.deletionChanges as any[])
      add({ id: deletion.target, scope, subject: anchor, object: neighbor(5), predicate, knownFrom: 13, erased: 1, evidence: deletion.target + ':e', text: text(deletion.target) });
    for (const _change of item.policyChanges as any[])
      add({ id: `${item.id}:other-scope-copy`, scope: other, subject: anchor, object: neighbor(6), predicate, knownFrom: 13, evidence: `${item.id}:other-e`, text: text(`${item.id}:other-scope-copy`) });
    if (!item.abstain) {
      // One ineligible look-alike per case, rotating through every exclusion rule. Its bounds
      // lie outside every view of the case, so it is forbidden in each of them.
      const views = [item, ...(item.views ?? [])], latestWorld = Math.max(...views.map((v: any) => v.worldAtUs)), earliestWorld = Math.min(...views.map((v: any) => v.worldAtUs));
      const kind = forbiddenKinds[number % forbiddenKinds.length], id = `${item.id}:forbidden`;
      add({ id, scope: kind === 'other_scope' ? other : scope, subject: anchor, object: neighbor(7), predicate, status: kind === 'disputed' ? 'disputed' : 'accepted',
        knownFrom: kind === 'not_yet_known' ? Math.max(...views.map((v: any) => v.knownRevision)) + 1 : 1, validFrom: kind === 'future_bound' ? latestWorld + 1 : 1,
        expires: kind === 'expired' ? earliestWorld : null, erased: kind === 'erased' ? 1 : 0, evidence: id + ':e', text: text(id) });
      // An expired relation one hop past the first object: only graph expansion can reach
      // it (its text shares no query term), so it exercises the graph route's eligibility.
      if (item.requiredPaths.length)
        add({ id: `${item.id}:expired-neighbor`, scope, subject: neighbor(0), object: neighbor(8), predicate, knownFrom: 1, validFrom: 1, expires: earliestWorld,
          evidence: `${item.id}:expired-neighbor-e`, text: 'expired downstream relation' });
    }
  }
  while (row < assertionCount) {
    const id = `fill-${String(row).padStart(6, '0')}`;
    const subject = `entity-${String(row % 10_000).padStart(5, '0')}`;
    const object = `entity-${String((row * 17 + 1) % 10_000).padStart(5, '0')}`;
    add({ id, scope: `scope-${row % 4}`, subject, object, predicate: row % 23 === 0 ? 'BLOCKED_BY' : 'RELATED_TO', status: row % 499 === 0 ? 'disputed' : 'accepted',
      knownFrom: row + 1, knownTo: row % 5 === 0 ? row + 2 : null, validFrom: 1_000_000 + row, expires: row % 991 === 0 ? 2_000_000 : null, erased: row % 997 === 0 ? 1 : 0,
      evidence: `fill-evidence-${row}`, text: `synthetic filler relation ${row % 211} ${subject}` });
  }
  for (let index = 0; index < 10_000; index++) insertEpisode.run(`episode-${index}`, `scope-${index % 4}`, index % 7 === 0 ? 'archived' : 'open', index + 1, index % 991 === 0 ? 1 : 0);
  db.exec('COMMIT; PRAGMA synchronous=FULL;');
  const generationMs = performance.now() - started;
  const embedded = Math.min(row, assertionCount);

  function semantic(query: string) {
    const q = new Float32Array(dimensions); embed(query, q, 0);
    const top: Array<[string, number]> = [];
    for (let item = 0; item < embedded; item++) {
      let score = 0; const offset = item * dimensions;
      for (let d = 0; d < dimensions; d++) score += q[d] * vectors[offset + d];
      if (top.length < 80 || score > top[top.length - 1][1]) { top.push([rowIds[item], score]); top.sort((a, b) => b[1] - a[1]); if (top.length > 80) top.pop(); }
    }
    return top.map(value => value[0]);
  }
  // The single complete eligibility predicate shared by every route and the final selection.
  const eligible = `scope_id=? AND erased=0 AND status='accepted' AND known_from<=? AND (known_to IS NULL OR ?<known_to) AND valid_from<=? AND (valid_to IS NULL OR ?<valid_to) AND (expires_at IS NULL OR expires_at>?)`;
  const params = (view: View, scope: string) => [scope, view.knownRevision, view.knownRevision, view.worldAtUs, view.worldAtUs, view.worldAtUs];
  const acceptEligible = db.prepare(`SELECT id,fact_id,evidence_id,subject_id,object_id,text FROM assertions WHERE id=? AND ${eligible}`);
  const acceptAny = db.prepare('SELECT id,fact_id,evidence_id,subject_id,object_id,text FROM assertions WHERE id=?');
  const byAnchor = db.prepare(`SELECT id FROM assertions WHERE (subject_id=? OR object_id=?) AND ${eligible} ORDER BY id LIMIT 40`);
  const neighbors = db.prepare(`SELECT id,subject_id,object_id FROM assertions WHERE (subject_id=? OR object_id=?) AND ${eligible} ORDER BY id LIMIT 20`);
  const fts = db.prepare('SELECT id FROM assertion_fts WHERE assertion_fts MATCH ? LIMIT 40');

  const results: Record<string, any> = {};
  // Optional per-view record of every route's candidates and the final selection.
  const trace: Record<string, Record<string, { routes: Record<string, string[]>; selected: string[] }>> | undefined = options.trace ? {} : undefined;
  for (const mode of modes) {
    const latencies: number[] = [], m = { required: 0, recalled: 0, reciprocal: 0, evidenceRequired: 0, evidenceRecalled: 0, relationalRequired: 0, relationalRecalled: 0,
      paths: 0, pathsSatisfied: 0, views: 0, viewsCorrect: 0, abstain: 0, abstainCorrect: 0, selected: 0, unsupported: 0, duplicates: 0, tokens: 0 };
    const viewFailures: { case: string; view: string; expected: string[]; answered: string[] }[] = [];
    for (const item of fixture.cases as Case[]) {
      const scope = item.eligibleScopes[0];
      const main: View = { name: 'main', worldAtUs: item.worldAtUs, knownRevision: item.knownRevision, requiredAssertionIds: item.requiredAssertionIds, requiredEvidenceIds: item.requiredEvidenceIds };
      for (const view of [main, ...(item.views as View[] ?? [])]) {
        const before = performance.now();
        const accept = (id: string) => (eligibility ? acceptEligible.get(id, ...params(view, scope)) : acceptAny.get(id)) as Row | undefined;
        const semanticIds = semantic(item.query).filter(id => accept(id));
        const routes: Record<string, string[]> = { semantic: semanticIds };
        let ranked = semanticIds;
        if (mode !== 'vector_only') {
          const terms = item.query.replace(/[^a-z0-9 -]/giu, ' ').trim().split(/\s+/u).map((term: string) => `"${term}"`).join(' OR ');
          const exact = (eligibility ? byAnchor.all(item.anchorEntityId, item.anchorEntityId, ...params(view, scope)) : db.prepare('SELECT id FROM assertions WHERE subject_id=? OR object_id=? ORDER BY id LIMIT 40').all(item.anchorEntityId, item.anchorEntityId)).map((v: any) => v.id).filter((id: string) => accept(id));
          const lexical = terms ? fts.all(terms).map((v: any) => v.id).filter((id: string) => accept(id)) : [];
          const lists = [exact, lexical, semanticIds];
          Object.assign(routes, { exact, lexical });
          if (mode.startsWith('hybrid')) {
            let frontier = [item.anchorEntityId]; const graph: string[] = [], edges: { from: string; to: string; weight: number }[] = [];
            for (let depth = 0; depth < 2; depth++) {
              const next: string[] = [];
              for (const entity of frontier) for (const edge of (eligibility ? neighbors.all(entity, entity, ...params(view, scope)) : db.prepare('SELECT id,subject_id,object_id FROM assertions WHERE subject_id=? OR object_id=? ORDER BY id LIMIT 20').all(entity, entity)) as any[]) {
                if (!accept(edge.id)) continue;
                const other = edge.subject_id === entity ? edge.object_id : edge.subject_id;
                graph.push(edge.id); edges.push({ from: entity, to: other, weight: 1 }); next.push(other);
              }
              frontier = [...new Set(next)].slice(0, 20);
            }
            routes.graph = graph;
            if (mode === 'hybrid_graph_relational_ranker' && edges.length) {
              // The engine's relational ranker, seeded from exact and lexical subjects.
              const seeds = new Map<string, number>();
              for (const id of [...exact, ...lexical]) { const subject = accept(id)!.subject_id; seeds.set(subject, (seeds.get(subject) || 0) + 1); }
              const scores = relationalRank(seeds.size ? seeds : new Map([[item.anchorEntityId, 1]]), edges);
              const subjectOf = new Map(graph.map(id => [id, accept(id)!.subject_id]));
              lists.push([...new Set(graph)].sort((a, b) => (scores.get(subjectOf.get(b)!) || 0) - (scores.get(subjectOf.get(a)!) || 0) || a.localeCompare(b)));
            } else lists.push(graph);
          }
          ranked = rrf(lists).map(([id]) => id);
        }
        // Rehydrate and deduplicate by fact before counting anything.
        const selected: Row[] = [], facts = new Set<string>();
        for (const id of ranked) {
          const value = accept(id); if (!value) continue;
          if (facts.has(value.fact_id)) { m.duplicates++; continue; }
          facts.add(value.fact_id); selected.push(value); if (selected.length === 10) break;
        }
        m.tokens += selected.reduce((sum, value) => sum + Math.ceil(value.text.length / 4), 0);
        if (trace) (trace[mode] ??= {})[`${item.id}/${view.name}`] = { routes, selected: selected.map(value => value.id) };
        latencies.push(performance.now() - before);
        const forbidden = new Set<string>((item.forbiddenFacts as string[]).map(f => f.replace(/^fact:/u, '')));
        for (const value of selected) {
          m.selected++;
          if (forbidden.has(value.fact_id) || !acceptEligible.get(value.id, ...params(view, scope))) m.unsupported++;
        }
        const factRank = (fact: string) => selected.findIndex(value => value.fact_id === fact);
        const evidence = new Set(selected.map(value => value.evidence_id));
        const relational = item.category === 'single_hop' || item.category === 'multi_hop';
        if (view === main) {
          for (const expected of item.requiredAssertionIds as string[]) {
            m.required++; if (relational) m.relationalRequired++;
            const rank = factRank(expected);
            if (rank >= 0) { m.recalled++; m.reciprocal += 1 / (rank + 1); if (relational) m.relationalRecalled++; }
          }
          for (const expected of item.requiredEvidenceIds as string[]) { m.evidenceRequired++; if (evidence.has(expected)) m.evidenceRecalled++; }
          for (const path of item.requiredPaths as string[][]) { m.paths++; if (path.every(fact => factRank(fact) >= 0)) m.pathsSatisfied++; }
          if (item.abstain) { m.abstain++; if (!selected.some(value => value.fact_id.startsWith(item.id))) m.abstainCorrect++; }
        }
        if (item.category === 'temporal_change' || item.category === 'historical_view') {
          m.views++;
          const answers = selected.filter(value => value.fact_id.startsWith(item.id + ':')).map(value => value.fact_id);
          if (view.requiredAssertionIds.every(fact => answers.includes(fact)) && answers.every(fact => view.requiredAssertionIds.includes(fact))) m.viewsCorrect++;
          else if (viewFailures.length < 20) viewFailures.push({ case: item.id, view: view.name, expected: view.requiredAssertionIds, answered: answers });
        }
      }
    }
    results[mode] = {
      factRecallAt10: m.recalled / m.required, relationalFactRecallAt10: m.relationalRecalled / m.relationalRequired, mrrAt10: m.reciprocal / m.required,
      evidenceRecallAt10: m.evidenceRecalled / m.evidenceRequired, pathRecall: m.pathsSatisfied / m.paths,
      temporalViewAccuracy: m.viewsCorrect / m.views, temporalViews: m.views, temporalViewFailures: viewFailures, abstentionAccuracy: m.abstainCorrect / m.abstain,
      unsupportedClaimRate: m.selected ? m.unsupported / m.selected : 0, selectedFacts: m.selected, repeatedRowsMerged: m.duplicates,
      falseMerges: { value: null, status: 'unmeasured', reason: 'The SQL workload has no entity resolution; see the canonical runner.' },
      meanEstimatedTokens: m.tokens / (fixture.cases.length + (fixture.cases as Case[]).reduce((n, c) => n + (c.views?.length ?? 0), 0)),
      latencyMs: stats(latencies), coldLatencyMs: latencies[0], warmLatencyMs: stats(latencies.slice(1)),
    };
  }

  const correctionLatencies: number[] = [];
  const correction = db.prepare('UPDATE assertions SET known_to=? WHERE id=?');
  for (let index = 0; index < 200; index++) { const before = performance.now(); db.exec('BEGIN IMMEDIATE'); correction.run(200_000 + index, `fill-${String(1_000 + index).padStart(6, '0')}`); db.exec('COMMIT'); correctionLatencies.push(performance.now() - before); }
  const databaseBytes = (await stat(databasePath)).size;
  const textSizes = db.prepare('SELECT MIN(length(text)) AS minimum,AVG(length(text)) AS mean,MAX(length(text)) AS maximum FROM assertions').get() as any;
  db.close();
  const ranker = results.hybrid_graph_relational_ranker, vector = results.vector_only;
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    eligibilityEnforced: eligibility,
    workload: { assertionVersions: row, embeddedAssertions: embedded, entities: 10_000, episodes: 10_000, vectorDimensions: dimensions, textBytes: textSizes, generationMs, databaseBytes, projectionCatchUpMs: null },
    corpus: { cases: fixture.cases.length, development: 35, heldout: 35, relational: 20, temporalViews: results[modes[0]].temporalViews },
    retrieval: results,
    correctionCommitMs: stats(correctionLatencies),
    process: { cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAfter: freemem(), peakRssBytes: process.resourceUsage().maxRSS * 1024, node: process.version, platform: `${process.platform}-${process.arch}` },
    gates: {
      relationalRecallTarget: gate('relational fact recall@10 >= 0.90 with the relational ranker', ranker.relationalFactRecallAt10, ranker.relationalFactRecallAt10 >= .9),
      improvementOverVectorFivePoints: gate('ranker relational recall at least 0.05 above vector-only', ranker.relationalFactRecallAt10 - vector.relationalFactRecallAt10, ranker.relationalFactRecallAt10 - vector.relationalFactRecallAt10 >= .05),
      noUnsupportedClaims: gate('no ineligible or forbidden fact selected in any mode', Math.max(...modes.map(mode => results[mode].unsupportedClaimRate)), modes.every(mode => results[mode].unsupportedClaimRate === 0)),
      temporalViews: gate('every temporal and historical view answered exactly (ranker mode)', ranker.temporalViewAccuracy, ranker.temporalViewAccuracy === 1),
      correctionP95Under100Ms: gate('synthetic correction commit p95 < 100 ms', stats(correctionLatencies).p95, stats(correctionLatencies).p95 < 100),
      falseMerges: gate('no false entity merges', null, null),
    },
    ...(trace ? { trace } : {}),
    limitations: [
      'Deterministic hash embeddings measure retrieval plumbing, not model semantic quality.',
      'This is a disposable SQL workload, not the canonical engine; benchmarks/memory/canonical-run.ts evaluates the engine itself.',
      'No GPU or VRAM sampler was available in this benchmark.',
      'End-to-end warm retrieval with live Qdrant, Neo4j, and Ollama is not part of this workload.',
    ],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = await runMicrobenchmark();
  await writeFile(new URL('./results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ gates: report.gates }));
}
