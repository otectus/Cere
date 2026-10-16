import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Canonical } from '../broker/graph-memory/canonical.ts';

// A05 retention, correction and erasure gates for M05's retention pins, plus M05's timeline and
// bounded neighborhood views. A pin keeps a record from retention expiry; it is never truth.
function canonical(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cere-curation-'));
  const c = new Canonical(directory);
  t.after(() => { c.close(); rmSync(directory, { recursive: true, force: true }); });
  return { c, scope: c.registerScope({ key: 'curation', label: 'Curation' }).id, other: c.registerScope({ key: 'other', label: 'Other' }).id };
}
const say = (c: Canonical, scope: string, text: string) => c.observeText({ scope_id: scope, text, role: 'user', session_id: 'past' });
const expirePayload = (c: Canonical, observation: string) => c.run("UPDATE payloads SET expires_us=? WHERE id=(SELECT payload_id FROM observations WHERE id=?)", Date.now() * 1000 - 1_000_000, observation);
function assertTool(c: Canonical, scope: string, text: string, tool: string) {
  const source = say(c, scope, text);
  return { source, result: c.remember({ scope_id: scope, claim: { subject: { type: 'Project', name: 'orchid' }, predicate: 'USES_TOOL', object: { type: 'Tool', name: tool } }, witness: { observation_id: source.id, quote: text } }) };
}

test('A05 a pinned passage survives retention expiry while unpinned ones expire, and unpinning restores expiry', t => {
  const { c, scope } = canonical(t);
  const kept = say(c, scope, 'The orchid deploy key rotates every ninety days.'), lost = say(c, scope, 'The orchid cache warms up overnight.');
  const pin = c.pin({ scope_id: scope, id: kept.id, note: 'Needed for the yearly audit' });
  assert.equal(pin.target_kind, 'observation');
  assert.equal((c.pin({ scope_id: scope, id: kept.id }) as any).existing, true, 'pinning twice keeps one pin');
  expirePayload(c, kept.id); expirePayload(c, lost.id);
  c.expire();
  assert.equal(c.one('SELECT erased FROM observations WHERE id=?', kept.id).erased, 0, 'the pinned passage stays');
  assert.equal(c.one('SELECT erased FROM observations WHERE id=?', lost.id).erased, 1, 'an unpinned passage still expires');
  assert.equal(c.pins({ scope_id: scope }).rows[0].text, 'The orchid deploy key rotates every ninety days.');
  c.unpin({ scope_id: scope, pin_id: pin.id });
  assert.throws(() => c.unpin({ scope_id: scope, pin_id: pin.id }), /no longer active/);
  c.expire();
  assert.equal(c.one('SELECT erased FROM observations WHERE id=?', kept.id).erased, 1, 'without its pin it expires like any other');
});

