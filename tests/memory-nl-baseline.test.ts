import test from 'node:test';
import assert from 'node:assert/strict';
import { runNaturalLanguage } from '../benchmarks/memory/nl-baseline.ts';

/** The baseline must never reach a model or any other network service. */
function offline(t: any) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('Network access is disabled in baseline tests'); }) as any;
  t.after(() => { globalThis.fetch = original; });
  return () => calls;
}
const quality = (report: any) => Object.fromEntries(Object.entries(report.retrieval).map(([mode, value]: [string, any]) => {
  const { latencyMs, ...rest } = value;
  return [mode, rest];
}));

// A05 slice 0: the measured natural-language recall baseline (2026-10-15). Later memory changes
// (continuity, collections, curation) must keep these floors or record a measured reason.
// correctionFirst was unstable at the baseline (0.333 or 0.667): exactly tied scores fell back to
// random record IDs. Ties now go to the more recently learned record, so it is measured and pinned.
const floors = {
  automatic: { recallAt8: 0.9, mrrAt8: 0.85, abstention: 0.8, correctionFound: 1, correctionFirst: 0.667 },
  explicit: { recallAt8: 0.95, mrrAt8: 0.86, abstention: 0.8, correctionFound: 1, correctionFirst: 0.667 },
} as const;

test('A05 natural-language recall keeps scopes and erasure intact and holds its measured baseline', async t => {
  const calls = offline(t);
  const report = await runNaturalLanguage();
  assert.equal(report.gates.noScopeLeakage.status, 'passed', JSON.stringify(report.gates.noScopeLeakage));
  assert.equal(report.gates.noErasureResurrection.status, 'passed', JSON.stringify(report.gates.noErasureResurrection));
  assert.equal(report.gates.semanticRecall.status, 'unmeasured', 'embedding recall is never claimed from a lexical run');
  for (const [mode, floor] of Object.entries(floors)) for (const [metric, minimum] of Object.entries(floor))
    assert.ok(report.retrieval[mode][metric] >= minimum, `${mode} ${metric} ${report.retrieval[mode][metric]} fell below the ${minimum} baseline`);
  // Automatic recall stays inside the 4,000-token packet budget with at most eight items.
  assert.ok(report.retrieval.automatic.packetTokens.p90 <= 4000);
  assert.ok(report.retrieval.automatic.items.max <= 8);
  assert.deepEqual(quality(await runNaturalLanguage()), quality(report), 'a rerun measures the same quality');
  assert.equal(calls(), 0);
});
