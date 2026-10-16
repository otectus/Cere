/**
 * M17: completion gates and output contracts for workflow results. A required check is satisfied
 * only by its latest broker-observed exit for that result, run with the check's current definition:
 * not-run, cancelled, failed-to-start or stale checks never count as passed. Output sections are a
 * deterministic warning about a reply's shape; they never change the saved transcript.
 */
export type RequiredCheck = { scriptId: string; label: string };
export type CheckAttempt = { scriptId: string; state: 'cancelled' | 'error'; at: number; reason?: string; seq?: number };
export type CheckStatus = 'passed' | 'failed' | 'not-run' | 'stale' | 'cancelled' | 'error' | 'missing';
export type ChecklistRow = { scriptId: string; label: string; status: CheckStatus; exitCode?: number; durationMs?: number; at?: number; reason?: string };
export type Gate = 'none' | 'passed' | 'failed' | 'incomplete';
export type OutputContract = { definitionId: string; version: number; sections: { name: string; present: boolean }[]; status: 'met' | 'missing' };

type Observed = { name: string; args: unknown; exitCode?: number; observedAt: number; verification?: 'reviewed-check'; durationMs?: number; seq?: number };

export const contractLimits = { sections: 12, sectionChars: 80, requiredChecks: 12 };

/** Section names a recipe expects in its reply; undefined when the recipe declares none. */
export function validSections(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > contractLimits.sections) throw new Error(`List up to ${contractLimits.sections} output sections`);
  const names = value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > contractLimits.sectionChars || /[\x00-\x1f\x7f#*]/.test(item)) throw new Error(`Name each output section with 1–${contractLimits.sectionChars} characters, without # or *`);
    return item.trim();
  });
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('Output sections must have different names');
  return names.length ? names : undefined;
}

const fold = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether each section starts a line as a Markdown heading, a bold label or a "Name:" label, outside code. */
export function checkSections(text: string, sections: string[]): { name: string; present: boolean }[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) lines.push(line);
  }
  const labels = lines.map(line => {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    const bold = line.match(/^\s*(?:[-*]\s+)?\*\*(.+?)\*\*/)?.[1];
    const plain = line.match(/^\s*([^:]{1,80}):(?:\s|$)/)?.[1];
    return [heading, bold, plain].filter(Boolean).map(value => fold(String(value).replace(/:$/, '')));
  }).flat();
  return sections.map(name => ({ name, present: labels.includes(fold(name)) }));
}

export function contractFor(definition: { id: string; version: number; outputSections?: string[] }, reply: string): OutputContract | undefined {
  if (!definition.outputSections?.length) return undefined;
  const sections = checkSections(reply, definition.outputSections);
  return { definitionId: definition.id, version: definition.version, sections, status: sections.every(section => section.present) ? 'met' : 'missing' };
}

/**
 * The required checks of a project, judged for one result. The latest event for each check wins:
 * a later cancellation or start failure replaces an earlier pass, and a check whose definition
 * changed since it ran is stale.
 */
export function checklist(required: RequiredCheck[], observed: Observed[], attempts: CheckAttempt[], current: (scriptId: string) => { definitionDigest: string; label: string } | undefined, digestOf: (value: unknown) => string) {
  const rows: ChecklistRow[] = required.map(check => {
    const script = current(check.scriptId), label = script?.label || check.label;
    if (!script) return { scriptId: check.scriptId, label, status: 'missing' as const };
    const run = [...observed].reverse().find(action => action.verification === 'reviewed-check' && action.name === 'script.run' && (action.args as any)?.id === check.scriptId);
    const attempt = [...attempts].reverse().find(item => item.scriptId === check.scriptId);
    // Events on one result are numbered in the order they happened; two can share a millisecond.
    const later = attempt && run ? (attempt.seq !== undefined || run.seq !== undefined ? (attempt.seq ?? 0) > (run.seq ?? 0) : attempt.at >= run.observedAt) : !!attempt;
    if (attempt && later) return { scriptId: check.scriptId, label, status: attempt.state, at: attempt.at, ...(attempt.reason ? { reason: attempt.reason } : {}) };
    if (!run) return { scriptId: check.scriptId, label, status: 'not-run' as const };
    const base = { scriptId: check.scriptId, label, at: run.observedAt, ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}), ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}) };
    if (digestOf((run.args as any)?.definition) !== script.definitionDigest) return { ...base, status: 'stale' as const };
    return { ...base, status: run.exitCode === 0 ? 'passed' as const : 'failed' as const };
  });
  const gate: Gate = !rows.length ? 'none' : rows.every(row => row.status === 'passed') ? 'passed' : rows.some(row => row.status === 'failed') ? 'failed' : 'incomplete';
  return { rows, gate };
}
