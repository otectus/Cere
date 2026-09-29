#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';

const categories = ['exact_identifier', 'single_hop', 'multi_hop', 'temporal_change', 'historical_view', 'interrupted_task', 'contradiction_abstention'] as const;
const cases = categories.flatMap((category, categoryIndex) => Array.from({ length: 10 }, (_, index) => {
  const number = categoryIndex * 10 + index;
  const id = `case-${String(number).padStart(2, '0')}`;
  const relational = category === 'single_hop' || category === 'multi_hop';
  const abstain = category === 'contradiction_abstention';
  const assertionIds = abstain ? [] : category === 'multi_hop' ? [`${id}:a0`, `${id}:a1`] : [`${id}:a0`];
  const evidenceIds = assertionIds.map((_, offset) => `${id}:e${offset}`);
  return {
    id,
    split: index % 2 === 0 ? 'development' : 'heldout',
    category,
    query: `${id} synthetic ${category.replaceAll('_', ' ')}`,
    eligibleScopes: [`scope-${number % 4}`],
    worldAtUs: category === 'historical_view' ? 1_500_000 : 3_000_000,
    knownRevision: category === 'historical_view' ? 50 : 100_000,
    sourceTimeline: abstain ? [
      { revision: 10, atUs: 1_000_000, event: 'conflicting_candidate', evidenceId: `${id}:e0` },
      { revision: 11, atUs: 1_000_001, event: 'equal_authority_conflict', evidenceId: `${id}:e1` },
    ] : assertionIds.map((assertionId, offset) => ({ revision: 10 + offset, atUs: 1_000_000 + offset, event: assertionId, evidenceId: evidenceIds[offset] })),
    expectedFacts: abstain ? [] : assertionIds.map(assertionId => `fact:${assertionId}`),
    requiredAssertionIds: assertionIds,
    requiredEvidenceIds: evidenceIds,
    requiredPaths: relational ? [assertionIds] : [],
    forbiddenFacts: abstain ? [`fact:${id}:left`, `fact:${id}:right`] : [`fact:${id}:forbidden`],
    abstain,
    anchorEntityId: `entity-${String(number).padStart(5, '0')}`,
    policyChanges: number % 10 === 8 ? [{ revision: 90_000, action: 'exclude_other_scopes' }] : [],
    deletionChanges: number % 10 === 9 ? [{ revision: 90_001, target: `${id}:deleted-copy` }] : [],
    repeatedSourceIds: number % 3 === 0 ? [`${id}:repeat`] : [],
  };
}));

await mkdir(new URL('../../tests/fixtures/memory/', import.meta.url), { recursive: true });
await writeFile(new URL('../../tests/fixtures/memory/retrieval-cases.json', import.meta.url), `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`);
console.log(JSON.stringify({ cases: cases.length, development: 35, heldout: 35, relational: 20 }));
