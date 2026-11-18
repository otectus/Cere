import type { Core } from './core.ts';
import { categoryEnabled } from './permissions.ts';
import type { Session, ToolDefinition } from './types.ts';

const id = { type: 'string', maxLength: 150, description: 'ID of a session delegated by this conversation' };
const prompt = { type: 'string', minLength: 1, maxLength: 100000, description: 'The complete task and context to send to this provider. The user reviews it before sending.' };
// A next task the user asked for, declared with this one. It travels with this task's delegation update,
// so it survives a long conversation; starting it is a separate delegation with its own approval.
const followUp = { type: 'object', description: 'Only when the user asked for a next task to run after this one finishes: that task, which you start from this task\'s delegation update with its result as context. It needs its own approval then.',
  properties: { provider: { type: 'string', enum: ['codex', 'claude'] }, prompt: { type: 'string', minLength: 1, maxLength: 20000, description: 'The next task as the user asked for it' },
    model: { type: 'string', maxLength: 512, description: 'Optional model ID from providers_list' }, effort: { type: 'string', maxLength: 32, description: 'Optional effort supported by that model' } },
  required: ['provider', 'prompt'], additionalProperties: false };
export const orchestrationDefinitions: ToolDefinition[] = [
  { name: 'providers.list', title: 'List providers', category: 'providers', description: 'List available Codex and Claude providers and their selectable models and efforts', schema: {}, readOnly: true },
  { name: 'sessions.list', title: 'List delegated sessions', category: 'providers', description: 'List sessions created by this conversation', schema: {}, readOnly: true },
  { name: 'sessions.start', title: 'Delegate a task', category: 'providers', description: 'Start a visible Codex or Claude conversation in the current project after user approval. Returns its ID immediately; Cere sends this conversation a delegation update when it finishes.',
    schema: { provider: { type: 'string', enum: ['codex', 'claude'] }, prompt, model: { type: 'string', maxLength: 512, description: 'Optional model ID from providers_list; omit for CLI default' }, effort: { type: 'string', maxLength: 32, description: 'Optional effort supported by that model' }, followUp }, required: ['provider', 'prompt'] },
  { name: 'sessions.send', title: 'Continue delegated work', category: 'providers', description: 'Send a follow-up to an idle delegated session after user approval. Returns immediately; Cere sends this conversation a delegation update when it finishes.', schema: { id, prompt, followUp }, required: ['id', 'prompt'] },
  { name: 'sessions.read', title: 'Read delegated results', category: 'providers', description: 'Read status and recent conversation messages from a delegated session', schema: { id }, readOnly: true },
  { name: 'sessions.wait', title: 'Wait for delegated work', category: 'providers', description: 'Wait up to 60 seconds for a delegated turn, then return status and recent messages. Usually unnecessary: a finished session reports back by itself. Waiting sessions need user input in Cere.', schema: { id, seconds: { type: 'integer', minimum: 1, maximum: 60 } }, required: ['id'], readOnly: true },
  { name: 'sessions.stop', title: 'Stop delegated work', category: 'providers', description: 'Interrupt a session created by this conversation', schema: { id } },
];
// With automatic delegation updates off, results arrive only by waiting or reading, as before they existed,
// and no next task can be declared, since no delegation update would carry it.
const withoutUpdates: Record<string, string> = {
  'sessions.start': 'Start a visible Codex or Claude conversation in the current project after user approval. Returns its ID immediately; use sessions_wait for results.',
  'sessions.send': 'Send a follow-up to an idle delegated session after user approval. Returns immediately.',
  'sessions.wait': 'Wait up to 60 seconds for a delegated turn, then return status and recent messages. Waiting sessions need user input in Cere.',
};
/** An orchestration tool as offered to the model, with or without automatic delegation updates. */
export function orchestrationOffer(def: ToolDefinition, updates: boolean): Pick<ToolDefinition, 'description' | 'schema' | 'required'> {
  if (updates) return def;
  const { followUp: _followUp, ...schema } = def.schema;
  return { description: withoutUpdates[def.name] ?? def.description, schema, required: def.required };
}
const busy = (s: Session) => ['starting', 'working', 'waiting', 'stopping'].includes(s.status);
// A nested object is checked by the same rules; its errors name the full path, such as followUp.prompt.
function validate(schema: Record<string, any>, required: string[] | undefined, args: any, path = '') {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(path ? 'Invalid ' + path.slice(0, -1) : 'Invalid tool arguments');
  for (const key of Object.keys(args)) if (!(key in schema)) throw new Error('Unexpected argument: ' + path + key);
  for (const [key, rule] of Object.entries(schema)) {
    const value = args[key];
    if (value === undefined && !(required || Object.keys(schema)).includes(key)) continue;
    if (rule.type === 'string' && (typeof value !== 'string' || value.includes('\0') || value.length > rule.maxLength || (rule.minLength && value.trim().length < rule.minLength))) throw new Error('Invalid ' + path + key);
    if (rule.enum && !rule.enum.includes(value)) throw new Error('Invalid ' + path + key);
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new Error('Invalid ' + path + key);
    if (rule.type === 'object') validate(rule.properties, rule.required, value, path + key + '.');
  }
}
export async function orchestrate(core: Core, parentId: string, name: string, args: any, signal: AbortSignal) {
  const def = orchestrationDefinitions.find(d => d.name === name);
  if (!def) throw new Error('Unknown orchestration tool');
  validate(def.schema, def.required, args);
  if (args.followUp && !core.settings.delegationUpdates) throw new Error('A next task can be declared only while automatic delegation updates are on. Start it yourself once this result is read.');
  const permitted = () => {
    signal.throwIfAborted();
    const parent = core.store.session(parentId);
    if (!(parent.ollama?.tools || parent.api?.tools) || !categoryEnabled(core.settingsFor(parentId), 'providers') || (parent.remote && !parent.remote.caps.includes('providers.execute'))) throw new Error('Provider orchestration is disabled in Cere settings');
    return parent;
  };
  const parent = permitted();
  const children = () => core.store.sessions().filter(s => s.parentId === parentId);
  const owned = () => { const session = core.store.session(args.id); if (session.parentId !== parentId || session.mode !== 'managed' || !['codex', 'claude'].includes(session.provider)) throw new Error('This conversation can only manage its own delegated sessions'); return session; };
  const summary = (s: Session) => ({ id: s.id, provider: s.provider, title: s.title, status: s.status, model: s.model, error: s.error });
  // A read that finds the delegated turn ended consumes its update: this turn already has the result.
  const read = () => {
    core.flush(); const session = owned();
    const result = { ...summary(session), messages: core.store.messages(session.id).filter(m => m.role === 'assistant' || m.role === 'user').slice(-12).map(m => ({ role: m.role, text: m.text.slice(-3500) })) };
    if (!busy(session)) core.pings.consume(parentId, session.id);
    return result;
  };
  if (name === 'providers.list') return ['codex', 'claude'].map(provider => ({ provider, available: !!core.capabilities[provider]?.available, models: core.capabilities[provider]?.models || [], modelsStatus: core.capabilities[provider]?.modelsStatus }));
  if (name === 'sessions.list') return children().map(summary);
  if (name === 'sessions.read') return read();
  if (name === 'sessions.stop') {
    const child = owned(); await core.stop(child.id);
    // The model stopped it itself and sees the result here, so no separate update follows.
    const stopped = core.store.session(child.id); if (!busy(stopped)) core.pings.consume(parentId, child.id);
    return summary(stopped);
  }
  if (name === 'sessions.wait') {
    if (busy(owned())) await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); core.off('state', changed); signal.removeEventListener('abort', abort); };
      const finish = () => { cleanup(); resolve(); };
      const changed = () => { if (!busy(owned())) finish(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(finish, (args.seconds || 60) * 1000);
      core.on('state', changed); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else changed();
    });
    permitted(); return read();
  }
  let child = name === 'sessions.send' ? owned() : undefined;
  if (child && busy(child)) throw new Error('The delegated session is busy. Wait for it or stop it first.');
  if (!child && children().filter(busy).length >= 4) throw new Error('At most four delegated sessions may run at once');
  const provider = child?.provider || args.provider, next = args.followUp;
  if (parent.remote && (provider === 'claude' || next?.provider === 'claude')) throw new Error('Claude native policy is unverified for remote delegation');
  if (core.capabilities[provider]?.available === false) throw new Error(provider + ' is unavailable');
  const label = (value: string) => value === 'codex' ? 'Codex' : 'Claude';
  // A declared next task is shown with this one, but allowing this task never allows that one.
  const planned = next ? `\n\nAfter it finishes, the next task is planned for ${label(next.provider)}${next.model || next.effort ? ` (model: ${next.model || 'CLI default'}, effort: ${next.effort || 'CLI default'})` : ''}. Allowing this task does not allow that one:\n${next.prompt}` : '';
  const answer = await core.approval(parentId, { kind: 'provider', title: `Send this task to ${label(provider)}?`,
    detail: `Project: ${parent.cwd}\nModel: ${child?.model || args.model || 'CLI default'}\nEffort: ${child?.effort || args.effort || 'CLI default'}\n\n${args.prompt}${planned}`,
    choices: ['allow', 'deny'] });
  if (answer.choice !== 'allow') throw new Error('Delegation declined. Do not send this task again without a new user request.');
  permitted();
  if(answer.automatic&&!core.automaticallyApprove(parentId,{kind:'provider',choices:['allow']}))throw new Error('Automatic CLI permission was revoked');
  if (!child) {
    child = await core.create({ provider, cwd: parent.cwd, trusted: true, model: args.model, effort: args.effort, title: 'Delegated · ' + args.prompt.trim().slice(0, 60) },permitted);
    child = core.updateSession(child.id, { parentId, remote:parent.remote ? structuredClone(parent.remote) : undefined, effectivePolicy:parent.remote ? 'unknown' : undefined });
  }
  permitted();
  if(!parent.remote)await core.power.attachChild(parent.id,child.id);
  if (parent.remote && child.remote?.deviceId !== parent.remote.deviceId) {
    await core.disconnect(child.id);
    child = core.updateSession(child.id,{remote:structuredClone(parent.remote),effectivePolicy:'unknown'});
  }
  const active = core.delegations.get(parentId) || new Set<string>(); active.add(child.id); core.delegations.set(parentId, active);
  // Registered before dispatch, so a child that finishes before send() returns still reports back.
  const ping = core.pings.register(parent, child, name, args);
  try { await core.send({ id: child.id, text: args.prompt }); }
  catch (error) { if (ping) core.pings.drop(ping.id, 'Dispatch failed'); throw error; }
  if (ping) core.pings.attachTurn(ping.id, core.store.session(child.id).turnId);
  if (signal.aborted) { await core.stop(child.id); signal.throwIfAborted(); }
  core.store.activity({ action: name, sessionId: parentId, childId: child.id, status: 'completed' }); core.changed();
  return summary(core.store.session(child.id));
}
