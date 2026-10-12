import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { citedEvidenceIds, stripMemoryCitations } from '../broker/citations.ts';
import { speechText } from '../broker/tts.ts';

// The same cases check native/citations.h in tests/ui.cpp (memoryCitationDisplay).
const cases: { name: string; input: string; output: string }[] = JSON.parse(readFileSync(new URL('./fixtures/memory-citations.json', import.meta.url), 'utf8'));
const first = 'ea105855-1459-41da-b270-d370d2b54457', second = '5a7d39e4-4f36-4177-8835-8a0c499943b1';

test('hidden memory citations leave readable text', () => {
  assert.ok(cases.length >= 30);
  for (const { name, input, output } of cases) assert.equal(stripMemoryCitations(input), output, name);
  // Text without a marker is returned as it is, so Copy keeps the original Markdown byte for byte.
  const plain = '# Title\r\n\n  indented [x](y) `code`\n\n';
  assert.equal(stripMemoryCitations(plain), plain);
});

test('speech never reads a citation aloud', () => {
  const spoken = speechText(`You prefer **Ruff** [evidence:${first}]. Black is out [evidence:${first}, ${second}].\n\nEvidence: [evidence:${second}]`);
  assert.equal(spoken, 'You prefer Ruff. Black is out.');
  assert.doesNotMatch(speechText(`Streaming [evidence:${first.slice(0, 12)}`), /evidence|ea105855/);
});

test('memory provenance still reads the exact markers from the stored reply', () => {
  assert.deepEqual(citedEvidenceIds(`A [evidence:${first}] B [evidence:${second}] C [Evidence:${first}] D [evidence: ${second}]`), [first, second]);
  assert.deepEqual(citedEvidenceIds('none here'), []);
});

test('stripping stays linear on long and malformed text', () => {
  const marker = `[evidence:${first}]`, spaces = ' '.repeat(200_000);
  for (const input of [
    marker + spaces + 'x', '(' + spaces + 'evidence:', '`' + spaces + marker + spaces + '`x', 'Sources' + spaces + 'x ' + marker,
    ('[evidence:' + first.slice(0, 30) + ' ').repeat(20_000), (marker + ', ').repeat(20_000) + 'end', '[evidence:' + spaces,
  ]) {
    const started = performance.now();
    stripMemoryCitations(input);
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms for ${JSON.stringify(input.slice(0, 40))}…`);
  }
});
