import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { behaviorInstructions, builtinPostures, resolveBehavior, traitConflicts, validCeiling, validTraits } from '../broker/behavior.ts';
import { checkReply, validConstraints } from '../broker/style-checks.ts';
import { defaultPersonality, personalityInstructions } from '../broker/personality.ts';
import type { BehaviorProfile } from '../broker/behavior.ts';

const profile = (patch: Partial<BehaviorProfile>): BehaviorProfile => ({ id: 'p', label: 'P', text: 'Be calm.', traits: {}, instructions: '', ceiling: {}, posture: false, revision: '1', created: 0, updated: 0, ...patch });

test('M01 with nothing chosen, the behavior block is the personality block byte for byte', () => {
  for (const personality of [defaultPersonality, '', 'Be terse.\nNo jokes.']) for (const name of ['Cere', 'Nova', '“Étoile”'])
    assert.equal(behaviorInstructions(resolveBehavior({ personality, profiles: [] }), name), personalityInstructions(personality, name));
});

test('M01 resolution is deterministic: conversation, then project, then global; postures narrow and never grant', () => {
  const project = profile({ id: 'project', label: 'Project style', text: 'Project voice.', traits: { verbosity: -1, humor: 1 }, ceiling: { web: false } });
  const session = profile({ id: 'session', label: 'Session style', text: 'Session voice.', traits: { verbosity: 2 }, instructions: 'Use British spelling.' });
  const profiles = [project, session];
  assert.equal(resolveBehavior({ personality: 'Global.', profiles }).source, 'global');
  const fromProject = resolveBehavior({ personality: 'Global.', profiles, projectProfileId: 'project' });
  assert.deepEqual([fromProject.source, fromProject.text, fromProject.ceiling], ['project', 'Project voice.', { web: false }]);
  const fromSession = resolveBehavior({ personality: 'Global.', profiles, projectProfileId: 'project', sessionProfileId: 'session', instructions: 'Cite file paths.' });
  assert.deepEqual([fromSession.source, fromSession.text], ['session', 'Session voice.']);
  assert.deepEqual(fromSession.traits, { verbosity: 2 }, 'the session style replaces the project style, traits included');
  assert.equal(fromSession.instructions, 'Use British spelling.\n\nCite file paths.');
  // A posture overlays traits and adds limits; a true ceiling value is never stored, so it cannot grant.
  const review = builtinPostures.find(item => item.id === 'posture:review')!;
  const withPosture = resolveBehavior({ personality: 'Global.', profiles, projectProfileId: 'project', postureId: review.id, pinned: true });
  assert.deepEqual(withPosture.ceiling, { web: false, desktop: false, delegation: false, extensions: false }, 'review also withholds extension tools (A02)');
  assert.deepEqual(withPosture.posture!.pinned, true);
  assert.deepEqual(validCeiling({ desktop: true, web: false }), { web: false });
  // A missing style falls back visibly to the next level.
  const missing = resolveBehavior({ personality: 'Global.', profiles, projectProfileId: 'project', sessionProfileId: 'deleted' });
  assert.equal(missing.source, 'project'); assert.match(missing.warnings[0], /no longer exists/);
  // Rendering names the posture's duration and the withheld tools; neutral traits emit nothing.
  const block = behaviorInstructions(withPosture, 'Cere');
  assert.match(block, /Current posture: Review, pinned to this conversation until the user changes it\./);
  assert.match(block, /withholds Cere's web, desktop, delegation, extension tools/);
  assert.doesNotMatch(behaviorInstructions(resolveBehavior({ personality: 'x', profiles: [profile({ traits: validTraits({ verbosity: 0, humor: 0 }) })], sessionProfileId: 'p' }), 'Cere'), /Conversation preferences/);
  assert.throws(() => validTraits({ verbosity: 3 }), /-2 to 2/);
  assert.throws(() => validTraits({ charm: 1 }), /Traits are/);
});

test('M02 output checks annotate prose only and never edit it', () => {
  const reply = 'Done 🎉 — all set.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nconst x = "—"; // 🎉\n```';
  const notes = checkReply(reply, ['no-emoji', 'no-em-dash', 'no-markdown-table']);
  assert.deepEqual(notes.map(note => [note.constraint, note.count]), [['no-emoji', 1], ['no-em-dash', 1], ['no-markdown-table', 1]]);
  assert.deepEqual(checkReply('Plain prose, no flourishes.', ['no-emoji', 'no-em-dash', 'no-markdown-table']), []);
  assert.throws(() => validConstraints(['no-adverbs']), /supported formatting checks/);
});

test('RC-06 emoji are what a reader sees as emoji, and every GFM table shape is a table, outside code', () => {
  const emoji = (text: string) => checkReply(text, ['no-emoji'])[0]?.count ?? 0;
  for (const [text, count] of [['😀', 1], ['👍🏽', 1], ['❤️', 1], ['🇺🇸', 1], ['👨‍👩‍👧', 1], ['✅ done', 1], ['😀 and 🇺🇸 and ❤️', 3]] as const) assert.equal(emoji(text), count, text);
  for (const text of ['©', '®', '™', '→', '↔', '•', '✓', 'Copyright © 2026, Cere™ ↔ ok ✓']) assert.equal(emoji(text), 0, text);
  const tables = (text: string) => checkReply(text, ['no-markdown-table'])[0]?.count ?? 0;
  for (const text of ['a | b\n--- | ---\n1 | 2', '| a |\n| --- |\n| 1 |', '| a | b |\n|-|-|\n| 1 | 2 |', 'a | b\n:-- | --:\n1 | 2', '| A | B |\n|---|---|\n| 1 | 2 |'])
    assert.equal(tables(text), 1, JSON.stringify(text));
  for (const text of ['Heading\n---\nprose', 'a\n\n| --- |', '```\n| a | b |\n|---|---|\n```', 'x - y | z'])
    assert.equal(tables(text), 0, JSON.stringify(text));
});

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any, factory: any = idle) {
  const dir = await mkdtemp(join(tmpdir(), 'cere-behavior-'));
  const core = new Core(new Store(dir), factory);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  return { core, dir };
}

