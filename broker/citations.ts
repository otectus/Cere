/**
 * Replies that use recalled memory cite it as [evidence:ID] (the memory guidance in providers.ts and
 * ollama.ts). The stored reply keeps every marker: memory provenance is read back from it. Hiding them
 * is presentation only. native/citations.h applies the same rules on the desktop, and both are checked
 * against tests/fixtures/memory-citations.json.
 */

/** The evidence ids a reply cites, in the exact form the memory guidance asks for. */
export function citedEvidenceIds(text: string): string[] {
  return [...text.matchAll(/\[evidence:([0-9a-f-]{36})\]/g)].map(match => match[1]);
}

// One bracket may list several ids; a run is adjacent brackets, optionally comma separated. A run
// wrapped only in parentheses or backticks goes with its wrapper. Every quantified part is bounded
// by a literal, so matching stays linear on long or malformed text.
const id = '[0-9a-f-]{36}';
const group = `\\[[ \\t]*evidence:[ \\t]*${id}(?:[ \\t]*[,;][ \\t]*(?:evidence:[ \\t]*)?${id})*[ \\t]*\\]`;
const run = `${group}(?:[ \\t]*(?:[,;][ \\t]*)?${group})*`;
const marker = new RegExp(`\\([ \\t]*${run}[ \\t]*\\)|\`[ \\t]*${run}[ \\t]*\`|${run}`, 'gi');
// A marker still streaming in: everything from its bracket to the end of the text.
const partial = /^\[[ \t]*evidence:[ \t]*[0-9a-f-]{0,36}(?:[ \t]*[,;][ \t]*(?:evidence:[ \t]*)?[0-9a-f-]{0,36})*[ \t]*$/i;
// What is left of a line that only cited: nothing, a list or quote marker, or a label such as "Sources:".
const leftover = /^(?:>[ \t]*)*(?:#{1,6}[ \t]+)?(?:(?:[-*+]|[0-9]{1,9}[.)])[ \t]*)?(?:[*_]{0,2}(?:evidence|sources?|references?|citations?|memory|memories)[*_]{0,2}[ \t]*(?::[ \t]*)?[*_]{0,2})?$/i;
// After these, the space before a removed marker goes too: "Ruff [evidence:…]." reads "Ruff.".
const closing = ' \t\r\f\v\u00a0.,;:!?)]}>"\'\u2019\u201d\u2026*_`~';

const horizontal = (character: string | undefined) => character === ' ' || character === '\t';
const blank = (line: string) => /^[ \t\r]*$/.test(line);
function trimEnd(text: string, characters: string) {
  let end = text.length;
  while (end > 0 && characters.includes(text[end - 1])) end--;
  return text.slice(0, end);
}
function trim(text: string) {
  let start = 0;
  while (start < text.length && ' \t\r'.includes(text[start])) start++;
  return trimEnd(text.slice(start), ' \t\r');
}

/** Drops a marker still arriving at the end of a streaming reply, with the space or wrapper before it. */
function withoutPartialTail(text: string) {
  const start = text.lastIndexOf('[');
  if (start < 0 || !partial.test(text.slice(start))) return text;
  let end = start;
  while (horizontal(text[end - 1])) end--;
  if (text[end - 1] === '(' || text[end - 1] === '`') end--;
  return trimEnd(text.slice(0, end), ' \t\r\n');
}

/**
 * The reply as shown while citations are hidden. A marker takes the space before it when punctuation
 * or the end of the line follows; one that starts a line takes the space after it instead. A line
 * that only cited is removed, with a blank line it would leave doubled. Code is not exempt. Text
 * without a complete or trailing partial marker is returned unchanged.
 */
export function stripMemoryCitations(text: string): string {
  if (!/evidence:/i.test(text)) return text;
  const source = withoutPartialTail(text), lines = source.split('\n'), kept: string[] = [];
  let changed = source !== text, skipBlank = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let output = '', last = 0, found = false;
    marker.lastIndex = 0;
    for (let match = marker.exec(line); match; match = marker.exec(line)) {
      found = true;
      output += line.slice(last, match.index);
      last = match.index + match[0].length;
      if (/^[ \t]*$/.test(output)) while (horizontal(line[last])) last++;
      else if (last >= line.length || closing.includes(line[last])) output = trimEnd(output, ' \t');
    }
    let value = line;
    if (found) {
      changed = true;
      value = output + line.slice(last);
      if (leftover.test(trim(value))) {
        if (kept.length && blank(kept[kept.length - 1]) && index + 1 < lines.length && blank(lines[index + 1])) skipBlank = true;
        if (index === lines.length - 1) while (kept.length && blank(kept[kept.length - 1])) kept.pop();
        continue;
      }
    }
    if (skipBlank) { skipBlank = false; if (blank(value)) continue; }
    kept.push(value);
  }
  return changed ? kept.join('\n') : text;
}
