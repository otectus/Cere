#!/usr/bin/env node
// Release check for the canonical memory engine itself: the 70-case corpus is loaded
// through Canonical.remember/correct/forget and evaluated with Canonical.retrieve, using
// the engine's own eligibility, temporal, conflict and relational-ranking code. It is
// deterministic, uses lexical/anchor/graph recall only, and never contacts a model.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Canonical } from '../../broker/graph-memory/canonical.ts';

type Case = Record<string, any>;
type Row = Record<string, any>;
const day = (date: string) => Date.parse(date + 'T00:00:00Z') * 1000;
const T0 = day('2026-01-01'), T1 = day('2026-06-01'), T2 = day('2026-07-01'), PAST = day('2026-03-01'), RECENT = day('2026-09-01'), FUTURE = day('2027-01-01');
const gate = (target: string, value: number | null, passed: boolean | null) => ({ target, value, status: passed === null ? 'unmeasured' : passed ? 'passed' : 'failed' });

function load(c: Canonical, cases: Case[]) {
  const scopes: Record<string, string> = {};
  for (const item of cases) scopes[item.eligibleScopes[0]] ??= c.registerScope({ key: 'bench:' + item.eligibleScopes[0], label: item.eligibleScopes[0] }).id;
  const names = Object.keys(scopes);
  const plan = new Map<string, { scope: string; other: string; anchor: string; evidence: Record<string, string>; views: Case[]; lookAlike?: { kind: string; observation: string } }>();
  for (const [number, item] of cases.entries()) {
    const scope = scopes[item.eligibleScopes[0]], other = scopes[names[(names.indexOf(item.eligibleScopes[0]) + 1) % names.length]];
    const evidence: Record<string, string> = {};
    const claim = (subject: any, predicate: string, object: any, extra: any = {}) => ({ subject, predicate, object, ...extra });
    const say = (text: string, scopeId = scope) => c.observeText({ scope_id: scopeId, text, role: 'user' });
    const assert = (text: string, value: any, corpusEvidence?: string, extra: any = {}, scopeId = scope, operation = 'assert') => {
      const source = say(text, scopeId), result = c.remember({ scope_id: scopeId, claim: value, witness: { observation_id: source.id, quote: text }, ...extra }, operation);
      if (corpusEvidence) evidence[corpusEvidence] = c.one('SELECT id FROM evidence WHERE observation_id=? AND erased=0', source.id).id;
      return { source, result };
    };
    const project = { type: 'Project', name: `${item.id} anchor` }, tool = (suffix: string) => ({ type: 'Tool', name: `${item.id}-${suffix}` });
    const task = (suffix: string) => ({ type: 'Task', name: `${item.id}-${suffix}` });
    let anchor = '', lookAlike: { kind: string; observation: string } | undefined;
    const views: Case[] = [];
    switch (item.category) {
      case 'exact_identifier': case 'single_hop': {
        const { result } = assert(`${item.id} anchor depends on ${item.id}-a0.`, claim(project, 'DEPENDS_ON', tool('a0')), item.requiredEvidenceIds[0]);
        anchor = c.one('SELECT subject_id FROM assertion_versions WHERE version_id=?', result.id).subject_id;
        views.push({ name: 'main', expected: item.requiredAssertionIds });
        break;
      }
      case 'multi_hop': {
        const { result } = assert(`${item.id} anchor depends on ${item.id}-a0.`, claim(project, 'DEPENDS_ON', task('a0')), item.requiredEvidenceIds[0]);
        assert(`${item.id}-a0 is blocked by ${item.id}-a1.`, claim(task('a0'), 'BLOCKED_BY', task('a1')), item.requiredEvidenceIds[1]);
        anchor = c.one('SELECT subject_id FROM assertion_versions WHERE version_id=?', result.id).subject_id;
        views.push({ name: 'main', expected: item.requiredAssertionIds });
        break;
      }
      case 'interrupted_task': {
        const { result } = assert(`${item.id}-task is blocked by ${item.id}-a0.`, claim(task('task'), 'BLOCKED_BY', task('a0')), item.requiredEvidenceIds[0]);
        anchor = c.one('SELECT subject_id FROM assertion_versions WHERE version_id=?', result.id).subject_id;
        views.push({ name: 'main', expected: item.requiredAssertionIds });
        break;
      }
      case 'temporal_change': case 'historical_view': {
        // A bounded fact corrected by an explicit, quoted user statement.
        const first = item.category === 'temporal_change' ? 'prior' : 'a0', second = item.category === 'temporal_change' ? 'a0' : 'later', change = item.category === 'temporal_change' ? T1 : T2;
        const bounded = (from: number) => ({ qualifiers: { purpose: 'formatting' }, valid_mode: 'bounded', valid_from_us: from, time_precision: 'date' });
        const original = assert(`${item.id} anchor uses ${item.id}-${first} for formatting.`, claim(project, 'USES_TOOL', tool(first), bounded(T0)),
          item.category === 'temporal_change' ? `${item.id}:prior-e` : item.requiredEvidenceIds[0]);
        const before = c.revision, slot = c.one('SELECT aggregate_revision FROM fact_slots WHERE id=?', original.result.slot_id).aggregate_revision;
        assert(`${item.id} anchor uses ${item.id}-${second} for formatting.`, claim(project, 'USES_TOOL', tool(second), bounded(change)),
          item.category === 'temporal_change' ? item.requiredEvidenceIds[0] : `${item.id}:later-e`, { id: original.result.id, expected_revision: slot }, scope, 'correct');
        anchor = c.one('SELECT subject_id FROM assertion_versions WHERE version_id=?', original.result.id).subject_id;
        if (item.category === 'temporal_change') views.push(
          { name: 'main', world: RECENT, expected: [`${item.id}:a0`] },
          { name: 'pre_change', world: PAST, expected: [`${item.id}:prior`] },
          { name: 'old_knowledge', world: RECENT, known: before, expected: [`${item.id}:prior`] });
        else views.push(
          { name: 'main', world: PAST, known: before, expected: [`${item.id}:a0`] },
          { name: 'current_knowledge', world: RECENT, expected: [`${item.id}:later`] });
        break;
      }
      case 'contradiction_abstention': {
        const user = { type: 'User', name: `${item.id} user` };
        const { result } = assert(`${item.id} user prefers ${item.id}-left.`, claim(user, 'PREFERS_TOOL', tool('left')), item.sourceTimeline[0].evidenceId);
        assert(`${item.id} user prefers ${item.id}-right.`, claim(user, 'PREFERS_TOOL', tool('right')), item.sourceTimeline[1].evidenceId);
        anchor = c.one('SELECT subject_id FROM assertion_versions WHERE version_id=?', result.id).subject_id;
        views.push({ name: 'main', expected: [] });
        break;
      }
    }
    // Repeated sources support the same fact; they never create a second fact.
    if (item.repeatedSourceIds.length && item.requiredAssertionIds.length && !['temporal_change', 'historical_view', 'multi_hop', 'interrupted_task'].includes(item.category))
      assert(`${item.id} anchor depends on ${item.id}-a0.`, claim(project, 'DEPENDS_ON', tool('a0')), item.repeatedSourceIds[0]);
    // Ineligible look-alikes, one exclusion rule per case, all naming the anchor.
    if (!item.abstain) {
      const kind = ['future_bound', 'planned', 'erased', 'other_scope', 'question', 'disputed'][number % 6];
      const forbidden = tool('forbidden'), text = `${item.id} anchor depends on ${item.id}-forbidden.`;
      let planted: { source: Row } | undefined;
      if (kind === 'future_bound') planted = assert(text, claim(project, 'DEPENDS_ON', forbidden, { valid_mode: 'bounded', valid_from_us: FUTURE, time_precision: 'date' }));
      if (kind === 'planned') planted = assert(text, claim(project, 'DEPENDS_ON', forbidden, { modality: 'planned' }));
      if (kind === 'erased') { planted = assert(text, claim(project, 'DEPENDS_ON', forbidden)); c.forget({ scope_id: scope, id: planted.source.id }); }
      if (kind === 'other_scope') planted = assert(text, claim(project, 'DEPENDS_ON', forbidden), undefined, {}, other);
      if (kind === 'question') planted = assert(`Does ${item.id} anchor depend on ${item.id}-forbidden?`, claim(project, 'DEPENDS_ON', forbidden), undefined, { model_proposal: true });
      if (kind === 'disputed') {
        const disputed = (name: any, sentence: string) => assert(sentence, claim(project, 'USES_TOOL', name, { qualifiers: { purpose: 'disputed' } }));
        planted = disputed(forbidden, `${item.id} anchor uses ${item.id}-forbidden for disputed.`); disputed(tool('rival'), `${item.id} anchor uses ${item.id}-rival for disputed.`);
      }
      lookAlike = { kind, observation: planted!.source.id };
    }
    for (const deletion of item.deletionChanges) {
      const { source } = assert(`${item.id} anchor depends on ${item.id}-deleted-copy.`, claim(project, 'DEPENDS_ON', tool('deleted-copy')));
      c.forget({ scope_id: scope, id: source.id });
      void deletion;
    }
    for (const _change of item.policyChanges) assert(`${item.id} anchor depends on ${item.id}-other-scope-copy.`, claim(project, 'DEPENDS_ON', tool('other-scope-copy')), undefined, {}, other);
    plan.set(item.id, { scope, other, anchor, evidence, views, lookAlike });
  }
  return plan;
}