test('A05 a pin changes no status or retrieval result, follows a correction, and goes away with an erasure', t => {
  const { c, scope, other } = canonical(t);
  const first = assertTool(c, scope, 'orchid uses pnpm for installs.', 'pnpm');
  const before = c.retrieve({ scope_id: scope, text: 'orchid tool' });
  const status = c.one('SELECT status,extraction_confidence FROM assertion_versions WHERE version_id=?', first.result.id);
  const pin = c.pin({ scope_id: scope, id: first.result.id, note: 'Team convention' });
  assert.equal(pin.target_kind, 'assertion');
  assert.deepEqual(c.one('SELECT status,extraction_confidence FROM assertion_versions WHERE version_id=?', first.result.id), status, 'pinning is not believing');
  const after = c.retrieve({ scope_id: scope, text: 'orchid tool' });
  // Same order; scores differ only by the time-based recency decay between the two calls.
  assert.deepEqual(after.results.map((row: any) => row.id), before.results.map((row: any) => row.id), 'ranking is unchanged');
  after.results.forEach((row: any, index: number) => assert.ok(Math.abs(row.score - before.results[index].score) < 1e-6 * before.results[index].score));
  // A pinned candidate is exempt from candidate expiry.
  c.run('UPDATE assertion_versions SET expires_at_us=? WHERE version_id=?', Date.now() * 1000 - 1_000_000, first.result.id);
  c.expire();
  assert.equal(c.one('SELECT erased FROM assertion_versions WHERE version_id=?', first.result.id).erased, 0);
  // A pinned fact stays correctable, and the pin follows it to the corrected version.
  const slot = c.one('SELECT aggregate_revision FROM fact_slots WHERE id=?', first.result.slot_id).aggregate_revision;
  const source = say(c, scope, 'orchid uses bun for installs now.');
  const corrected = c.remember({ scope_id: scope, id: first.result.id, expected_revision: slot, claim: { subject: { type: 'Project', name: 'orchid' }, predicate: 'USES_TOOL', object: { type: 'Tool', name: 'bun' } }, witness: { observation_id: source.id, quote: 'orchid uses bun for installs now.' } }, 'correct');
  assert.equal(c.inspect({ scope_id: scope, id: corrected.id }).retention_pin?.id, pin.id);
  // Pins never reach another project's scope.
  assert.throws(() => c.pin({ scope_id: other, id: first.source.id }), /Only a live passage or assertion in this project/);
  // Forgetting removes the pinned record and the pin, note included.
  c.forget({ scope_id: scope, id: first.source.id }); c.forget({ scope_id: scope, id: source.id });
  assert.equal(c.one("SELECT COUNT(*) AS n FROM retention_pins WHERE note='Team convention'").n, 0);
  assert.equal(c.pins({ scope_id: scope }).total, 0);
  // Credentials never become pin notes.
  const passage = say(c, scope, 'Keep this passage.');
  assert.throws(() => c.pin({ scope_id: scope, id: passage.id, note: 'api_key=sk-live-0123456789abcdef0123456789abcdef' }));
});

test('M05 a timeline separates valid time from recording time, links evidence and names what changed', t => {
  const { c, scope } = canonical(t);
  const first = assertTool(c, scope, 'orchid uses npm for installs.', 'npm');
  const slot = c.one('SELECT aggregate_revision FROM fact_slots WHERE id=?', first.result.slot_id).aggregate_revision;
  const later = say(c, scope, 'Correction: orchid uses pnpm for installs.');
  c.remember({ scope_id: scope, id: first.result.id, expected_revision: slot, claim: { subject: { type: 'Project', name: 'orchid' }, predicate: 'USES_TOOL', object: { type: 'Tool', name: 'pnpm' } }, witness: { observation_id: later.id, quote: 'orchid uses pnpm for installs.' } }, 'correct');
  const timeline = c.timeline({ scope_id: scope, id: first.result.id });
  assert.equal(timeline.entries.length, 2);
  const [old, current] = timeline.entries;
  assert.equal(old.current, false); assert.equal(current.current, true);
  assert.ok(old.known.to_revision !== null && old.known.to_revision <= current.known.from_revision, 'recording intervals do not overlap');
  assert.deepEqual(current.changed, ['object'], 'only the object changed');
  assert.match(current.evidence[0].witness, /orchid uses pnpm for installs\./);
  assert.ok(current.evidence[0].observation_id === later.id);
  assert.equal(timeline.pinned, false);
  assert.throws(() => c.timeline({ scope_id: scope, id: later.id }), /Timelines describe assertions/);
});

test('M05 a neighborhood is one hop, current, accepted and bounded', t => {
  const { c, scope } = canonical(t);
  for (let index = 0; index < 30; index++) assertTool(c, scope, `orchid uses tool-${index} for builds.`, `tool-${index}`);
  const anchor = c.one("SELECT version_id FROM assertion_versions WHERE erased=0 LIMIT 1").version_id;
  const view = c.neighborhood({ scope_id: scope, id: anchor, limit: 12 });
  assert.equal(view.entity.name, 'orchid');
  assert.equal(view.edges.length, 12); assert.equal(view.truncated, true);
  assert.ok(view.edges.every((edge: any) => edge.direction === 'out' && edge.predicate === 'USES_TOOL' && /^tool-\d+$/.test(edge.other.name)));
  assert.equal(c.neighborhood({ scope_id: scope, id: anchor, limit: 500 }).edges.length, 24, 'never more than 24 edges');
  assert.deepEqual(c.call('ontology').then((value: any) => value.predicates.includes('USES_TOOL')) instanceof Promise, true);
});

