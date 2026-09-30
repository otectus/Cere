import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const state = vm.createContext({});
vm.runInContext(readFileSync(new URL('../qml/PortraitState.js', import.meta.url), 'utf8')
  .replace(/^\.pragma library\s*/, ''), state);

function resolve(input: Record<string, unknown> = {}) {
  return state.resolve({ connected: true, session: {}, approvals: [], ...input });
}

test('portrait state gives connection, approvals, and failures precedence', () => {
  assert.equal(resolve({ connected: false, approvals: [{}], session: { status: 'error' } }).expression, 'concerned');
  assert.equal(resolve({ approvals: [{}], session: { status: 'error' } }).label, 'Waiting for your input');
  assert.equal(resolve({ session: { status: 'error' }, paused: true }).expression, 'concerned');
  assert.equal(resolve({ session: { status: 'interrupted' } }).label, 'Interrupted');
  assert.equal(resolve({ session: { status: 'disconnected' } }).label, 'Session disconnected');
});

test('activity wins over conversational mood, greeting, hover and listening', () => {
  assert.equal(resolve({ session: { status: 'working', activity: 'thinking' }, mood: 'cheeky', greeting: true, hovered: true, listening: true }).expression, 'thinking');
  assert.equal(resolve({ session: { status: 'working', activity: 'working' }, mood: 'tender' }).expression, 'focused');
  assert.equal(resolve({ session: { status: 'starting', activity: 'planning' }, mood: 'happy' }).expression, 'thinking');
  assert.equal(resolve({ session: { status: 'stopping' }, mood: 'happy' }).expression, 'focused');
});

test('replying retains neutral activity but permits an explicit conversational expression', () => {
  assert.equal(resolve({ session: { status: 'working', activity: 'speaking' } }).label, 'Replying');
  const warm = resolve({ session: { status: 'working', activity: 'speaking' }, mood: 'tender' });
  assert.deepEqual(structuredClone(warm), { expression: 'tender', label: 'Here with you', tone: 'warm' });
});

test('idle attention has stable greeting, mood, hover and neutral fallback ordering', () => {
  assert.equal(resolve({ greeting: true, mood: 'skeptical', hovered: true }).expression, 'cheeky');
  assert.equal(resolve({ mood: 'surprised', listening: true }).expression, 'surprised');
  assert.equal(resolve({ hovered: true }).label, 'Listening');
  assert.equal(resolve({ listening: true }).expression, 'curious');
  assert.equal(resolve().expression, 'neutral');
});

test('pause is an idle state but approvals and failures still take priority', () => {
  assert.equal(resolve({ paused: true }).expression, 'sleepy');
  assert.equal(resolve({ paused: true, session: { status: 'waiting' } }).expression, 'curious');
  assert.equal(resolve({ paused: true, session: { status: 'working', activity: 'thinking' } }).expression, 'sleepy');
});