test('M01 a style can withhold Cere tools but never add any, for API/Ollama and CLI conversations alike', async t => {
  const { core, dir } = await broker(t);
  core.capabilities.ollama = { available: true, modelsStatus: 'ready', models: [{ id: 'm', displayName: 'm', description: '', efforts: [], defaultEffort: '', isDefault: true, capabilities: ['completion', 'tools'] }] };
  await core.updateSettings({ categories: ['timers', 'apps'], webSearch: { enabled: true } });
  const ollama = await core.create({ provider: 'ollama', model: 'm', cwd: dir, tools: true, trusted: true });
  const names = () => core.toolsFor(ollama.id).map(tool => tool.function.name);
  assert.ok(names().includes('timer_start') && names().includes('web_search'));
  const limited = await core.rpc('presets.save', { label: 'Quiet', text: 'Be quiet.', ceiling: { desktop: false, web: false, memory: true }, expectedRevision: '0' });
  assert.deepEqual(limited.ceiling, { desktop: false, web: false }, 'a true limit is not stored: it could only grant');
  await core.rpc('session.behavior', { id: ollama.id, profileId: limited.id });
  assert.ok(!names().some(name => ['timer_start', 'apps_launch', 'web_search', 'web_read'].includes(name)), names().join(','));
  await assert.rejects(core.callTool(ollama.id, 'timer_start', { minutes: 1, label: 'x' }, new AbortController().signal), /disabled/);
  // With every desktop category off, no style can bring a desktop tool back.
  await core.rpc('session.behavior', { id: ollama.id, profileId: null });
  await core.updateSettings({ categories: [] });
  assert.ok(!names().some(name => name.startsWith('timer_') || name.startsWith('apps_')));
  // CLI conversations: Cere's MCP tools follow the same ceiling.
  await core.updateSettings({ categories: ['timers'] });
  const codex = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  core.ensureAdapter(core.store.session(codex.id));
  const token = [...core.tokens].find(([, owner]) => owner === codex.id)![0];
  assert.ok((await core.rpc('mcp.tools', { token })).some((tool: any) => tool.name === 'timer.start'));
  await core.rpc('session.behavior', { id: codex.id, postureId: 'posture:review' });
  assert.deepEqual(await core.rpc('mcp.tools', { token }), []);
  await assert.rejects(core.rpc('mcp.call', { token, name: 'timer.start', args: { minutes: 1, label: 'x' } }), /withholds desktop tools/);
});

