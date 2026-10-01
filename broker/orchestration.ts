import type { Core } from './core.ts';
import { categoryEnabled } from './permissions.ts';
import type { Session, ToolDefinition } from './types.ts';

const id = { type: 'string', maxLength: 150, description: 'ID of a session delegated by this conversation' };
const prompt = { type: 'string', minLength: 1, maxLength: 100000, description: 'The complete task and context to send to this provider. The user reviews it before sending.' };
export const orchestrationDefinitions: ToolDefinition[] = [
  { name: 'providers.list', title: 'List providers', category: 'providers', description: 'List available Codex and Claude providers and their selectable models and efforts', schema: {}, readOnly: true },
  { name: 'sessions.list', title: 'List delegated sessions', category: 'providers', description: 'List sessions created by this conversation', schema: {}, readOnly: true },
  { name: 'sessions.start', title: 'Delegate a task', category: 'providers', description: 'Start a visible Codex or Claude conversation in the current project after user approval. Returns its ID immediately; use sessions_wait for results.',
    schema: { provider: { type: 'string', enum: ['codex', 'claude'] }, prompt, model: { type: 'string', maxLength: 512, description: 'Optional model ID from providers_list; omit for CLI default' }, effort: { type: 'string', maxLength: 32, description: 'Optional effort supported by that model' } }, required: ['provider', 'prompt'] },
  { name: 'sessions.send', title: 'Continue delegated work', category: 'providers', description: 'Send a follow-up to an idle delegated session after user approval. Returns immediately.', schema: { id, prompt } },
  { name: 'sessions.read', title: 'Read delegated results', category: 'providers', description: 'Read status and recent conversation messages from a delegated session', schema: { id }, readOnly: true },
  { name: 'sessions.wait', title: 'Wait for delegated work', category: 'providers', description: 'Wait up to 60 seconds for a delegated turn, then return status and recent messages. Waiting sessions need user input in Cere.', schema: { id, seconds: { type: 'integer', minimum: 1, maximum: 60 } }, required: ['id'], readOnly: true },
  { name: 'sessions.stop', title: 'Stop delegated work', category: 'providers', description: 'Interrupt a session created by this conversation', schema: { id } },
];
const busy = (s: Session) => ['starting', 'working', 'waiting', 'stopping'].includes(s.status);
function validate(def: ToolDefinition, args: any) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments');
  for (const key of Object.keys(args)) if (!(key in def.schema)) throw new Error('Unexpected argument: ' + key);
  for (const [key, rule] of Object.entries(def.schema)) {
    const value = args[key];
    if (value === undefined && !(def.required || Object.keys(def.schema)).includes(key)) continue;
    if (rule.type === 'string' && (typeof value !== 'string' || value.includes('\0') || value.length > rule.maxLength || (rule.minLength && value.trim().length < rule.minLength))) throw new Error('Invalid ' + key);
    if (rule.enum && !rule.enum.includes(value)) throw new Error('Invalid ' + key);
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new Error('Invalid ' + key);
  }
}
export async function orchestrate(core: Core, parentId: string, name: string, args: any, signal: AbortSignal) {
  const def = orchestrationDefinitions.find(d => d.name === name);
  if (!def) throw new Error('Unknown orchestration tool');
  validate(def, args);
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
  const read = () => { core.flush(); const session = owned(); return { ...summary(session), messages: core.store.messages(session.id).filter(m => m.role === 'assistant' || m.role === 'user').slice(-12).map(m => ({ role: m.role, text: m.text.slice(-3500) })) }; };
  if (name === 'providers.list') return ['codex', 'claude'].map(provider => ({ provider, available: !!core.capabilities[provider]?.available, models: core.capabilities[provider]?.models || [], modelsStatus: core.capabilities[provider]?.modelsStatus }));
  if (name === 'sessions.list') return children().map(summary);
  if (name === 'sessions.read') return read();
  if (name === 'sessions.stop') { const child = owned(); await core.stop(child.id); return summary(core.store.session(child.id)); }
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
  const provider = child?.provider || args.provider;
  if (parent.remote && provider === 'claude') throw new Error('Claude native policy is unverified for remote delegation');
  if (core.capabilities[provider]?.available === false) throw new Error(provider + ' is unavailable');
  const answer = await core.approval(parentId, { kind: 'provider', title: `Send this task to ${provider === 'codex' ? 'Codex' : 'Claude'}?`,
    detail: `Project: ${parent.cwd}\nModel: ${child?.model || args.model || 'CLI default'}\nEffort: ${child?.effort || args.effort || 'CLI default'}\n\n${args.prompt}`,
    choices: ['allow', 'deny'] });
  if (answer.choice !== 'allow') throw new Error('Delegation declined. Do not send this task again without a new user request.');
  permitted();
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
  await core.send({ id: child.id, text: args.prompt });
  if (signal.aborted) { await core.stop(child.id); signal.throwIfAborted(); }
  core.store.activity({ action: name, sessionId: parentId, childId: child.id, status: 'completed' }); core.changed();
  return summary(core.store.session(child.id));
}