/** Integrity fixtures for findings F-011, F-012, F-013, F-025 and F-034. */
function integrity(directory: string) {
  const c = new Canonical(directory);
  try { return integrityChecks(c); } finally { c.close(); }
}
function integrityChecks(c: Canonical) {
  c.policyUpdate({ policy: { enabled: true } });
  const scope = (key: string, parent?: string) => c.registerScope({ key: 'integrity:' + key, label: key, ...(parent ? { parent_id: parent, kind: 'task' } : {}) }).id;
  const say = (scopeId: string, text: string) => c.observeText({ scope_id: scopeId, text, role: 'user' });
  const use = (name: string, extra: any = {}) => ({ subject: { type: 'Project', name: 'Atlas' }, predicate: 'USES_TOOL', object: { type: 'Tool', name }, ...extra });
  const checks: Record<string, boolean> = {};
  let s = scope('polarity');
  for (const [text, claim] of [['Atlas uses Kitty.', use('Kitty')], ['Atlas uses Ruff.', use('Ruff')], ['Atlas does not use Ruff.', use('Ruff', { polarity: 'negative' })]] as const) {
    const o = say(s, text); c.remember({ scope_id: s, claim, witness: { observation_id: o.id, quote: text } });
  }
  let packet = c.retrieve({ scope_id: s, text: 'Atlas' });
  checks.F011_polarity_disputed = !packet.assertions.some((a: any) => /Ruff/.test(a.claim)) && packet.assertions.some((a: any) => /Kitty/.test(a.claim));
  s = scope('batch');
  const batch = say(s, 'Atlas uses Ruff and Black for formatting.');
  let run = c.extractionNext();
  while (run && run.observation_id !== batch.id) { c.extractionResult({ id: run.id, error: 'MODEL_UNAVAILABLE_OR_INVALID' }); run = c.extractionNext(); }
  if (!run) throw new Error('The batch observation was not scheduled for extraction');
  c.extractionResult({ id: run.id, identity: { model: 'fixture' } });
  const quote = { observation_id: batch.id, quote: 'Atlas uses Ruff and Black for formatting.' };
  c.applyExtraction({ id: run.id, proposals: [{ claim: use('Ruff', { qualifiers: { purpose: 'formatting' } }), witness: quote }, { claim: use('Ruff', { qualifiers: { purpose: 'formatting' } }), witness: quote }, { claim: use('Black', { qualifiers: { purpose: 'formatting' } }), witness: quote }] });
  const current = c.all("SELECT status FROM assertion_versions WHERE scope_id=? AND erased=0 AND known_to_revision IS NULL", s);
  checks.F012_batch_committed = current.length === 2 && current.every(v => v.status === 'disputed');
  s = scope('question');
  const question = say(s, 'Does Atlas use Ruff for formatting?');
  checks.F013_question_candidate = c.remember({ scope_id: s, claim: use('Ruff'), witness: { observation_id: question.id, quote: 'Does Atlas use Ruff for formatting?' }, model_proposal: true }).status === 'candidate';
  const parent = scope('parent'), child = scope('child', parent);
  const inherited = say(parent, 'Atlas uses Ruff.');
  const fact = c.remember({ scope_id: parent, claim: use('Ruff'), witness: { observation_id: inherited.id, quote: 'Atlas uses Ruff.' } });
  const subject = c.one('SELECT subject_id FROM assertion_versions WHERE version_id=?', fact.id).subject_id;
  packet = c.retrieve({ scope_id: child, text: 'NoLexicalMatch', entity_ids: [subject] });
  checks.F025_inherited_anchor = packet.assertions.length === 1;
  s = scope('uncertain');
  const uncertain = say(s, 'Jade prefers Ruff since around September.');
  checks.F034_uncertain_candidate = c.remember({ scope_id: s, model_proposal: true, witness: { observation_id: uncertain.id, quote: 'Jade prefers Ruff since around September.' },
    claim: { subject: { type: 'User', name: 'Jade' }, predicate: 'PREFERS_TOOL', object: { type: 'Tool', name: 'Ruff' }, valid_mode: 'unknown', time_precision: 'approximate', time_expression: 'around September' } }).status === 'candidate';
  return checks;
}