test('M05 the broker exposes curation through memory.graph within the conversation’s project', async t => {
  const { Core } = await import('../broker/core.ts');
  const { Store } = await import('../broker/store.ts');
  const dir = mkdtempSync(join(tmpdir(), 'cere-curation-core-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.updateSettings({ memory: { enabled: true }, ollama: { host: 'http://127.0.0.1:9' } });
  await core.memory.ready;
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  const saved = await core.memory.save(session, 'Release notes go in docs/RELEASES.md.');
  const pin = await core.rpc('memory.graph', { sessionId: session.id, method: 'pin', params: { id: saved.id, note: 'Keep' } });
  assert.equal(pin.target_id, saved.id);
  assert.equal((await core.rpc('memory.graph', { sessionId: session.id, method: 'pins', params: {} })).total, 1);
  assert.ok((await core.rpc('memory.graph', { method: 'ontology', params: {} })).predicates.includes('BLOCKED_BY'));
  await assert.rejects(core.rpc('memory.graph', { method: 'pins', params: {} }), /Choose a conversation/);
});

test('A05 identity decisions take effect in recall: same joins, not-same blocks, revert splits', t => {
  const { c, scope } = canonical(t);
  const fact = (project: string, tool: string) => {
    const text = `${project} uses ${tool} for builds.`, source = say(c, scope, text);
    return c.remember({ scope_id: scope, claim: { subject: { type: 'Project', name: project }, predicate: 'USES_TOOL', object: { type: 'Tool', name: tool } }, witness: { observation_id: source.id, quote: text } });
  };
  fact('orchid', 'vite'); fact('orchid web', 'pnpm'); fact('orchid mobile', 'gradle');
  const entity = (name: string) => c.one("SELECT e.id FROM entities e JOIN entity_aliases a ON a.entity_id=e.id WHERE a.normalized=? AND e.erased=0", name).id;
  const [orchid, web, mobile] = ['orchid', 'orchid web', 'orchid mobile'].map(entity);
  // A text with no lexical match: only the anchor, and the identity decisions around it, select facts.
  const recalled = () => c.retrieve({ scope_id: scope, text: 'zqxj', entity_ids: [orchid] }).assertions.map((a: any) => a.claim).sort().join(' | ');
  const witness = () => { const text = 'orchid web is the same project as orchid.'; const source = say(c, scope, text); return { observation_id: source.id, quote: text }; };
  assert.doesNotMatch(recalled(), /pnpm/, 'separate entities are recalled separately');
  // "possible" is a note for review and changes nothing.
  const possible = c.identity({ scope_id: scope, left_id: orchid, right_id: web, decision: 'possible', witness: witness() });
  assert.deepEqual([possible.applied, possible.recorded_only], [false, true]);
  assert.doesNotMatch(recalled(), /pnpm/);
  const same = c.identity({ scope_id: scope, left_id: orchid, right_id: web, decision: 'same', witness: witness() });
  assert.deepEqual([same.applied, same.recorded_only], [true, false]);
  assert.deepEqual(new Set(same.members), new Set([orchid, web]));
  assert.match(recalled(), /pnpm/, 'a same decision joins them in recall');
  // A not-same decision is a hard block: a chain of same links cannot join that pair.
  c.identity({ scope_id: scope, left_id: orchid, right_id: mobile, decision: 'not_same', witness: witness() });
  c.identity({ scope_id: scope, left_id: web, right_id: mobile, decision: 'same', witness: witness() });
  assert.doesNotMatch(recalled(), /gradle/, 'not-same keeps orchid mobile apart even through orchid web');
  assert.match(recalled(), /pnpm/);
  // Reverting the same decision splits them again; nothing about either entity was rewritten.
  const link = c.one("SELECT id,revision FROM identity_links WHERE id=?", same.id);
  const reverted = c.identity({ scope_id: scope, revert_id: same.id, expected_revision: link.revision });
  assert.equal(reverted.applied, true);
  assert.doesNotMatch(recalled(), /pnpm/);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM assertion_versions WHERE subject_id=? AND erased=0", web).n, 1, 'assertions keep their own subjects');
});
