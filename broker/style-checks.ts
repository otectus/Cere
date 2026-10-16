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
const emoji = /\p{Extended_Pictographic}/gu;
const table = /^\s*\|.*\|\s*\n\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

export type StyleViolation = { constraint: StyleConstraint; label: string; count: number };
export function checkReply(text: string, constraints: StyleConstraint[]): StyleViolation[] {
  const body = prose(text), violations: StyleViolation[] = [];
  for (const constraint of constraints) {
    const count = constraint === 'no-emoji' ? (body.match(emoji) || []).length
      : constraint === 'no-em-dash' ? (body.match(/—/g) || []).length
        : (body.match(new RegExp(table.source, 'gm')) || []).length;
    if (count) violations.push({ constraint, label: styleConstraints[constraint].label, count });
  }
  return violations;
}
export function constraintInstructions(constraints: StyleConstraint[]) {
  return constraints.length ? '\nFormatting the user asked for: ' + constraints.map(id => styleConstraints[id].instruction).join(' ') + '\n' : '';
}
