import { createHash } from 'node:crypto';

/**
 * Notices when Cere's own API/Ollama tool loop stops making progress within one turn: the same
 * tool called with the same arguments keeps returning the same result. It only warns, once per
 * call, and never stops, retries or replays a tool; the 24-round limit and Stop stay in charge.
 * A changed result counts as progress. Waiting and status tools legitimately repeat, so they never
 * trigger it. Loops inside native CLI providers are theirs to report and are not observed here.
 */
export const noProgressRepeats = 3;
/** Tools whose purpose is to be asked again until something changes. */
export const pollingTools = new Set(['sessions_wait', 'sessions_read', 'sessions_list', 'providers_list', 'timer_list', 'audio_status', 'media_status', 'windows_list', 'apps_list', 'script_list']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value ?? null);
}
/** A bounded fingerprint: results can be large, and only equality matters. */
const fingerprint = (value: string) => createHash('sha256').update(value.length > 200_000 ? value.slice(0, 200_000) + value.length : value).digest('base64url');

export class ToolProgress {
  private calls = new Map<string, { result: string; repeats: number; warned: boolean }>();
  /** Records one finished call; returns a warning the first time it has repeated without progress. */
  observe(name: string, args: unknown, serializedResult: string): string | undefined {
    if (pollingTools.has(name)) return;
    const key = name + '\u0000' + fingerprint(canonical(args)), result = fingerprint(serializedResult);
    const previous = this.calls.get(key);
    if (!previous || previous.result !== result) { this.calls.set(key, { result, repeats: 1, warned: previous?.warned === true }); return; }
    previous.repeats++;
    if (previous.repeats < noProgressRepeats || previous.warned) return;
    previous.warned = true;
    return `No progress: ${name} returned the same result ${previous.repeats} times with the same arguments in this turn. Stop the turn if it looks stuck; Cere does not stop or retry it for you.`;
  }
  get size() { return this.calls.size; }
}
