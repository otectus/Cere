import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modes, runMicrobenchmark } from "../benchmarks/memory/run.ts";
import { runCanonical } from "../benchmarks/memory/canonical-run.ts";

const corpus = async () => JSON.parse(await readFile(new URL("./fixtures/memory/retrieval-cases.json", import.meta.url), "utf8")).cases;
async function scratch(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "cere-benchmark-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
/** Benchmarks must never reach a model or any other network service. */
function offline(t: any) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("Network access is disabled in benchmark tests"); }) as any;
  t.after(() => { globalThis.fetch = original; });
  return () => calls;
}
const quality = (report: any) => Object.fromEntries(Object.entries(report.retrieval).map(([mode, value]: [string, any]) => {
  const { latencyMs, coldLatencyMs, warmLatencyMs, ...rest } = value;
  return [mode, rest];
}));

test("F-028 a future-bound exact candidate and an expired graph neighbor never reach selected results", async (t) => {
  const calls = offline(t), directory = await scratch(t), cases = await corpus();
  // Index 0 plants a future-bound look-alike on the anchor; the multi-hop case adds an
  // expired relation reachable only through graph expansion.
  const exact = cases.find((c: any) => c.category === "exact_identifier"), chain = cases.find((c: any) => c.category === "multi_hop");
  const run = (eligibility: boolean) => runMicrobenchmark({ assertionCount: 400, directory, cases: [exact, chain], trace: true, eligibility });
  const control = await run(false);
  assert.ok(control.trace!.exact_lexical_vector_rrf[`${exact.id}/main`].routes.exact.includes(`${exact.id}:forbidden`), "the look-alike is an exact candidate");
  const routes = control.trace!.hybrid_graph_rrf[`${chain.id}/main`].routes;
  assert.ok(routes.graph.includes(`${chain.id}:expired-neighbor`), "the expired row is a graph neighbor");
  assert.ok(!routes.exact.includes(`${chain.id}:expired-neighbor`) && !routes.lexical.includes(`${chain.id}:expired-neighbor`), "only the graph route reaches it");
  for (const mode of modes) assert.ok(control.retrieval[mode].unsupportedClaimRate > 0, `${mode} counts planted rows without eligibility`);
  assert.equal(control.gates.noUnsupportedClaims.status, "failed");
  const enforced = await run(true);
  for (const [mode, views] of Object.entries(enforced.trace!) as [string, any][])
    for (const [view, record] of Object.entries(views) as [string, any][]) {
      const planted = (id: string) => /:(forbidden|expired-neighbor)$/.test(id);
      assert.ok(!record.selected.some(planted), `${mode} ${view} selected a planted row`);
      for (const [route, ids] of Object.entries(record.routes) as [string, string[]][]) assert.ok(!ids.some(planted), `${mode} ${view} ${route} admitted a planted row`);
    }
  for (const mode of modes) assert.equal(enforced.retrieval[mode].unsupportedClaimRate, 0, mode);
  assert.equal(calls(), 0);
});

test("F-028 the microbenchmark measures the corpus deterministically and reports unmeasured metrics as unmeasured", async (t) => {
  const calls = offline(t), directory = await scratch(t);
  const report = await runMicrobenchmark({ assertionCount: 1000, directory });
  for (const mode of modes) {
    const r = report.retrieval[mode];
    assert.equal(r.unsupportedClaimRate, 0, mode);
    assert.equal(r.temporalViewAccuracy, 1, `${mode} ${JSON.stringify(r.temporalViewFailures)}`);
    assert.equal(r.temporalViews, 50);
    assert.equal(r.abstentionAccuracy, 1, mode);
    assert.equal(r.falseMerges.status, "unmeasured");
    assert.equal(r.falseMerges.value, null);
    assert.ok(r.repeatedRowsMerged > 0, "repeated sources support one fact instead of filling ranks");
  }
  assert.equal(report.gates.noUnsupportedClaims.status, "passed");
  assert.equal(report.gates.falseMerges.status, "unmeasured");
  for (const g of Object.values(report.gates) as any[]) assert.ok(["passed", "failed", "unmeasured"].includes(g.status));
  assert.deepEqual(quality(await runMicrobenchmark({ assertionCount: 1000, directory })), quality(report), "a rerun in scratch space is identical");
  assert.equal(calls(), 0);
});

test("F-028 the canonical-engine corpus runner holds eligibility, temporal, conflict and integrity gates", async (t) => {
  const calls = offline(t);
  const report = await runCanonical();
  for (const name of ["noUnsupportedClaims", "temporalViews", "abstention", "lookAlikesLive", "integrityFixtures"])
    assert.equal((report.gates as Record<string, any>)[name].status, "passed", `${name}: ${JSON.stringify((report.gates as Record<string, any>)[name])}`);
  assert.deepEqual(report.integrity, { F011_polarity_disputed: true, F012_batch_committed: true, F013_question_candidate: true, F025_inherited_anchor: true, F034_uncertain_candidate: true });
  for (const [kind, tally] of Object.entries(report.lookAlikes) as [string, any][]) assert.ok(tally.planted > 0 && tally.demonstrated === tally.planted, kind);
  assert.equal(report.corpus.temporalViews, 50);
  assert.equal(report.gates.acceptedAssertionPrecision.status, "unmeasured");
  assert.equal(report.gates.semanticQuality.status, "unmeasured");
  const settled = report.retrieval.relational_ranker;
  assert.equal(settled.pathRecall, 1);
  assert.equal(settled.evidenceRecallAt10, 1);
  assert.equal(calls(), 0);
});
