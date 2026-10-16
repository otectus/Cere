#!/usr/bin/env node
// M06 baseline: document-collection retrieval through Canonical.retrieve, the path
// KnowledgeCollections.context takes: a collection's own scope, document chunks from the shared
// chunker keyed by file and content hash, local model route, relevance floor and six items. The
// corpus in tests/fixtures/memory/document-cases.json asks paraphrased questions about a small set
// of project documents. Lexical only: no embedding model, Neo4j or Qdrant is involved, and nothing
// contacts the network. Lineage, chunk bounds, erasure and scope isolation are pass/fail gates;
// hit rates are a measured baseline for later retrieval changes, not a release target.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Canonical } from '../../broker/graph-memory/canonical.ts';
import { chunkDocument, collectionLimits } from '../../broker/knowledge-collections.ts';

const round = (value: number) => Number(value.toFixed(3));
const gate = (target: string, value: number, passed: boolean) => ({ target, value, status: passed ? 'passed' : 'failed' });

export async function runDocuments(options: { cases?: any } = {}) {
  const corpus = options.cases ?? JSON.parse(await readFile(new URL('../../tests/fixtures/memory/document-cases.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'cere-document-baseline-'));
  const c = new Canonical(directory);
  try {
    // Collections register a project-kind scope of their own, with no parent (knowledge-collections.ts).
    const collection = c.registerScope({ key: JSON.stringify(['fixture-host', 'collection:baseline']), label: 'Collection · baseline', kind: 'project' }).id;
    const project = c.registerScope({ key: 'documents:project', label: 'Project memory' }).id;
    const chunks = new Map<string, { path: string; sha256: string; index: number }>();
    let oversized = 0, total = 0;
    for (const doc of corpus.documents) {
      const sha256 = createHash('sha256').update(doc.text).digest('hex');
      for (const [index, chunk] of chunkDocument(doc.text).entries()) {
        total++;
        // A chunk is at most chunkChars of the document plus its "§ heading" line.
        if (Array.from(chunk.text).length > collectionLimits.chunkChars + 3 + chunk.heading.length) oversized++;
        const row = c.observeText({ scope_id: collection, text: chunk.text, role: 'document', kind: 'document', session_id: 'file:' + doc.path, source_event_id: `${sha256}#${index}` });
        chunks.set(row.id, { path: doc.path, sha256, index });
      }
    }
    for (const text of corpus.projectMemory) c.observeText({ scope_id: project, text, role: 'user', session_id: 'history' });
    const retrieve = (scope: string, text: string) => c.retrieve({ scope_id: scope, text, relevance_floor: true, max_items: 6, model_route: 'local' }).results as any[];
    let unresolved = 0, cited = 0;
    const sources = (results: any[]) => results.map(row => {
      cited++;
      const chunk = chunks.get(row.id);
      // Lineage: every returned chunk names its file and the content revision it was indexed from.
      if (!chunk || row.sessionId !== 'file:' + chunk.path) { unresolved++; return ''; }
      return chunk.path;
    });
    const ranks: (number | null)[] = [], misses: string[] = [];
    for (const item of corpus.questions) {
      const found = sources(retrieve(collection, item.query)).indexOf(item.source);
      ranks.push(found < 0 ? null : found + 1);
      if (found !== 0) misses.push(item.id);
    }
    const abstained = corpus.abstain.filter((query: string) => retrieve(collection, query).length === 0).length;
    // Erasure by document source removes every chunk of the file; nothing returns afterwards.
    const erasedPath = corpus.erase.path;
    const foundBefore = corpus.erase.queries.filter((query: string) => sources(retrieve(collection, query)).includes(erasedPath)).length;
    c.forget({ scope_id: collection, document_source: 'file:' + erasedPath });
    const resurrected = corpus.erase.queries.filter((query: string) => sources(retrieve(collection, query)).includes(erasedPath)).length;
    // Isolation: project memory never answers from a collection, and a collection never from project memory.
    let leaked = 0;
    for (const query of corpus.leakQueries) {
      leaked += retrieve(project, query).filter(row => chunks.has(row.id)).length;
      leaked += retrieve(collection, query).filter(row => !chunks.has(row.id)).length;
    }
    const answered = ranks.filter(rank => rank !== null) as number[];
    return {
      corpus: { documents: corpus.documents.length, chunks: total, questions: corpus.questions.length, abstain: corpus.abstain.length },
      retrieval: {
        hitAt1: round(ranks.filter(rank => rank === 1).length / ranks.length),
        hitAt3: round(ranks.filter(rank => rank !== null && rank <= 3).length / ranks.length),
        hitAt6: round(answered.length / ranks.length),
        mrr: round(ranks.reduce((sum: number, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length),
        abstention: round(abstained / corpus.abstain.length),
        notFirst: misses,
      },
      gates: {
        lineage: gate('every returned chunk resolves to its file and content hash', unresolved, unresolved === 0 && cited > 0),
        chunkBounds: gate(`chunks stay within ${collectionLimits.chunkChars} characters plus their heading`, oversized, oversized === 0),
        noErasureResurrection: gate('a forgotten document returns nothing', resurrected, foundBefore > 0 && resurrected === 0),
        noScopeLeakage: gate('collections and project memory stay apart', leaked, leaked === 0),
        semanticRecall: { target: 'embedding recall', status: 'unmeasured' },
      },
    };
  } finally {
    c.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = await runDocuments();
  const output = process.argv.indexOf('--output');
  if (output > 0 && process.argv[output + 1]) await writeFile(process.argv[output + 1], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
