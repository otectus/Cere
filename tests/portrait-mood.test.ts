import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const mood: any = vm.createContext({});
vm.runInContext(readFileSync(new URL('../qml/PortraitMood.js', import.meta.url), 'utf8')
  .replace(/^\.pragma library\s*/, ''), mood);

const now = 2_000_000;
const message = (id: string, text: string, overrides: Record<string, unknown> = {}) => ({
  id, sessionId: 'selected', role: 'assistant', kind: 'text', text, time: now - 1000, ...overrides,
});
const analyze = (messages: unknown[], at = now, session = 'selected') => mood.analyze(messages, at, session);

test('recognizes distinct conversational tones with bounded outputs', () => {
  const cases = [
    ['curious', "I'm curious how that part felt to you. Tell me more?"],
    ['thinking', 'Let me think. There are a few possibilities to sort through.'],
    ['happy', "Great news — that worked! I'm glad we found it."],
    ['cheeky', 'Well, well. Plot twist: the tiny rebellion worked. 😉'],
    ['skeptical', "Hmm, are we sure? I'm not convinced that claim adds up."],
    ['tender', "That sounds really hard. Take your time; I'm here with you. ♥"],
    ['concerned', "I'm worried. Are you safe? Please get help right away."],
    ['surprised', "Oh wow! I didn't expect that. What a surprise!"],
    ['focused', "Here's the plan. First, I'll check the boundary; next, we'll trace the request."],
    ['sleepy', "It's been a long day. I'm getting sleepy — time for bed."],
  ];
  for (const [expected, text] of cases) {
    const result = analyze([message(expected, text)]);
    assert.equal(result.mood, expected, `${expected}: ${JSON.stringify(result)}`);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    assert.ok(result.intensity >= 0 && result.intensity <= 1);
    assert.equal(result.messageId, expected);
    assert.equal(result.ageMs, 1000);
  }
});

test('negation and contrast change the inferred tone', () => {
  assert.notEqual(analyze([message('safe', "It's not a disaster and I'm not worried. We're all set.")]).mood, 'concerned');
  assert.notEqual(analyze([message('no-disaster', 'This is no disaster.')]).mood, 'concerned');
  assert.equal(analyze([message('contrast', "Great news, this looked wonderful! However, I'm concerned. Are you safe?")]).mood, 'concerned');
  assert.equal(analyze([message('reverse', "I was concerned. But great news — it worked, and I'm glad.")]).mood, 'happy');
  assert.equal(analyze([message('support', "You don't have to solve it tonight. We've got this, one step at a time.")]).mood, 'tender');
  assert.equal(analyze([message('menace', 'You absolute menace. The tiny rebellion worked. 😏')]).mood, 'cheeky');
  assert.equal(analyze([message('curly', 'I’m here with you. We’ve got this, one step at a time.')]).mood, 'tender');
  const changing = `${'Great news! Wonderful! '.repeat(12)}However, I'm concerned now. Are you safe?`;
  assert.equal(analyze([message('repeated', changing)]).mood, 'concerned');
});

test('ignores code, quotes, URLs, and technical failure prose', () => {
  const result = analyze([message('logs', [
    'The test failure is in the build log. I will check it step by step.',
    '> I am terrified; this is a disaster!',
    '```text',
    'ERROR: catastrophic failure; urgent danger',
    '```',
    'See https://example.test/urgent-disaster and `throw new Error("panic")`.',
  ].join('\n'))]);
  assert.equal(result.mood, 'focused');
  assert.notEqual(result.mood, 'concerned');
});

test('filters sessions strictly and uses only the latest assistant turn after the newest user', () => {
  const messages = [
    message('old', "I'm worried. This is serious.", { time: now - 3000 }),
    message('foreign', 'Great news! Wonderful!', { sessionId: 'other', time: now - 2000 }),
    message('user', 'New topic', { role: 'user', time: now - 1500 }),
    message('tool', "I'm worried!", { role: 'tool', kind: 'tool', time: now - 1200 }),
    message('answer', "I'm curious. Tell me more about what you want.", { time: now - 1000 }),
  ];
  assert.equal(analyze(messages).mood, 'curious');
  assert.equal(analyze(messages).messageId, 'answer');
  assert.equal(analyze(messages, now, 'other').mood, 'happy');
  assert.equal(analyze([...messages, message('reset', 'One more thing', { role: 'user', time: now })]).mood, 'neutral');
});