test('M01 bindings: project and conversation styles, turn and pinned postures, recorded in the turn plan', async t => {
  const sent: string[] = [];
  const { core, dir } = await broker(t, (_s: any, hooks: any) => ({ async send() { sent.push(hooks.behavior()); setTimeout(() => hooks.event({ type: 'complete' }), 2); }, async interrupt() {}, async close() {} }));
  const projectStyle = await core.rpc('presets.save', { label: 'Project voice', text: 'Speak like a release manager.', traits: { directness: 2 }, expectedRevision: '0' });
  const sessionStyle = await core.rpc('presets.save', { label: 'Mentor', text: 'Mentor the user.', instructions: 'Ask one question at a time.', expectedRevision: core.presets.catalog().revision });
  await core.rpc('projects.save', { cwd: dir, name: 'Demo', favorite: false, expectedRevision: '0', defaults: { provider: 'codex', model: '', effort: '', tools: false, trusted: true, temporary: false } });
  await core.rpc('projects.setProfile', { cwd: dir, expectedRevision: '1', profileId: projectStyle.id });
  // Editing other project settings keeps its style.
  const saved = await core.rpc('projects.save', { cwd: dir, name: 'Demo renamed', favorite: true, expectedRevision: '2', defaults: { provider: 'codex', model: '', effort: '', tools: false, trusted: true, temporary: false } });
  assert.equal(saved.behaviorProfileId, projectStyle.id);
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  const wait = async () => { for (let index = 0; index < 200 && core.store.session(session.id).status !== 'idle'; index++) await new Promise(resolve => setTimeout(resolve, 5)); };
  await core.rpc('session.send', { id: session.id, text: 'First' }); await wait();
  assert.match(sent.at(-1)!, /Speak like a release manager\./); assert.match(sent.at(-1)!, /Be blunt and concise about problems\./);
  await core.rpc('session.behavior', { id: session.id, profileId: sessionStyle.id, instructions: 'Use metric units.' });
  await core.rpc('session.send', { id: session.id, text: 'Second', posture: 'posture:plan' }); await wait();
  assert.match(sent.at(-1)!, /Mentor the user\./); assert.match(sent.at(-1)!, /Ask one question at a time\.\n\nUse metric units\./);
  assert.match(sent.at(-1)!, /Current posture: Plan, for this turn only/);
  const plan = (await core.rpc('session.context', { id: session.id })).lastPlan;
  assert.deepEqual(plan.layers[0].detail.source, 'session'); assert.equal(plan.layers[0].detail.posture, 'Plan (this turn)');
  await core.rpc('session.send', { id: session.id, text: 'Third' }); await wait();
  assert.doesNotMatch(sent.at(-1)!, /Current posture/, 'a turn posture ends with its turn');
  await core.rpc('session.behavior', { id: session.id, postureId: 'posture:brief' });
  await core.rpc('session.send', { id: session.id, text: 'Fourth' }); await wait();
  assert.match(sent.at(-1)!, /Current posture: Brief, pinned to this conversation/);
  await assert.rejects(core.rpc('session.send', { id: session.id, text: 'Fifth', posture: 'posture:unknown' }), /posture no longer exists/);
  await assert.rejects(core.rpc('session.behavior', { id: session.id, postureId: sessionStyle.id }), /posture no longer exists/, 'only styles marked as postures are postures');
  // Deleting the conversation's style falls back to the project's, visibly.
  await core.rpc('presets.delete', { id: sessionStyle.id, expectedItemRevision: '1' });
  const resolved = await core.rpc('behavior.resolve', { id: session.id });
  assert.equal(resolved.source, 'project'); assert.match(resolved.warnings[0], /no longer exists/);
});

