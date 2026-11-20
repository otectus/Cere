import { createHash } from 'node:crypto';
/**
 * The typed registry for Workbench tools. Each definition carries its model-facing name, a strict input
 * schema (validated at execution whatever the provider claims about schema enforcement), its family and
 * effects as Cere declares them, and an availability check. Advertising a tool is not authorization:
 * availability is checked again when a call is accepted, and each service re-checks before it reads,
 * releases, dispatches or commits.
 *
 * Small models get a focused set: each enabled family contributes its core tools, and `cere_tools`
 * lists the rest so the model can add one for the remainder of the turn. Selecting a tool never widens
 * authority; it only changes which already-authorized schemas the next request carries.
 *
 * The older tool families (desktop, delegation, web, memory, notes, extensions, custom tools) keep their
 * existing routing in Core and are not registered here.
 */
import { z } from 'zod';
import type { OllamaTool } from '../ollama.ts';
import type { Session } from '../types.ts';
import { completed, failed, isToolResult, type ToolResultV1, type WorkbenchFamily } from './contracts.ts';

export type ToolEffects = { read?: boolean; write?: boolean; execute?: boolean; network?: boolean; spend?: boolean };
export type ToolContext = { sessionId: string; session: Session; signal: AbortSignal; turnId: string };
export type ToolSpec<Input extends z.ZodType = z.ZodType> = {
  name: string;
  family: WorkbenchFamily | 'operations' | 'knowledge';
  description: string;
  input: Input;
  effects: ToolEffects;
  /** Part of the focused default set for its family; others are reached through cere_tools. */
  core?: boolean;
  /** '' when the tool may be offered to this conversation now; otherwise the reason it is not. */
  available(session: Session): string;
  run(context: ToolContext, args: z.infer<Input>): Promise<ToolResultV1>;
};
type Selection = { turnId: string; names: Set<string> };
const invalidLimit = 2;

/** JSON Schema for a provider, generated from the same definition that validates the call. */
export function providerSchema(input: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  return schema;
}