test('the newest streaming wording can overturn its earlier tone', () => {
  const early = [message('stream', "Great news! I'm glad this worked.")];
  assert.equal(analyze(early).mood, 'happy');
  const updated = [message('stream', "Great news! I'm glad this worked. However, I'm concerned now. Are you safe?")];
  assert.equal(analyze(updated).mood, 'concerned');
});

test('bounds history and decays old replies to neutral', () => {
  const history = Array.from({ length: 140 }, (_, i) => message(`m${i}`, 'Ordinary status text.', { time: now - 2000 + i }));
  history.push(message('latest', 'Fantastic, great news!', { time: now - 500 }));
  assert.equal(analyze(history).mood, 'happy');
  const old = analyze([message('stale', "Great news! I'm glad.", { time: now - 90_000 })]);
  assert.deepEqual({ mood: old.mood, intensity: old.intensity, ageMs: old.ageMs }, { mood: 'neutral', intensity: 0, ageMs: 90_000 });

  const beyondBudget = [message('selected-old', 'Great news! Wonderful!')];
  for (let i = 0; i < 96; ++i) beyondBudget.push(message(`other-${i}`, 'ignored', { sessionId: 'other' }));
  assert.equal(analyze(beyondBudget).mood, 'neutral');
});

test('unfinished and tail-truncated quoted material never becomes mood evidence', () => {
  assert.equal(analyze([message('open-fence', 'Routine note.\n```text\nGreat news! Wonderful!')]).mood, 'neutral');
  assert.equal(analyze([message('tail-in-code', "I'm worried! This is serious.\n```\nRoutine prose after the fence")]).mood, 'neutral');
  assert.equal(analyze([message('inline', 'Routine note followed by `Great news! Wonderful!')]).mood, 'neutral');
  assert.equal(analyze([message('quote', 'Routine note: “I am worried and this is serious')]).mood, 'neutral');
  const fenceOutsideOldTail = `\`\`\`text\n${'Great news! Wonderful! '.repeat(1000)}`;
  assert.equal(analyze([message('long-open-fence', fenceOutsideOldTail)]).mood, 'neutral');
  assert.equal(analyze([message('long-plain', 'Great news! '.repeat(1000))]).mood, 'neutral');
});

test('falls back safely for non-English, ambiguous, unsupported, and malformed input', () => {
  assert.equal(analyze([message('nonenglish', '这是一个非常好的消息，我很高兴！')]).mood, 'neutral');
  assert.equal(analyze([message('plain', 'The value is 42 and the operation completed.')]).mood, 'neutral');
  assert.equal(analyze([message('substring', 'The unsuccessful Yawnson operation completed normally.')]).mood, 'neutral');
  for (const bad of [
    message('reasoning', "I'm delighted!", { kind: 'thinking' }),
    message('question', "I'm curious!", { kind: 'question' }),
    message('invented', "I'm happy!", { kind: 'response' }),
    message('system', 'Great news!', { role: 'system' }),
    message('tool', 'Wonderful!', { role: 'tool', kind: 'tool' }),
  ]) assert.equal(analyze([bad]).mood, 'neutral');
  assert.equal(analyze([]).messageId, '');
  assert.equal(analyze(null as any).mood, 'neutral');
  assert.equal(analyze([message('x'.repeat(400), "I'm happy! Great news!")]).messageId.length, 256);
});

test('technical questions alone are not treated as personal curiosity', () => {
  const result = analyze([message('technical', 'Does the API return 204? Which request header is required?')]);
  assert.equal(result.mood, 'neutral');
  assert.ok(result.confidence <= .18);
});

test('emoji cues use complete code points instead of shared surrogate halves', () => {
  assert.equal(analyze([message('frown', "I'm concerned. Are you safe? 😟")]).mood, 'concerned');
  assert.equal(analyze([message('robot', 'Routine update. 🤖')]).mood, 'neutral');
});
