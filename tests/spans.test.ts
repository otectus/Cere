import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { Spans, spanLimits } from '../broker/spans.ts';
import { Speech } from '../broker/tts.ts';
import { selectAudio, useAudioRunner } from '../broker/audio-devices.ts';
import { defaultSettings } from '../broker/types.ts';

test('M16 spans are off by default, bounded when on, and forget everything when turned off', () => {
  const spans = new Spans();
  spans.record('turn', 10); spans.start('tool', 'web')();
  assert.deepEqual(spans.summary(), { enabled: false });
  spans.configure(true);
  for (let index = 0; index < spanLimits.entries + 100; index++) spans.record('tool', index, index % 10 === 0 ? 'failed' : 'ok', 'web/../../secret path');
  const summary: any = spans.summary();
  assert.equal(summary.spans.tool.count, spanLimits.entries);
  assert.deepEqual([summary.spans.tool.p50, summary.spans.tool.max], [349, 599]);
  assert.deepEqual(summary.spans.tool.details, ['websecretpath'], 'details keep only letters, digits, _ and -');
  assert.throws(() => spans.uiLag({ p50: -1, p90: 1, max: 1, samples: 1 }), /Invalid interface timing/);
  spans.uiLag({ p50: 2.04, p90: 9, max: 40, samples: 120 });
  assert.deepEqual((spans.summary() as any).uiLag, { p50: 2, p90: 9, max: 40, samples: 120 });
  spans.configure(false);
  assert.deepEqual(spans.summary(), { enabled: false });
  spans.configure(true);
  assert.equal((spans.summary() as any).spans.tool.count, 0, 'turning measurements off forgot them');
});

test('M16 a measured turn records its duration, first text and Stop latency; nothing private reaches the summary or the export', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-spans-'));
  let hooks: any, hold = false;
  const core = new Core(new Store(dir), (_session, h) => { hooks = h; return {
    async send() { setTimeout(() => { hooks.event({ type: 'delta', id: 'reply', text: 'The tangerine-secret answer' }); if (!hold) setTimeout(() => hooks.event({ type: 'complete' }), 20); }, 15); },
    async interrupt() { hooks.event({ type: 'interrupted' }); }, async close() {} }; });
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  const idle = async () => { for (let index = 0; index < 300 && core.store.session(session.id).status !== 'idle' && core.store.session(session.id).status !== 'interrupted'; index++) await new Promise(resolve => setTimeout(resolve, 5)); };
  await core.send({ id: session.id, text: 'Tell me the tangerine-secret' }); await idle();
  assert.deepEqual(await core.rpc('diagnostics.spans', {}), { enabled: false }, 'nothing is measured until the user turns it on');
  await core.updateSettings({ responsiveness: true });
  await core.send({ id: session.id, text: 'Tell me the tangerine-secret again' }); await idle();
  hold = true;
  await core.send({ id: session.id, text: 'And once more' });
  for (let index = 0; index < 100 && !core.store.messages(session.id).some(message => message.text === 'The tangerine-secret answer' && message.time > 0) ; index++) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 40));
  await core.stop(session.id); await idle();
  const summary: any = await core.rpc('diagnostics.spans', {});
  assert.deepEqual([summary.spans.turn.count, summary.spans.turn.stopped, summary.spans['first-token'].count, summary.spans.cancel.count], [2, 1, 2, 1]);
  assert.deepEqual(summary.spans.turn.details, ['codex']);
  assert.ok(summary.spans['first-token'].p50 >= 10, 'time to first text is measured from the send');
  const preview = await core.rpc('diagnostics.preview', {});
  assert.match(preview.text, /"responsiveness"/);
  assert.doesNotMatch(JSON.stringify(summary) + preview.text, /tangerine|\/tmp\//, 'no text or paths');
  await core.rpc('diagnostics.clearSpans', {});
  assert.equal((await core.rpc('diagnostics.spans', {})).spans.turn.count, 0);
});

test('M16 speech reports time to first audio, or a failure before any audio', async t => {
  t.after(() => { useAudioRunner(async () => { throw new Error('reset'); }); selectAudio({ input: '', output: '' }); });
  useAudioRunner(async () => '[]');
  selectAudio({ input: '', output: 'pw:unplugged-sink' });
  const timings: any[] = [];
  const speech = new Speech(() => ({ ...defaultSettings }), () => {}, { PATH: '/nonexistent' } as any);
  speech.timing = (ms, outcome, backend) => timings.push({ ms, outcome, backend });
  speech.speak('Hello', true); await speech.idle(); await speech.close();
  assert.equal(timings.length, 1);
  assert.equal(timings[0].outcome, 'failed'); assert.ok(timings[0].ms >= 0);
});
