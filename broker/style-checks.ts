/**
 * M02 deterministic output checks. A style can ask for a few checkable formatting constraints; the
 * instruction asks the model to follow them, and a finished reply is checked afterwards. A failed
 * check is a visible note on that reply. Nothing here edits, strips, hides or re-requests a reply:
 * the text the user saw and the text Cere stored stay identical. Code is never checked.
 */
export const styleConstraints = {
  'no-emoji': { label: 'No emoji', instruction: 'Do not use emoji.' },
  'no-em-dash': { label: 'No em dashes', instruction: 'Do not use em dashes (—); use commas, colons or parentheses instead.' },
  'no-markdown-table': { label: 'No Markdown tables', instruction: 'Do not format answers as Markdown tables; use lists or prose.' },
} as const;
export type StyleConstraint = keyof typeof styleConstraints;

export function validConstraints(value: unknown): StyleConstraint[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some(item => typeof item !== 'string' || !(item in styleConstraints))) throw new Error('Choose from the supported formatting checks: no emoji, no em dashes, no Markdown tables');
  return [...new Set(value as StyleConstraint[])];
}

/** Prose outside fenced and inline code: constraints describe writing, not code or quoted output. */
function prose(text: string) { return text.replace(/```[\s\S]*?(```|$)/g, '\n').replace(/`[^`\n]*`/g, ' '); }
/**
 * Emoji as a reader sees them: a code point shown as emoji by default, a pictograph followed by the
 * emoji variation selector (U+FE0F), or a flag, which is a pair of regional indicators. Skin-tone
 * modifiers and the parts of a joined sequence belong to the emoji they follow. Text symbols such
 * as ©, ™, → or a plain ✓ are not emoji.
 */
function emojiCount(text: string) {
  const points = Array.from(text);
  let count = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index], joined = points[index - 1] === '\u200D';
    if (/\p{Regional_Indicator}/u.test(point)) { if (/\p{Regional_Indicator}/u.test(points[index + 1] ?? '')) index++; count++; continue; }
    if (joined || /\p{Emoji_Modifier}/u.test(point)) continue;
    if (/\p{Emoji_Presentation}/u.test(point) || (/\p{Extended_Pictographic}/u.test(point) && points[index + 1] === '\uFE0F')) count++;
  }
  return count;
}
/** A GFM table: a delimiter row (cells of dashes with optional colons, with at least one pipe; the outer pipes are optional) under a header line. */
const delimiterRow = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
function tableCount(text: string) {
  const lines = text.split('\n');
  let count = 0;
  for (let index = 1; index < lines.length; index++) if (lines[index].includes('|') && delimiterRow.test(lines[index]) && lines[index - 1].trim()) count++;
  return count;
}

export type StyleViolation = { constraint: StyleConstraint; label: string; count: number };
export function checkReply(text: string, constraints: StyleConstraint[]): StyleViolation[] {
  const body = prose(text), violations: StyleViolation[] = [];
  for (const constraint of constraints) {
    const count = constraint === 'no-emoji' ? emojiCount(body)
      : constraint === 'no-em-dash' ? (body.match(/—/g) || []).length
        : tableCount(body);
    if (count) violations.push({ constraint, label: styleConstraints[constraint].label, count });
  }
  return violations;
}
export function constraintInstructions(constraints: StyleConstraint[]) {
  return constraints.length ? '\nFormatting the user asked for: ' + constraints.map(id => styleConstraints[id].instruction).join(' ') + '\n' : '';
}
