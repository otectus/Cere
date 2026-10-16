import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchCommand } from '../broker/voice-commands.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

test('M21 only a whole transcript that is an allowlisted phrase is a command; everything else stays text', () => {
  for (const [text, id] of [['Stop speaking.', 'stop-speaking'], ['Cere, stop speaking', 'stop-speaking'], ['hey Cere stop talking', 'stop-speaking'], ['please read that again', 'read-last'],
    ['Open Settings!', 'open-settings'], ['new conversation please', 'new-conversation'], ['Stop the reply', 'stop-reply']] as [string, string][])
    assert.equal(matchCommand(text)?.id, id, text);
  assert.equal(matchCommand('Nova, open desktop', 'Nova')?.id, 'open-desktop', 'the assistant’s chosen name can address it');
  for (const text of ['Tell him to stop speaking', 'stop speaking and summarize the meeting', '"stop speaking"', 'Delete all my notes', 'approve', 'allow', 'yes', '', 'open settings '.repeat(20)])
    assert.equal(matchCommand(text), undefined, text);
});

test('M21 commands are off by default, shown before they run, never answer approvals, and run only allowlisted actions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cere-voice-commands-'));
  const core = new Core(new Store(dir), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  core.transcription.finish = (async () => ({ sessionId: session.id, revision: 1, text: 'Cere, stop speaking' })) as any;
  assert.equal((await core.rpc('transcription.finish', {})).command, undefined, 'off by default: the transcript is text');
  await assert.rejects(core.rpc('voice.command', { id: 'stop-speaking' }), /Voice commands are off/);
  await core.updateSettings({ voiceCommands: { enabled: true } });
  assert.deepEqual((await core.rpc('transcription.finish', {})).command, { id: 'stop-speaking', label: 'Stop speaking', confirm: true });
  await assert.rejects(core.updateSettings({ voiceCommands: { enabled: 'yes' } }), /Invalid voice command settings/);
  // A pending approval is never answered by a spoken command.
  const pending = core.approval(session.id, { kind: 'desktop', title: 'Open a file?', detail: '', choices: ['allow', 'deny'] });
  let stopped = 0, spoken: string[] = [];
  core.speech.stop = () => { stopped++; };
  core.speech.speak = ((text: string) => { spoken.push(text); return true; }) as any;
  assert.deepEqual(await core.rpc('voice.command', { id: 'stop-speaking', sessionId: session.id }), { id: 'stop-speaking', label: 'Stop speaking' });
  assert.equal(stopped, 1);
  assert.deepEqual(await core.rpc('voice.command', { id: 'open-settings' }), { id: 'open-settings', label: 'Open Settings', ui: 'settings' });
  assert.deepEqual(spoken, [], 'no spoken feedback unless chosen');
  await core.updateSettings({ voiceCommands: { speakFeedback: true } });
  await core.rpc('voice.command', { id: 'open-desktop' });
  assert.deepEqual(spoken, ['Open Desktop']);
  await assert.rejects(core.rpc('voice.command', { id: 'read-last', sessionId: session.id }), /no reply to read/);
  core.putMessage({ id: 'reply-1', sessionId: session.id, role: 'assistant', text: 'The **build** passed.', time: Date.now() });
  spoken = [];
  await core.rpc('voice.command', { id: 'read-last', sessionId: session.id });
  assert.deepEqual(spoken, ['The **build** passed.'], 'the last reply is queued; Speech removes Markdown itself');
  await assert.rejects(core.rpc('voice.command', { id: 'approve-everything' }), /Unknown voice command/);
  assert.equal(core.approvals.size, 1, 'the approval is still waiting for a person');
  core.answer({ id: [...core.approvals.keys()][0], choice: 'deny' }); await pending;
  assert.ok(core.store.activities().some((entry: any) => entry.action === 'voice.command' && entry.command === 'stop-speaking'));
});
