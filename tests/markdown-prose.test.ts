import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSections } from '../broker/output-contracts.ts';
import { checkReply } from '../broker/style-checks.ts';
import { speechText } from '../broker/tts.ts';

test('reply checks and speech agree on fence character, length, indentation and trailing content', () => {
  for (const marker of ['~', '\x60']) {
    const open = marker.repeat(4), other = (marker === '~' ? '\x60' : '~').repeat(4);
    const text = ['Before', '   ' + open + 'lang', other, marker.repeat(3), open + ' more', '# Hidden —', open + '  ', '# Visible', 'After'].join('\n');
    assert.deepEqual(checkSections(text, ['Hidden', 'Visible']).map(s => s.present), [false, true]);
    assert.deepEqual(checkReply(text, ['no-em-dash']), []);
    assert.equal(speechText(text), 'Before Visible After');
    assert.equal(speechText('Before\n' + open + '\nunfinished'), 'Before');
  }
  assert.match(speechText('Before\n\x60\x60\x60infoline\x60\nAfter'), /After/);
});

test('writing checks preserve prose around code spans with matching backtick runs', () => {
  const code = '``example ` — ` here``';
  assert.deepEqual(checkReply(code, ['no-em-dash']), []);
  assert.equal(checkReply('Before — ' + code + ' after —', ['no-em-dash'])[0].count, 2);
  assert.equal(checkReply('``unclosed —', ['no-em-dash'])[0].count, 1);
});
