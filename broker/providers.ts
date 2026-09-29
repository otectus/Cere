import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcProcess } from './wire.ts';
import type { Session, Adapter, ProviderEvent, Approval } from './types.ts';
import { paths } from './paths.ts';
import { cliBypassArgs } from './permissions.ts';
import { defaultPersonality, personalityInstructions } from './personality.ts';
export type Hooks = {
  event: (event: ProviderEvent) => void;
  native: (id: string) => void;
  approve: (approval: Omit<Approval, 'id' | 'sessionId' | 'time'>) => Promise<any>;
  token: string;
  bypassCliPermissions?: () => boolean;
  personality?: () => string;
};
const mcpPath = fileURLToPath(new URL('./mcp.ts', import.meta.url));
function mcpConfig(token: string) {
  return { command: process.execPath, args: [mcpPath], env: { CERE_RUNTIME_DIR: paths().runtime, CERE_SESSION_TOKEN: token } };
}
export class CodexAdapter implements Adapter {
  process!: RpcProcess; session: Session; hooks: Hooks; ready!: Promise<void>; turn = ''; intentional = false;
  appliedPersonality = '';
  normalPermissions: Record<string, any> = {};
  constructor(session: Session, hooks: Hooks) {
    this.session = session; this.hooks = hooks;
    this.launch(hooks.personality?.() ?? defaultPersonality);
  }
  launch(personality: string) {
    this.process = new RpcProcess(process.env.CERE_CODEX_BIN || 'codex', ['app-server'], this.session.cwd);
    this.process.on('fault', error => this.hooks.event({ type: 'error', text: error.message }));
    this.process.on('exit', code => { if (!this.intentional) this.hooks.event({ type: 'error', text: `Codex disconnected (${code ?? 'signal'}). Resume explicitly to continue.` }); });
    this.process.on('message', message => { void this.handle(message).catch(error => this.hooks.event({ type: 'error', text: error.message })); });
    this.ready = this.initialize(personality);
  }
  async initialize(personality: string) {
    await this.process.request('initialize', { clientInfo: { name: 'cere', title: 'Cere', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    this.process.write({ method: 'initialized', params: {} });
    // Resolve the configured policy afresh on resume: turn overrides persist in Codex.
    const { config } = await this.process.request('config/read', { cwd: this.session.cwd });
    const params: any = { cwd: this.session.cwd,
      approvalPolicy: config.approval_policy ?? 'on-request',
      approvalsReviewer: config.approvals_reviewer ?? 'user', sandbox: config.sandbox_mode ?? 'read-only',
      developerInstructions: [config.developer_instructions, personalityInstructions(personality)].filter(Boolean).join('\n\n'),
      config: { 'mcp_servers.cere': mcpConfig(this.hooks.token) } };
    if (this.session.model) params.model = this.session.model;
    if (this.session.nativeId) params.threadId = this.session.nativeId;
    const result = await this.process.request(this.session.nativeId ? 'thread/resume' : 'thread/start', params);
    this.normalPermissions = { approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer, sandboxPolicy: result.sandbox };
    this.session.nativeId = result.thread.id; this.hooks.native(result.thread.id);
    this.appliedPersonality = personality;
  }
  async handle(m: any) {
    const p = m.params || {};
    if (m.id !== undefined && m.method) {
      if (/requestApproval$/.test(m.method)) {
        let response: any;
        if (m.method === 'item/permissions/requestApproval') {
          const answer = await this.hooks.approve({ nativeRequestId:m.id, kind: 'permissions', title: 'Codex needs additional permissions', detail: JSON.stringify(p.permissions ?? p, null, 2), choices: ['allow', 'deny'] });
          response = { permissions: answer.choice === 'allow' ? p.permissions : {}, scope: 'turn' };
        } else if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
          const answer = await this.hooks.approve({ nativeRequestId:m.id, kind: 'provider', title: m.method.includes('fileChange') ? 'Allow file changes?' : 'Allow this command?', detail: [p.command, p.cwd, p.reason].filter(Boolean).join('\n'), choices: ['allow', 'deny', 'cancel'] });
          response = { decision: answer.choice === 'allow' ? 'accept' : answer.choice === 'cancel' ? 'cancel' : 'decline' };
        } else {
          this.process.write({ id: m.id, error: { code: -32601, message: 'Unsupported approval type; use the CLI to continue' } }); return;
        }
        if (!this.process.closed) this.process.write({ id: m.id, result: response });
      } else if (m.method === 'item/tool/requestUserInput') {
        const answer = await this.hooks.approve({ nativeRequestId:m.id, kind: 'question', title: 'Codex has a question', detail: '', choices: ['answer'], questions: p.questions });
        this.process.write({ id: m.id, result: { answers: answer.answers || {} } });
      } else if (m.method === 'mcpServer/elicitation/request') {
        const properties=p.requestedSchema?.properties || {};
        const supported=p.mode!=='url'&&Object.values(properties).every((v:any)=>['string','boolean','number','integer'].includes(v.type));
        if(!supported){
          this.hooks.event({type:'message',text:'This MCP request requires a form Cere cannot display. Continue it in the CLI.'});
          this.process.write({id:m.id,result:{action:'decline'}});return;
        }
        const questions=Object.entries(properties).map(([id,v]:[string,any])=>({id,question:v.title||v.description||id,options:v.enum?.map((label:string)=>({label}))||v.oneOf?.map((o:any)=>({label:o.const,description:o.title}))||(v.type==='boolean'?[{label:'true'},{label:'false'}]:undefined)}));
        const answer=await this.hooks.approve({nativeRequestId:m.id,kind:questions.length?'question':'provider',title:'MCP · '+p.serverName,detail:p.message,questions,fields:properties,choices:questions.length?['answer','deny']:['allow','deny']});
        const content:any={};
        if(answer.choice==='answer')for(const [key,v]of Object.entries(properties) as [string,any][]){
          const raw=answer.answers?.[key]?.answers?.[0];
          content[key]=v.type==='boolean'?raw==='true':['number','integer'].includes(v.type)?Number(raw):raw;
        }
        this.process.write({id:m.id,result:{action:['allow','answer'].includes(answer.choice)?'accept':'decline',content:questions.length?content:{}}});
      } else {
        this.hooks.event({type:'message',text:`Cere cannot handle this provider request yet: ${m.method}. Continue in the CLI.`});
        this.process.write({ id: m.id, error: { code: -32601, message: `Cere does not support ${m.method}` } });
      }
      return;
    }
    if (m.method === 'turn/started') { this.turn = p.turn.id; this.hooks.event({ type: 'status', text: 'working' }); }
    if (m.method === 'item/agentMessage/delta') this.hooks.event({ type: 'delta', id: p.itemId, text: p.delta });
    if (m.method === 'item/started' && p.item?.type === 'reasoning') this.hooks.event({ type: 'activity', text: 'thinking' });
    else if (m.method === 'item/started' && p.item?.type !== 'agentMessage' && p.item?.type !== 'userMessage') {
      this.hooks.event({ type: 'tool', id: p.item.id, text: p.item.command || p.item.tool || p.item.type, data: p.item });
    }
    if (m.method === 'item/completed') {
      if (p.item?.type === 'agentMessage') this.hooks.event({ type: 'message', id: p.item.id, text: p.item.text });
      else if (p.item?.type === 'reasoning') this.hooks.event({ type: 'activity', text: 'thinking' });
      else if (p.item?.type !== 'userMessage') this.hooks.event({ type: 'tool', id: p.item?.id, text: p.item?.aggregatedOutput || p.item?.command || p.item?.type, data: p.item });
    }
    if (m.method === 'turn/completed') {
      this.turn = '';
      const status = String(p.turn?.status || '').toLowerCase();
      if (status === 'completed' || status === 'succeeded') this.hooks.event({ type: 'complete', text: status });
      else if (['interrupted','cancelled','canceled','stopped'].includes(status)) this.hooks.event({ type: 'interrupted', text: p.turn?.error?.message || status });
      else this.hooks.event({ type: 'error', text: p.turn?.error?.message || (status ? `Codex turn ended with status ${status}` : 'Codex turn ended without a status') });
    }
    if (m.method === 'serverRequest/resolved') this.hooks.event({ type: 'approvalResolved', data: p });
    if (m.method === 'error' && !p.willRetry) this.hooks.event({ type: 'error', text: p.error?.message || 'Codex reported an error' });
  }
  async send(text: string, images: string[] = []) {
    const personality = this.hooks.personality?.() ?? defaultPersonality;
    await this.ready;
    if (personality !== this.appliedPersonality) {
      // Codex accepts free-form instructions only at thread start/resume. Resume
      // in a fresh process between turns; never interrupt work to change its voice.
      this.intentional = true;
      await this.process.close();
      this.intentional = false;
      this.launch(personality);
      await this.ready;
    }
    const input: any[] = [{ type: 'text', text, text_elements: [] }];
    for (const path of images) input.push({ type: 'localImage', path });
    const permissions = this.hooks.bypassCliPermissions?.()
      ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } } : this.normalPermissions;
    const params:any={ threadId: this.session.nativeId, input, ...permissions };
    if(this.session.effort)params.effort=this.session.effort;
    const r = await this.process.request('turn/start', params); this.turn = r.turn.id;
  }
  async interrupt() { await this.ready; if (this.turn) await this.process.request('turn/interrupt', { threadId: this.session.nativeId, turnId: this.turn }); }
  async close() { this.intentional = true; await this.process.close(); }
}
export class ClaudeAdapter implements Adapter {
  session: Session; hooks: Hooks; process?: RpcProcess; interrupted = false;
  constructor(session: Session, hooks: Hooks) { this.session = session; this.hooks = hooks; }
  async send(text: string, images: string[] = []) {
    if (images.length) text += '\n\nThe user explicitly attached these local image files. Read them if needed:\n' + images.join('\n');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__cere__approve', '--mcp-config', JSON.stringify({ mcpServers: { cere: mcpConfig(this.hooks.token) } })];
    if (this.hooks.bypassCliPermissions?.()) args.push(...cliBypassArgs('claude'));
    else args.push('--permission-mode', 'default'); // Do not inherit a resumed bypass mode.
    if (this.session.nativeId) args.push('--resume', this.session.nativeId);
    if (this.session.model) args.push('--model', this.session.model);
    if (this.session.effort) args.push('--effort', this.session.effort);
    this.interrupted = false;
    // User-authored personality text can be personal. Pass it in a private file,
    // not argv, and retain it only until this turn's provider process exits.
    const promptDirectory = mkdtempSync(join(tmpdir(), 'cere-personality-'));
    const promptPath = join(promptDirectory, 'system.txt');
    let proc: RpcProcess;
    try {
      writeFileSync(promptPath, personalityInstructions(this.hooks.personality?.() ?? defaultPersonality), { mode: 0o600 });
      args.push('--append-system-prompt-file', promptPath);
      proc = this.process = new RpcProcess(process.env.CERE_CLAUDE_BIN || 'claude', args, this.session.cwd);
    } catch (error) { rmSync(promptDirectory, { recursive: true, force: true }); throw error; }
    proc.on('exit', () => rmSync(promptDirectory, { recursive: true, force: true }));
    let resultSeen = false, messageId = randomUUID(), emittedPartial = false;
    proc.on('fault', error => this.hooks.event({ type: 'error', text: error.message }));
    proc.on('message', m => {
      if (m.session_id) { this.session.nativeId = m.session_id; this.hooks.native(m.session_id); }
      if (m.type === 'stream_event') {
        const e = m.event;
        if (e?.type === 'message_start') { messageId = e.message?.id || randomUUID(); emittedPartial = false; }
        if (e?.type === 'content_block_start' && e.content_block?.type === 'thinking' || e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') this.hooks.event({ type: 'activity', text: 'thinking' });
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') { emittedPartial = true; this.hooks.event({ type: 'delta', id: messageId, text: e.delta.text }); }
      }
      if (m.type === 'assistant') {
        const content = m.message?.content || [];
        const finalText = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        if (finalText) this.hooks.event({ type: 'message', id: emittedPartial ? messageId : m.message?.id || messageId, text: finalText });
        for (const tool of content.filter((c: any) => c.type === 'tool_use')) this.hooks.event({ type: 'tool', id: tool.id, text: tool.name + '\n' + JSON.stringify(tool.input, null, 2) });
      }
      if (m.type === 'user') for (const c of m.message?.content || []) {
        if (c.type === 'tool_result') {
          this.hooks.event({ type: 'tool', id: c.tool_use_id, text: typeof c.content === 'string' ? c.content : JSON.stringify(c.content) });
          this.hooks.event({ type: 'activity', text: 'thinking' });
        }
      }
      if (m.type === 'result') {
        resultSeen = true;
        this.hooks.event(this.interrupted
          ? { type: 'interrupted', text: 'interrupted' }
          : { type: m.is_error ? 'error' : 'complete', text: m.is_error ? (m.errors?.join('\n') || m.result || m.subtype) : '' });
      }
    });
    proc.on('exit', code => {
      if (this.process === proc) this.process = undefined;
      if (!resultSeen) this.hooks.event({ type: this.interrupted ? 'interrupted' : 'error', text: this.interrupted ? 'interrupted' : `Claude exited (${code ?? 'signal'}) before returning a result. Check CLI authentication and project configuration.` });
    });
    // Print mode consumes plain stdin; keep user messages out of process listings.
    proc.child.stdin.end(text);
  }
  async interrupt() { this.interrupted = true; this.process?.child.kill('SIGINT'); }
  async close() { if (this.process) { this.interrupted = true; await this.process.close(); } }
}
