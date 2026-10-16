import test from 'node:test';
import assert from 'node:assert/strict';
import { runDocuments } from '../benchmarks/memory/document-baseline.ts';

// M06: the measured document-collection retrieval baseline (2026-10-15, lexical only). Later
// retrieval changes must keep these floors or record a measured reason.
const floors = { hitAt1: 0.923, hitAt3: 1, mrr: 0.962, abstention: 0.667 } as const;

test('M06 collection retrieval cites resolvable sources, forgets erased files, stays in scope and holds its baseline', async t => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('Network access is disabled in baseline tests'); }) as any;
  t.after(() => { globalThis.fetch = original; });
  const report = await runDocuments();
  for (const name of ['lineage', 'chunkBounds', 'noErasureResurrection', 'noScopeLeakage'] as const)
    assert.equal(report.gates[name].status, 'passed', `${name}: ${JSON.stringify(report.gates[name])}`);
  assert.equal(report.gates.semanticRecall.status, 'unmeasured', 'embedding recall is never claimed from a lexical run');
  for (const [metric, minimum] of Object.entries(floors))
    assert.ok((report.retrieval as any)[metric] >= minimum, `${metric} ${(report.retrieval as any)[metric]} fell below the ${minimum} baseline`);
  const { notFirst: _a, ...first } = report.retrieval, { notFirst: _b, ...again } = (await runDocuments()).retrieval;
  assert.deepEqual(again, first, 'a rerun measures the same quality');
  assert.equal(calls, 0);
});
