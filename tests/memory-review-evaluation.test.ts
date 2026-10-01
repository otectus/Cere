import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateReviewed } from '../benchmarks/memory/evaluate-reviewed.ts';

test('review corpus covers realistic multi-turn memory decisions without network or model calls', async t => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/memory/review-cases.json', import.meta.url), 'utf8'));
  assert.equal(fixture.schemaVersion, 1);
  assert.ok(fixture.cases.length >= 20);
  for (const category of ['correction','scope','provider','source-role','temporal','conflict','resolution','forget-source','forget-logical','backup-forget'])
    assert.ok(fixture.cases.some((item: any) => item.category === category), category);
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('Network access is forbidden in deterministic memory evaluation'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const report = await evaluateReviewed({ fixture });
  assert.equal(calls, 0);
  assert.equal(report.cases, fixture.cases.length);
  assert.equal(report.evaluation, 'fixture-based deterministic canonical memory review; no model or network calls');
  assert.equal(report.proposalStatusAccuracy, 1, JSON.stringify(report.results.filter((row: any) => row.expectedStatuses.join() !== row.actualStatuses.join())));
  assert.equal(report.acceptedAssertionQuality, 1, JSON.stringify(report.results.filter((row: any) => row.checks.some((check: any) => !check.passed))));
  assert.equal(report.restoredErasure, true);
  assert.equal(report.passed, true);
  assert.ok(report.statusCounts.accepted > 0);
  assert.ok(report.statusCounts.candidate > 0);
  assert.ok(report.statusCounts.disputed > 0);
  assert.ok(report.statusCounts.rejected > 0);
  const byId = new Map(report.results.map((row: any) => [row.id, row]));
  assert.deepEqual(byId.get('planned-is-candidate')!.actualStatuses, ['candidate']);
  assert.deepEqual(byId.get('invalid-quote-rejected')!.actualStatuses, ['rejected']);
  assert.deepEqual(byId.get('contradictory-preference')!.actualStatuses, ['accepted','disputed']);
  assert.ok(byId.get('explicit-tool-correction')!.checks.every((check: any) => check.passed));
  assert.ok(byId.get('cross-provider-same-project')!.checks.every((check: any) => check.passed));
  assert.ok(byId.get('same-name-project-one')!.checks.every((check: any) => check.passed));
  assert.ok(byId.get('same-name-project-two')!.checks.every((check: any) => check.passed));
  assert.ok(byId.get('backup-erasure')!.checks.every((check: any) => check.passed));
});