function evaluate(c: Canonical, cases: Case[], plan: ReturnType<typeof load>) {
  const m = { required: 0, recalled: 0, reciprocal: 0, evidenceRequired: 0, evidenceRecalled: 0, relationalRequired: 0, relationalRecalled: 0, paths: 0, pathsSatisfied: 0,
    views: 0, viewsCorrect: 0, abstain: 0, abstainCorrect: 0, selected: 0, unsupported: 0, tokens: 0 };
  const latencies: number[] = [], failures: any[] = [];
  // A fact is identified by its object entity, never by the first name found in the claim text.
  const objects = new Map<string, string>();
  const factOf = (assertion: any, id: string) => {
    if (!assertion.object_entity_id) return undefined;
    if (!objects.has(assertion.object_entity_id)) objects.set(assertion.object_entity_id, c.one('SELECT name FROM entities WHERE id=?', assertion.object_entity_id).name);
    const name = objects.get(assertion.object_entity_id)!;
    return name.startsWith(`${id}-`) ? name.slice(id.length + 1) : undefined;
  };
  for (const item of cases) {
    const { scope, anchor, evidence, views } = plan.get(item.id)!;
    for (const view of views) {
      const started = performance.now();
      const packet = c.retrieve({ scope_id: scope, text: item.query, entity_ids: [anchor], ...(view.world ? { world_at_us: view.world } : {}), ...(view.known ? { known_revision: view.known } : {}) });
      latencies.push(performance.now() - started);
      m.tokens += packet.budget.estimated_tokens;
      const settled = packet.assertions.map((a: any) => factOf(a, item.id)).filter((suffix: string | undefined): suffix is string => !!suffix).map((suffix: string) => `${item.id}:${suffix}`);
      const allowed = new Set<string>([...item.requiredAssertionIds, ...(item.views || []).flatMap((v: any) => v.requiredAssertionIds), `${item.id}:prior`, `${item.id}:later`, `${item.id}:a0`, `${item.id}:a1`]);
      for (const fact of settled) { m.selected++; if (!allowed.has(fact) || fact.endsWith(':forbidden')) m.unsupported++; }
      const relational = item.category === 'single_hop' || item.category === 'multi_hop';
      if (view.name === 'main') {
        for (const expected of item.requiredAssertionIds as string[]) {
          if (item.category === 'temporal_change' || item.category === 'historical_view') continue;
          m.required++; if (relational) m.relationalRequired++;
          const rank = settled.indexOf(expected);
          if (rank >= 0 && rank < 10) { m.recalled++; m.reciprocal += 1 / (rank + 1); if (relational) m.relationalRecalled++; }
        }
        const supplied = new Set(packet.evidence.map((e: any) => e.id));
        for (const expected of item.requiredEvidenceIds as string[]) if (evidence[expected]) { m.evidenceRequired++; if (supplied.has(evidence[expected])) m.evidenceRecalled++; }
        for (const path of item.requiredPaths as string[][]) { m.paths++; if (path.every(fact => settled.includes(fact))) m.pathsSatisfied++; }
        if (item.abstain) { m.abstain++; if (!settled.length && packet.conflicts.length >= 2) m.abstainCorrect++; }
      }
      if (item.category === 'temporal_change' || item.category === 'historical_view') {
        m.views++;
        const answers = [...new Set(settled)];
        if (view.expected.every((f: string) => answers.includes(f)) && answers.every(f => view.expected.includes(f))) m.viewsCorrect++;
        else if (failures.length < 20) failures.push({ case: item.id, view: view.name, expected: view.expected, answered: answers });
      }
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b), at = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  return {
    factRecallAt10: m.recalled / m.required, relationalFactRecallAt10: m.relationalRecalled / m.relationalRequired, mrrAt10: m.reciprocal / m.required,
    evidenceRecallAt10: m.evidenceRecalled / m.evidenceRequired, pathRecall: m.pathsSatisfied / m.paths, temporalViewAccuracy: m.viewsCorrect / m.views, temporalViews: m.views,
    temporalViewFailures: failures, abstentionAccuracy: m.abstainCorrect / m.abstain, unsupportedClaimRate: m.selected ? m.unsupported / m.selected : 0, settledFacts: m.selected,
    meanEstimatedTokens: m.tokens / latencies.length, latencyMs: { p50: at(.5), p95: at(.95), p99: at(.99), samples: latencies.length },
  };
}

/**
 * Proves the planted look-alikes are live: each one is reachable when its exclusion no
 * longer applies (future world time, another scope) or is visible as a conflict rather
 * than settled, and erased ones are actually erased. A zero unsupported-claim rate is
 * therefore not an artifact of look-alikes the engine could never have found.
 */
function probes(c: Canonical, cases: Case[], plan: ReturnType<typeof load>) {
  const counts: Record<string, { planted: number; demonstrated: number }> = {};
  const object = (a: any) => a.object_entity_id && c.one('SELECT name FROM entities WHERE id=?', a.object_entity_id).name;
  for (const item of cases) {
    const entry = plan.get(item.id)!, look = entry.lookAlike;
    if (!look) continue;
    const target = `${item.id}-forbidden`, tally = counts[look.kind] ??= { planted: 0, demonstrated: 0 };
    tally.planted++;
    let shown = false;
    if (look.kind === 'future_bound')
      shown = c.retrieve({ scope_id: entry.scope, text: item.query, entity_ids: [entry.anchor], world_at_us: FUTURE + 86_400_000_000 }).assertions.some((a: any) => object(a) === target);
    else if (look.kind === 'other_scope')
      shown = c.retrieve({ scope_id: entry.other, text: `${item.id} anchor` }).assertions.some((a: any) => object(a) === target);
    else if (look.kind === 'erased')
      shown = c.one('SELECT erased FROM observations WHERE id=?', look.observation).erased === 1 && !c.one("SELECT COUNT(*) AS n FROM assertion_evidence x JOIN evidence e ON e.id=x.evidence_id JOIN assertion_versions v ON v.version_id=x.version_id WHERE e.observation_id=? AND v.erased=0", look.observation).n;
    else
      shown = c.retrieve({ scope_id: entry.scope, text: item.query, entity_ids: [entry.anchor] }).conflicts.some((a: any) => object(a) === target);
    if (shown) tally.demonstrated++;
  }
  return counts;
}

export async function runCanonical(options: { directory?: string; cases?: Case[] } = {}) {
  const cases: Case[] = options.cases ?? JSON.parse(await readFile(new URL('../../tests/fixtures/memory/retrieval-cases.json', import.meta.url), 'utf8')).cases;
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'cere-canonical-bench-'));
  const c = new Canonical(directory);
  try {
    const started = performance.now(), plan = load(c, cases), loadMs = performance.now() - started;
    const modes: Record<string, any> = {};
    for (const [mode, ranker] of [['relational_ranker', true], ['rrf_without_relational_ranker', false]] as const) {
      c.policyUpdate({ policy: { relational_ranker: ranker } });
      modes[mode] = evaluate(c, cases, plan);
    }
    const lookAlikes = probes(c, cases, plan), checks = integrity(join(directory, 'integrity'));
    const ranker = modes.relational_ranker, plain = modes.rrf_without_relational_ranker;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      engine: 'broker/graph-memory/canonical.ts Canonical.retrieve (lexical, entity anchors and graph expansion; no embeddings)',
      corpus: { cases: cases.length, temporalViews: ranker.temporalViews, loadMs, revisions: c.revision },
      retrieval: modes,
      lookAlikes,
      integrity: checks,
      gates: {
        noUnsupportedClaims: gate('no forbidden, erased, out-of-scope, planned or questioned fact settled', Math.max(ranker.unsupportedClaimRate, plain.unsupportedClaimRate), ranker.unsupportedClaimRate === 0 && plain.unsupportedClaimRate === 0),
        temporalViews: gate('every temporal and historical view answered exactly', ranker.temporalViewAccuracy, ranker.temporalViewAccuracy === 1),
        abstention: gate('every equal-authority contradiction abstains', ranker.abstentionAccuracy, ranker.abstentionAccuracy === 1),
        relationalRecallTarget: gate('relational fact recall@10 >= 0.90', ranker.relationalFactRecallAt10, ranker.relationalFactRecallAt10 >= .9),
        rankerImprovement: gate('relational ranker at least 0.05 above plain fusion on relational recall', ranker.relationalFactRecallAt10 - plain.relationalFactRecallAt10, ranker.relationalFactRecallAt10 - plain.relationalFactRecallAt10 >= .05),
        lookAlikesLive: gate('every planted look-alike is reachable, a conflict, or erased', Object.values(lookAlikes).reduce((n, t) => n + t.demonstrated, 0), Object.values(lookAlikes).every(t => t.demonstrated === t.planted)),
        integrityFixtures: gate('F-011, F-012, F-013, F-025 and F-034 fixtures hold', Object.values(checks).filter(Boolean).length, Object.values(checks).every(Boolean)),
        acceptedAssertionPrecision: gate('>= 95% accepted-assertion precision on real extraction output', null, null),
        semanticQuality: gate('production embedding retrieval quality', null, null),
      },
      limitations: [
        'Corpus text is synthetic and anchored by known entity IDs; it measures engine eligibility, temporal and conflict behavior, not natural-language recall.',
        'No embedding model, Neo4j or Qdrant is involved; semantic and projection routes are unmeasured here.',
        'Model extraction quality is not measured; integrity fixtures submit proposals directly.',
      ],
    };
  } finally { c.close(); if (!options.directory) await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = await runCanonical();
  await writeFile(new URL('./canonical-results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ gates: report.gates, integrity: report.integrity }));
}
