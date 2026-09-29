#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { OllamaExtractionAdapter } from '../../broker/graph-memory/adapters/ollama.ts';

if (process.env.CERE_ALLOW_CLOUD_EVAL !== '1') throw new Error('Set CERE_ALLOW_CLOUD_EVAL=1 to authorize this synthetic cloud evaluation');
const model = 'gpt-oss:20b-cloud';
const digest = '9a01793d9ef8de5309f157c06dbcbadfb598001b4a6f13cbc699cdff5042eaae';
const corpus = [
  { text: 'For project Atlas, use Ruff for Python formatting.', predicate: 'USES_TOOL' },
  { text: 'Task Orbit is blocked by task Relay.', predicate: 'BLOCKED_BY' },
  { text: 'I prefer pytest for project Atlas.', predicate: 'PREFERS_TOOL' },
  { text: 'Repository Aurora implements project Northstar.', predicate: 'IMPLEMENTS' },
  { text: 'Checkout Delta is a checkout of repository Aurora.', predicate: 'CHECKOUT_OF' },
];
const adapter = new OllamaExtractionAdapter({ endpoint: 'http://127.0.0.1:11434', model, expectedDigest: digest, allowCloud: true, timeoutMs: 90_000, probeTimeoutMs: 60_000 });
const probe = await adapter.probe();
const latencies: number[] = [];
let proposals = 0, matching = 0, casesRecalled = 0;
const caseResults: Array<{ index: number; expectedPredicate: string; proposedPredicates: string[] }> = [];
for (let index = 0; index < corpus.length; index++) {
  const started = performance.now();
  const output = await adapter.extract({ sourceRecordId: `synthetic-eval-${index}`, sourceRevision: 1, sourceRole: 'user', modelRoute: 'cloud_allowed', text: corpus[index].text });
  latencies.push(performance.now() - started);
  proposals += output.proposals.assertions.length;
  const expected = output.proposals.assertions.filter(assertion => assertion.predicate === corpus[index].predicate);
  caseResults.push({ index, expectedPredicate: corpus[index].predicate, proposedPredicates: output.proposals.assertions.map(assertion => assertion.predicate) });
  matching += expected.length;
  if (expected.length) casesRecalled++;
}
const sorted = [...latencies].sort((a, b) => a - b);
const result = {
  schemaVersion: 1,
  evaluatedAt: new Date().toISOString(),
  model,
  modelDigest: probe.digest,
  samples: corpus.length,
  assertionProposals: proposals,
  expectedPredicateProposals: matching,
  predicatePrecision: proposals ? matching / proposals : 0,
  caseRecall: casesRecalled / corpus.length,
  exactQuoteValidation: true,
  latencyMs: { p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], maximum: sorted.at(-1) },
  targetPrecisionAtLeast95Percent: proposals > 0 && matching / proposals >= .95,
  caseResults,
  caveat: 'Small synthetic predicate-level evaluation; it does not estimate production-domain extraction quality.',
};
await writeFile(new URL('./extraction-results.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
