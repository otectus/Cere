import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, propose, proposalLimits } from '../broker/file-proposals.ts';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'cere-file-proposals-')), vault = join(root, 'vault'), backups = join(root, 'backups');
  await mkdir(vault);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, vault, backups };
}

test('AUD-007 same-base edits and creates serialize so exactly one reviewed operation commits', async t => {
  const { vault, backups } = await fixture(t);
  await writeFile(join(vault, 'edit.md'), 'base');
  const editA = await propose({ root: vault, path: 'edit.md', content: 'A', sessionId: 'a' });
  const editB = await propose({ root: vault, path: 'edit.md', content: 'B', sessionId: 'b' });
  const edits = await Promise.allSettled([apply(editA, backups), apply(editB, backups)]);
  assert.deepEqual(edits.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const rejectedEdit = edits.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejectedEdit.reason.code, 'STALE_BASE');
  assert.ok(['A', 'B'].includes(await readFile(join(vault, 'edit.md'), 'utf8')));

  const createA = await propose({ root: vault, path: 'new.md', content: 'A', sessionId: 'a' });
  const createB = await propose({ root: vault, path: 'new.md', content: 'B', sessionId: 'b' });
  const creates = await Promise.allSettled([apply(createA, backups), apply(createB, backups)]);
  assert.deepEqual(creates.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const rejectedCreate = creates.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejectedCreate.reason.code, 'STALE_BASE');
  assert.ok(['A', 'B'].includes(await readFile(join(vault, 'new.md'), 'utf8')));
});

test('AUD-007 commit validation, external changes and symlink swaps fail closed without temporary files', async t => {
  const { root, vault, backups } = await fixture(t);
  const target = join(vault, 'note.md');
  await writeFile(target, 'base');

  const revoked = await propose({ root: vault, path: 'note.md', content: 'reviewed', sessionId: 's' });
  await assert.rejects(apply(revoked, backups, () => { throw new Error('Vault authority changed'); }), /authority changed/);
  assert.equal(await readFile(target, 'utf8'), 'base');
  assert.ok(!(await readdir(vault)).some(name => name.includes('.cere-')));

  const externallyChanged = await propose({ root: vault, path: 'note.md', content: 'reviewed', sessionId: 's' });
  let checks = 0;
  await assert.rejects(apply(externallyChanged, backups, async () => {
    if (++checks === 1) await writeFile(target, 'external');
  }), (error: any) => error.code === 'STALE_BASE');
  assert.equal(await readFile(target, 'utf8'), 'external');
  assert.ok(!(await readdir(vault)).some(name => name.includes('.cere-')));

  const outside = join(root, 'outside.md');
  await writeFile(target, 'base'); await writeFile(outside, 'outside');
  const swapped = await propose({ root: vault, path: 'note.md', content: 'reviewed', sessionId: 's' });
  await assert.rejects(apply(swapped, backups, async () => {
    await rm(target); await symlink(outside, target);
  }), /Linked files cannot be edited/);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  assert.ok(!(await readdir(vault)).some(name => name.includes('.cere-')));
});

test('AUD-011 file proposals reject incomplete previews and bind the reviewed content to a digest', async t => {
  const { vault, backups } = await fixture(t);
  await assert.rejects(propose({ root: vault, path: 'large.md', content: Array.from({ length: proposalLimits.diffLines + 1 }, (_, index) => `line ${index}`).join('\n'), sessionId: 's' }), /too large to review completely/);

  const proposal = await propose({ root: vault, path: 'bound.md', content: 'reviewed', sessionId: 's', reason: 'exact content' });
  assert.match(proposal.digest, /^[0-9a-f]{64}$/);
  proposal.content = 'changed after review';
  await assert.rejects(apply(proposal, backups), /changed after review/);
  await assert.rejects(readFile(join(vault, 'bound.md')), /ENOENT/);
});

test('AUD-007 synchronous commit guard rejects authority lost after asynchronous validation',async t=>{
  const {vault,backups}=await fixture(t);await writeFile(join(vault,'note.md'),'base');
  const proposal=await propose({root:vault,path:'note.md',content:'replacement',sessionId:'s'});
  await assert.rejects(apply(proposal,backups,()=>{},()=>{throw new Error('Permission revoked at commit');}),/revoked at commit/);
  assert.equal(await readFile(join(vault,'note.md'),'utf8'),'base');
});
