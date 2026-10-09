import { ElevenLabs, validateElevenConfig } from './elevenlabs.ts';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { stat, realpath, readdir, open } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { Store } from './store.ts';
import { autoApprove, bypassCategory, categoryEnabled } from './permissions.ts';
import type { Session, Settings, Message, Approval, Adapter, ProviderEvent, Provider, ModelOption, AgentActivity, RunCompletion, DraftView } from './types.ts';
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
import { SendQueue } from './send-queue.ts';
import { ordinarySettings, busy, remoteError } from './execution.ts';
import type { RemoteExecution } from './execution.ts';
import { Speech, listVoices, validateVoice, voiceDirectories, ttsTestLine } from './tts.ts';
import { Attachments } from './attachments.ts';
import { Organization } from './organization.ts';
import { PowerSessions } from './power.ts';
import { Diagnostics,healthReport } from './health.ts';
import { Utilities } from './utilities.ts';
import { Recovery } from './recovery.ts';
import { MemoryReview } from './memory-review.ts';
import { Transcription } from './transcription.ts';
import { forkCodex } from './branching.ts';
import { Workflows } from './workflows.ts';
import { Projects } from './projects.ts';
import { providerIds, isApiProvider, providerLabels } from './provider-catalog.ts';
import { ProviderCredentials } from './credentials.ts';
import { ApiAdapter, apiModels, portableApiHistory } from './api-providers.ts';
import { AntigravityAdapter } from './antigravity.ts';
import { IndexTTS } from './indextts.ts';
import { IndexError, indexPrefix, validateIndexConfig } from './indextts-config.ts';
import { TelemetryService } from './telemetry/service.ts';
import { configuration as telemetryConfiguration } from './telemetry/paths.ts';

const untitledSession = 'Untitled session';
/** One title rule for every client: trimmed, at most 100 characters, never blank. */
export const sessionTitle = (value: unknown) => String(value ?? '').trim().slice(0,100) || untitledSession;
/** Validates the desktop view record; cursor positions are clamped to the draft text. */
export function draftView(value: unknown, text: string): DraftView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid draft view');
  const v = value as Record<string, unknown>;
  const position = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.min(text.length, Math.max(0, Math.trunc(n))) : 0;
  const offset = typeof v.anchorOffset === 'number' && Number.isFinite(v.anchorOffset) ? Math.max(-1e6, Math.min(1e6, Math.round(v.anchorOffset))) : 0;
  return { cursor: position(v.cursor), selectionStart: position(v.selectionStart), selectionEnd: position(v.selectionEnd),
    webSearch: v.webSearch === true, activityExpanded: v.activityExpanded === true,
    anchorId: typeof v.anchorId === 'string' && v.anchorId.length <= 200 ? v.anchorId : '', anchorOffset: offset, atEnd: v.atEnd !== false,
    focus: v.focus === 'composer' ? 'composer' : '' };
}

const bodyMoodNames = new Set(Object.keys(JSON.parse(readFileSync(new URL('../assets/motions.json', import.meta.url), 'utf8')).bodyMoods.moods));

