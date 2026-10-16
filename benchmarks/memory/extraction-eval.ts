/**
 * EV-01: evaluation of a memory extraction model on the held-out synthetic corpus in
 * tests/fixtures/memory/extraction-cases.json. Each statement is extracted by the adapter under
 * test, mapped to canonical claims exactly as the memory worker maps them, and submitted through
 * Canonical.remember in a temporary store, so the report covers both what the model proposed and
 * what canonical memory would accept. Nothing here reaches the network except through the adapter.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Canonical } from '../../broker/graph-memory/canonical.ts';
import { predicates } from '../../broker/graph-memory/contracts.ts';
import { normalized } from '../../broker/graph-memory/ontology.ts';
import { extractionProposals } from '../../broker/graph-memory/proposals.ts';
import type { ExtractionAdapter } from '../../broker/graph-memory/adapters/contracts.ts';

type Row = Record<string, any>;
export type Expected = { predicate: string; subject: { name?: string; type?: string }; object?: { name: string }; value?: string; polarity?: 'positive' | 'negative' };
export type ExtractionCase = { id: string; source: string; role: 'user' | 'assistant' | 'tool'; text: string; expected: Expected[] };
type Gate = { status: 'passed' | 'failed' | 'unmeasured'; value: number | null; threshold: string };

export const casesUrl = new URL('../../tests/fixtures/memory/extraction-cases.json', import.meta.url);
export const preservedResults = new URL('./extraction-results.json', import.meta.url);
export function loadCases(): ExtractionCase[] { return JSON.parse(readFileSync(casesUrl, 'utf8')).cases; }
/** Results go to one file per model; the preserved gpt-oss runs in extraction-results.json are never written. */
export function resultsFile(model: string) {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('Name the extraction model to evaluate');
  return new URL(`./extraction-results-${slug}.json`, import.meta.url);
}

const contains = (a: string, b: string) => { const x = normalized(a), y = normalized(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };
/** Whether a canonical claim states one of the case's expected assertions. */
export function matches(claim: Row, expected: Expected) {
  if (claim.predicate !== expected.predicate || (claim.polarity ?? 'positive') !== (expected.polarity ?? 'positive')) return false;
  const subject = expected.subject.type ? normalized(claim.subject?.type ?? '') === normalized(expected.subject.type) : contains(claim.subject?.name ?? '', expected.subject.name!);
  const object = expected.object ? !!claim.object && contains(claim.object.name, expected.object.name) : claim.value != null && contains(String(claim.value), expected.value!);
  return subject && object;
}

/** The acceptance rules that hold a model proposal back as a candidate, in Canonical.remember's terms. */
export function candidateReasons(c: Canonical, claim: Row, versionId: string) {
  const reasons: string[] = [];
  if (['inference', 'derived_summary'].includes(claim.epistemic_type)) reasons.push('epistemic type ' + claim.epistemic_type);
  if (claim.modality !== 'actual') reasons.push('modality ' + claim.modality);
  if ((claim.valid_mode === 'unknown' && (claim.time_expression || '').trim()) || claim.time_precision === 'approximate') reasons.push('uncertain time');
  for (const evidence of c.support(versionId)) {
    if (evidence.trust === 'derived_summary') reasons.push('assistant source');
    if (evidence.trust === 'document_claim') reasons.push('document source');
    if (c.grounded(evidence, claim as any)) continue;
    const quotation = normalized(evidence.witness);
    reasons.push(!quotation.includes(normalized(claim.object?.name ?? String(claim.value))) ? 'ungrounded: value not in the quoted span'
      : !quotation.includes(normalized(claim.subject.name)) && !/\bthis project\b/u.test(quotation) ? 'ungrounded: subject not in the quoted span'
        : 'ungrounded: question, hedge, quotation, negation or missing cue');
  }
  return [...new Set(reasons)];
}

const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]) : null; };
const ratio = (part: number, whole: number) => whole ? part / whole : null;
const gate = (value: number | null, threshold: string, pass: (value: number) => boolean): Gate => ({ status: value === null ? 'unmeasured' : pass(value) ? 'passed' : 'failed', value, threshold });

