#!/usr/bin/env node
// A05 baseline: natural-language recall through Canonical.retrieve. The corpus in
// tests/fixtures/memory/natural-language-cases.json states preferences, decisions, tasks and facts the
// way a person would, and asks paraphrased questions. Nothing is anchored by entity ID, and no
// embedding model, Neo4j or Qdrant is involved, so the figures describe lexical natural-language
// recall only. Scope leakage and erasure resurrection are pass/fail gates; recall figures are a
// measured baseline for later memory changes, not a release target. Runs offline and never
// contacts a model or any other network service.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Canonical } from '../../broker/graph-memory/canonical.ts';

type Mode = 'automatic' | 'explicit';
const modes: Mode[] = ['automatic', 'explicit'];
const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};
const round = (value: number | null, digits = 3) => value === null ? null : Number(value.toFixed(digits));
const gate = (target: string, value: number, passed: boolean) => ({ target, value, status: passed ? 'passed' : 'failed' });

export async function runNaturalLanguage(options: { cases?: any } = {}) {
  const corpus = options.cases ?? JSON.parse(await readFile(new URL('../../tests/fixtures/memory/natural-language-cases.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'cere-nl-baseline-'));
  const c = new Canonical(directory);
  try {
    const scope = c.registerScope({ key: 'nl:project', label: 'Natural-language baseline' }).id;
    const other = c.registerScope({ key: 'nl:other', label: 'Another project' }).id;
    const observe = (text: string, scopeId = scope, session = 'history') => c.observeText({ scope_id: scopeId, text, role: 'user', session_id: session });
    const save = (text: string, scopeId = scope) => c.saveText({ scope_id: scopeId, text, session_id: 'history', source_role: 'user' });
    for (const text of corpus.filler) observe(text);
    const expected = new Map<string, string>();
    for (const item of corpus.cases) expected.set(item.id, (item.store === 'saved' ? save(item.memory) : observe(item.memory)).id);
    const corrections = corpus.corrections.map((item: any) => ({ ...item, originalId: observe(item.original).id, correctionId: observe(item.correction).id }));
    // Look-alikes that live only in another project's scope.
    const leaks = corpus.scopeLeaks.map((item: any) => ({ ...item, id: observe(item.memory, other).id }));
    // Memories the user later asked Cere to forget.
    const erased = corpus.erasures.map((item: any) => ({ ...item, id: observe(item.memory).id }));
    for (const item of erased) c.forget({ scope_id: scope, id: item.id });

    const retrieve = (text: string, mode: Mode) => {
      const started = performance.now();
      const result = c.retrieve({ scope_id: scope, text, ...(mode === 'automatic' ? { relevance_floor: true, max_items: 8, recent_session_id: 'baseline-query' } : {}) });
      return { result, latency: performance.now() - started };
    };
    const ids = (result: any): string[] => result.results.map((row: any) => row.id);
    const report: any = { corpus: { cases: corpus.cases.length, filler: corpus.filler.length, corrections: corpus.corrections.length, abstain: corpus.abstain.length, scopeLeaks: corpus.scopeLeaks.length, erasures: corpus.erasures.length }, retrieval: {}, gates: {} };
    let leakage = 0, resurrection = 0;
    for (const mode of modes) {
      const ranks: (number | null)[] = [], latencies: number[] = [], tokens: number[] = [], itemCounts: number[] = [];
      const byCategory: Record<string, { n: number; found: number; reciprocal: number }> = {}, byOverlap: Record<string, { n: number; found: number }> = {};
      for (const item of corpus.cases) {
        const { result, latency } = retrieve(item.query, mode);
        latencies.push(latency); tokens.push(result.budget.estimated_tokens); itemCounts.push(result.items.length);
        const index = ids(result).indexOf(expected.get(item.id)!), rank = index < 0 || index >= 8 ? null : index + 1;
        ranks.push(rank);
        const category = byCategory[item.category] ??= { n: 0, found: 0, reciprocal: 0 };
        category.n++; if (rank) { category.found++; category.reciprocal += 1 / rank; }
        const overlap = byOverlap[item.overlap] ??= { n: 0, found: 0 };
        overlap.n++; if (rank) overlap.found++;
      }
      const at = (k: number) => ranks.filter(rank => rank !== null && rank <= k).length / ranks.length;
      let correctionFirst = 0, correctionFound = 0;
      for (const item of corrections) {
        const list = ids(retrieve(item.query, mode).result), newer = list.indexOf(item.correctionId), older = list.indexOf(item.originalId);
        if (newer >= 0) correctionFound++;
        if (newer >= 0 && (older < 0 || newer < older)) correctionFirst++;
      }
      let abstained = 0;
      for (const query of corpus.abstain) if (!retrieve(query, mode).result.items.length) abstained++;
      for (const item of leaks) if (ids(retrieve(item.query, mode).result).includes(item.id)) leakage++;
      for (const item of erased) {
        const { result } = retrieve(item.query, mode);
        if (ids(result).includes(item.id) || result.items.some((entry: any) => String(entry.text).includes(item.memory))) resurrection++;
      }
      report.retrieval[mode] = {
        recallAt1: round(at(1)), recallAt3: round(at(3)), recallAt8: round(at(8)),
        mrrAt8: round(ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length),
        byCategory: Object.fromEntries(Object.entries(byCategory).map(([key, value]) => [key, { recallAt8: round(value.found / value.n), mrrAt8: round(value.reciprocal / value.n), n: value.n }])),
        byOverlap: Object.fromEntries(Object.entries(byOverlap).map(([key, value]) => [key, { recallAt8: round(value.found / value.n), n: value.n }])),
        correctionFound: round(correctionFound / corrections.length), correctionFirst: round(correctionFirst / corrections.length),
        abstention: round(abstained / corpus.abstain.length),
        packetTokens: { p50: percentile(tokens, .5), p90: percentile(tokens, .9) },
        items: { p50: percentile(itemCounts, .5), max: Math.max(...itemCounts) },
        latencyMs: { p50: round(percentile(latencies, .5)), p95: round(percentile(latencies, .95)) },
      };
    }
    report.gates.noScopeLeakage = gate('0 other-scope memories returned', leakage, leakage === 0);
    report.gates.noErasureResurrection = gate('0 forgotten memories returned', resurrection, resurrection === 0);
    report.gates.semanticRecall = { target: 'Embedding-backed recall measured offline', value: null, status: 'unmeasured' };
    report.storeRevision = c.revision;
    return report;
  } finally {
    c.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = await runNaturalLanguage();
  const output = process.argv.indexOf('--output');
  if (output > 0 && process.argv[output + 1]) await writeFile(process.argv[output + 1], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
