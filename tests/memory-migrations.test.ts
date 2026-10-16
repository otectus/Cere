import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrations, schema } from '../broker/graph-memory/schema.ts';

// Checksums that stores record when they apply each migration. The live store has carried all five
// since 15 October 2026, and Canonical.migrate refuses any store whose recorded checksum differs from
// the code's, so editing an applied migration would leave existing memory unreadable. Pin each new
// migration here once it ships.
const applied: Record<number, string> = {
  1: 'f81269ed121069331d357b7244e9605ff810aafc89ffb25bcff0727257acf25a',
  2: '22e189a9a7aecc25c8f4279f80d1c8227b0e7ba91b3fb474ac9bf489914dd2cc',
  3: '8d7400e82b0ad94fcbcf0fb6fb41888f9a6a95995badc3cff77ab58105bc1e73',
  4: '2e488843376a205fba32765044518e735e4a789a1812b6b968975419c2e91e67',
  5: 'fa3a04d5ee812bac2a80d207c533710444649077807a1c54df46117035b1ecf5',
};

test('S3 applied memory migrations are never edited', () => {
  const digest = (sql: string) => createHash('sha256').update(sql).digest('hex');
  const current = new Map([[1, digest(schema)], ...migrations.map((migration): [number, string] => [migration.id, digest(migration.sql)])]);
  for (const [id, checksum] of Object.entries(applied))
    assert.equal(current.get(Number(id)), checksum, `memory migration ${id} changed: add a new migration; never edit an applied one`);
  assert.deepEqual(migrations.map(migration => migration.id), migrations.map((_, index) => index + 2), 'migrations follow the schema in order');
});