test('M02 checkpoints are immutable, restoring makes a new revision, and checked replies keep their text', async t => {
  const { core, dir } = await broker(t, (_s: any, hooks: any) => ({ async send() { hooks.event({ type: 'message', id: 'r1', text: 'Shipped 🎉 — done.' }); setTimeout(() => hooks.event({ type: 'complete' }), 2); }, async interrupt() {}, async close() {} }));
  const style = await core.rpc('presets.save', { label: 'Plain', text: 'Version one.', constraints: ['no-emoji', 'no-em-dash'], expectedRevision: '0' });
  const point = await core.rpc('presets.checkpoint', { id: style.id, expectedItemRevision: '1', label: 'First draft' });
  await assert.rejects(core.rpc('presets.checkpoint', { id: style.id, expectedItemRevision: '1' }), /already has a checkpoint/);
  const edited = await core.rpc('presets.save', { id: style.id, label: 'Plain', text: 'Version two.', expectedItemRevision: '1' });
  assert.deepEqual(edited.constraints, ['no-emoji', 'no-em-dash'], 'fields left out keep their saved values');
  const restored = await core.rpc('presets.restore', { id: style.id, expectedItemRevision: '2', checkpointRevision: point.revision });
  assert.deepEqual([restored.text, restored.revision], ['Version one.', '3']);
  assert.deepEqual(restored.checkpoints.map((item: any) => [item.revision, item.label, item.text]), [['1', 'First draft', 'Version one.']], 'the checkpoint itself is unchanged');
  // The preview renders with the runtime renderer and binds nothing.
  const preview = await core.rpc('behavior.preview', { profileId: style.id });
  assert.match(preview.text, /Do not use emoji\. Do not use em dashes/);
  // A reply that misses its turn's checks gets a note; its stored text is exactly what was shown.
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  await core.rpc('session.behavior', { id: session.id, profileId: style.id });
  await core.rpc('session.send', { id: session.id, text: 'Ship it' });
  for (let index = 0; index < 200 && core.store.session(session.id).status !== 'idle'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  const reply = core.store.messages(session.id).find(message => message.role === 'assistant')!;
  assert.equal(reply.text, 'Shipped 🎉 — done.');
  assert.deepEqual(reply.styleNotes!.map(note => note.constraint), ['no-emoji', 'no-em-dash']);
  // A catalog from a newer Cere is refused rather than rewritten.
  core.store.set('behaviorPresets', { schema: 3, revision: '1', items: [] });
  await assert.rejects(core.rpc('presets.list', {}), /newer version of Cere/);
});

test('RC-02 a recall limit narrows like any other, renders only when set, and can never turn recall on', () => {
  assert.deepEqual(validCeiling({ recall: false, memory: true }), { recall: false });
  assert.deepEqual(validCeiling({ recall: true }), {}, 'a true limit could only grant, so it is dropped');
  assert.throws(() => validCeiling({ remember: false }), /automatic memory recall/);
  const noMemory = builtinPostures.find(item => item.id === 'posture:no-memory')!;
  assert.deepEqual([noMemory.label, noMemory.ceiling, noMemory.posture], ['Without memory', { recall: false, memory: false }, true]);
  const resolved = resolveBehavior({ personality: defaultPersonality, profiles: [profile({ id: 'base' })], sessionProfileId: 'base', postureId: 'posture:no-memory' });
  assert.deepEqual(resolved.ceiling, { recall: false, memory: false });
  const block = behaviorInstructions(resolved, 'Cere');
  assert.match(block, /withholds Cere's memory tools/); assert.match(block, /withholds automatic memory recall: no stored memory is supplied/);
  assert.doesNotMatch(behaviorInstructions(resolveBehavior({ personality: defaultPersonality, profiles: [profile({ id: 'base', ceiling: { memory: false } })], sessionProfileId: 'base' }), 'Cere'), /recall/);
});

test('RC-02 a pinned Without memory posture keeps memory out of a CLI turn, still arms capture, and memory off stays off', async t => {
  const sent: string[] = [];
  const { core, dir } = await broker(t, (_s: any, hooks: any) => ({ async send(text: string) { sent.push(text); setTimeout(() => hooks.event({ type: 'complete' }), 5); }, async interrupt() {}, async close() {} }));
  await core.memory.ready;
  await core.updateSettings({ ollama: { host: 'http://127.0.0.1:9' }, memory: { enabled: true, allowCloudMemory: true } });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  await core.memory.save(core.store.session(session.id), 'The orchid launch moved to Friday.');
  const armed: boolean[] = [], finish = core.finishNativeMemory.bind(core);
  core.finishNativeMemory = (current: any, answer?: string) => { armed.push(core.nativeMemoryTurns.has(current.id)); return finish(current, answer); };
  const send = async (text: string) => { await core.rpc('session.send', { id: session.id, text }); for (let index = 0; index < 400 && core.store.session(session.id).status !== 'idle'; index++) await new Promise(resolve => setTimeout(resolve, 5)); };
  const outcome = () => { const [latest] = core.memory.outcomes(session.id); return [latest.outcome, latest.reason]; };
  await send('When is the orchid launch?');
  assert.match(sent.at(-1)!, /<cere_memory_data>/); assert.match(sent.at(-1)!, /moved to Friday/);
  await core.rpc('session.behavior', { id: session.id, postureId: 'posture:no-memory' });
  await send('Is the orchid launch still on Friday?');
  assert.doesNotMatch(sent.at(-1)!, /<cere_memory_data>|moved to Friday/);
  assert.deepEqual(outcome(), ['disabled', 'style_withheld']);
  assert.deepEqual(armed, [true, true], 'both turns keep their memory capture');
  await core.updateSettings({ memory: { enabled: false } });
  await send('And the orchid launch?');
  assert.deepEqual(outcome(), ['disabled', 'setting_off'], 'with memory off the reason is memory being off');
});

test('RC-07 conflicting traits warn, a posture can create the conflict, and what is sent never changes', async t => {
  assert.match(traitConflicts({ warmth: -1, humor: 2 })[0], /reserved tone with very playful humor/);
  assert.match(traitConflicts({ formality: 1, humor: 2 })[0], /formal register with very playful humor/);
  assert.match(traitConflicts({ directness: 2, warmth: 1 })[0], /Blunt directness with a warm tone/);
  assert.equal(traitConflicts({ warmth: -2, formality: 2, humor: 2 }).length, 2);
  for (const traits of [{}, { humor: 1, warmth: -2 }, { directness: 1, warmth: 2 }, { formality: -2, humor: 2 }]) assert.deepEqual(traitConflicts(traits), [], JSON.stringify(traits));
  const base = profile({ id: 'base', traits: { directness: 2 } });
  assert.deepEqual(resolveBehavior({ personality: defaultPersonality, profiles: [base], sessionProfileId: 'base' }).conflicts, []);
  const merged = resolveBehavior({ personality: defaultPersonality, profiles: [base], sessionProfileId: 'base', postureId: 'posture:explain' });
  assert.match(merged.conflicts.join(), /Blunt directness/, 'the Explain posture adds warmth to a blunt style');
  assert.equal(behaviorInstructions(merged, 'Cere'), behaviorInstructions({ ...merged, conflicts: [] }, 'Cere'));
  assert.doesNotMatch(behaviorInstructions(merged, 'Cere'), /mixed signals/);
  const { core, dir } = await broker(t);
  const style = await core.rpc('presets.save', { label: 'Blunt friend', text: 'Be yourself.', traits: { directness: 2, warmth: 1 }, expectedRevision: '0' });
  assert.equal(style.label, 'Blunt friend', 'a conflicting style still saves');
  assert.match((await core.rpc('behavior.preview', { profileId: style.id })).conflicts[0], /Blunt directness/);
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  await core.rpc('session.behavior', { id: session.id, profileId: style.id });
  assert.equal((await core.rpc('behavior.resolve', { id: session.id })).conflicts.length, 1);
});
