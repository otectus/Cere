/** W16: the evidence record certifies only the exact tested bytes, signer, source and gates. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { problems, requiredGates } from '../tools/mobile-release-evidence.ts';

const now = Date.parse('2026-10-20T12:00:00Z');
const record = () => ({
  schema: 1, tag: 'mobile-v0.1.5', commit: 'a'.repeat(40), date: '2026-10-18', tester: 'owner',
  desktopBuild: { version: '0.1.5', commit: 'a'.repeat(40), dirty: false },
  apk: { unsignedSha256: 'b'.repeat(64), packageId: 'dev.otectus.cere.mobile', versionName: '0.1.5', versionCode: 1005 },
  signerSha256: 'c'.repeat(64), device: { model: 'Pixel 10 Pro', os: 'GrapheneOS 2026101500', sdk: 37 },
  gates: Object.fromEntries(Object.keys(requiredGates).map(gate => [gate, { result: 'passed', notes: '' }])) as any,
});
const expected = { tag: 'mobile-v0.1.5', commit: 'a'.repeat(40), unsignedSha256: 'B'.repeat(64), signer: 'c'.repeat(64), now };

test('a complete record for the exact APK, signer and commit certifies the release', () => {
  assert.deepEqual(problems(record(), expected), []);
});

test('other bytes, signer, version, a stale date or an unrun gate are refused', () => {
  assert.match(problems(record(), { ...expected, unsignedSha256: 'd'.repeat(64) }).join(), /not the APK being signed/);
  assert.match(problems(record(), { ...expected, signer: 'e'.repeat(64) }).join(), /another signing certificate/);
  assert.match(problems(record(), { ...expected, tag: 'mobile-v0.1.6' }).join(), /not mobile-v0.1.6/);
  assert.match(problems(record(), { ...expected, now: now + 60 * 86_400_000 }).join(), /more than 45 days/);
  const unrun = record(); unrun.gates['upgrade'] = { result: 'not-run', notes: '' };
  assert.match(problems(unrun, expected).join(), /Gate upgrade is not-run/);
  const vague = record(); vague.gates['no-play'] = { result: 'not-applicable', notes: '' };
  assert.match(problems(vague, expected).join(), /Gate no-play is not-applicable/, 'not applicable needs a reason');
  const missing = record() as any; delete missing.desktopBuild;
  assert.match(problems(missing, expected).join(), /desktop build/);
});

test('a later commit may only add evidence records; any other change needs new gates', () => {
  const later = { ...expected, commit: 'f'.repeat(40) };
  assert.deepEqual(problems(record(), { ...later, changedSince: () => ['docs/mobile/release-evidence/mobile-v0.1.5.json'] }), []);
  assert.match(problems(record(), { ...later, changedSince: () => ['broker/core.ts'] }).join(), /Source changed after the tested commit: broker\/core.ts/);
  assert.match(problems(record(), { ...later, changedSince: () => null }).join(), /not an ancestor/);
});