export class Core extends EventEmitter {
  telemetry: TelemetryService;
  store: Store; settings: Settings; credentials: ProviderCredentials; adapters = new Map<string, Adapter>();
  attachments: Attachments; organization: Organization; projects: Projects;
  power: PowerSessions;
  diagnostics: Diagnostics; utilities: Utilities; recovery: Recovery; memoryReview:MemoryReview; workflows:Workflows;
  approvals = new Map<string, { value: Approval; resolve: (value: any) => void }>();
  tokens = new Map<string, string>(); partials = new Map<string, Message>();
  terminal = new Set<string>();
  pendingCompletions = new Map<string, ProviderEvent>();
  completions: RunCompletion[] = [];
  companionReplies: RunCompletion[] = [];
  // Per-turn message boundaries, including messages received before pinning.
  settledReplies = new Map<string, Set<string>>();
  deliveredReplies = new Map<string, Set<string>>();
  turnReplies = new Map<string, Message>();
  elevenlabs:ElevenLabs; speech: Speech; transcription:Transcription; indextts:IndexTTS;
  speechResponses = new Map<string, string>();
  sending = new Set<string>();
  sendQueue: SendQueue;
  stopping = new Map<string, Promise<boolean>>();
  delegations = new Map<string, Set<string>>(); closed = false;
  web = new WebSearch(); webController = new AbortController(); memory: Memory;
  panels = { ui: false, overlay: false };
  attention: Record<'ui'|'overlay',{owner:'ui'|'overlay';sessionId:string;listening:boolean;mood?:{mood:string;moodConfidence:number;reactive:boolean;messageId:string;time:number}}> = {
    ui: { owner:'ui', sessionId:'', listening:false }, overlay: { owner:'overlay', sessionId:'', listening:false },
  };
  stopTimers=new Set<NodeJS.Timeout>();
  capabilities: any = {}; ticker: NodeJS.Timeout; flushTimer?: NodeJS.Timeout;
  generations = new Map<string, number>();
  remoteAuthority?: (execution: RemoteExecution, session: Session) => boolean;
  remoteStatus: unknown = { enabled:false, connected:[] };
  factory: (s: Session, h: Hooks) => Adapter;
  modelLoader: (provider: Provider, host?: string) => Promise<ModelOption[]>; modelGenerations = new Map<Provider,number>();
  nativeMemoryTurns = new Map<string, { text: string; turnId?: string; controller: AbortController; epoch: AbortSignal }>();
  /** Desktop turns their provider has not yet accepted; one that ends first returns to the draft. */
  unacknowledged = new Map<string, { turnId: string; messageId: string; text: string; attachmentIds: string[]; returned?: boolean }>();
  memoryCaptures = new Set<Promise<unknown>>();
  constructor(store = new Store(), factory?: (s: Session, h: Hooks) => Adapter, modelLoader = discoverProviderModels) {
    super(); this.store = store; this.settings = store.settings(); this.credentials = new ProviderCredentials(join(store.directory, 'credentials')); this.modelLoader = modelLoader === discoverProviderModels ? (provider, host) => isApiProvider(provider) ? apiModels(provider, {key:()=>this.credentials.key(provider)}) : discoverProviderModels(provider,host) : modelLoader;
    this.telemetry=new TelemetryService(()=>{if(!this.closed)this.changed();},process.env.CERE_RUNTIME_DIR?paths().runtime:undefined);
    this.power=new PowerSessions({sessions:()=>this.store.sessions(),changed:()=>{if(!this.closed)this.changed();},stop:id=>this.stopAndClose(id)});
    this.attachments=new Attachments(store);this.organization=new Organization(store,()=>this.changed());
    this.projects=new Projects(this);
    this.diagnostics=new Diagnostics(this);this.utilities=new Utilities(this);this.recovery=new Recovery(this);this.memoryReview=new MemoryReview(this);this.workflows=new Workflows(this);
    this.transcription=new Transcription({settings:()=>this.settings.transcription,changed:()=>{if(!this.closed)this.changed();}});
    this.speech = new Speech(() => this.settings, () => { if (!this.closed) this.changed(); });
    this.indextts=new IndexTTS(store,()=>this.settings.indextts,()=>{if(!this.closed)this.changed();});
    this.speech.indextts=this.indextts;
    this.elevenlabs=new ElevenLabs(()=>this.settings.elevenlabs,()=>this.credentials.key('elevenlabs'),()=>{if(!this.closed)this.changed();});
    this.speech.elevenlabs=this.elevenlabs;
    this.memory = new Memory(store, () => this.settings, () => { if (!this.closed) this.changed(); });
    this.factory = factory || ((s, h) => s.provider === 'codex' ? new CodexAdapter(s,h) : s.provider === 'claude' ? new ClaudeAdapter(s,h) : s.provider === 'antigravity' ? new AntigravityAdapter(s,h) : this.conversationAdapter(s,h,{
      load: () => this.store.get<OllamaMessage[]>((isApiProvider(s.provider) ? 'api:' : 'ollama:') + s.id, []),
      ...this.telemetryContext(s.id),
      save: messages => this.store.set((isApiProvider(s.provider) ? 'api:' : 'ollama:') + s.id, messages),
      tools: () => this.toolsFor(s.id), call: (name, args, signal) => this.callTool(s.id, name, args, signal),
      prepare: (text, signal, budget, route) => this.settingsFor(s.id).memory.enabled && this.memory.active() ? this.memory.context(s, text, signal, budget, route, this.memoryWritable(s.id), () => this.memoryAuthorized(s.id, false, signal)) : Promise.resolve(''),
      memorySignal: () => this.memory.controller.signal,
      inference: active => this.memory.service.call('foreground',{active}),
      memoryActive: () => this.settingsFor(s.id).memory.enabled && this.memory.active(), completed: (text, answer, signal) => this.settingsFor(s.id).memory.enabled && this.memoryWritable(s.id) ? this.memory.capture(s, text, answer, signal, () => this.memoryAuthorized(s.id, true, signal)) : Promise.resolve(),
      search: (query, signal) => { if (!this.settingsFor(s.id).webSearch.enabled) throw new Error('Web scope denied'); return this.webCall('web_search', { query }, signal); },
    }));
    this.sendQueue = new SendQueue(this);
    for (const s of store.sessions()) if (['starting','working','waiting','stopping'].includes(s.status)) {
      s.status = 'interrupted'; delete s.activity;
      s.agents = s.agents?.map(a => this.agentActive(a) ? {...a, status:'interrupted', updated:Date.now()} : a); s.error = 'Cere restarted. The previous turn was not replayed.'; store.saveSession(s);
      for (const agent of s.agents || []) if (agent.status === 'interrupted') this.recordAgent(s.id,agent);
    }
    for (const s of store.sessions()) this.sendQueue.recover(s.id);
    this.completions=store.get<any[]>('completionInbox',[]).flatMap(row=>{const message=store.messageById(row.messageId);try{const s=store.session(row.sessionId);return[{...row,message:message||{id:'',sessionId:s.id,role:'assistant',text:'This run finished without a final message.',time:row.time}}];}catch{return[];}});
    this.flush();
    this.ticker = setInterval(() => void this.checkTimers(), 1000); this.ticker.unref();
    void this.telemetry.configure(this.settings.telemetry);
  }
  conversationAdapter(s: Session, h: Hooks, context: import('./ollama.ts').OllamaContext): Adapter {
    if (isApiProvider(s.provider)) {
      const provider=s.provider,model:ModelOption|undefined=this.capabilities[provider]?.models?.find((m:ModelOption)=>m.id===s.model);
      return new ApiAdapter(s,h,context,{key:()=>this.credentials.key(provider)},{contextLength:model?.contextLength,maxOutputTokens:model?.maxOutputTokens});
    }
    if (s.provider === 'ollama') return new OllamaAdapter(s,h,context);
    throw new Error('Unsupported conversation provider');
  }
  telemetryContext(id:string){
    let epoch=-1;
    return {telemetry:async()=>{epoch=this.telemetry.epoch;const s=this.store.session(id);return !this.settings.paused&&!s.remote?this.telemetry.report(s.cwd):'';},
      telemetryValid:()=>epoch===this.telemetry.epoch&&!this.settings.paused&&!this.telemetry.paused};
  }
  stateRevision=0;
  changed() { this.stateRevision++;this.emit('state', this.snapshot()); }
  snapshot() { this.completions=this.completions.map(c=>{let message=this.store.messageById(c.message.id)||c.message;if(message.text.length>16000){let end=16000;if(/[\uD800-\uDBFF]/.test(message.text[end-1]))end--;message={...message,text:message.text.slice(0,end)+'\n\n[Long reply — open the conversation to read more.]',truncated:true} as RunCompletion['message'];}return{...c,message}});return { version: 1, revision:this.stateRevision, sessions: this.store.snapshotSessions(Object.values(this.attention).map(a=>a.sessionId)), sessionCount:this.store.sessionCount(),sessionCatalogRevision:this.store.catalogRevision,recoveryWarning:this.recovery.warning,recoveryPending:this.recovery.pending, power:this.power.snapshot(), folders:this.store.folders(), bookmarks:this.store.bookmarks(),navigation:this.store.get('navigation',{favorites:[],recents:[]}), settings: this.settings, telemetry: this.telemetry.status, speech: this.speech.snapshot(), indextts:this.indextts.snapshot(), elevenlabs:{...this.elevenlabs.snapshot(),credential:this.credentials.status().elevenlabs}, transcription:this.transcription.status(), settingsRevision:this.store.get('settingsRevision','0'), remote: this.remoteStatus, personality: { defaultText: defaultPersonality, maxLength: personalityMaxLength }, memory: this.memory.summary(), approvals: [...this.approvals.values()].map(a => a.value), completions: this.completions, companionReplies: this.companionReplies, capabilities: this.capabilities, actions: actionDefinitions, timers: this.store.timers(), activity: this.store.activities(), panels: {...this.panels}, attention: structuredClone(this.attention) }; }
  settingsFor(id: string): Settings {
    const session = this.store.session(id), execution = session.remote;
    if (execution && (!this.remoteAuthority?.(execution, session) || execution.expiresAt <= Date.now())) throw remoteError('AUTH_REVOKED', 'Remote authority expired or was revoked. Detach locally to continue.');
    const settings=ordinarySettings(this.settings, execution),power=this.power.effective(session);
    if (execution && session.provider !== 'ollama' && !execution.memoryHosts?.some(host => ollamaHost(host) === ollamaHost(settings.ollama.host))) settings.memory = {...settings.memory, enabled:false};
    return {...settings,bypassCliPermissions:settings.bypassCliPermissions||power.cli,bypassComputerPermissions:settings.bypassComputerPermissions||power.computer,...(session.temporary?{memory:{...settings.memory,enabled:false},profile:'manual' as const,categories:[],grants:[]}: {})};
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
    const initial=this.store.session(p.id);
    if(!p.queuedMessageId && initial.draftAttachments?.length)throw remoteError('REVISION_CONFLICT','This desktop draft has attachments. Review or send it from the desktop before sending from mobile.');
    if (!p.queuedMessageId && this.sendQueue.shouldQueue(initial)) return this.sendQueue.add(p, execution, beforeAccept, onAccepted);
    if (this.sending.has(p.id) || this.stopping.has(p.id) || busy(initial)) throw remoteError('SESSION_BUSY', 'This session is busy.');
    this.sending.add(p.id);
    try {
      await this.disconnect(p.id);
      const session = this.store.session(p.id);
      if ((!p.queuedMessageId && (session.draftRevision || '0') !== p.expectedDraftRevision) || (session.configRevision || '0') !== p.expectedConfigRevision) throw remoteError('REVISION_CONFLICT', 'The desktop draft or configuration changed.');
      if (!this.remoteAuthority?.(execution, session)) throw remoteError('AUTH_REVOKED','Remote authority changed.');
      this.updateSession(p.id, { remote:structuredClone(execution), effectivePolicy:['ollama','claude'].includes(session.provider)?'restricted':'unknown', turnId:p.turnId });
      return await this.sendTurn(p,beforeAccept,onDispatched,onAccepted,onRejected);
    } finally { this.sending.delete(p.id); this.sendQueue.kick(p.id); }
  }
  draft(id: string, text: string, expectedRevision?: string, scroll?: number, attachmentIds?:unknown, view?:unknown) {
    const session = this.store.session(id);
    if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid draft');
    if (expectedRevision !== undefined && expectedRevision !== (session.draftRevision || '0')) throw remoteError('REVISION_CONFLICT', 'Draft changed on another client. Your local draft is retained.');
    const draftAttachments=attachmentIds===undefined?session.draftAttachments:this.attachments.resolve(id,attachmentIds);
    const views=view===undefined?{}:{view:draftView(view,text)};
    // Moving between the compact panel and the workspace keeps the session's place in recent order.
    if(view!==undefined&&text===session.draft&&JSON.stringify(draftAttachments||[])===JSON.stringify(session.draftAttachments||[])){
      const saved={...session,...views,...(scroll === undefined ? {} : {scroll})};this.store.saveSession(saved);this.changed();return saved;
    }
    const saved=this.updateSession(id, {draft:text,draftAttachments, ...(scroll === undefined ? {} : {scroll}), ...views});
    this.attachments.prune(id);return saved;
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
    await Promise.all(providerIds.map(async provider => {
      try {
        if (provider === 'ollama' || isApiProvider(provider)) { await this.refreshProviderModels(provider); return; }
        const command=providerExecutable(provider);
        const result=await exec(command, [provider==='antigravity'?'--help':'--version'], { timeout: 10000 });
        if(provider==='antigravity'&&!['--input-format','--output-format','--conversation','--disable-slash-commands'].every(flag=>(result.stdout+result.stderr).includes(flag)))throw new Error('Update the agy CLI to a version with headless streaming support');
        // Help probing only gates remote execution. A provider that cannot prove
        // restricted-mode support remains usable by its ordinary desktop flow.
        const help=provider==='claude'?await exec(command,['--help'],{timeout:10000}).catch(()=>({stdout:''})): {stdout:''};
        if (this.closed) return;
        this.capabilities[provider] = { ...this.capabilities[provider], available: true, version: provider==='antigravity'?'agy · headless streaming':result.stdout.trim(), managed: true, resume: true, liveAttach: false, questions: provider!=='antigravity', subagents: provider!=='antigravity', remoteRestricted:provider==='codex'||claudeRestrictedHelp(help.stdout) };
        this.changed(); await this.refreshProviderModels(provider);
      } catch (error:any) {
        if (this.closed || provider === 'ollama' || isApiProvider(provider)) return;
        if (!this.capabilities[provider]?.available) this.capabilities[provider] = { available: false, models: [], modelsStatus:'error', error: `${provider} was not found in PATH or did not start` };
        this.changed();
      }
    }));
  }
  async refreshProviderModels(provider: Provider) {
    const generation=(this.modelGenerations.get(provider)||0)+1;this.modelGenerations.set(provider,generation);
    const previous=this.capabilities[provider] || { available:!isApiProvider(provider) };
    if(isApiProvider(provider))Object.assign(previous,{...this.credentials.status()[provider],label:providerLabels[provider],remoteRestricted:false});
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
      this.capabilities[provider]={...this.capabilities[provider],models:previous.models || [],modelsStatus:'error',modelsError:error.message,...(provider==='ollama'||isApiProvider(provider)?{available:false,error:error.message}:{})};this.changed();throw error;
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
      this.workflows.finish(id);
      this.speech.stopSession(id);
      this.pendingCompletions.delete(id);
      this.speechResponses.delete(id);
      this.turnReplies.delete(id);
      // A late provider fault retracts that turn's success, never another turn's.
      if (patch.status === 'error' || patch.status === 'interrupted')
        this.completions = this.completions.filter(c => c.sessionId !== id || c.turnId !== this.store.session(id).turnId);
      this.persistCompletions();
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
    if (!(providerIds as readonly string[]).includes(p.provider)) throw new Error('Choose a supported provider');
    if(initial?.remote && (isApiProvider(p.provider)||p.provider==='antigravity'))throw new Error('This provider is currently available on the desktop only');
    if(p.temporary!==undefined&&typeof p.temporary!=='boolean')throw new Error('Invalid temporary-conversation choice');
    if(p.temporary&&(p.nativeId||initial?.remote||p.tools))throw new Error('Temporary conversations start fresh without Cere tools or mobile sharing');
    if(p.temporary&&this.store.sessions().filter(s=>s.temporary).length>=10)throw new Error('Close a temporary conversation before opening another');
    if ((p.provider === 'ollama' || isApiProvider(p.provider)) && p.nativeId) throw new Error('API and Ollama conversations are stored by Cere; CLI imports are not supported');
    if (p.tools !== undefined && typeof p.tools !== 'boolean') throw new Error('Invalid assistance mode');
    if (!p.trusted && !this.settings.bypassCliPermissions && (!isApiProvider(p.provider) && p.provider !== 'ollama' || p.tools)) throw new Error(isApiProvider(p.provider) ? 'Confirm desktop tool access for this conversation' : 'Confirm that you trust this project before its CLI configuration is loaded');
    if ((p.provider === 'ollama' || isApiProvider(p.provider)) && !p.tools && !p.cwd) p = {...p, cwd:homedir()};
    if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) throw new Error('Choose an absolute project folder');
    const cwd = await realpath(p.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error('Project must be a folder');
    if (p.nativeId && (typeof p.nativeId !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(p.nativeId))) throw new Error('Invalid native session ID');
    if (p.nativeId && !p.handoffConfirmed) throw new Error('Stop the external CLI session before handing it to Cere');
    if (p.nativeId && this.store.sessions().some(s => s.provider === p.provider && s.nativeId === p.nativeId)) throw new Error('This session is already in Cere');
    const model=String(p.model || (p.provider === 'ollama' ? ollamaConfig.model : '')).trim(), effort=String(p.effort || '').trim().slice(0,32);
    if (model.length > 512 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('Invalid model name');
    if (p.provider === 'ollama') {
      if (!model) throw new Error('Choose an Ollama model or set a default in Settings');
      if (effort) throw new Error('Ollama uses the model’s default thinking settings');
      if (!ollamaCatalog) ollamaCatalog = await this.modelLoader('ollama', ollamaConfig.host);
    }
    if(isApiProvider(p.provider)){if(!model)throw new Error('Choose an API model or enter its model ID');if(effort)throw new Error('API conversations use the model’s default reasoning settings');if(!this.credentials.key(p.provider))throw new Error('Add an API key in Settings → Connections');}
    const catalog:ModelOption[]=p.provider === 'ollama' ? ollamaCatalog || [] : this.capabilities[p.provider]?.modelsStatus==='ready' ? this.capabilities[p.provider].models || [] : [];
    if (p.provider === 'ollama' && !catalog.some(m => m.id === model)) throw new Error('Choose an available Ollama chat model; refresh the model list');
    if(catalog.length && !isApiProvider(p.provider)){
      const selected=model ? catalog.find(option=>option.id===model) : catalog.find(option=>option.isDefault);
      if(model&&!selected)throw new Error('Choose a model available to this provider');
      if(effort&&(!selected||!selected.efforts.some(option=>option.id===effort)))throw new Error('Choose an effort available for this model');
    } else if(!isApiProvider(p.provider)&&this.capabilities[p.provider]?.modelsStatus==='ready'&&(model||effort))throw new Error('This provider reported no selectable models');
    if (p.provider === 'ollama' && p.tools && !catalog.find(m => m.id === model)?.capabilities?.includes('tools')) throw new Error('Choose a model with tool support or use Conversation mode');
    const s: Session = { ...(isApiProvider(p.provider)?{api:{tools:p.tools===true}}:{}), ...(p.provider === 'ollama' ? {ollama:{host:ollamaHost(ollamaConfig.host),tools:p.tools === true}} : {}), id: randomUUID(), provider: p.provider, nativeId: p.nativeId || null, title: sessionTitle(p.title), cwd, mode: 'managed', status: 'idle', created: Date.now(), updated: Date.now(), draft: '', scroll: 0, model, effort };
    if(p.temporary)s.temporary=true;
    if(initial){s.remote=initial.remote;s.effectivePolicy=initial.effectivePolicy;if(initial.draft!==undefined)s.draft=initial.draft;}
    authorize?.();
    if(p.nativeId&&this.store.sessions().some(other=>other.provider===p.provider&&other.nativeId===p.nativeId))throw new Error('This session is already in Cere');
    this.store.saveSession(s); this.changed(); return s;
  }
  // Live events carry a frame-bounded copy; the complete text stays in SQLite.
  putMessage(message: Message) { this.store.message(message); this.emit('message', transportMessage(message)); }
  queueCompletion(session: Session, reply?: Message) {
    if (session.mode !== 'managed' || session.temporary || session.parentId) return;
    const time = Date.now();
    // Bound snapshots across simultaneous runs; the transcript keeps the full reply.
    let message: RunCompletion['message'] = reply ? { ...reply } : { id:'', sessionId:session.id, role:'assistant', text:'This run finished without a final message.', time };
    if (message.text.length > 16000) {
      let end = 16000;
      if (/[\uD800-\uDBFF]/.test(message.text[end - 1])) end--;
      message = { ...message, text:message.text.slice(0,end) + '\n\n[Long reply — open the conversation to read more. Copy retrieves the full message.]', truncated:true };
    }
    this.completions = [...this.completions, { id:randomUUID(), sessionId:session.id, turnId:session.turnId,
      title:session.title, provider:session.provider, cwd:session.cwd, time, message,
      ...(session.pinned || reply && this.deliveredReplies.get(session.id)?.has(reply.id) ? {companion:true} : {}) }].slice(-100);this.persistCompletions();
  }
  persistCompletions(){this.store.set('completionInbox',this.completions.filter(c=>!this.store.temporary(c.sessionId)).map(({message,...row})=>({...row,messageId:message.id})));}

  speechText(text: string) {
    if(!this.settings.speechBrief||text.length<=600)return text;
    const end=text.slice(0,600).replace(/\s+\S*$/,'').length;
    return 'Brief reading. '+(this.settings.ttsProvider==='indextts'?indexPrefix(text,end):text.slice(0,end))+'. The full answer is in the conversation.';
  }
  finishReply(session: Session, message: Message) {
    if (message.role !== 'assistant' || !message.text.trim()) return;
    const seen = this.settledReplies.get(session.id) || new Set<string>();
    if (seen.has(message.id)) return;
    seen.add(message.id); this.settledReplies.set(session.id, seen);
    if (!session.pinned || session.archived || session.mode !== 'managed' || this.closed || session.status === 'stopping') return;
    const delivered = this.deliveredReplies.get(session.id) || new Set<string>();
    delivered.add(message.id); this.deliveredReplies.set(session.id, delivered);
    let preview: RunCompletion['message'] = {...message};
    if (preview.text.length > 16000) {
      let end = 16000; if (/[\uD800-\uDBFF]/.test(preview.text[end-1])) end--;
      preview = {...preview, text:preview.text.slice(0,end)+'\n\n[Long reply — open the conversation to read more.]', truncated:true};
    }
    // Transient desktop presentation: reconnects retain it, broker restarts do
    // not replay old replies. The full transcript remains the source of truth.
    const replyId = randomUUID();
    this.companionReplies = [...this.companionReplies, {id:replyId,sessionId:session.id,turnId:session.turnId,
      title:session.title,provider:session.provider,cwd:session.cwd,time:Date.now(),message:preview}].slice(-100);
    // JSON escaping can multiply text size. Keep this additional snapshot data
    // comfortably inside the desktop transport budget, even for many long replies.
    let bytes = 0;
    for (let index=this.companionReplies.length-1; index>=0; index--) {
      bytes += Buffer.byteLength(JSON.stringify(this.companionReplies[index]));
      if (bytes > 512*1024 && index < this.companionReplies.length-1) {
        this.companionReplies = this.companionReplies.slice(index+1); break;
      }
    }
    if(this.settings.speechProviders[session.provider]!==false)this.speech.speak(this.speechText(message.text), false, session.id, replyId, undefined, session.provider);
    this.changed();
  }
  clearCompanion(sessionId: string) {
    this.companionReplies = this.companionReplies.filter(reply => reply.sessionId !== sessionId);
    this.speech.stopSession(sessionId);
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
      if(e.type==='tool'&&Number.isInteger(e.data?.exitCode)&&typeof e.data?.command==='string'&&!session.temporary){this.workflows.observeAction(id,'Provider-reported command',{command:e.data.command.slice(0,7000)},{exitCode:e.data.exitCode});}
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
      if (e.type === 'message') { this.flush(); this.finishReply(session,message); }
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
      this.workflows.finish(id);
      this.workflows.observeResult(session,this.turnReplies.get(id),status==='idle'?'completed':status==='error'?'failed':'interrupted');
      const reply = this.turnReplies.get(id);
      if (status === 'idle') {
        if (reply) this.finishReply(session,reply);
        this.queueCompletion(session,reply);
      } else this.speech.stopSession(id);
      this.finishNativeMemory(session, status === 'idle' ? this.turnReplies.get(id)?.text || '' : undefined);
      this.turnReplies.delete(id);
      if (status === 'idle') this.unacknowledged.delete(id); else this.returnUnacknowledged(id, e.type === 'error' ? e.text || 'The provider reported an error.' : 'Stopped before the provider accepted it.');
      this.updateSession(id, { status, unread:true,error: e.type === 'error' ? e.text : undefined });
      this.attachments.prune(id);
      this.emit('notice', { kind: e.type === 'error' ? 'error' : interrupted ? 'interrupted' : 'complete', sessionId: id, text: e.type === 'error' ? e.text : interrupted ? (e.text || 'Task interrupted') : 'Task complete' });
      const response = this.speechResponses.get(id); this.speechResponses.delete(id);
      if (status === 'idle' && response && !session.pinned && !this.deliveredReplies.get(id)?.has(reply?.id || '') && session.mode === 'managed' && !session.parentId && !session.remote && !this.closed && this.settings.speechProviders[session.provider]!==false) this.speech.speak(this.speechText(response),false,undefined,undefined,undefined,session.provider);
      this.settledReplies.delete(id); this.deliveredReplies.delete(id);
      if (status === 'idle') this.sendQueue.kick(id);
      else this.sendQueue.cancel(id, 'The previous turn ended; copy this message to send it again');
    }
  }
  automaticallyApprove(id: string, approval: Pick<Approval, 'kind' | 'choices'>): boolean {
    let settings: Settings;
    try { settings = id ? this.settingsFor(id) : this.settings; } catch { return false; }
    const remote = id ? this.store.session(id).remote : undefined;
    // The owner's explicit CLI switch also covers authorized mobile-origin requests.
    // Execution still uses ordinarySettings: device scopes and native sandboxes stay intact.
    const cli = remote && this.settings.bypassCliPermissions && remote.caps.includes('approvals.provider')
      && remote.caps.includes('providers.execute');
    return autoApprove(cli ? {...settings, bypassCliPermissions:true} : settings, approval);
  }
  approval(sessionId: string, p: Omit<Approval,'id'|'sessionId'|'time'>): Promise<any> {
    // Automatic allows are marked so the caller revalidates that authority before acting.
    if (this.automaticallyApprove(sessionId, p)) return Promise.resolve({ choice: 'allow', automatic: true });
    const value = { ...p, sessionId, id: randomUUID(), time: Date.now() };
    return new Promise(resolve => {
      this.approvals.set(value.id, { value, resolve });
      if (sessionId && p.kind === 'question') {
        this.flush();
        const message: Message = {id:`question:${value.id}`,sessionId,role:'assistant',kind:'question',text:[p.title,...(p.questions || []).map(q => q.question)].join('\n\n'),time:value.time};
        this.putMessage(message); this.finishReply(this.store.session(sessionId),message);
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
    if(this.recovery.pending)throw new Error('Recovery restart is pending');
    if (typeof p.text === 'string' && p.text.trim() === '/tts-test' && !p.images?.length) {
      this.draft(p.id, '', p.expectedDraftRevision);
      return this.speech.speak(this.settings.ttsProvider==='indextts'?this.indextts.previewText(this.settings.indextts.profileId):ttsTestLine, true);
    }
    if (!p.queuedMessageId && this.sendQueue.shouldQueue(this.store.session(p.id))) return this.sendQueue.add(p);
    if(this.sending.has(p.id) || this.stopping.has(p.id))throw new Error('This session is busy. Stop it or wait for completion.');
    this.sending.add(p.id);
    try { return await this.sendTurn(p); } finally { this.sending.delete(p.id); this.sendQueue.kick(p.id); }
  }
  async sendTurn(p: any, beforeAccept?:()=>void, onDispatched?:()=>void, onAccepted?:()=>void, onRejected?:()=>void) {
    let s = this.store.session(p.id);
    const powerAtStart=this.power.effective(s);
    const authorizeDispatch=()=>{this.settingsFor(s.id);if(powerAtStart.leaseId&&this.power.effective(this.store.session(s.id)).leaseId!==powerAtStart.leaseId)throw new Error('Power authorization expired before the provider accepted this turn');beforeAccept?.();};
    if (p.expectedDraftRevision !== undefined && !p.turnId && !p.queuedMessageId && p.expectedDraftRevision !== (s.draftRevision || '0')) throw remoteError('REVISION_CONFLICT','Draft changed on another client. Review before sending.');
    const effective = this.settingsFor(p.id);
    if(s.remote&&(isApiProvider(s.provider)||s.provider==='antigravity'))throw new Error('This provider is currently available on the desktop only');
    if(s.remote&&s.provider!=='ollama'&&effective.paused)throw remoteError('POLICY_PAUSED','Native provider execution is paused.');
    if (s.remote && s.provider === 'claude' && s.effectivePolicy !== 'restricted') throw remoteError('PROVIDER_POLICY_UNSAFE', 'Claude restricted mode is not established; read, Stop and Deny remain available.');
    if (s.remote && s.provider !== 'ollama' && !s.remote.caps.includes('providers.execute')) throw remoteError('SCOPE_DENIED', 'Native provider execution is not granted.');
    if (s.remote && !p.turnId) { await this.disconnect(s.id); s = this.store.session(s.id); }
    if (p.webSearch !== undefined && typeof p.webSearch !== 'boolean') throw new Error('Invalid web search choice');
    if (p.webSearch && (s.provider !== 'ollama' && !isApiProvider(s.provider) || !effective.webSearch.enabled || effective.paused)) throw new Error('Enable web search in Settings for an API or Ollama conversation');
    if (p.webSearch && (typeof p.text !== 'string' || p.text.length > 500)) throw new Error('Use a question of at most 500 characters for Search web');
    if (s.mode !== 'managed') throw new Error('Hand this session to Cere before sending');
    if (['starting','working','waiting','stopping'].includes(s.status)) throw new Error('This session is busy. Stop it or wait for completion.');
    if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 100000) throw new Error('Enter a message of up to 100,000 characters');
    const userText=p.text;
    const attached=p.attachmentIds===undefined?{assets:[],images:[],text:''}:await this.attachments.content(s.id,p.attachmentIds);
    let providerText=userText+attached.text;
    if(providerText.length>100000)throw new Error('Message and text attachments exceed 100,000 characters');
    const images: string[] = [];
    images.push(...attached.images);
    if(p.images!==undefined&&(!Array.isArray(p.images)||!p.images.every((v:any)=>typeof v==='string')))throw new Error('Invalid image attachments');
    for (const path of p.images || []) {
      const resolved = await realpath(path);
      if (!(await stat(resolved)).isFile()) throw new Error('Attachment is not a file'); images.push(resolved);
    }
    if (images.length > 4) throw new Error('Attach at most four images');
    this.settingsFor(s.id); // Recheck after every asynchronous attachment validation.
    if (!p.queuedMessageId && p.expectedDraftRevision !== undefined && p.expectedDraftRevision !== (this.store.session(s.id).draftRevision || '0')) throw remoteError('REVISION_CONFLICT','Draft changed during send validation.');
    // Input the destination cannot take is refused before anything is recorded or sent.
    await this.preflight(s, images);
    this.settingsFor(s.id);
    if (!p.queuedMessageId && p.expectedDraftRevision !== undefined && p.expectedDraftRevision !== (this.store.session(s.id).draftRevision || '0')) throw remoteError('REVISION_CONFLICT','Draft changed during send validation.');
    // A very fast provider can emit and flush its first reply before its start
    // acknowledgement returns. Reserve an earlier timestamp for the deferred
    // remote user row so transcript ordering still reflects the turn.
    this.workflows.beforeSend(s.id,userText,[...attached.assets,...images],{webSearch:p.webSearch});
    const userTime=Date.now()-1;
    if (s.provider === 'ollama') this.delegations.delete(s.id);
    this.terminal.delete(s.id); this.pendingCompletions.delete(s.id); this.speechResponses.delete(s.id); this.turnReplies.delete(s.id);
    this.settledReplies.delete(s.id); this.deliveredReplies.delete(s.id);
    const remoteAcceptance=!!onAccepted;
    s = this.updateSession(s.id, { status: 'starting', activity: 'thinking', error: undefined, agents:[], turnId:p.turnId || randomUUID() });
    const submittedDraftRevision=s.draftRevision;
    if(!remoteAcceptance)this.store.set('submission:'+s.id,{text:userText,attachmentIds:attached.assets.map(a=>a.id),turnId:s.turnId,time:Date.now(),state:'dispatching'});
    const userMessageId=randomUUID();
    if(!remoteAcceptance && !p.queuedMessageId)this.putMessage({ id: userMessageId, sessionId: s.id, role: 'user', text: p.text + (attached.assets.length ? '\n\nAttached files: ' + attached.assets.map(a=>a.name).join(', ') : '') + (images.length ? '\n\nAttached: ' + images.join(', ') : ''), time: Date.now() });
    // HTTP providers and AntiGravity accept a turn from their stream, after send() returns.
    const tracked=!remoteAcceptance&&!p.queuedMessageId&&(s.provider==='ollama'||s.provider==='antigravity'||isApiProvider(s.provider));
    if(tracked)this.unacknowledged.set(s.id,{turnId:s.turnId!,messageId:userMessageId,text:userText,attachmentIds:attached.assets.map(a=>a.id)});
    const acknowledged=()=>{const turn=this.unacknowledged.get(s.id);if(!turn||turn.turnId!==s.turnId||turn.returned)return;this.unacknowledged.delete(s.id);this.store.set('submission:'+s.id,{turnId:s.turnId,time:Date.now(),state:'accepted'});this.attachments.prune(s.id);};
    let accepted=!remoteAcceptance;
    const acceptedByProvider=remoteAcceptance?()=>{if(accepted)return;onAccepted!();accepted=true;if(p.queuedMessageId)return;s=this.updateSession(s.id,{draft:'',view:undefined});this.putMessage({id:randomUUID(),sessionId:s.id,role:'user',text:p.text+(images.length?'\n\nAttached: '+images.join(', '):''),time:userTime});}:undefined;
    try {
      let memorySignal: AbortSignal | undefined;
      if (s.provider !== 'ollama' && !isApiProvider(s.provider) && effective.memory.enabled && this.memory.active()) {
        const controller = new AbortController();
        const epoch = this.memory.controller.signal;
        this.nativeMemoryTurns.set(s.id, { text:userText, turnId:s.turnId, controller, epoch });
        const context = await this.memory.context(s, userText, controller.signal, 4000, 'cloud', this.memoryWritable(s.id), () => this.memoryAuthorized(s.id, false, controller.signal));
        controller.signal.throwIfAborted();
        if (context && !epoch.aborted) {
          memorySignal = AbortSignal.any([controller.signal, epoch]);
          providerText = context + '\n\n' + providerText;
        } else memorySignal = controller.signal;
      }
      this.ensureAdapter(s);
      if(s.remote&&s.provider!=='ollama'&&this.settingsFor(s.id).paused)throw remoteError('POLICY_PAUSED','Native provider execution is paused.');
      authorizeDispatch();
      await this.adapters.get(s.id)!.send(providerText, images, { webSearch: p.webSearch, beforeAccept:()=>{memorySignal?.throwIfAborted();authorizeDispatch();}, onDispatched:remoteAcceptance?onDispatched:undefined, onAccepted:acceptedByProvider, onRejected:remoteAcceptance?onRejected:undefined, acknowledged:tracked?acknowledged:undefined });
      if(!accepted)throw new Error('Provider did not confirm that it accepted the turn.');
      if(!remoteAcceptance){
        const turn=this.unacknowledged.get(s.id),returned=!!turn&&turn.turnId===s.turnId&&turn.returned===true;
        if(returned)this.unacknowledged.delete(s.id);
        // A tracked turn stays recoverable until its provider accepts it.
        else if(!tracked)this.store.set('submission:'+s.id,{turnId:s.turnId,time:Date.now(),state:'accepted'});
        if(!returned && !p.queuedMessageId && this.store.session(s.id).draftRevision===submittedDraftRevision)this.updateSession(s.id,{draft:'',draftAttachments:[],view:undefined});
        if(!returned)this.attachments.prune(s.id);
      }
      if (this.store.session(s.id).status === 'starting') this.updateSession(s.id, { status: 'working' });
      return true;
    } catch (e: any) {
      if(!remoteAcceptance)this.store.set('submission:'+s.id,{text:userText,attachmentIds:attached.assets.map(a=>a.id),turnId:s.turnId,time:Date.now(),state:'uncertain'});
      this.event(s.id, { type: 'error', text: e.message });
      for (const [token, owner] of this.tokens) if (owner === s.id) this.tokens.delete(token);
      const adapter = this.adapters.get(s.id); this.adapters.delete(s.id); await adapter?.close();
      throw e;
    }
  }
  /** Why a conversation cannot take image attachments, when its provider or model says so. */
  imageRefusal(s: Session) {
    if (s.provider === 'antigravity') return 'AntiGravity accepts text attachments only. Use an API provider or an Ollama model with Images for pictures.';
    if (s.provider !== 'ollama' || !s.ollama || ollamaHost(this.settings.ollama.host) !== s.ollama.host) return '';
    const model = (this.capabilities.ollama?.models as ModelOption[] | undefined)?.find(m => m.id === s.model);
    return model?.capabilities?.length && !model.capabilities.includes('vision') ? `${s.model} does not accept images. Choose a model with Images, or attach text.` : '';
  }
  /** Refuses input the destination cannot accept, before a turn is recorded or dispatched. */
  async preflight(s: Session, images: string[]) {
    await this.ensureAdapter(s).preflight?.(images, AbortSignal.timeout(30000));
  }
  /** The session's provider adapter, created with callbacks bound to its current generation. */
  ensureAdapter(s: Session): Adapter {
    const existing = this.adapters.get(s.id); if (existing) return existing;
    const token = randomBytes(32).toString('hex'); this.tokens.set(token, s.id);
    const generation = (this.generations.get(s.id) || 0) + 1; this.generations.set(s.id, generation);
    const live = () => this.generations.get(s.id) === generation;
    const hooks: Hooks = { token, restrictive:!!s.remote, policy:verified => { if (live()) this.updateSession(s.id, {effectivePolicy:verified ? 'restricted' : 'unknown'}); }, personality: () => this.settings.personality,
      bypassCliPermissions: () => this.settingsFor(s.id).bypassCliPermissions,
      automaticApprovalValid: kind => {try{return live()&&!this.terminal.has(s.id)&&this.automaticallyApprove(s.id,{kind,choices:['allow']});}catch{return false;}},
      event: e => { if (live()) this.event(s.id,e); }, native: nativeId => { if (live()) this.updateSession(s.id,{nativeId}); },
      approve: value => live() && !this.terminal.has(s.id) ? this.approval(s.id,value) : Promise.resolve({choice:'deny',cancelled:true}) };
    const adapter = this.factory(s, hooks); this.adapters.set(s.id, adapter); return adapter;
  }
  /**
   * A desktop turn that ended before its provider accepted it never reached the model: its
   * transcript row says so and the message returns to an empty draft (or stays recoverable).
   */
  private returnUnacknowledged(id: string, reason: string) {
    const turn = this.unacknowledged.get(id), session = this.store.session(id);
    if (!turn || turn.returned || turn.turnId !== session.turnId) return;
    turn.returned = true;
    const message = this.store.messageById(turn.messageId);
    let restored = session.draft === turn.text && JSON.stringify((session.draftAttachments || []).map(a => a.id)) === JSON.stringify(turn.attachmentIds);
    if (!restored && !session.draft && !session.draftAttachments?.length) {
      try { this.draft(id, turn.text, undefined, undefined, turn.attachmentIds); restored = true; } catch {}
    }
    this.store.set('submission:' + id, restored ? null : { text: turn.text, attachmentIds: turn.attachmentIds, turnId: turn.turnId, time: Date.now(), state: 'uncertain' });
    // Same wording and kind as a cancelled queued message, on every client.
    if (message) this.putMessage({ ...message, kind: 'queue-cancelled', text: `Not sent — ${reason.trim()} ${restored ? 'The message is back in your draft.' : 'Recover it from the conversation menu.'}\n\n${message.text}` });
  }
  async stop(id: string): Promise<boolean> {
    this.sendQueue.cancel(id, 'Stopped before sending; copy this message to send it again');
    this.speech.stopSession(id);
    const existing = this.stopping.get(id); if (existing) return existing;
    const pending = Promise.resolve().then(() => this.stopTurn(id)).finally(() => this.stopping.delete(id));
    this.stopping.set(id, pending); return pending;
  }
  async stopAndClose(id:string) {
    this.sendQueue.cancel(id, 'Authorization ended before sending');
    const wasActive=busy(this.store.session(id));
    const adapter=this.adapters.get(id);
    this.cancelApprovals(id);this.abortActions(id,new Error('Power access ended'));
    this.terminal.add(id);this.generations.set(id,(this.generations.get(id)||0)+1);
    for(const [token,owner]of this.tokens)if(owner===id)this.tokens.delete(token);
    this.adapters.delete(id);
    this.updateSession(id,{status:'stopping'});
    let timer:NodeJS.Timeout|undefined;
    try {
      await Promise.race([adapter?.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Provider termination could not be confirmed')),5000);timer.unref();})]);
      this.updateSession(id,{status:'interrupted',error:'Power access ended. Managed provider termination confirmed; external processes are outside Cere’s supervision.'});
      this.attachments.prune(id);
    } catch(error){this.updateSession(id,{status:'interrupted',error:'Power access ended. Provider termination is unconfirmed.'});throw error;}
    finally{if(timer)clearTimeout(timer);if(wasActive)this.finishInterruptedTurn(id);}
  }
  private finishInterruptedTurn(id:string) {
    this.pendingCompletions.delete(id);this.flush();this.cancelApprovals(id);
    this.returnUnacknowledged(id,'Stopped before the provider accepted it.');
    this.workflows.finish(id);
    const session=this.store.session(id);
    this.workflows.observeResult(session,this.turnReplies.get(id),'interrupted');
    this.finishNativeMemory(session);this.turnReplies.delete(id);this.speechResponses.delete(id);
  }
  stopDeadlineMs = 10000; forceCloseMs = 3000;
  /** In-flight Cere actions per session ('' for user-started desktop actions). */
  actionControllers = new Map<string, Set<AbortController>>();
  abortActions(id: string, reason: Error) {
    this.nativeMemoryTurns.get(id)?.controller.abort(reason);
    for (const controller of this.actionControllers.get(id) || []) controller.abort(reason);
  }
  finishNativeMemory(session: Session, answer?: string) {
    const turn = this.nativeMemoryTurns.get(session.id);
    if (!turn) return;
    this.nativeMemoryTurns.delete(session.id);
    if (answer === undefined || turn.controller.signal.aborted || turn.epoch.aborted || !this.memoryWritable(session.id)) {
      this.memory.packets.delete(session.id); return;
    }
    const signal = AbortSignal.any([turn.controller.signal, turn.epoch]);
    const authorize = () => {
      this.memoryAuthorized(session.id, true, signal);
      if (this.closed || this.store.session(session.id).turnId !== turn.turnId) throw new Error('Memory source turn changed');
    };
    const capture = this.memory.capture(session, turn.text, answer, signal, authorize).catch(() => {});
    this.memoryCaptures.add(capture);
    void capture.finally(() => this.memoryCaptures.delete(capture));
  }
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
    this.terminal.add(id);this.generations.set(id,(this.generations.get(id)||0)+1);
    for(const [token,owner]of this.tokens)if(owner===id)this.tokens.delete(token);
    this.abortActions(id,new Error('Provider force-stopped'));
    const adapter=this.adapters.get(id);this.adapters.delete(id);
    let timeout:NodeJS.Timeout|undefined;
    const confirmed=await Promise.race([adapter?.close().then(()=>true).catch(()=>false)??Promise.resolve(true),new Promise<boolean>(resolve=>{timeout=setTimeout(()=>resolve(false),this.forceCloseMs);timeout.unref();})]);if(timeout)clearTimeout(timeout);
    if(this.store.session(id).status!=='stopping')return;
    const text=confirmed?'Managed provider termination confirmed. External processes are outside Cere’s supervision.':'Provider termination is unconfirmed. Cere revoked this session’s tools; inspect the provider before retrying.';
    this.updateSession(id,{status:'interrupted',error:text});
    this.finishInterruptedTurn(id);
    if(confirmed)this.attachments.prune(id);
    this.emit('notice',{kind:'interrupted',sessionId:id,text});
  }
  async updateSettings(patch: any) {
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== this.store.get('settingsRevision','0')) throw remoteError('REVISION_CONFLICT','Settings changed on another client. Reload before saving.');
    const next = structuredClone(this.settings);
    if ('telemetry' in patch) next.telemetry = await telemetryConfiguration(patch.telemetry, next.telemetry);
    if ('personality' in patch) next.personality = validatePersonality(patch.personality);
    if ('voice' in patch) next.voice = validateVoice(patch.voice);
    if ('ttsProvider' in patch) {if(!['local','indextts','elevenlabs'].includes(patch.ttsProvider))throw new IndexError('INVALID_CONFIG');next.ttsProvider=patch.ttsProvider;}
    if ('speechProviders' in patch) {
      const value=patch.speechProviders;
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,v])=>!providerIds.includes(key as Provider)||typeof v!=='boolean'))throw new Error('Choose conversation providers with boolean speech switches');
      next.speechProviders={...this.settings.speechProviders,...value};
    }
    if ('elevenlabs' in patch) next.elevenlabs=validateElevenConfig(patch.elevenlabs,this.settings.elevenlabs);
    if ('indextts' in patch) {
      if(this.indextts.snapshot().busy)throw new IndexError('BUSY');
      next.indextts=validateIndexConfig(patch.indextts,this.settings.indextts);
      await this.indextts.validateDirectory(next.indextts);
      if(next.indextts.profileId&&!this.indextts.profiles().some(p=>p.id===next.indextts.profileId&&p.version===next.indextts.version))throw new IndexError('PROFILE_MISSING');
    }
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
    for (const key of ['speechEnabled','speechBrief','topmost','roaming','quiet','reducedMotion','expressiveCues','hidden','paused','onboarding','bypassCliPermissions','bypassComputerPermissions'] as const) if (key in patch) {
      if (typeof patch[key] !== 'boolean') throw new Error(`Invalid ${key}`); next[key] = patch[key];
    }
    for (const [key,min,max,label] of [['speechRate',.5,2,'Speech rate'],['speechPitch',-6,6,'Speech pitch'],['speechVolume',0,1,'Speech volume']] as const) {
      if (key in patch) {
        if (!Number.isFinite(patch[key]) || patch[key]<min || patch[key]>max) throw new Error(`${label} must be between ${min} and ${max}`);
        next[key]=patch[key];
      }
    }
    if ('transcription' in patch) {const t=patch.transcription;if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).some(k=>!['executable','model'].includes(k))||Object.values(t).some(v=>typeof v!=='string'||v.length>4096||v.includes('\0')))throw new Error('Choose local executable and model paths');next.transcription={...next.transcription,...t};await this.transcription.cancel();}
    if ('interfaceScale' in patch) {if(!Number.isFinite(patch.interfaceScale)||patch.interfaceScale<.8||patch.interfaceScale>1.5)throw new Error('Interface scale must be between 80% and 150%');next.interfaceScale=patch.interfaceScale;}
    if ('desktopProfile' in patch) {
      if(!['normal','focus','gaming','presentation'].includes(patch.desktopProfile))throw new Error('Unknown desktop profile');
      const keys=['hidden','speechEnabled','quiet','reducedMotion','roaming'] as const;
      if(this.settings.desktopProfile==='normal')this.store.set('desktopProfilePrevious',Object.fromEntries(keys.map(key=>[key,this.settings[key]])));
      if(patch.desktopProfile==='normal')Object.assign(next,this.store.get('desktopProfilePrevious',{}));
      else Object.assign(next,{hidden:patch.desktopProfile!=='focus',speechEnabled:false,quiet:true,reducedMotion:true,roaming:false});
      next.desktopProfile=patch.desktopProfile;
    }
    if ('homePositions' in patch) {
      const values=patch.homePositions;if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length>32||Object.entries(values).some(([key,p]:[string,any])=>key.length>200||!p||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)))throw new Error('Invalid monitor homes');next.homePositions=structuredClone(values);
    }
    if ('scale' in patch) { if (!Number.isFinite(patch.scale) || patch.scale < .5 || patch.scale > 3) throw new Error('Size must be between 50% and 300%'); next.scale = patch.scale; }
    if ('idleEnergy' in patch) { if (!['calm','lively'].includes(patch.idleEnergy)) throw new Error('Idle energy must be calm or lively'); next.idleEnergy = patch.idleEnergy; }
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
    if('ttsProvider' in patch||'indextts' in patch||'elevenlabs' in patch){this.speech.stop();await this.speech.idle();await this.indextts.reconfigure();}
    this.settings = next; this.store.set('settings', next);
    if('speechProviders' in patch)this.speech.stopProviders(providerIds.filter(id=>next.speechProviders[id]===false));
    await this.telemetry.configure(next.telemetry);
    if (!next.speechEnabled || next.quiet || next.speechVolume===0 || 'voice' in patch) this.speech.stop();
    // Resolve only matching permission requests; input questions must never receive invented answers.
    for (const { value } of [...this.approvals.values()]) if (this.automaticallyApprove(value.sessionId, value)) this.answer({ id: value.id, choice: 'allow' }, true);
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
    if(this.recovery.pending)throw new Error('Recovery restart is pending');
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
    const scriptBefore=name==='script.run'?JSON.stringify(this.settings.scripts.find(s=>s.id===args.id)):undefined;
    if(this.memory.active())await recordMemory('proposed');
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
      if(sessionId&&!this.store.temporary(sessionId)&&!result?.cancelled&&(typeof result?.exitCode==='number'||typeof result?.path==='string'))this.workflows.observeAction(sessionId,name,args,{...(typeof result.exitCode==='number'?{exitCode:result.exitCode}:{}),...(typeof result.path==='string'?{outputPaths:[result.path]}:{})});
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
    if ((s.provider !== 'ollama' && !isApiProvider(s.provider)) || settings.paused) return [];
    const definitions = [
      ...(s.ollama?.tools || s.api?.tools ? [...actionDefinitions, ...orchestrationDefinitions].filter(d => categoryEnabled(settings, d.category) && (!s.remote || d.category !== 'providers' || s.remote.caps.includes('providers.execute'))) : []),
      ...(settings.webSearch.enabled ? webDefinitions : []), ...(settings.memory.enabled && this.memory.active() && (!isApiProvider(s.provider)||settings.memory.allowCloudMemory) ? memoryDefinitions.filter(d=>!s.remote || d.readOnly || s.remote.caps.includes('memory.write')) : []),
    ];
    return definitions.map(d => ({
      type: 'function', function: { name: d.name.replaceAll('.', '_'), description: d.description,
        parameters: { type: 'object', properties: d.schema, required: d.required || Object.keys(d.schema), additionalProperties: false } },
    }));
  }
  memoryToolsFor(id: string) {
    const s = this.store.session(id), settings = this.settingsFor(id);
    if (!settings.memory.enabled || !this.memory.active() || (s.provider !== 'ollama' && !settings.memory.allowCloudMemory)) return [];
    return memoryDefinitions.filter(d => !s.remote || d.readOnly || s.remote.caps.includes('memory.write'));
  }
  memoryWritable(id: string) { const execution=this.store.session(id).remote;return !execution||execution.caps.includes('memory.write'); }
  memoryAuthorized(id: string, write: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.settingsFor(id).memory.enabled || !this.memory.active() || (write && !this.memoryWritable(id))) throw remoteError('SCOPE_DENIED', 'Memory authority changed.');
  }
  async callTool(id: string, name: string, args: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const nativeMemory = this.store.session(id).provider !== 'ollama' && this.memoryToolsFor(id).some(d => d.name.replaceAll('.', '_') === name);
    if (!nativeMemory && !this.toolsFor(id).some(t => t.function.name === name)) throw new Error('This tool is disabled in Cere settings');
    const knowledge = [...webDefinitions, ...memoryDefinitions].find(d => d.name.replaceAll('.', '_') === name);
    if (knowledge) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !(k in knowledge.schema)) || (knowledge.required || Object.keys(knowledge.schema)).some(k => !(k in args))) throw new Error('Invalid tool arguments');
      const p = args as Record<string, unknown>, s = this.store.session(id);
      if (name.startsWith('web_')) return this.webCall(name, p, signal);
      const authorize=()=>{
        this.memoryAuthorized(id,!knowledge.readOnly,signal);
        if (s.provider !== 'ollama' && !this.memoryToolsFor(id).some(d => d.name.replaceAll('.', '_') === name)) throw new Error('This tool is disabled in Cere settings');
      };
      authorize();
      if (name === 'memory_search') { const result = await this.memory.recall(s, p.query, signal); authorize(); return result; }
      if (name === 'memory_save') return this.memory.save(s, p.text, p.id, undefined, true, signal, authorize);
      if (name === 'memory_forget') return this.memory.forget(s, p.id, signal, authorize);
      if (name === 'memory_inspect') { const result = await this.memory.inspectForModel(s,p.id,signal,authorize); authorize(); return result; }
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
  async configureSession(p: any, authorize?: () => void, remoteExecution?: RemoteExecution) {
    if (this.sending.has(p.id) || this.stopping.has(p.id)) throw new Error('This session is busy');
    this.sending.add(p.id);
    try {
      const s = this.store.session(p.id), api=isApiProvider(s.provider), local=s.provider==='ollama';
      if (s.mode!=='managed') throw new Error('Hand this session to Cere before changing its model');
      if (['starting','working','waiting','stopping'].includes(s.status)) throw new Error('Stop the current turn before changing its model');
      const remoteNative=!!s.remote&&!local;
      if(remoteNative&&!remoteExecution)throw new Error('Detach this conversation from mobile control before changing its model on the desktop');
      const revision=s.configRevision||'0';
      const check=()=>{authorize?.();const current=this.store.session(s.id);if(remoteNative&&(!current.remote||current.remote.deviceId!==remoteExecution!.deviceId||current.remote.scopeVersion!==remoteExecution!.scopeVersion||!this.remoteAuthority?.(remoteExecution!,current)))throw remoteError('AUTH_REVOKED','Remote authority changed.');if((current.configRevision||'0')!==revision||(p.expectedConfigRevision!==undefined&&p.expectedConfigRevision!==revision))throw remoteError('REVISION_CONFLICT','Conversation settings changed. Reopen Model and try again.');};
      check();
      if(typeof p.model!=='string'||p.model.length>512||/[\x00-\x1f\x7f]/.test(p.model))throw new Error('Choose a valid model');
      const modelId=p.model.trim(),oldTools=s.ollama?.tools||s.api?.tools||false;
      const tools=p.tools===undefined?oldTools:p.tools;
      if(typeof tools!=='boolean'||(!api&&!local&&tools))throw new Error('Choose a valid assistance mode');
      if(s.temporary&&tools)throw new Error('Cere tools are unavailable in temporary conversations');
      if(tools&&!oldTools&&!p.trusted&&!this.settings.bypassCliPermissions)throw new Error('Confirm that you trust this project before enabling delegation');
      if((local||api)&&!modelId)throw new Error('Choose a model or enter its API model ID');
      const effort=p.effort===undefined?(modelId===s.model?s.effort||'':''):p.effort;
      if(typeof effort!=='string'||effort.length>32||/[\x00-\x1f\x7f]/.test(effort))throw new Error('Choose a valid reasoning effort');
      if((local||api)&&effort)throw new Error('This provider uses the model’s default reasoning settings');
      if(local){
        if(!s.ollama)throw new Error('Missing Ollama connection settings');
        const models=await ollamaModels(s.ollama.host),model=models.find(m=>m.id===modelId);
        if(!model)throw new Error('Choose an available Ollama model');
        if(tools&&!model.capabilities?.includes('tools'))throw new Error('This model does not support tools');
        if(!model.capabilities?.includes('vision')&&this.store.get<OllamaMessage[]>('ollama:'+s.id,[]).some(m=>m.images?.length))throw new Error('This conversation contains images. Choose a model with Images, or start a new conversation.');
      }else if(!api&&(modelId!==s.model||effort!==s.effort&&!!effort)){
        const models:ModelOption[]=this.capabilities[s.provider]?.modelsStatus==='ready'?this.capabilities[s.provider].models:await this.refreshProviderModels(s.provider);
        const selected=modelId?models.find(m=>m.id===modelId):models.find(m=>m.isDefault);
        if(modelId&&!selected)throw new Error('Choose a model available to this provider');
        if(effort&&!selected?.efforts.some(e=>e.id===effort))throw new Error('Choose an effort available for this model');
      }
      check();
      if(modelId===s.model&&effort===(s.effort||'')&&tools===oldTools)return this.store.session(s.id);
      // Invalidate callbacks before closing; late events from the old adapter cannot
      // overwrite the newly chosen model, transcript, or completion status.
      await this.disconnect(s.id);check();
      if(api&&modelId!==s.model)this.store.set('api:'+s.id,portableApiHistory(this.store.get<OllamaMessage[]>('api:'+s.id,[])));
      return this.updateSession(s.id,{model:modelId,effort,...(local?{ollama:{...s.ollama!,tools}}:api?{api:{tools}}:{}),error:undefined});
    } finally { this.sending.delete(p.id); }
  }
  /**
   * Deletes a saved conversation: transcript, draft, attachments, queued and recovery records,
   * completions, bookmarks and result cards. Memory derived from it stays under Forget.
   */
  async deleteSession(p: any) {
    const s = this.store.session(p.id);
    if (p.confirmed !== true) throw new Error('Confirm deleting this conversation');
    if (s.temporary) throw new Error('Discard temporary conversations instead');
    if (busy(s) || this.sending.has(s.id) || this.stopping.has(s.id) || (s.agents || []).some(a => this.agentActive(a)) || [...this.approvals.values()].some(a => a.value.sessionId === s.id))
      throw new Error('Stop this conversation before deleting it');
    if (this.power.effective(s).leaseId) throw new Error('End this conversation’s power session before deleting it');
    if (this.store.sessions().some(child => child.parentId === s.id && busy(child))) throw new Error('Stop its delegated conversations before deleting it');
    await this.disconnect(s.id);
    this.sendQueue.cancel(s.id, 'Conversation deleted');
    this.workflows.finish(s.id); this.workflows.forgetSession(s.id);
    this.attachments.removeSession(s.id);
    this.store.deleteSession(s.id);
    for (const map of [this.settledReplies, this.deliveredReplies, this.turnReplies, this.speechResponses, this.pendingCompletions, this.unacknowledged, this.delegations, this.generations]) map.delete(s.id);
    for (const children of this.delegations.values()) children.delete(s.id);
    this.terminal.delete(s.id); this.memory.packets.delete(s.id);
    this.completions = this.completions.filter(c => c.sessionId !== s.id); this.persistCompletions(); this.clearCompanion(s.id);
    for (const row of this.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'memory-review:%'").all()) {
      const proposals = JSON.parse(String(row.value)) as { sessionId: string }[];
      if (proposals.some(proposal => proposal.sessionId === s.id)) this.store.set(String(row.key), proposals.filter(proposal => proposal.sessionId !== s.id));
    }
    const navigation = this.store.get<{ favorites: string[]; recents: string[] }>('navigation', { favorites: [], recents: [] });
    if ([...navigation.favorites, ...navigation.recents].includes('session:' + s.id))
      this.store.set('navigation', { favorites: navigation.favorites.filter(id => id !== 'session:' + s.id), recents: navigation.recents.filter(id => id !== 'session:' + s.id) });
    for (const child of this.store.sessions()) if (child.parentId === s.id) this.updateSession(child.id, { parentId: undefined });
    for (const owner of ['ui', 'overlay'] as const) if (this.attention[owner].sessionId === s.id) {
      this.attention[owner] = { owner, sessionId: '', listening: false };
      this.emit('ui', { command: 'attention', ...this.attention[owner] });
    }
    this.changed();
    return true;
  }
  checkingTimers = false;
  async checkTimers() {
    if (this.checkingTimers||this.recovery.pending) return;
    this.checkingTimers = true;
    try {
      for (const t of this.store.timers()) if (!t.paused && t.due <= Date.now()) {
        // Claim each timer atomically just before delivery: a stale sweep or a timer
        // cancelled during an earlier notification never produces a second notice.
        if (!this.store.removeTimer(t.id)) continue;
        if(t.repeatMinutes)this.store.timer({...t,due:Date.now()+t.repeatMinutes*60000});
        this.emit('notice', { kind: 'timer', text: t.label }); this.changed();
        if(!this.settings.quiet)await exec('notify-send', ['--app-name=Cere', 'Cere · Timer', t.label], { timeout: 5000 }).catch(() => {});
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
    const readOnly=['state','projects.list','session.messages','session.messageText','session.recovery','session.context','navigation.search','sessions.list','session.search','bookmarks.list','capsules.get','recipes.list','recipes.versions','results.list','memoryReview.list','memoryReview.recalled','recovery.status','diagnostics.preview','utility.list','utility.calculate','utility.convert','ui.panel','ui.attention','session.stop','approval.answer','power.end'].includes(method);
    if(readOnly||method==='recovery.activate'||method==='recovery.cancel')return this.rpcInner(method,p);
    return this.withMutation(()=>this.rpcInner(method,p));
  }
  activeMutations=0;
  async withMutation<T>(work:()=>Promise<T>):Promise<T>{
    if(this.recovery.pending)throw new Error('Recovery is pending. Wait for the broker to restart before making changes.');
    this.activeMutations++;
    try{return await work();}finally{this.activeMutations--;}
  }
  private async rpcInner(method:string,p:any):Promise<any>{
    if(method==='telemetry.pause'){if(typeof p.paused!=='boolean')throw new Error('Invalid telemetry pause');return this.telemetry.pause(p.paused);}
    if(method==='telemetry.clear')return this.telemetry.clear();
    if(method==='telemetry.status')return this.telemetry.status;
    if(method==='session.read'){const result=this.organization.dispatch(method,p);this.completions=this.completions.filter(c=>c.sessionId!==p.id);this.persistCompletions();this.changed();return result;}
    if(method==='session.organize'){
      const result=this.organization.dispatch(method,p);
      if(!result.pinned || result.archived) this.clearCompanion(p.id);
      this.changed(); return result;
    }
    if(method.startsWith('projects.'))return this.projects.dispatch(method,p);
    if(['capsules.','recipes.','results.'].some(prefix=>method.startsWith(prefix)))return this.workflows.dispatch(method,p);
    if(method.startsWith('memoryReview.'))return this.memoryReview.dispatch(method,p);
    if(method.startsWith('recovery.'))return this.recovery.dispatch(method,p);
    if(method.startsWith('utility.')||method.startsWith('routine.')||['timer.pause','timer.resume','timer.repeat'].includes(method))return this.utilities.dispatch(method,p);
    if(['sessions.list','session.search','session.organize','session.read','folders.save','folders.delete','bookmarks.list','message.bookmark','navigation.search','navigation.record','navigation.favorite'].includes(method))return this.organization.dispatch(method,p);
    switch (method) {
      case 'state': return this.snapshot();
      case 'session.create': return this.create(p);
      case 'session.configure': return this.configureSession(p);
      case 'session.send': if(this.recovery.pending)throw new Error('Recovery restart is pending');return this.send(p);
      case 'session.stop': return this.stop(p.id);
      case 'session.disconnect': return this.disconnect(p.id);
      case 'session.discardTemporary': {const s=this.store.session(p.id);if(!s.temporary)throw new Error('This is a saved conversation');await this.stopAndClose(s.id);this.completions=this.completions.filter(c=>c.sessionId!==s.id);this.clearCompanion(s.id);this.settledReplies.delete(s.id);this.deliveredReplies.delete(s.id);this.store.discardTemporary(s.id);this.changed();return true;}
      case 'session.delete': return this.deleteSession(p);
      case 'session.detachRemote': { await this.disconnect(p.id); return this.updateSession(p.id,{remote:undefined,effectivePolicy:undefined}); }
      // Byte-bounded pages, newest first by cursor; clients load older pages on request.
      case 'session.messages': this.flush(); return messagePage(this.store, p.id, p.before, p.maxBytes);
      case 'session.messageText': this.flush(); return messageChunk(this.store, p.id, p.messageId, p.offset);
      case 'session.draft': return this.draft(p.id, p.text, p.expectedRevision, Number(p.scroll) || 0,p.attachmentIds,p.view);
      case 'attachments.import': {const asset=await this.attachments.import(p.sessionId,p.path,this.imageRefusal(this.store.session(p.sessionId)));this.changed();return asset;}
      case 'attachments.remove': return this.attachments.remove(p.sessionId,p.id);
      case 'attachments.keepInDraft': {const s=this.store.session(p.sessionId),assets=this.attachments.resolve(s.id,[p.attachmentId]);if(!(s.draftAttachments||[]).some(a=>a.id===p.attachmentId)){const next=[...(s.draftAttachments||[]),...assets];this.attachments.resolve(s.id,next.map(a=>a.id));s.draftAttachments=next;this.store.saveSession(s);this.changed();}return s;}
      case 'session.recovery': return this.store.get('submission:'+this.store.session(p.id).id,null);
      case 'session.dismissRecovery': {const session=this.store.session(p.id);this.store.set('submission:'+session.id,null);this.attachments.prune(session.id);return true;}
      case 'session.recoverDraft': {
        const s=this.store.session(p.id),record=this.store.get<any>('submission:'+s.id,null);
        if(!record?.text)throw new Error('No recoverable submission');
        return this.draft(s.id,record.text,p.expectedRevision,s.scroll,record.attachmentIds||[]);
      }
      case 'session.context': {
        const s=this.store.session(p.id),packet=this.memory.packets.get(s.id);
        const text=typeof p.text==='string'?p.text:s.draft;
        const attachments=p.attachmentIds===undefined?s.draftAttachments||[]:this.attachments.resolve(s.id,p.attachmentIds);
        return {destination:{provider:s.provider,model:s.model||'Provider default',cwd:s.cwd,host:s.ollama?.host},attachments,
          estimatedTokens:Math.ceil((text.length+attachments.filter(a=>a.kind==='text').reduce((n,a)=>n+a.size,0))/3),
          estimateLabel:'Estimate for this text and attached text files; excludes images, instructions and provider history.',
          memories:packet?.evidence||[],memoryLabel:'Evidence supplied for the most recent turn. Recall for the next turn is selected at submission.',
          nativeContext:s.provider==='ollama'||isApiProvider(s.provider)?'Conversation context is managed by Cere.':'The native CLI may additionally read its session history, project instructions and files. Cere cannot measure all of that context.'};
      }
      case 'session.nativeFork': {const source=this.store.session(p.id);const nativeId=await forkCodex(source);return this.create({provider:'codex',nativeId,handoffConfirmed:true,cwd:source.cwd,model:source.model,title:'Fork · '+source.title,trusted:true});}
      case 'session.branch': {
        const source=this.store.session(p.id);
        if(typeof p.text!=='string'||!p.text.trim()||p.text.length>100000)throw new Error('Review the selected context first');
        const branch=await this.create({provider:p.provider||source.provider,cwd:source.cwd,model:p.provider&&p.provider!==source.provider?(p.model||''):source.model,title:'Branch · '+source.title,temporary:source.temporary===true,trusted:p.trusted===true,tools:source.ollama?.tools||source.api?.tools});
        return this.draft(branch.id,p.text);
      }
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
        if (p.sessionId) { const s = this.store.session(p.sessionId); if(p.provider!==s.provider)throw new Error('Choose this conversation’s provider'); if(s.provider==='ollama')return ollamaModels(s.ollama!.host);return this.refreshProviderModels(s.provider); }
        if(!(providerIds as readonly string[]).includes(p.provider))throw new Error('Unknown provider');
        return this.refreshProviderModels(p.provider);
      }
      case 'approval.answer': return this.answer(p);
      case 'companion.dismiss': {
        if (typeof p.id !== 'string') throw new Error('Invalid reply');
        this.companionReplies = this.companionReplies.filter(reply => reply.id !== p.id);
        this.changed(); return true;
      }
      case 'completion.dismiss': {
        if (typeof p.id !== 'string') throw new Error('Invalid completion');
        this.completions = this.completions.filter(c => c.id !== p.id);this.persistCompletions();
        this.changed(); return true;
      }
      case 'provider.credentials': {
        if (!isApiProvider(p.provider)) throw new Error('Choose an API provider');
        const status=this.credentials.update(p.provider,p.key);
        this.modelGenerations.set(p.provider,(this.modelGenerations.get(p.provider)||0)+1);
        this.capabilities[p.provider]={...status[p.provider],available:false,models:[],modelsStatus:'unknown',remoteRestricted:false,label:providerLabels[p.provider as Provider]};
        // Revoking a key also stops an in-flight tool loop before another request can leave.
        for(const s of this.store.sessions())if(s.provider===p.provider){if(busy(s))await this.stop(s.id);await this.disconnect(s.id);}
        this.changed(); return status[p.provider];
      }
      case 'elevenlabs.refresh': return this.elevenlabs.refresh();
      case 'elevenlabs.credentials': {
        this.speech.stop();await this.speech.idle();this.elevenlabs.reset();
        const status=this.credentials.update('elevenlabs',p.key);this.changed();return status.elevenlabs;
      }
      case 'settings.update': return this.updateSettings(p);
      case 'health.inspect': return healthReport(this);
      case 'diagnostics.preview': return this.diagnostics.preview();
      case 'diagnostics.export': return this.diagnostics.export(p.id,p.digest);
      case 'power.start': return this.power.start(p);
      case 'power.end': return this.power.end(p.id);
      case 'permissions.inspect': {
        const sessions=p.sessionId?[this.store.session(p.sessionId)]:this.store.snapshotSessions();
        return {paused:this.settings.paused,profile:this.settings.profile,categories:this.settings.categories,grants:this.settings.grants,
          persistent:{cli:this.settings.bypassCliPermissions,computer:this.settings.bypassComputerPermissions},
          providers:Object.entries(this.capabilities).map(([provider,value])=>({provider,...(value as object)})),power:this.power.snapshot(),
          effective:sessions.map(s=>{const lease=this.power.effective(s),persistentCli=!s.remote&&this.settings.bypassCliPermissions,persistentComputer=!s.remote&&this.settings.bypassComputerPermissions;return{sessionId:s.id,title:s.title,cwd:s.cwd,provider:s.provider,status:s.status,termination:s.error||'',...lease,persistentCli,persistentComputer,cli:persistentCli||lease.cli,computer:persistentComputer||lease.computer};}),
          warning:'Pause Cere actions blocks Cere tools. Stop provider ends the selected turn. CLI shell access is not sandboxed by Cere grants.'};
      }
      case 'permissions.revoke': return this.updateSettings({grants:this.settings.grants.filter(g=>g.category!==p.category||g.cwd!==p.cwd)});
      case 'transcription.status': return this.transcription.status();
      case 'transcription.start': {const session=this.store.session(p.sessionId);if(session.temporary)throw new Error('Voice drafts create temporary audio files. Use a saved conversation.');return this.transcription.start({sessionId:session.id});}
      case 'transcription.finish': return this.transcription.finish();
      case 'transcription.cancel': return this.transcription.cancel();
      case 'tts.test': return { queued: this.speech.speak(this.settings.ttsProvider==='indextts'?this.indextts.previewText(this.settings.indextts.profileId):ttsTestLine, true) };
      case 'tts.speak': { if(typeof p.text!=='string'||!p.text.trim()||p.text.length>20000)throw new Error('Select 1–20,000 characters to speak');return {queued:this.speech.speak(p.text,true)}; }
      case 'tts.stop': this.speech.stop(); return true;
      case 'tts.voices': return { voices: await listVoices(), directories: voiceDirectories() };
      case 'tts.status': return this.speech.snapshot();
      case 'indextts.status': return this.indextts.snapshot();
      case 'indextts.refresh': return this.indextts.refresh();
      case 'indextts.install': return this.indextts.install(p);
      case 'indextts.verify': return this.indextts.install({verify:true});
      case 'indextts.cancelDownload': return this.indextts.cancelDownload();
      case 'indextts.load': return this.indextts.load();
      case 'indextts.unload': this.speech.stop();await this.speech.idle();return this.indextts.unload();
      case 'indextts.saveVoice': return this.indextts.saveProfile(p);
      case 'indextts.deleteVoice': {
        this.speech.stop();await this.speech.idle();await this.indextts.deleteProfile(p.id);
        if(this.settings.indextts.profileId===p.id){this.settings.indextts={...this.settings.indextts,profileId:''};this.store.set('settings',this.settings);this.changed();}return true;
      }
      case 'indextts.preview': return {queued:this.speech.speak(this.indextts.previewText(p.profileId),true,undefined,undefined,{profileId:p.profileId})};
      case 'indextts.speak': {
        if(typeof p.text!=='string'||!p.text.trim()||p.text.length>8000)throw new IndexError('INVALID_CONFIG');
        return {queued:this.speech.speak(p.text,true,undefined,undefined,{profileId:p.profileId,language:p.language,emotion:p.emotion,durationFactor:p.durationFactor})};
      }
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
      case 'action.run': {if(p.name==='script.run'&&!isDeepStrictEqual(p.expectedScript,this.settings.scripts.find(s=>s.id===p.args?.id)))throw new Error('The executable action changed. Review it again.');return this.action(p.name,p.args || {});}
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
        const previous=this.attention[p.owner as 'ui'|'overlay'].sessionId;
        const prior=this.attention[p.owner as 'ui'|'overlay'];
        let mood=previous===p.sessionId?prior.mood:undefined;
        if ('mood' in p) {
          const authority=this.panels.ui?'ui':this.panels.overlay?'overlay':this.settings.topmost?'overlay':'ui';
          if(p.owner!==authority) throw new Error('Only the active expression host can publish tone');
          const sample=p.mood;
          if(!sample || !bodyMoodNames.has(sample.mood) || !Number.isFinite(sample.moodConfidence) || sample.moodConfidence<0 || sample.moodConfidence>1 || typeof sample.reactive!=='boolean' || typeof sample.messageId!=='string' || sample.messageId.length>256)
            throw new Error('Invalid settled mood');
          mood={mood:sample.mood,moodConfidence:sample.moodConfidence,reactive:sample.reactive,messageId:sample.messageId,time:Date.now()};
        }
        // Tone updates share this transport but never change composer attention.
        this.attention[p.owner as 'ui'|'overlay'] = { owner:p.owner, sessionId:p.sessionId, listening:'mood' in p?prior.listening:p.listening, ...(mood?{mood}:{}) };
        if(previous!==p.sessionId)this.changed();
        this.emit('ui', { command:'attention', ...this.attention[p.owner as 'ui'|'overlay'] }); return true;
      }
      case 'ui.quit': this.emit('ui',{command:'quit',stopTasks:!!p.stopTasks}); return true;
      case 'mcp.tools': {
        const id = this.tokens.get(p.token); if (!id) throw new Error('Session capability expired');
        return [...actionDefinitions.filter(d => categoryEnabled(this.settingsFor(id), d.category)), ...this.memoryToolsFor(id)];
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
          return answer.choice === 'allow' && (!answer.automatic || this.tokens.get(p.token) === id && this.automaticallyApprove(id,{kind,choices:['allow']})) ? { behavior:'allow', updatedInput:p.args.input || {} } : { behavior:'deny', message:'Declined in Cere or automatic permission was revoked' };
        }
        if (memoryDefinitions.some(d => d.name === p.name)) {
          const controller = new AbortController(), active = this.actionControllers.get(id) || new Set<AbortController>();
          active.add(controller); this.actionControllers.set(id, active);
          try { return await this.callTool(id, p.name.replaceAll('.', '_'), p.args, AbortSignal.any([controller.signal, this.memory.controller.signal])); }
          finally { active.delete(controller); if (!active.size && this.actionControllers.get(id) === active) this.actionControllers.delete(id); }
        }
        return this.action(p.name,p.args,id);
      }
      default: throw new Error('Unknown Cere method: '+method);
    }
  }
  async close() {
    this.closed = true;
    for (const session of this.store.sessions()) this.sendQueue.cancel(session.id, 'Cere closed before sending');
    await this.telemetry.close();
    this.workflows.close();this.utilities.close();await this.transcription.close();await this.power.close();
    const speechClosed = this.speech.close(); this.speechResponses.clear();
    this.memory.invalidate(); this.webController.abort(new Error('Cere is closing'));
    clearInterval(this.ticker); this.flush();
    for(const timer of this.stopTimers)clearTimeout(timer);this.stopTimers.clear();
    // Shutdown cancels owned work (captures, scripts, tool calls) and never waits unboundedly.
    for (const id of [...this.actionControllers.keys()]) this.abortActions(id, new Error('Cere is closing'));
    for (const turn of this.nativeMemoryTurns.values()) turn.controller.abort(new Error('Cere is closing'));
    this.nativeMemoryTurns.clear();
    for (const id of new Set([...this.approvals.values()].map(a => a.value.sessionId))) this.cancelApprovals(id);
    const bounded = (work: unknown[]) => Promise.race([Promise.allSettled(work), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    await bounded([...this.adapters.values()].map(a => a.close()));
    await bounded([...this.stopping.values()]);
    await bounded([...this.memoryCaptures]);
    for(const timer of this.stopTimers)clearTimeout(timer);this.stopTimers.clear();
    await this.memory.close();
    await speechClosed;
    this.elevenlabs.reset();
    await this.indextts.close();
    this.store.close();
  }
}