export class ToolRegistry {
  private specs = new Map<string, ToolSpec<any>>();
  private selected = new Map<string, Selection>();
  private refused = new Map<string, string>();
  private invalid = new Map<string, number>();
  register<Input extends z.ZodType>(spec: ToolSpec<Input>) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(spec.name) || this.specs.has(spec.name) || spec.name === 'cere_tools') throw new Error('Invalid or duplicate tool name ' + spec.name);
    this.specs.set(spec.name, spec);
  }
  has(name: string) { return name === 'cere_tools' || this.specs.has(name); }
  spec(name: string) { return this.specs.get(name); }
  /** Every registered tool this conversation could use now, with the reason for each that it cannot. */
  availability(session: Session, families: Set<string>) {
    const usable: ToolSpec[] = [], unavailable: { name: string; family: string; reason: string }[] = [];
    for (const spec of this.specs.values()) {
      if (!families.has(spec.family)) continue;
      let reason = '';
      try { reason = spec.available(session); } catch (error: any) { reason = error?.message || 'Unavailable'; }
      if (reason) unavailable.push({ name: spec.name, family: spec.family, reason }); else usable.push(spec);
    }
    return { usable, unavailable };
  }
  private selection(session: Session) {
    const turnId = session.turnId || '', current = this.selected.get(session.id);
    if (!current || current.turnId !== turnId) { const fresh = { turnId, names: new Set<string>() }; this.selected.set(session.id, fresh); return fresh; }
    return current;
  }
  /** The tools a request carries: core tools of enabled families, tools selected this turn, and the catalog when more exist. */
  advertise(session: Session, families: Set<string>): OllamaTool[] {
    const { usable } = this.availability(session, families);
    if (!usable.length) return [];
    const chosen = this.selection(session).names;
    const offered = usable.filter(spec => spec.core || chosen.has(spec.name));
    const tools = offered.map(spec => ({ type: 'function' as const, function: { name: spec.name, description: spec.description, parameters: providerSchema(spec.input) } }));
    if (offered.length < usable.length) tools.push({ type: 'function', function: { name: 'cere_tools', description: 'List more Workbench tools available in this conversation, or add some of them to your next request. Adding a tool grants nothing new; it only makes an already-permitted tool callable.',
      parameters: providerSchema(z.strictObject({ add: z.array(z.string().max(64)).max(8).optional().describe('Names of listed tools to make callable in your next request') })) } });
    return tools;
  }
  /** Runs one Workbench tool after validating its arguments and re-checking that it is still available. */
  async call(session: Session, families: Set<string>, name: string, args: unknown, signal: AbortSignal): Promise<ToolResultV1> {
    const turnId = session.turnId || '';
    if (name === 'cere_tools') return this.catalog(session, families, args);
    const spec = this.specs.get(name);
    if (!spec || !families.has(spec.family)) return failed('not_offered', 'This tool is not available in this conversation.', 'never');
    const reason = spec.available(session);
    if (reason) return failed('unavailable', reason, 'never');
    const key = `${session.id}\n${turnId}\n${name}`;
    if ((this.invalid.get(key) || 0) >= invalidLimit) return failed('invalid_arguments', `The arguments for ${name} were invalid ${invalidLimit} times this turn. Stop calling it; tell the user what you were trying to do so they can do it from the Workbench.`, 'never');
    const parsed = spec.input.safeParse(args ?? {});
    if (!parsed.success) {
      this.invalid.set(key, (this.invalid.get(key) || 0) + 1);
      if (this.invalid.size > 500) this.invalid.delete(this.invalid.keys().next().value!);
      const detail = parsed.error.issues.slice(0, 5).map((issue: z.core.$ZodIssue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
      return failed('invalid_arguments', `Invalid arguments for ${name}: ${detail}`.slice(0, 600), 'explicit');
    }
    signal.throwIfAborted();
    // A call refused as never retryable is not run again in the same turn; the model is told to stop.
    const refusalKey = `${key}\n${createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')}`;
    const earlier = this.refused.get(refusalKey);
    if (earlier) return failed('repeated_refusal', `This exact ${name} call was already refused this turn (${earlier}). Repeating it cannot succeed: stop calling it, and tell the user what you were trying to do and what permission or change it needs.`, 'never');
    const result = await spec.run({ sessionId: session.id, session, signal, turnId }, parsed.data);
    if (!isToolResult(result)) throw new Error('A Workbench tool returned an invalid result');
    if (result.status === 'failed' && result.error?.retry === 'never') { this.refused.set(refusalKey, result.summary.slice(0, 200)); if (this.refused.size > 500) this.refused.delete(this.refused.keys().next().value!); }
    return result;
  }
  private catalog(session: Session, families: Set<string>, args: unknown): ToolResultV1 {
    const parsed = z.strictObject({ add: z.array(z.string().max(64)).max(8).optional() }).safeParse(args ?? {});
    if (!parsed.success) return failed('invalid_arguments', 'cere_tools takes an optional "add" list of tool names', 'explicit');
    const { usable, unavailable } = this.availability(session, families), chosen = this.selection(session).names;
    const added: string[] = [], unknown: string[] = [];
    for (const name of parsed.data.add || []) { if (usable.some(spec => spec.name === name && !spec.core)) { chosen.add(name); added.push(name); } else unknown.push(name); }
    return completed(added.length ? `Added ${added.join(', ')} to your next request.` : 'Workbench tools available in this conversation.', {
      tools: usable.map(spec => ({ name: spec.name, offered: !!spec.core || chosen.has(spec.name), description: spec.description.split('. ')[0].slice(0, 160) })),
      ...(unavailable.length ? { unavailable: unavailable.slice(0, 20) } : {}), ...(unknown.length ? { notAdded: unknown } : {}),
    });
  }
  forgetSession(sessionId: string) { this.selected.delete(sessionId); for (const key of [...this.refused.keys()]) if (key.startsWith(sessionId + '\n')) this.refused.delete(key); for (const key of [...this.invalid.keys()]) if (key.startsWith(sessionId + '\n')) this.invalid.delete(key); }
}
