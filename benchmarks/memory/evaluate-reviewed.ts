#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Canonical } from '../../broker/graph-memory/canonical.ts';

type Row = Record<string, any>;
const utc = (date: string) => Date.parse(date + 'T00:00:00Z') * 1000;
const contains = (rows: any[], text: string) => rows.some(row => JSON.stringify(row).includes(text));

function claim(value: Row): Row {
  const copy = structuredClone(value);
  if (copy.valid_from) { copy.valid_from_us = utc(copy.valid_from); delete copy.valid_from; }
  if (copy.valid_to) { copy.valid_to_us = utc(copy.valid_to); delete copy.valid_to; }
  return copy;
}

export async function evaluateReviewed(options: { directory?: string; fixture?: Row } = {}) {
  const fixture = options.fixture ?? JSON.parse(await readFile(new URL('../../tests/fixtures/memory/review-cases.json', import.meta.url), 'utf8'));
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'cere-memory-review-'));
  const c = new Canonical(directory), scopes = new Map<string, string>();
  const results: Row[] = [], statuses = { expected: 0, correct: 0, accepted: 0, candidate: 0, disputed: 0, rejected: 0 };
  let qualityChecks = 0, qualityPassed = 0, restoredErasure = true;
  try {
    for (const item of fixture.cases as Row[]) {
      const scopeKey = `${item.scope}:${item.id}`;
      let scope = scopes.get(scopeKey);
      if (!scope) { scope = c.registerScope({ key: 'review:' + scopeKey, label: item.scope }).id; scopes.set(scopeKey, scope!); }
      const steps = new Map<string, Row>(), observations = new Map<string, string>();
      const actual: string[] = [];
      for (const [index, step] of (item.steps as Row[]).entries()) {
        const observation = c.observeText({ scope_id: scope, text: step.text, role: step.role, session_id: step.session || `${item.id}:session`, source_event_id: `${item.id}:${index}` });
        if (step.id) observations.set(step.id, observation.id);
        let status = 'rejected', result: Row | undefined;
        try {
          const target = step.target ? steps.get(step.target) : undefined;
          const request: Row = { scope_id: scope, claim: claim(step.claim), witness: { observation_id: observation.id, quote: step.quote || step.text }, model_proposal: true };
          if (target) { request.id = target.id; request.expected_revision = target.aggregate_revision; }
          result = c.remember(request, step.operation === 'correct' ? 'correct' : step.operation === 'resolve' ? 'resolve' : 'assert');
          status = c.inspect({ scope_id: scope, id: result.id }).record.status;
          if (step.id) steps.set(step.id, result);
        } catch { /* Rejection is an evaluated outcome. */ }
        actual.push(status); statuses.expected++; if (status === step.expect) statuses.correct++;
        if (status in statuses) (statuses as any)[status]++;
      }

      if (item.forgetObservation) c.forget({ scope_id: scope, id: observations.get(item.forgetObservation) });
      if (item.forgetLogical) {
        const version = steps.get(item.forgetLogical)!;
        const logical = c.one('SELECT logical_id FROM assertion_versions WHERE version_id=?', version.id).logical_id;
        c.forget({ scope_id: scope, id: logical });
      }

      let engine = c, restored: Canonical | undefined;
      if (item.category === 'backup-forget') {
        const target = steps.get('secret')!, backup = join(directory, `${item.id}-before.sqlite`), staging = join(directory, `${item.id}-restored`);
        await c.backup({ output: backup }); c.forget({ scope_id: scope, id: target.id }); await c.restore({ input: backup, staging });
        restored = new Canonical(staging); engine = restored;
      }
      const packet = engine.retrieve({ scope_id: scope, text: item.query, ...(item.worldAt ? { world_at_us: utc(item.worldAt) } : {}) });
      const settled = packet.assertions.filter((row: Row) => row.status === 'accepted'), conflicts = packet.conflicts;
      const checks: Row[] = [];
      for (const text of item.include || []) checks.push({ kind: 'include', text, passed: contains(settled, text) });
      for (const text of item.exclude || []) checks.push({ kind: 'exclude', text, passed: !contains(settled, text) });
      for (const text of item.conflicts || []) checks.push({ kind: 'conflict', text, passed: contains(conflicts, text) });
      if (item.evidenceCount !== undefined) checks.push({ kind: 'evidence', expected: item.evidenceCount, passed: settled.some((row: Row) => row.evidence_ids?.length === item.evidenceCount) });
      qualityChecks += checks.length; qualityPassed += checks.filter(check => check.passed).length;
      if (restored) { restoredErasure &&= packet.results.length === 0 && !contains([...settled, ...conflicts], 'SecretTool'); restored.close(); }
      results.push({ id: item.id, category: item.category, expectedStatuses: item.steps.map((step: Row) => step.expect), actualStatuses: actual, checks });
    }
    return {
      schemaVersion: 1,
      evaluation: 'fixture-based deterministic canonical memory review; no model or network calls',
      cases: fixture.cases.length,
      proposalStatusAccuracy: statuses.expected ? statuses.correct / statuses.expected : 0,
      acceptedAssertionQuality: qualityChecks ? qualityPassed / qualityChecks : 0,
      statusCounts: statuses,
      restoredErasure,
      passed: statuses.correct === statuses.expected && qualityPassed === qualityChecks && restoredErasure,
      results,
      limitations: [
        'Claims are deterministic fixture proposals; proposal status accuracy is not extraction-model precision.',
        'Accepted-assertion quality measures canonical acceptance, scope, time, conflict and erasure behavior for these fixtures only.',
        'No cloud service, embedding model, microphone, or network endpoint is used.',
      ],
    };
  } finally { c.close(); if (!options.directory) await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = await evaluateReviewed();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
