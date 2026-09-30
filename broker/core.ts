import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { stat, realpath, readdir, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { Store } from './store.ts';
import { autoApprove, bypassCategory, categoryEnabled } from './permissions.ts';
import type { Session, Settings, Message, Approval, Adapter, ProviderEvent, Provider, ModelOption, AgentActivity, RunCompletion } from './types.ts';
import { CodexAdapter, ClaudeAdapter, claudeRestrictedHelp, providerExecutable } from './providers.ts';
import type { Hooks } from './providers.ts';
import { transportMessage, messagePage, messageChunk } from './transcript.ts';
import { discoverProviderModels } from './models.ts';
import { actionDefinitions, validateAction, desktopAction, applications, windows, audioStatus, mediaStatus, exec } from './desktop.ts';
import { RpcProcess } from './wire.ts';
import { paths } from './paths.ts';
import { OllamaAdapter, ollamaHost, ollamaModels } from './ollama.ts';
import type { OllamaMessage, OllamaTool } from './ollama.ts';
import { orchestrationDefinitions, orchestrate } from './orchestration.ts';
import { WebSearch, webDefinitions, webUrl, searchProviders } from './web.ts';
import { Memory, memoryDefinitions } from './memory.ts';
import { defaultPersonality, personalityMaxLength, validatePersonality } from './personality.ts';
import { validateAnswers, claudeQuestions } from './questions.ts';
import { ordinarySettings, busy, remoteError } from './execution.ts';
import type { RemoteExecution } from './execution.ts';
import { Speech, listVoices, validateVoice, voiceDirectories, ttsTestLine } from './tts.ts';

const untitledSession = 'Untitled session';
const sessionTitle = (value: unknown) => String(value ?? '').trim().slice(0,100) || untitledSession;

export class Core extends EventEmitter {
  store: Store; settings: Settings; adapters = new Map<string, Adapter>();
  approvals = new Map<string, { value: Approval; resolve: (value: any) => void }>();
  tokens = new Map<string, string>(); partials = new Map<string, Message>();
  terminal = new Set<string>();
  pendingCompletions = new Map<string, ProviderEvent>();
  completions: RunCompletion[] = [];
  turnReplies = new Map<string, Message>();
  speech: Speech;
  speechResponses = new Map<string, string>();
  sending = new Set<string>();
  stopping = new Map<string, Promise<boolean>>();
  delegations = new Map<string, Set<string>>(); closed = false;
  web = new WebSearch(); webController = new AbortController(); memory: Memory;
  panels = { ui: false, overlay: false };
  attention: Record<'ui'|'overlay',{owner:'ui'|'overlay';sessionId:string;listening:boolean}> = {
    ui: { owner:'ui', sessionId:'', listening:false }, overlay: { owner:'overlay', sessionId:'', listening:false },
  };
  stopTimers=new Set<NodeJS.Timeout>();
  capabilities: any = {}; ticker: NodeJS.Timeout; flushTimer?: NodeJS.Timeout;
  generations = new Map<string, number>();
  remoteAuthority?: (execution: RemoteExecution, session: Session) => boolean;
  remoteStatus: unknown = { enabled:false, connected:[] };
  factory: (s: Session, h: Hooks) => Adapter;
  modelLoader: (provider: Provider, host?: string) => Promise<ModelOption[]>; modelGenerations = new Map<Provider,number>();
  constructor(store = new Store(), factory?: (s: Session, h: Hooks) => Adapter, modelLoader = discoverProviderModels) {
    super(); this.store = store; this.settings = store.settings(); this.modelLoader = modelLoader;
    this.speech = new Speech(() => this.settings, () => { if (!this.closed) this.changed(); });
    this.memory = new Memory(store, () => this.settings, () => { if (!this.closed) this.changed(); });
    this.factory = factory || ((s, h) => s.provider === 'codex' ? new CodexAdapter(s,h) : s.provider === 'claude' ? new ClaudeAdapter(s,h) : new OllamaAdapter(s,h,{
      load: () => this.store.get<OllamaMessage[]>('ollama:' + s.id, []),
      save: messages => this.store.set('ollama:' + s.id, messages),
      tools: () => this.toolsFor(s.id), call: (name, args, signal) => this.callTool(s.id, name, args, signal),
      prepare: (text, signal, budget, route) => this.settingsFor(s.id).memory.enabled && this.memory.active() ? this.memory.context(s, text, signal, budget, route, this.memoryWritable(s.id), () => this.memoryAuthorized(s.id, false, signal)) : Promise.resolve(''),
      memorySignal: () => this.memory.controller.signal,
      inference: active => this.memory.service.call('foreground',{active}),
      memoryActive: () => this.settingsFor(s.id).memory.enabled && this.memory.active(), completed: (text, answer, signal) => this.settingsFor(s.id).memory.enabled && this.memoryWritable(s.id) ? this.memory.capture(s, text, answer, signal, () => this.memoryAuthorized(s.id, true, signal)) : Promise.resolve(),
      search: (query, signal) => { if (!this.settingsFor(s.id).webSearch.enabled) throw new Error('Web scope denied'); return this.webCall('web_search', { query }, signal); },
    }));
    for (const s of store.sessions()) if (['starting','working','waiting','stopping'].includes(s.status)) {
      s.status = 'interrupted'; delete s.activity;
      s.agents = s.agents?.map(a => this.agentActive(a) ? {...a, status:'interrupted', updated:Date.now()} : a); s.error = 'Cere restarted. The previous turn was not replayed.'; store.saveSession(s);
      for (const agent of s.agents || []) if (agent.status === 'interrupted') this.recordAgent(s.id,agent);
    }
    this.flush();
    this.ticker = setInterval(() => void this.checkTimers(), 1000); this.ticker.unref();
  }
  changed() { this.emit('state', this.snapshot()); }
  snapshot() { return { version: 1, sessions: this.store.sessions(), settings: this.settings, speech: this.speech.snapshot(), settingsRevision:this.store.get('settingsRevision','0'), remote: this.remoteStatus, personality: { defaultText: defaultPersonality, maxLength: personalityMaxLength }, memory: this.memory.summary(), approvals: [...this.approvals.values()].map(a => a.value), completions: this.completions, capabilities: this.capabilities, actions: actionDefinitions, timers: this.store.timers(), activity: this.store.activities(), panels: {...this.panels}, attention: structuredClone(this.attention) }; }
  settingsFor(id: string): Settings {
    const session = this.store.session(id), execution = session.remote;
    if (execution && (!this.remoteAuthority?.(execution, session) || execution.expiresAt <= Date.now())) throw remoteError('AUTH_REVOKED', 'Remote authority expired or was revoked. Detach locally to continue.');
    return ordinarySettings(this.settings, execution);
  }
  async disconnect(id: string) {
    const s = this.store.session(id); if (busy(s)) throw remoteError('SESSION_BUSY', 'Stop the active turn first.');
    this.abortActions(id, new Error('Session disconnected'));
    this.terminal.add(id); this.generations.set(id, (this.generations.get(id) || 0) + 1);
    const adapter = this.adapters.get(id); this.adapters.delete(id);
    for (const [token, sessionId] of this.tokens) if (sessionId === id) this.tokens.delete(token);
    await adapter?.close(); return true;
  }
  async sendRemote(p: any, execution: RemoteExecution, beforeAccept?:()=>void, onDispatched?:()=>void, onAccepted?:()=>void, onRejected?:()=>void) {
    if (this.sending.has(p.id) || this.stopping.has(p.id) || busy(this.store.session(p.id))) throw remoteError('SESSION_BUSY', 'This session is busy.');
    this.sending.add(p.id);
    try {
      await this.disconnect(p.id);
      const session = this.store.session(p.id);
      if ((session.draftRevision || '0') !== p.expectedDraftRevision || (session.configRevision || '0') !== p.expectedConfigRevision) throw remoteError('REVISION_CONFLICT', 'The desktop draft or configuration changed.');
      if (!this.remoteAuthority?.(execution, session)) throw remoteError('AUTH_REVOKED','Remote authority changed.');
      this.updateSession(p.id, { remote:structuredClone(execution), effectivePolicy:['ollama','claude'].includes(session.provider)?'restricted':'unknown', turnId:p.turnId });
      return await this.sendTurn(p,beforeAccept,onDispatched,onAccepted,onRejected);
    } finally { this.sending.delete(p.id); }
  }
  draft(id: string, text: string, expectedRevision?: string, scroll?: number) {
    const session = this.store.session(id);
    if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid draft');
    if (expectedRevision !== undefined && expectedRevision !== (session.draftRevision || '0')) throw remoteError('REVISION_CONFLICT', 'Draft changed on another client. Your local draft is retained.');
    return this.updateSession(id, {draft:text, ...(scroll === undefined ? {} : {scroll})});
  }
  panel(owner: string, visible: boolean) {
    if (owner !== 'ui' && owner !== 'overlay') throw new Error('Invalid panel owner');
    if (typeof visible !== 'boolean') throw new Error('Invalid panel visibility');
    if (!visible && this.attention[owner].listening) {
      this.attention[owner] = { ...this.attention[owner], listening:false };
      this.emit('ui', {command:'attention',...this.attention[owner]});
    }
    this.panels[owner] = visible;
    this.emit('ui', {command:'panel',owner,visible});
    return true;
  }
  async detect() {
    await Promise.all((['codex','claude','ollama'] as Provider[]).map(async provider => {
      try {
        if (provider === 'ollama') { await this.refreshProviderModels(provider); return; }
        const command=providerExecutable(provider);
        const result=await exec(command, ['--version'], { timeout: 10000 });
        // Help probing only gates remote execution. A provider that cannot prove
        // restricted-mode support remains usable by its ordinary desktop flow.
        const help=provider==='claude'?await exec(command,['--help'],{timeout:10000}).catch(()=>({stdout:''})): {stdout:''};
        if (this.closed) return;
        this.capabilities[provider] = { ...this.capabilities[provider], available: true, version: result.stdout.trim(), managed: true, resume: true, liveAttach: false, questions: true, subagents: true, remoteRestricted:provider==='codex'||claudeRestrictedHelp(help.stdout) };
        this.changed(); await this.refreshProviderModels(provider);
      } catch (error:any) {
        if (this.closed || provider === 'ollama') return;
        if (!this.capabilities[provider]?.available) this.capabilities[provider] = { available: false, models: [], modelsStatus:'error', error: `${provider} was not found in PATH or did not start` };
        this.changed();
      }
    }));
  }
  async refreshProviderModels(provider: Provider) {
    const generation=(this.modelGenerations.get(provider)||0)+1;this.modelGenerations.set(provider,generation);
    const previous=this.capabilities[provider] || { available:true };
    this.capabilities[provider]={...previous,modelsStatus:'loading',modelsError:undefined};this.changed();
    try {
      const models=await this.modelLoader(provider, provider === 'ollama' ? this.settings.ollama.host : undefined);
      if (this.closed) return models;
      if(this.modelGenerations.get(provider)!==generation)return this.capabilities[provider]?.models || models;
      // A partially readable catalog stays available; omitted entries are named, never guessed.
      const omitted=(models as {omitted?:{id:string;error:string}[]}).omitted;
      this.capabilities[provider]={...this.capabilities[provider],available:true,models,modelsStatus:'ready',modelsError:undefined,modelsWarning:omitted?.length?`Some models could not be inspected: ${omitted.map(o=>o.id).join(', ')}`:undefined,error:undefined,managed:true,resume:true};this.changed();return models;
    } catch(error:any) {
      if(this.closed || this.modelGenerations.get(provider)!==generation)return this.capabilities[provider]?.models || [];
      this.capabilities[provider]={...this.capabilities[provider],models:previous.models || [],modelsStatus:'error',modelsError:error.message,...(provider==='ollama'?{available:false,error:error.message}:{})};this.changed();throw error;
    }
  }
  agentActive(agent: AgentActivity) { return ['starting','running','waiting'].includes(agent.status); }
  recordAgent(id: string, agent: AgentActivity) {
    const session = this.store.session(id), key = `${id}:agent:${session.turnId || 'initial'}:${agent.id}`;
    const existing = this.partials.get(key) || this.store.messageById(key);
    const text = [agent.name + ' · ' + agent.status, agent.task, agent.detail].filter(Boolean).join('\n');
    this.partials.set(key,{id:key,sessionId:id,role:'tool',kind:'agent',text,time:existing?.time || Date.now(),turnId:session.turnId});
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(),80);
  }
  updateSession(id: string, patch: Partial<Session>) {
    const interruptedAgents: AgentActivity[] = [];
    if (patch.status && ['error','interrupted','disconnected'].includes(patch.status)) {
      this.pendingCompletions.delete(id);
      this.speechResponses.delete(id);
      this.turnReplies.delete(id);
      // A late provider fault retracts that turn's success, never another turn's.
      if (patch.status === 'error' || patch.status === 'interrupted')
        this.completions = this.completions.filter(c => c.sessionId !== id || c.turnId !== this.store.session(id).turnId);
      patch = {...patch, agents:(patch.agents || this.store.session(id).agents)?.map(a => {
        if (!this.agentActive(a)) return a;
        const interrupted: AgentActivity = {...a,status:'interrupted',updated:Date.now()}; interruptedAgents.push(interrupted); return interrupted;
      })};
    }
    if (patch.status && ['idle','waiting','error','interrupted','disconnected'].includes(patch.status) && !('activity' in patch)) patch = { ...patch, activity: undefined };
    const s = { ...this.store.session(id), ...patch, updated: Date.now() }; this.store.saveSession(s); this.changed();
    for (const agent of interruptedAgents) this.recordAgent(id,agent);
    if (interruptedAgents.length) this.flush();
    if (s.parentId && (patch.status || patch.activity)) {
      const status = ({idle:'completed',starting:'starting',working:'running',waiting:'waiting',stopping:'running',error:'failed',interrupted:'interrupted',disconnected:'closed'} as const)[s.status];
      this.event(s.parentId,{type:'agent',id:s.id,data:{name:s.provider.toUpperCase(),task:s.title,status,detail:s.error || (s.activity ? s.activity : undefined)}});
    }
    return s;
  }
  async create(p: any, authorize?: () => void, initial?:Pick<Session,'remote'|'effectivePolicy'> & {draft?:string}) {
    const ollamaConfig = {...this.settings.ollama,...(p.provider==='ollama'&&p.ollamaHost?{host:ollamaHost(p.ollamaHost)}:{})};
    let ollamaCatalog: ModelOption[] | undefined = this.capabilities.ollama?.modelsStatus === 'ready' ? this.capabilities.ollama.models : undefined;
    if (!['codex','claude','ollama'].includes(p.provider)) throw new Error('Choose Codex, Claude, or Ollama');
    if (p.provider === 'ollama' && p.nativeId) throw new Error('Ollama conversations are stored by Cere; CLI imports are not supported');
    if (p.tools !== undefined && typeof p.tools !== 'boolean') throw new Error('Invalid assistance mode');
    if (!p.trusted && !this.settings.bypassCliPermissions && (p.provider !== 'ollama' || p.tools)) throw new Error('Confirm that you trust this project before its CLI configuration is loaded');
    if (p.provider === 'ollama' && !p.tools && !p.cwd) p = {...p, cwd:homedir()};
    if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) throw new Error('Choose an absolute project folder');
    const cwd = await realpath(p.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error('Project must be a folder');
    if (p.nativeId && (typeof p.nativeId !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(p.nativeId))) throw new Error('Invalid native session ID');
    if (p.nativeId && !p.handoffConfirmed) throw new Error('Stop the external CLI session before handing it to Cere');
    if (p.nativeId && this.store.sessions().some(s => s.provider === p.provider && s.nativeId === p.nativeId)) throw new Error('This session is already in Cere');
    const model=String(p.model || (p.provider === 'ollama' ? ollamaConfig.model : '')).trim(), effort=String(p.effort || '').trim().slice(0,32);
    if (model.length > 512 || model.includes('\0')) throw new Error('Invalid model name');
    if (p.provider === 'ollama') {
      if (!model) throw new Error('Choose an Ollama model or set a default in Settings');
      if (effort) throw new Error('Ollama uses the model’s default thinking settings');
      if (!ollamaCatalog) ollamaCatalog = await this.modelLoader('ollama', ollamaConfig.host);
    }
    const catalog:ModelOption[]=p.provider === 'ollama' ? ollamaCatalog || [] : this.capabilities[p.provider]?.modelsStatus==='ready' ? this.capabilities[p.provider].models || [] : [];
    if (p.provider === 'ollama' && !catalog.some(m => m.id === model)) throw new Error('Choose an available Ollama chat model; refresh the model list');
    if(catalog.length){
      const selected=model ? catalog.find(option=>option.id===model) : catalog.find(option=>option.isDefault);
      if(model&&!selected)throw new Error('Choose a model available to this provider');
      if(effort&&(!selected||!selected.efforts.some(option=>option.id===effort)))throw new Error('Choose an effort available for this model');
    } else if(this.capabilities[p.provider]?.modelsStatus==='ready'&&(model||effort))throw new Error('This provider reported no selectable models');
    if (p.provider === 'ollama' && p.tools && !catalog.find(m => m.id === model)?.capabilities?.includes('tools')) throw new Error('Choose a model with tool support or use Conversation mode');
    const s: Session = { ...(p.provider === 'ollama' ? {ollama:{host:ollamaHost(ollamaConfig.host),tools:p.tools === true}} : {}), id: randomUUID(), provider: p.provider, nativeId: p.nativeId || null, title: sessionTitle(p.title), cwd, mode: 'managed', status: 'idle', created: Date.now(), updated: Date.now(), draft: '', scroll: 0, model, effort };
    if(initial){s.remote=initial.remote;s.effectivePolicy=initial.effectivePolicy;if(initial.draft!==undefined)s.draft=initial.draft;}
    authorize?.();
    if(p.nativeId&&this.store.sessions().some(other=>other.provider===p.provider&&other.nativeId===p.nativeId))throw new Error('This session is already in Cere');
    this.store.saveSession(s); this.changed(); return s;
  }
  // Live events carry a frame-bounded copy; the complete text stays in SQLite.
  putMessage(message: Message) { this.store.message(message); this.emit('message', transportMessage(message)); }
  queueCompletion(session: Session, reply?: Message) {
    if (session.mode !== 'managed' || session.provider === 'ollama' || session.parentId) return;
    const time = Date.now();
    // Bound snapshots across simultaneous runs; the transcript keeps the full reply.
    let message: RunCompletion['message'] = reply ? { ...reply } : { id:'', sessionId:session.id, role:'assistant', text:'This run finished without a final message.', time };
    if (message.text.length > 16000) {
      let end = 16000;
      if (/[\uD800-\uDBFF]/.test(message.text[end - 1])) end--;
      message = { ...message, text:message.text.slice(0,end) + '\n\n[Long reply — open the conversation to read more. Copy retrieves the full message.]', truncated:true };
    }
    this.completions = [...this.completions, { id:randomUUID(), sessionId:session.id, turnId:session.turnId,
      title:session.title, provider:session.provider, cwd:session.cwd, time, message }].slice(-20);
  }
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = undefined;
    for (const message of this.partials.values()) this.putMessage(message);
    this.partials.clear();
  }
  event(id: string, e: ProviderEvent) {
    if (e.type === 'approvalResolved') {
      let resolved = false;
      for (const [key,a] of this.approvals) if (a.value.sessionId===id && a.value.nativeRequestId===e.data?.requestId && (!e.data?.threadId || !a.value.nativeThreadId || a.value.nativeThreadId===e.data.threadId)) {
        this.approvals.delete(key); a.resolve({choice:'deny',answers:{},resolved:true}); resolved = true;
      }
      if (resolved && this.store.session(id).status === 'waiting' && ![...this.approvals.values()].some(a => a.value.sessionId === id)) this.updateSession(id, { status: 'working', activity: 'thinking' });
      else this.changed();
      return;
    }
    if (e.type === 'agent') {
      const session = this.store.session(id);
      if (this.terminal.has(id) || ['stopping','error','interrupted','disconnected'].includes(session.status) || !e.id) return;
      const data = e.data || {}, agents = [...session.agents || []], index = agents.findIndex(a => a.id === e.id);
      const previous = index < 0 ? undefined : agents[index];
      if (!['starting','running','waiting','completed','failed','interrupted','closed'].includes(data.status)) return;
      const bounded = (value: unknown, length: number) => typeof value === 'string' ? value.slice(0, length) : undefined;
      const agent: AgentActivity = { ...previous, id:e.id, name:bounded(data.name,200) || previous?.name || 'Agent', status:data.status, updated:Date.now() };
      for (const field of ['task','detail','parentId'] as const) if (typeof data[field] === 'string') agent[field] = bounded(data[field], field === 'parentId' ? 200 : 12000);
      if (index < 0) agents.push(agent); else agents[index] = agent;
      // Keep current work plus recent results bounded in each state snapshot.
      const retained = agents.length > 100 ? [...agents.filter(a => this.agentActive(a)), ...agents.filter(a => !this.agentActive(a)).slice(-80)] : agents;
      const active = retained.some(a => this.agentActive(a));
      const waiting = [...this.approvals.values()].some(a => a.value.sessionId === id);
      this.updateSession(id, { agents:retained, status:waiting ? 'waiting' : 'working', activity:waiting ? undefined : active ? 'delegating' : 'thinking' });
      this.recordAgent(id,agent);
      if (!active && this.pendingCompletions.has(id)) { const completion = this.pendingCompletions.get(id)!; this.pendingCompletions.delete(id); this.event(id,completion); }
      return;
    }
    if (e.type === 'activity') {
      const session = this.store.session(id);
      if (this.terminal.has(id) || !['starting','working'].includes(session.status) || !['thinking','speaking','working','delegating','waitingForAgents','compacting','planning'].includes(e.text || '')) return;
      if (session.activity !== e.text) this.updateSession(id, { activity: e.text as Session['activity'] });
      return;
    }
    if (['delta','message','tool'].includes(e.type)) {
      const session = this.store.session(id);
      if (this.terminal.has(id) || ['error','interrupted','disconnected'].includes(session.status)) return;
      const activity = e.type === 'tool' ? 'working' : 'speaking';
      if (['starting','working'].includes(session.status) && session.activity !== activity) this.updateSession(id, { activity });
      const key = `${id}:${e.id || randomUUID()}`;
      const existing = this.partials.get(key) || this.store.messageById(key);
      const message: Message = { id: key, sessionId: id, role: e.type === 'tool' ? 'tool' : 'assistant', kind: e.type === 'tool' ? 'tool' : 'text', text: e.type === 'delta' ? (existing?.text || '') + (e.text || '') : e.text || '', time: existing?.time || Date.now(), sources: e.data?.sources || existing?.sources };
      if (e.type === 'tool' || e.data?.phase === 'commentary') this.speechResponses.delete(id);
      else this.speechResponses.set(id, message.text.slice(0, 100000));
      this.partials.set(key, message);
      if (message.role === 'assistant' && message.text.trim()) this.turnReplies.set(id,message);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 80);
    } else if (e.type === 'status') {
      const session = this.store.session(id);
      if (this.terminal.has(id) || ['error','interrupted','disconnected'].includes(session.status)) return;
      // Provider thread 'idle' is advisory; only a terminal turn event ends a turn.
      if (e.text === 'working' && session.status !== 'waiting' && session.status !== 'stopping') this.updateSession(id, { status:'working' });
    } else if (['error','complete','interrupted','cancelled','stopped'].includes(e.type)) {
      const session = this.store.session(id);
      if ((this.terminal.has(id) && e.type !== 'error') || ['error','interrupted','disconnected'].includes(session.status)) return;
      if (e.type === 'complete' && !['interrupted','cancelled','canceled','stopped'].includes((e.text || '').toLowerCase()) && session.status !== 'stopping' && (session.agents || []).some(a => this.agentActive(a))) {
        this.pendingCompletions.set(id,e);
        if (session.status !== 'waiting') this.updateSession(id,{status:'working',activity:'waitingForAgents'});
        return;
      }
      this.pendingCompletions.delete(id); this.terminal.add(id);
      this.flush(); this.cancelApprovals(id);
      const interrupted = session.status === 'stopping' || ['interrupted','cancelled','stopped'].includes(e.type) || e.type === 'complete' && ['interrupted','cancelled','canceled','stopped'].includes((e.text || '').toLowerCase());
      const status = e.type === 'error' ? 'error' : interrupted ? 'interrupted' : 'idle';
      if (status === 'idle') this.queueCompletion(session,this.turnReplies.get(id));
      this.turnReplies.delete(id);
      this.updateSession(id, { status, error: e.type === 'error' ? e.text : undefined });
      this.emit('notice', { kind: e.type === 'error' ? 'error' : interrupted ? 'interrupted' : 'complete', sessionId: id, text: e.type === 'error' ? e.text : interrupted ? (e.text || 'Task interrupted') : 'Task complete' });
      const response = this.speechResponses.get(id); this.speechResponses.delete(id);
      if (status === 'idle' && response && session.mode === 'managed' && !session.parentId && !session.remote && !this.closed) this.speech.speak(response);
    }
  }
  approval(sessionId: string, p: Omit<Approval,'id'|'sessionId'|'time'>): Promise<any> {
    // Automatic allows are marked so the caller revalidates that authority before acting.
    if (autoApprove(sessionId ? this.settingsFor(sessionId) : this.settings, p)) return Promise.resolve({ choice: 'allow', automatic: true });
    const value = { ...p, sessionId, id: randomUUID(), time: Date.now() };
    return new Promise(resolve => {
      this.approvals.set(value.id, { value, resolve });
      if (sessionId && p.kind === 'question') {
        this.flush();
        this.putMessage({id:`question:${value.id}`,sessionId,role:'assistant',kind:'question',text:[p.title,...(p.questions || []).map(q => q.question)].join('\n\n'),time:value.time});
      }
      if (sessionId) this.updateSession(sessionId, { status: 'waiting' }); else this.changed();
      this.emit('notice', { kind: 'approval', text: p.title, sessionId });
    });
  }
  answer(p: any, automatic = false) {
    const approval = this.approvals.get(p.id); if (!approval) throw new Error('This request has already ended');
    if (!approval.value.choices.includes(p.choice)) throw new Error('Invalid approval response');
    if (approval.value.kind === 'question' && p.choice === 'answer') {
      p = {...p, answers:validateAnswers(approval.value,p.answers)};
    }
    if (approval.value.kind === 'question' && p.choice === 'answer' && approval.value.sessionId) {
      this.flush();
      const text = (approval.value.questions || []).map(q => q.question + '\n' + (q.isSecret ? '[Private answer sent]' : p.answers[q.id]?.answers.join(', ') || '[Skipped]')).join('\n\n');
      this.putMessage({id:`answer:${approval.value.id}`,sessionId:approval.value.sessionId,role:'user',kind:'answer',text,time:Date.now()});
    }
    this.approvals.delete(p.id); approval.resolve({ ...p, automatic });
    if (approval.value.sessionId && ![...this.approvals.values()].some(a => a.value.sessionId === approval.value.sessionId)) this.updateSession(approval.value.sessionId, { status: 'working', activity: 'thinking' });
    else this.changed();
    return true;
  }
  cancelApprovals(id: string) {
    for (const [key,a] of this.approvals) if (a.value.sessionId === id) { this.approvals.delete(key); a.resolve({ choice: 'deny', answers: {}, cancelled: true }); }
  }
  async send(p: any) {
    if (typeof p.text === 'string' && p.text.trim() === '/tts-test' && !p.images?.length) {
      this.draft(p.id, '', p.expectedDraftRevision);
      return this.speech.speak(ttsTestLine, true);
    }
    if(this.sending.has(p.id) || this.stopping.has(p.id))throw new Error('This session is busy. Stop it or wait for completion.');
    this.sending.add(p.id);
    try { return await this.sendTurn(p); } finally { this.sending.delete(p.id); }
  }
  async sendTurn(p: any, beforeAccept?:()=>void, onDispatched?:()=>void, onAccepted?:()=>void, onRejected?:()=>void) {
    let s = this.store.session(p.id);
    if (p.expectedDraftRevision !== undefined && !p.turnId && p.expectedDraftRevision !== (s.draftRevision || '0')) throw remoteError('REVISION_CONFLICT','Draft changed on another client. Review before sending.');
    const effective = this.settingsFor(p.id);
    if(s.remote&&s.provider!=='ollama'&&effective.paused)throw remoteError('POLICY_PAUSED','Native provider execution is paused.');
    if (s.remote && s.provider === 'claude' && s.effectivePolicy !== 'restricted') throw remoteError('PROVIDER_POLICY_UNSAFE', 'Claude restricted mode is not established; read, Stop and Deny remain available.');
    if (s.remote && s.provider !== 'ollama' && !s.remote.caps.includes('providers.execute')) throw remoteError('SCOPE_DENIED', 'Native provider execution is not granted.');
    if (s.remote && !p.turnId) { await this.disconnect(s.id); s = this.store.session(s.id); }
    if (p.webSearch !== undefined && typeof p.webSearch !== 'boolean') throw new Error('Invalid web search choice');
    if (p.webSearch && (s.provider !== 'ollama' || !effective.webSearch.enabled || effective.paused)) throw new Error('Enable web search in Settings for an Ollama conversation');
    if (p.webSearch && (typeof p.text !== 'string' || p.text.length > 500)) throw new Error('Use a question of at most 500 characters for Search web');
    if (s.mode !== 'managed') throw new Error('Hand this session to Cere before sending');
    if (['starting','working','waiting','stopping'].includes(s.status)) throw new Error('This session is busy. Stop it or wait for completion.');
    if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 100000) throw new Error('Enter a message of up to 100,000 characters');
    const images: string[] = [];
    if(p.images!==undefined&&(!Array.isArray(p.images)||!p.images.every((v:any)=>typeof v==='string')))throw new Error('Invalid image attachments');
    for (const path of p.images || []) {
      const resolved = await realpath(path);
      if (!(await stat(resolved)).isFile()) throw new Error('Attachment is not a file'); images.push(resolved);
    }
    if (images.length > 4) throw new Error('Attach at most four images');
    this.settingsFor(s.id); // Recheck after every asynchronous attachment validation.
    if (p.expectedDraftRevision !== undefined && p.expectedDraftRevision !== (this.store.session(s.id).draftRevision || '0')) throw remoteError('REVISION_CONFLICT','Draft changed during send validation.');
    // A very fast provider can emit and flush its first reply before its start
    // acknowledgement returns. Reserve an earlier timestamp for the deferred
    // remote user row so transcript ordering still reflects the turn.
    const userTime=Date.now()-1;
    if (s.provider === 'ollama') this.delegations.delete(s.id);
    this.terminal.delete(s.id); this.pendingCompletions.delete(s.id); this.speechResponses.delete(s.id); this.turnReplies.delete(s.id);
    const remoteAcceptance=!!onAccepted;
    s = this.updateSession(s.id, { status: 'starting', activity: 'thinking', error: undefined, agents:[], turnId:p.turnId || randomUUID(),
      ...(!remoteAcceptance?{draft:''}:{}) });
    if(!remoteAcceptance)this.putMessage({ id: randomUUID(), sessionId: s.id, role: 'user', text: p.text + (images.length ? '\n\nAttached: ' + images.join(', ') : ''), time: Date.now() });
    let accepted=!remoteAcceptance;
    const acceptedByProvider=remoteAcceptance?()=>{if(accepted)return;onAccepted!();accepted=true;s=this.updateSession(s.id,{draft:''});this.putMessage({id:randomUUID(),sessionId:s.id,role:'user',text:p.text+(images.length?'\n\nAttached: '+images.join(', '):''),time:userTime});}:undefined;
    try {
      if (!this.adapters.has(s.id)) {
        const token = randomBytes(32).toString('hex'); this.tokens.set(token, s.id);
        const generation = (this.generations.get(s.id) || 0) + 1; this.generations.set(s.id, generation);
        const live = () => this.generations.get(s.id) === generation;
        const hooks: Hooks = { token, restrictive:!!s.remote, policy:verified => { if (live()) this.updateSession(s.id, {effectivePolicy:verified ? 'restricted' : 'unknown'}); }, personality: () => this.settings.personality,
          bypassCliPermissions: () => this.settingsFor(s.id).bypassCliPermissions,
          event: e => { if (live()) this.event(s.id,e); }, native: nativeId => { if (live()) this.updateSession(s.id,{nativeId}); },
          approve: value => live() && !this.terminal.has(s.id) ? this.approval(s.id,value) : Promise.resolve({choice:'deny',cancelled:true}) };
        this.adapters.set(s.id, this.factory(s, hooks));
      }
      if(s.remote&&s.provider!=='ollama'&&this.settingsFor(s.id).paused)throw remoteError('POLICY_PAUSED','Native provider execution is paused.');
      await this.adapters.get(s.id)!.send(p.text, images, { webSearch: p.webSearch, beforeAccept:remoteAcceptance?()=>{this.settingsFor(s.id);beforeAccept?.();}:undefined, onDispatched:remoteAcceptance?onDispatched:undefined, onAccepted:acceptedByProvider, onRejected:remoteAcceptance?onRejected:undefined });
      if(!accepted)throw new Error('Provider did not confirm that it accepted the turn.');
      if (this.store.session(s.id).status === 'starting') this.updateSession(s.id, { status: 'working' });
      return true;
    } catch (e: any) {
      this.event(s.id, { type: 'error', text: e.message });
      const adapter = this.adapters.get(s.id); this.adapters.delete(s.id); await adapter?.close();
      throw e;
    }
  }
  async stop(id: string): Promise<boolean> {
    const existing = this.stopping.get(id); if (existing) return existing;
    const pending = Promise.resolve().then(() => this.stopTurn(id)).finally(() => this.stopping.delete(id));
    this.stopping.set(id, pending); return pending;
  }
  stopDeadlineMs = 10000; forceCloseMs = 3000;
  /** In-flight Cere actions per session ('' for user-started desktop actions). */
  actionControllers = new Map<string, Set<AbortController>>();
  abortActions(id: string, reason: Error) { for (const controller of this.actionControllers.get(id) || []) controller.abort(reason); }
  async stopTurn(id: string) {
    const s = this.store.session(id); if (!['starting','working','waiting','stopping'].includes(s.status)) return true;
    this.cancelApprovals(id); this.updateSession(id, { status: 'stopping' });
    // The deadline is armed before anything is awaited: an interruption that never
    // acknowledges, or a capture editor left open, cannot hold Stop past it.
    this.abortActions(id, new Error('Stopped by the user'));
    const forced = new Promise<void>(resolve => {
      const timer=setTimeout(async()=>{
        this.stopTimers.delete(timer);
        if(this.store.session(id).status==='stopping')await this.forceStop(id);
        resolve();
      },this.stopDeadlineMs);this.stopTimers.add(timer);timer.unref();
    });
    await Promise.race([Promise.allSettled([this.adapters.get(id)?.interrupt(), ...[...(this.delegations.get(id) || [])].map(child => this.stop(child))]), forced]);
    this.delegations.delete(id);
    return true;
  }
  /** Bounded force-close: a close that itself hangs cannot keep the session stopping. */
  async forceStop(id: string) {
    const adapter=this.adapters.get(id);this.adapters.delete(id);
    await Promise.race([adapter?.close().catch(()=>{}), new Promise(resolve=>setTimeout(resolve,this.forceCloseMs).unref())]);
    if(this.store.session(id).status!=='stopping')return;
    const text='The provider did not acknowledge interruption and was stopped.';
    this.terminal.add(id);
    this.updateSession(id,{status:'interrupted',error:text});
    this.emit('notice',{kind:'interrupted',sessionId:id,text});
  }
  async updateSettings(patch: any) {
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== this.store.get('settingsRevision','0')) throw remoteError('REVISION_CONFLICT','Settings changed on another client. Reload before saving.');
    const next = structuredClone(this.settings);
    if ('personality' in patch) next.personality = validatePersonality(patch.personality);
    if ('voice' in patch) next.voice = validateVoice(patch.voice);
    for (const key of ['webSearch','memory'] as const) if (key in patch) {
      const value = patch[key], allowed = key === 'webSearch' ? ['enabled','provider','searxngUrl'] : ['enabled','model','extractionModel','allowCloudMemory','allowCloudExtraction'];
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`Invalid ${key} settings`);
      if ('enabled' in value && typeof value.enabled !== 'boolean') throw new Error(`Invalid ${key} enabled setting`);
      if (key === 'webSearch') {
        if ('provider' in value && !searchProviders.includes(value.provider)) throw new Error('Choose a supported search provider');
        if ('searxngUrl' in value) {
          if (typeof value.searxngUrl !== 'string') throw new Error('Enter a SearXNG base URL');
          if (value.searxngUrl) { const url = webUrl(value.searxngUrl, true); if (url.search || url.hash) throw new Error('Use a SearXNG base URL without query or fragment'); value.searxngUrl = url.href.replace(/\/+$/, ''); }
        }
        next.webSearch = { ...next.webSearch, ...value };
        if (next.webSearch.enabled && next.webSearch.provider === 'searxng' && !next.webSearch.searxngUrl) throw new Error('Enter your SearXNG server URL first');
      } else {
        if ('model' in value && (typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,511}$/.test(value.model))) throw new Error('Enter an Ollama embedding model name');
        if ('extractionModel' in value && (typeof value.extractionModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,511}$/.test(value.extractionModel))) throw new Error('Enter an Ollama extraction model name');
        if ('allowCloudMemory' in value && typeof value.allowCloudMemory !== 'boolean') throw new Error('Invalid cloud memory permission');
        if ('allowCloudExtraction' in value && typeof value.allowCloudExtraction !== 'boolean') throw new Error('Invalid cloud extraction permission');
        next.memory = { ...next.memory, ...value };
      }
    }
    if ('ollama' in patch) {
      const value = patch.ollama;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['host','model'].includes(k))) throw new Error('Invalid Ollama settings');
      if ('host' in value) { next.ollama.host = ollamaHost(value.host); if (next.ollama.host !== ollamaHost(this.settings.ollama.host)) next.ollama.model = ''; }
      if ('model' in value) {
        if (typeof value.model !== 'string' || value.model.length > 512) throw new Error('Invalid default model');
        if (value.model && (next.ollama.host !== ollamaHost(this.settings.ollama.host) || this.capabilities.ollama?.modelsStatus !== 'ready' || !this.capabilities.ollama.models.some((m: ModelOption) => m.id === value.model))) throw new Error('Refresh Ollama models and choose an available default');
        next.ollama.model = value.model;
      }
    }
    for (const key of ['speechEnabled','topmost','roaming','quiet','reducedMotion','expressiveCues','hidden','paused','onboarding','bypassCliPermissions','bypassComputerPermissions'] as const) if (key in patch) {
      if (typeof patch[key] !== 'boolean') throw new Error(`Invalid ${key}`); next[key] = patch[key];
    }
    if ('scale' in patch) { if (!Number.isFinite(patch.scale) || patch.scale < .5 || patch.scale > 3) throw new Error('Size must be between 50% and 300%'); next.scale = patch.scale; }
    if ('motionIntensity' in patch) { if (!Number.isFinite(patch.motionIntensity) || patch.motionIntensity < 0 || patch.motionIntensity > 1) throw new Error('Motion intensity must be between 0 and 1'); next.motionIntensity = patch.motionIntensity; }
    if ('profile' in patch) { if (!['manual','scoped','broad'].includes(patch.profile)) throw new Error('Invalid permission profile'); next.profile = patch.profile; }
    if ('categories' in patch) {
      if (!Array.isArray(patch.categories) || !patch.categories.every((c: string) => [...actionDefinitions,...orchestrationDefinitions].some(a => a.category === c))) throw new Error('Invalid tool category');
      next.categories = [...new Set<string>(patch.categories)];
    }
    if ('position' in patch) {
      const p = patch.position;
      if (typeof p.output !== 'string' || ![p.x,p.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Invalid position'); next.position = p;
    }
    if ('roamArea' in patch) {
      const p = patch.roamArea;
      if (![p.left,p.right,p.top,p.bottom].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || p.left >= p.right || p.top >= p.bottom) throw new Error('Invalid roaming bounds'); next.roamArea = p;
    }
    if ('grants' in patch) {
      if (!Array.isArray(patch.grants)) throw new Error('Invalid grants');
      next.grants = patch.grants.map((g: any) => {
        if (!next.categories.includes(g.category) || !isAbsolute(g.cwd) || !Number.isFinite(g.expires) || g.expires <= Date.now() || g.expires > Date.now()+86400000) throw new Error('Grants need a category, project, and expiry within 24 hours');
        return { category: g.category, cwd: g.cwd, expires: g.expires };
      });
    }
    if ('scripts' in patch) {
      if (!Array.isArray(patch.scripts) || patch.scripts.length > 100) throw new Error('Invalid script list');
      next.scripts = patch.scripts.map((s: any) => {
        if (!s.id || typeof s.id !== 'string' || typeof s.name !== 'string' || !isAbsolute(s.executable) || !isAbsolute(s.cwd) || !Array.isArray(s.args) || !s.args.every((v: any) => typeof v === 'string' && !v.includes('\0')) || !Number.isInteger(s.timeout) || s.timeout < 1000 || s.timeout > 600000) throw new Error('Scripts need absolute paths, argument arrays, and a 1–600 second timeout'); return s;
      });
    }
    const hostChanged = next.ollama.host !== this.settings.ollama.host;
    if (JSON.stringify(next.webSearch) !== JSON.stringify(this.settings.webSearch) || next.paused !== this.settings.paused) { this.webController.abort(new Error('Web search settings changed')); this.webController = new AbortController(); }
    if (JSON.stringify(next.memory) !== JSON.stringify(this.settings.memory) || hostChanged || next.paused !== this.settings.paused) this.memory.invalidate();
    this.settings = next; this.store.set('settings', next);
    if (!next.speechEnabled || next.quiet || 'voice' in patch) this.speech.stop();
    // Resolve only permission requests; input questions must never receive invented answers.
    for (const { value } of [...this.approvals.values()]) if ((!value.sessionId || !this.store.session(value.sessionId).remote) && autoApprove(next, value)) this.answer({ id: value.id, choice: 'allow' }, true);
    this.store.set('settingsRevision', String(BigInt(this.store.get('settingsRevision', '0')) + 1n));
    this.changed();
    if (hostChanged) { this.capabilities.ollama = {}; void this.refreshProviderModels('ollama').catch(() => {}); }
    return next;
  }
  /**
   * Every Cere action runs under a controller registered to its session, combined
   * with the caller's signal, so Stop, disconnect and shutdown cancel MCP-originated
   * and model-originated work alike.
   */
  async action(name: string, args: any, sessionId?: string, signal?: AbortSignal) {
    const controller = new AbortController(), owner = sessionId || '';
    const active = this.actionControllers.get(owner) || new Set<AbortController>();
    active.add(controller); this.actionControllers.set(owner, active);
    try { return await this.runAction(name, args, sessionId, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); }
    finally { active.delete(controller); if (!active.size && this.actionControllers.get(owner) === active) this.actionControllers.delete(owner); }
  }
  async runAction(name: string, args: any, sessionId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const def = validateAction(name,args);
    const memoryActionId=randomUUID(), memoryExecutionId=randomUUID();
    const recordMemory=(phase:string,exitCode?:number)=>sessionId&&this.memoryWritable(sessionId)?this.memory.actionEvent(this.store.session(sessionId),memoryActionId,memoryExecutionId,phase,name,exitCode,signal,()=>this.memoryAuthorized(sessionId,true,signal)):Promise.resolve();
    if(this.memory.active())await recordMemory('proposed');
    const scriptBefore=name==='script.run'?JSON.stringify(this.settings.scripts.find(s=>s.id===args.id)):undefined;
    // The source of this action's authority. Automatic authority (a broad project grant
    // or a permission bypass) is revalidated after every await before any side effect;
    // an explicit allow needs no unrelated grant, but the category must stay enabled.
    let authority: 'category' | 'grant' | 'bypass' | 'manual' = 'category';
    const grantValid = (settings: Settings, s: Session) => settings.profile === 'broad' && settings.grants.some(g => g.category === def.category && g.cwd === s.cwd && g.expires > Date.now());
    const authorized = () => {
      signal?.throwIfAborted();
      if (!sessionId) return;
      const current = this.settingsFor(sessionId), s = this.store.session(sessionId);
      if(s.remote&&name==='files.open') { const path=realpathSync(args.path),rel=relative(s.cwd,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw remoteError('SCOPE_DENIED','File is outside this session project.');args.path=path; }
      if (!categoryEnabled(current, def.category)) throw new Error('Desktop permission was revoked');
      if ((authority === 'grant' && !grantValid(current, s)) || (authority === 'bypass' && (current.paused || !bypassCategory(current, def.category))))
        throw new Error('The automatic permission for this action was revoked. Request it again.');
    };
    if (sessionId) {
      const s = this.store.session(sessionId);
      if (!categoryEnabled(this.settingsFor(sessionId), def.category)) throw new Error('This desktop tool is disabled in Cere settings');
      const grant = grantValid(this.settingsFor(sessionId), s);
      if (!def.readOnly && !grant && !['audio','media','timers'].includes(def.category)) {
        const detail=name==='script.run'?JSON.stringify(this.settings.scripts.find(s=>s.id===args.id) || args,null,2):JSON.stringify(args,null,2);
        const answer = await this.approval(sessionId, { kind: def.category === 'scripts' ? 'cli' : 'desktop', title: def.title, detail, choices: ['allow','deny'] });
        if (answer.choice !== 'allow') { await recordMemory('cancelled'); throw new Error('Desktop action declined'); }
        authority = answer.automatic ? 'bypass' : 'manual';
      } else if (!def.readOnly && grant) authority = 'grant';
      // A grant or enabled category can be revoked while a request awaits approval.
      authorized();
      const current = this.settingsFor(sessionId);
      if(name==='script.run'&&JSON.stringify(current.scripts.find(s=>s.id===args.id))!==scriptBefore)throw new Error('The saved script changed while approval was pending. Request it again.');
    }
    try {
      if(this.memory.active()){await recordMemory('authorized');await recordMemory('running');}
      authorized();
      if(sessionId && this.store.session(sessionId).remote && name === 'script.run' && !this.settingsFor(sessionId).scripts.some(s=>s.id===args.id))throw new Error('Saved script is not granted to this device');
      if(name==='script.run'&&JSON.stringify(this.store.settings().scripts.find(s=>s.id===args.id))!==scriptBefore)throw new Error('The saved script changed while approval was pending. Request it again.');
      let result: any;
      if (name === 'timer.list') { const scope=sessionId?this.store.session(sessionId).remote:undefined;return this.store.timers().filter(t=>!scope||t.remoteProjectId===scope.projectId); }
      if (name === 'timer.start') {
        const scope=sessionId?this.store.session(sessionId).remote:undefined;
        result = { id: randomUUID(), label: args.label || 'Timer', due: Date.now()+args.minutes*60000,...(scope?{remoteProjectId:scope.projectId}:{}) }; this.store.timer(result);
      } else result = await desktopAction(name,args,sessionId ? this.settingsFor(sessionId) : this.settings,signal,authorized);
      signal?.throwIfAborted();
      await recordMemory(result?.cancelled?'cancelled':'succeeded',typeof result?.exitCode==='number'?result.exitCode:undefined);
      if (def.readOnly) return result;
      if(result?.cancelled)return result;
      if(name==='screenshot.capture'&&sessionId&&result.path){
        const answer=await this.approval(sessionId,{kind:'image',title:'Share this capture with '+this.store.session(sessionId).provider+'?',detail:'The image is saved locally. Allow this session to read it?',image:result.path,choices:['allow','deny']});
        if(answer.choice!=='allow')result={message:'Capture saved locally; the user declined sharing it with this session.'};
        else if(Buffer.isBuffer(answer.verifiedImage))Object.defineProperty(result,'approvedImage',{value:answer.verifiedImage});
      }
      this.store.activity({ action: name, sessionId: sessionId || null, status: 'completed' }); this.changed();
      const reaction = def.category === 'capture' ? 'capture' : def.category === 'media' ? 'music' : 'success';
      this.emit('ui', { command: 'animate', name: reaction });
      return result;
    } catch (e: any) {
      await recordMemory('failed');
      this.store.activity({ action: name, sessionId: sessionId || null, status: 'failed', error: e.message }); this.changed();
      this.emit('ui', { command: 'animate', name: 'error' }); throw e;
    }
  }
  toolsFor(id: string): OllamaTool[] {
    const s = this.store.session(id);
    const settings = this.settingsFor(id);
    if (s.provider !== 'ollama' || settings.paused) return [];
    const definitions = [
      ...(s.ollama?.tools ? [...actionDefinitions, ...orchestrationDefinitions].filter(d => categoryEnabled(settings, d.category) && (!s.remote || d.category !== 'providers' || s.remote.caps.includes('providers.execute'))) : []),
      ...(settings.webSearch.enabled ? webDefinitions : []), ...(settings.memory.enabled && this.memory.active() ? memoryDefinitions.filter(d=>!s.remote || d.readOnly || s.remote.caps.includes('memory.write')) : []),
    ];
    return definitions.map(d => ({
      type: 'function', function: { name: d.name.replaceAll('.', '_'), description: d.description,
        parameters: { type: 'object', properties: d.schema, required: d.required || Object.keys(d.schema), additionalProperties: false } },
    }));
  }
  memoryWritable(id: string) { const execution=this.store.session(id).remote;return !execution||execution.caps.includes('memory.write'); }
  memoryAuthorized(id: string, write: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.settingsFor(id).memory.enabled || !this.memory.active() || (write && !this.memoryWritable(id))) throw remoteError('SCOPE_DENIED', 'Memory authority changed.');
  }
  async callTool(id: string, name: string, args: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.toolsFor(id).some(t => t.function.name === name)) throw new Error('This tool is disabled in Cere settings');
    const knowledge = [...webDefinitions, ...memoryDefinitions].find(d => d.name.replaceAll('.', '_') === name);
    if (knowledge) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !(k in knowledge.schema)) || (knowledge.required || Object.keys(knowledge.schema)).some(k => !(k in args))) throw new Error('Invalid tool arguments');
      const p = args as Record<string, unknown>, s = this.store.session(id);
      if (name.startsWith('web_')) return this.webCall(name, p, signal);
      if (name === 'memory_search') return this.memory.recall(s, p.query, signal);
      const authorize=()=>this.memoryAuthorized(id,!knowledge.readOnly,signal);
      authorize();
      if (name === 'memory_save') return this.memory.save(s, p.text, p.id, undefined, true, signal, authorize);
      if (name === 'memory_forget') return this.memory.forget(s, p.id, signal, authorize);
      if (name === 'memory_inspect') return this.memory.graph(s,'inspect',{id:p.id},signal,authorize);
      if (name === 'memory_remember') return this.memory.structured(s,'remember',p,signal,authorize);
      if (name === 'memory_correct') return this.memory.structured(s,'correct',p,signal,authorize);
    }
    const orchestration = orchestrationDefinitions.find(d => d.name.replaceAll('.', '_') === name);
    if (orchestration) return orchestrate(this, id, orchestration.name, args, signal);
    const def = actionDefinitions.find(d => d.name.replaceAll('.', '_') === name);
    if (!def) throw new Error('Unknown tool');
    return this.action(def.name, args, id, signal);
  }
  async webCall(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (!this.settings.webSearch.enabled || this.settings.paused) throw new Error('Web search is disabled in Cere settings');
    const guard = AbortSignal.any([signal, this.webController.signal]);
    const settings = { ...this.settings.webSearch };
    const result = name === 'web_search' ? await this.web.search(args.query, settings, guard) : await this.web.read(args.url, guard);
    guard.throwIfAborted(); return result;
  }
  async configureSession(p: any, authorize?: () => void) {
    if (this.sending.has(p.id) || this.stopping.has(p.id)) throw new Error('This session is busy');
    this.sending.add(p.id);
    try {
      const s = this.store.session(p.id);
      if (s.provider !== 'ollama' || !s.ollama) throw new Error('Model changes here are only available for Ollama');
      if (['starting','working','waiting','stopping'].includes(s.status)) throw new Error('Stop the current turn before changing its model');
      if (typeof p.model !== 'string' || typeof p.tools !== 'boolean') throw new Error('Choose a model and assistance mode');
      if (p.tools && !s.ollama.tools && !p.trusted && !this.settings.bypassCliPermissions) throw new Error('Confirm that you trust this project before enabling delegation');
      const models = await ollamaModels(s.ollama.host), model = models.find(m => m.id === p.model);
      if (!model) throw new Error('Choose an available Ollama model');
      if (p.tools && !model.capabilities?.includes('tools')) throw new Error('This model does not support tools');
      if (!model.capabilities?.includes('vision') && this.store.get<OllamaMessage[]>('ollama:' + s.id, []).some(m => m.images?.length)) throw new Error('This conversation contains images. Choose a model with Images, or start a new conversation.');
      authorize?.();
      const adapter = this.adapters.get(s.id); this.adapters.delete(s.id); await adapter?.close();
      authorize?.();
      return this.updateSession(s.id, { model: p.model, ollama: { ...s.ollama, tools: p.tools }, error: undefined });
    } finally { this.sending.delete(p.id); }
  }
  checkingTimers = false;
  async checkTimers() {
    if (this.checkingTimers) return;
    this.checkingTimers = true;
    try {
      for (const t of this.store.timers()) if (t.due <= Date.now()) {
        // Claim each timer atomically just before delivery: a stale sweep or a timer
        // cancelled during an earlier notification never produces a second notice.
        if (!this.store.removeTimer(t.id)) continue;
        this.emit('notice', { kind: 'timer', text: t.label }); this.changed();
        await exec('notify-send', ['--app-name=Cere', 'Cere · Timer', t.label], { timeout: 5000 }).catch(() => {});
      }
    } finally { this.checkingTimers = false; }
  }
  async history(provider: string, signal?:AbortSignal) {
    signal?.throwIfAborted();
    if (provider === 'codex') {
      const process = new RpcProcess(providerExecutable('codex'), ['app-server'], homedir());
      process.on('fault', () => {});
      const abort=()=>{void process.close();};signal?.addEventListener('abort',abort,{once:true});
      try {
        await process.request('initialize', { clientInfo: { name: 'cere-history', version: '0.1.0' } }); process.write({ method: 'initialized' });
        const r = await process.request('thread/list', { limit: 100, useStateDbOnly: true });
        signal?.throwIfAborted();return (r.data || []).map((t: any) => ({ nativeId: t.id, title: t.name || t.preview || t.id, cwd: t.cwd, provider, mode: 'historical' }));
      } finally { signal?.removeEventListener('abort',abort);await process.close(); }
    }
    if (provider !== 'claude') throw new Error('Unknown provider');
    const root = join(homedir(), '.claude/projects'), candidates: {path:string;time:number}[] = [];
    for (const directory of await readdir(root).catch(() => [])) {
      const dir = join(root,directory);
      for (const file of await readdir(dir).catch(() => [])) if (file.endsWith('.jsonl')) {
        const path = join(dir,file); const s = await stat(path); candidates.push({path,time:s.mtimeMs});
      }
    }
    const entries = [];
    for (const c of candidates.sort((a,b) => b.time-a.time).slice(0,100)) {
      const f = await open(c.path,'r'); const buffer = Buffer.alloc(256*1024);
      try {
        const {bytesRead} = await f.read(buffer,0,buffer.length,0);
        const lines = buffer.subarray(0,bytesRead).toString().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const meta = lines.find(v => v.sessionId && v.cwd); if (!meta) continue;
        const first = lines.find(v => v.type === 'user' && typeof v.message?.content === 'string');
        entries.push({ provider, nativeId: meta.sessionId, cwd: meta.cwd, title: (first?.message.content || meta.sessionId).slice(0,100), mode: 'historical' });
      } finally { await f.close(); }
    }
    return entries;
  }
  async rpc(method: string, p: any = {}) : Promise<any> {
    switch (method) {
      case 'state': return this.snapshot();
      case 'session.create': return this.create(p);
      case 'session.configure': return this.configureSession(p);
      case 'session.send': return this.send(p);
      case 'session.stop': return this.stop(p.id);
      case 'session.disconnect': return this.disconnect(p.id);
      case 'session.detachRemote': { await this.disconnect(p.id); return this.updateSession(p.id,{remote:undefined,effectivePolicy:undefined}); }
      // Byte-bounded pages, newest first by cursor; clients load older pages on request.
      case 'session.messages': this.flush(); return messagePage(this.store, p.id, p.before, p.maxBytes);
      case 'session.messageText': this.flush(); return messageChunk(this.store, p.id, p.messageId, p.offset);
      case 'session.draft': return this.draft(p.id, String(p.text || '').slice(0,100000), p.expectedRevision, Number(p.scroll) || 0);
      case 'session.rename': return this.updateSession(p.id, { title: sessionTitle(p.title) });
      case 'session.link': {
        if (!['codex','claude'].includes(p.provider)) throw new Error('Terminal linking is available for Codex and Claude');
        const s=await this.create({...p,trusted:true,nativeId:null});
        this.store.set('link:'+s.id,{pid:p.pid,address:p.address || ''});
        return this.updateSession(s.id,{mode:'linked',title:p.title || `${p.provider} · terminal`,status:'idle'});
      }
      case 'session.linkEnded': return this.updateSession(p.id,{status:'disconnected'});
      case 'session.terminal': {
        const link=this.store.get<any>('link:'+p.id,null);if(!link?.address)throw new Error('The terminal window could not be identified; switch to it manually');
        return this.action('windows.focus',{address:link.address});
      }
      case 'session.history': return this.history(p.provider);
      case 'provider.models': {
        if (p.sessionId) { const s = this.store.session(p.sessionId); if (s.provider !== 'ollama') throw new Error('Expected an Ollama session'); return ollamaModels(s.ollama!.host); }
        if(!['codex','claude','ollama'].includes(p.provider))throw new Error('Unknown provider');
        return this.refreshProviderModels(p.provider);
      }
      case 'approval.answer': return this.answer(p);
      case 'completion.dismiss': {
        if (typeof p.id !== 'string') throw new Error('Invalid completion');
        this.completions = this.completions.filter(c => c.id !== p.id);
        this.changed(); return true;
      }
      case 'settings.update': return this.updateSettings(p);
      case 'tts.test': return { queued: this.speech.speak(ttsTestLine, true) };
      case 'tts.stop': this.speech.stop(); return true;
      case 'tts.voices': return { voices: await listVoices(), directories: voiceDirectories() };
      case 'tts.status': return this.speech.snapshot();
      case 'memory.check': return this.memory.check();
      case 'memory.graph': return this.memory.graph(p.sessionId ? this.store.session(p.sessionId) : undefined, p.method, p.params || {});
      case 'memory.models': return ollamaModels(this.settings.ollama.host, 'embedding');
      case 'memory.list': return this.memory.list(this.store.session(p.sessionId), p.kind, p.offset, p.filter);
      case 'memory.save':
        // Management clients must prove which revision they edited; only the model's
        // assistant-attributed memory_save tool may replace a note without one.
        if (p.id !== undefined && p.id !== '' && !Number.isSafeInteger(p.expected_revision)) throw Object.assign(new Error('Editing a saved memory requires its current revision'), { code: 'INVALID_ARGUMENT' });
        return this.memory.save(this.store.session(p.sessionId), p.text, p.id, p.expected_revision);
      case 'memory.forget': return this.memory.forget(this.store.session(p.sessionId), p.id);
      case 'memory.clear': return this.memory.clear(this.store.session(p.sessionId));
      case 'apps.list': return applications();
      case 'windows.list': return windows();
      case 'audio.status': return audioStatus();
      case 'media.status': return mediaStatus(p.player);
      case 'action.run': return this.action(p.name,p.args || {});
      case 'timer.cancel': this.store.removeTimer(p.id); this.changed(); return true;
      case 'ui.toggle': await this.updateSettings({ hidden: false }); this.emit('ui', { command:'toggle' }); return true;
      case 'ui.expand': this.emit('ui', { command:'expand' }); return true;
      case 'ui.animate':
        if (typeof p.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(p.name)) throw new Error('Invalid animation name');
        this.emit('ui', { command:'animate', name:p.name }); return true;
      case 'ui.panel': return this.panel(p.owner,p.visible);
      case 'ui.attention': {
        if (p.owner !== 'ui' && p.owner !== 'overlay') throw new Error('Invalid attention owner');
        if (typeof p.sessionId !== 'string') throw new Error('Invalid attention session');
        if (typeof p.listening !== 'boolean') throw new Error('Invalid attention state');
        if (p.sessionId) this.store.session(p.sessionId);
        this.attention[p.owner as 'ui'|'overlay'] = { owner:p.owner, sessionId:p.sessionId, listening:p.listening };
        this.emit('ui', { command:'attention', ...this.attention[p.owner as 'ui'|'overlay'] }); return true;
      }
      case 'ui.quit': this.emit('ui',{command:'quit',stopTasks:!!p.stopTasks}); return true;
      case 'mcp.tools': {
        const id = this.tokens.get(p.token); if (!id) throw new Error('Session capability expired');
        return actionDefinitions.filter(d => categoryEnabled(this.settingsFor(id), d.category));
      }
      case 'mcp.call': {
        const id = this.tokens.get(p.token); if (!id) throw new Error('Session capability expired');
        if (p.name === 'approve') {
          const s = this.store.session(id); if (s.provider !== 'claude') throw new Error('Approval tool is only available to Claude');
          if (p.args?.tool_name === 'AskUserQuestion') {
            const input = p.args.input || {}, questions = claudeQuestions(input);
            const answer = await this.approval(id, {kind:'question',title:'Claude has a question',detail:'',questions,choices:['answer','deny']});
            if (answer.choice !== 'answer') return {behavior:'deny',message:'The user did not answer these questions. Do not invent answers.'};
            const answers = Object.fromEntries(questions.map(q => [q.question,answer.answers[q.id].answers.join(', ')]));
            return {behavior:'allow',updatedInput:{...input,answers}};
          }
          // Claude also asks before entering our MCP bridge. Use the same category
          // as the underlying action, so computer bypass does not need CLI bypass.
          const tool = actionDefinitions.find(d => p.args.tool_name === 'mcp__cere__' + d.name.replaceAll('.', '_'));
          const kind = tool ? (tool.category === 'scripts' ? 'cli' : 'desktop') : 'provider';
          const answer = await this.approval(id, { kind, title:`Allow Claude to use ${String(p.args.tool_name || 'a tool')}?`, detail:JSON.stringify(p.args.input || {},null,2), choices:['allow','deny'] });
          return answer.choice === 'allow' ? { behavior:'allow', updatedInput:p.args.input || {} } : { behavior:'deny', message:'Declined in Cere' };
        }
        return this.action(p.name,p.args,id);
      }
      default: throw new Error('Unknown Cere method: '+method);
    }
  }
  async close() {
    this.closed = true;
    const speechClosed = this.speech.close(); this.speechResponses.clear();
    this.memory.invalidate(); this.webController.abort(new Error('Cere is closing'));
    clearInterval(this.ticker); this.flush();
    for(const timer of this.stopTimers)clearTimeout(timer);this.stopTimers.clear();
    // Shutdown cancels owned work (captures, scripts, tool calls) and never waits unboundedly.
    for (const id of [...this.actionControllers.keys()]) this.abortActions(id, new Error('Cere is closing'));
    for (const id of new Set([...this.approvals.values()].map(a => a.value.sessionId))) this.cancelApprovals(id);
    const bounded = (work: unknown[]) => Promise.race([Promise.allSettled(work), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    await bounded([...this.adapters.values()].map(a => a.close()));
    await bounded([...this.stopping.values()]);
    for(const timer of this.stopTimers)clearTimeout(timer);this.stopTimers.clear();
    await this.memory.close();
    await speechClosed;
    this.store.close();
  }
}