export async function evaluate(adapter: ExtractionAdapter, cases: ExtractionCase[], options: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cere-extraction-eval-'));
  const c = new Canonical(directory);
  const latencies: number[] = [], caseResults: Row[] = [];
  const reasons = new Map<string, number>(), rejections = new Map<string, number>();
  const perPredicate = Object.fromEntries(predicates.map(predicate => [predicate, { expectedCases: 0, recalledCases: 0, proposals: 0, correct: 0, accepted: 0, acceptedCorrect: 0 }]));
  const totals = { proposals: 0, expectedPredicate: 0, correct: 0, accepted: 0, acceptedCorrect: 0, candidate: 0, disputed: 0, rejected: 0, heldOnlyByTime: 0, heldOnlyByTimeCorrect: 0, uncertainTime: 0,
    extractionFailures: 0, mappingFailures: 0, recalledCases: 0, negativeProposals: 0, negativeAccepted: 0, abstained: 0 };
  let identity: Row = {};
  try {
    for (const [index, item] of cases.entries()) {
      options.signal?.throwIfAborted();
      const scope = c.registerScope({ key: 'eval-' + item.id, label: item.id }).id;
      const observation = c.observeText({ scope_id: scope, text: item.text, role: item.role });
      const result: Row = { id: item.id, role: item.role, expected: item.expected.map(e => e.predicate), proposals: [] };
      const started = performance.now();
      let run;
      try { run = await adapter.extract({ sourceRecordId: observation.id, sourceRevision: 1, sourceRole: item.role, modelRoute: 'cloud_allowed', text: item.text }, options.signal); }
      catch (error: any) { if (options.signal?.aborted) throw error; totals.extractionFailures++; result.error = String(error?.message || error).slice(0, 200); }
      finally { latencies.push(performance.now() - started); result.latencyMs = Math.round(latencies.at(-1)!); }
      if (run) {
        identity = { model: run.model, modelDigest: run.modelDigest, endpointClass: run.endpointClass, promptVersion: run.promptVersion, parserVersion: run.parserVersion, schemaVersion: run.schemaVersion };
        let proposals: Row[] = [];
        try { proposals = extractionProposals(run, observation.id); }
        catch (error: any) { totals.mappingFailures++; result.error = 'mapping: ' + String(error?.message || error).slice(0, 160); }
        for (const [position, proposal] of proposals.entries()) {
          const claim = proposal.claim, raw = run.proposals.assertions[position];
          const correct = item.expected.some(expected => matches(claim, expected)), expectedPredicate = item.expected.some(expected => expected.predicate === claim.predicate);
          const entry: Row = { predicate: claim.predicate, correct, uncertainTime: !!raw?.temporal?.uncertain };
          totals.proposals++; if (expectedPredicate) totals.expectedPredicate++; if (correct) totals.correct++; if (entry.uncertainTime) totals.uncertainTime++;
          if (perPredicate[claim.predicate]) { perPredicate[claim.predicate].proposals++; if (correct) perPredicate[claim.predicate].correct++; }
          try {
            const remembered = c.remember({ scope_id: scope, claim, witness: proposal.witness, model_proposal: true });
            entry.status = c.one('SELECT status FROM assertion_versions WHERE version_id=?', remembered.id).status;
            if (entry.status === 'candidate') {
              entry.reasons = candidateReasons(c, claim, remembered.id);
              for (const reason of entry.reasons) reasons.set(reason, (reasons.get(reason) || 0) + 1);
              if (entry.reasons.length === 1 && entry.reasons[0] === 'uncertain time') { totals.heldOnlyByTime++; if (correct) totals.heldOnlyByTimeCorrect++; }
            }
          } catch (error: any) {
            entry.status = 'rejected'; entry.reason = `${error?.code || 'ERROR'}: ${String(error?.message || error).slice(0, 120)}`;
            rejections.set(entry.reason, (rejections.get(entry.reason) || 0) + 1);
          }
          if (entry.status === 'accepted') { totals.accepted++; if (correct) totals.acceptedCorrect++; if (perPredicate[claim.predicate]) { perPredicate[claim.predicate].accepted++; if (correct) perPredicate[claim.predicate].acceptedCorrect++; } }
          else if (entry.status === 'candidate') totals.candidate++;
          else if (entry.status === 'disputed') totals.disputed++;
          else if (entry.status === 'rejected') totals.rejected++;
          if (!item.expected.length) { totals.negativeProposals++; if (entry.status === 'accepted') totals.negativeAccepted++; }
          result.proposals.push(entry);
        }
      }
      for (const predicate of new Set(item.expected.map(expected => expected.predicate))) {
        perPredicate[predicate].expectedCases++;
        if (result.proposals.some((entry: Row) => entry.predicate === predicate && entry.correct)) perPredicate[predicate].recalledCases++;
      }
      if (item.expected.length && result.proposals.some((entry: Row) => entry.correct)) totals.recalledCases++;
      if (!item.expected.length && !result.error && !result.proposals.length) totals.abstained++;
      caseResults.push(result);
      options.progress?.(index + 1, cases.length);
    }
  } finally { c.close(); rmSync(directory, { recursive: true, force: true }); }
  const positive = cases.filter(item => item.expected.length).length, negative = cases.length - positive;
  const metrics = {
    samples: cases.length, positiveCases: positive, negativeCases: negative,
    extractionFailures: totals.extractionFailures, mappingFailures: totals.mappingFailures,
    assertionProposals: totals.proposals, expectedPredicateProposals: totals.expectedPredicate, correctProposals: totals.correct,
    predicatePrecision: ratio(totals.expectedPredicate, totals.proposals), proposalPrecision: ratio(totals.correct, totals.proposals),
    caseRecall: ratio(totals.recalledCases, positive), recalledCases: totals.recalledCases,
    canonical: { accepted: totals.accepted, candidate: totals.candidate, disputed: totals.disputed, rejected: totals.rejected, acceptedCorrect: totals.acceptedCorrect,
      candidateReasons: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])), rejections: Object.fromEntries([...rejections].sort((a, b) => b[1] - a[1])) },
    acceptedAssertionPrecision: ratio(totals.acceptedCorrect, totals.accepted),
    uncertainTimeProposals: totals.uncertainTime,
    // Counterfactual only: candidates whose single reason is the approximate-time rule, and how many are correct.
    heldOnlyByTimeRule: { proposals: totals.heldOnlyByTime, correct: totals.heldOnlyByTimeCorrect },
    negatives: { abstained: totals.abstained, abstention: ratio(totals.abstained, negative), proposals: totals.negativeProposals, accepted: totals.negativeAccepted },
    latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), maximum: latencies.length ? Math.round(Math.max(...latencies)) : null },
    perPredicate,
  };
  return {
    ...identity,
    fixture: { path: 'tests/fixtures/memory/extraction-cases.json', sha256: createHash('sha256').update(readFileSync(casesUrl)).digest('hex'), cases: cases.length },
    metrics,
    gates: {
      predicatePrecisionAtLeast95Percent: gate(metrics.predicatePrecision, '>= 0.95', value => value >= .95),
      acceptedAssertionPrecisionAtLeast95Percent: gate(metrics.acceptedAssertionPrecision, '>= 0.95 of accepted assertions', value => value >= .95),
      noAcceptedAssertionFromNegatives: gate(negative ? totals.negativeAccepted : null, '= 0', value => value === 0),
    },
    caseResults,
  };
}
