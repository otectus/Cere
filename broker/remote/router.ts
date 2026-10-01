import { randomUUID, createHmac } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { Core } from '../core.ts';
import type { Session, Approval } from '../types.ts';
import { ordinarySettings, remoteError, busy } from '../execution.ts';
import type { RemoteExecution } from '../execution.ts';
import { categoryEnabled } from '../permissions.ts';
import { actionDefinitions, validateAction, applications, windows, audioStatus, mediaStatus, desktopAction } from '../desktop.ts';
import { ollamaHost, ollamaModels } from '../ollama.ts';
import { digest } from './crypto.ts';
import type { Device, Project } from './store.ts';
import { RemoteStore } from './store.ts';
import { MediaStore } from './media.ts';
import { readFile } from 'node:fs/promises';
import { bytesDigest } from './crypto.ts';
import { mobilePage, mobilePart } from './transcript.ts';
import { Parity } from './parity.ts';

export class Router {
  core:Core;registry:RemoteStore;revoke:(id:string)=>Promise<void>;
  actions=new Map<string,{deviceId:string;controller:AbortController;check:()=>void}>();
  media:MediaStore;
  parity:Parity;
  scopeReduced?:(id:string)=>void;
  constructor(core:Core,registry:RemoteStore,revoke:(id:string)=>Promise<void>) {this.core=core;this.registry=registry;this.revoke=revoke;this.media=new MediaStore(this);this.parity=new Parity(this);}
  abortActions(deviceId?:string) {for(const action of this.actions.values())if(!deviceId||action.deviceId===deviceId)action.controller.abort(remoteError('AUTH_REVOKED','Remote action authority revoked.'));}
  recheckActions() {for(const action of this.actions.values())try{action.check();}catch(error){action.controller.abort(error);}}
  current(device:Device) {
    const current=this.registry.live(device.id);
    if(!current)throw remoteError('AUTH_REVOKED','Device access expired or was revoked.');
    if(!this.registry.config().enabled)throw remoteError('REMOTE_DISABLED','The owner disabled remote access.');
    if(current.scopeVersion!==device.scopeVersion)throw remoteError('SCOPE_CHANGED','Device grants changed. Reconnect to refresh.');
    return current;
  }
  require(device:Device,cap:string) {this.current(device);if(!device.caps.includes(cap))throw remoteError('SCOPE_DENIED','This device is not granted '+cap);}
  ollamaAllowed(device:Device,host:string) {let wanted:string;try{wanted=ollamaHost(host);}catch{return false;}return (device.ollamaHosts||[]).some(value=>{try{return ollamaHost(value)===wanted;}catch{return false;}});}
  providerAccess(device:Device,id:string,p:any) {
    if(!['ollama','codex','claude'].includes(id))return {remoteExecution:false,remoteUnavailableReason:'This provider is currently available on the desktop only.'};
    if(id==='ollama'&&!this.ollamaAllowed(device,this.core.settings.ollama.host))return {remoteExecution:false,remoteUnavailableReason:'This device is not granted the desktop Ollama server. Update device access on the desktop.'};
    if(id!=='ollama'&&!device.caps.includes('providers.execute'))return {remoteExecution:false,remoteUnavailableReason:'Native provider execution is not granted to this device.'};
    if(id==='claude'&&p.remoteRestricted!==true)return {remoteExecution:false,remoteUnavailableReason:'Update Claude Code to a version with restricted mode before using it remotely.'};
    const remoteExecution=['ollama','codex','claude'].includes(id);
    return p.available===true?{remoteExecution}:{remoteExecution,remoteUnavailableReason:id==='ollama'?'Ollama is unavailable on the desktop. Refresh models after checking the configured server.':'Provider is unavailable on the desktop.'};
  }
  project(device:Device,id:string):Project {this.current(device);const p=device.projects.find(p=>p.id===id);if(!p)throw remoteError('SCOPE_DENIED','Project is not granted to this device.');return p;}
  inScope(device:Device,s:Session) {return !s.temporary&&device.projects.some(p=>p.path===s.cwd)&&(s.provider!=='ollama'||this.ollamaAllowed(device,s.ollama?.host||''));}
  session(device:Device,id:string) {
    this.require(device,'chat.read');
    const s=this.core.store.sessions().find(s=>s.id===id&&this.inScope(device,s));
    if(!s)throw remoteError('SCOPE_DENIED','Session is not available to this device.');return s;
  }
  execution(device:Device,project?:Project):RemoteExecution {return {deviceId:device.id,projectId:project?.id||'',scopeVersion:device.scopeVersion,expiresAt:device.expiresAt,caps:[...device.caps],categories:[...device.categories],scriptIds:[...device.scriptIds],memoryHosts:[...device.ollamaHosts||[]]};}
  sessionDto(device:Device,s:Session,includeDraft=true) {
    const p=device.projects.find(p=>p.path===s.cwd)!;
    const restrictedProvider=['ollama','codex','claude'].includes(s.provider)&&(s.provider!=='claude'||this.core.capabilities.claude?.remoteRestricted===true);
    const folder=s.folderId?this.core.store.folders().find(folder=>folder.id===s.folderId):undefined,draftAttachmentCount=s.draftAttachments?.length||0;
    return {id:s.id,provider:s.provider,title:s.title.slice(0,100),projectId:p.id,project:p.path,mode:s.mode,status:s.status,model:s.model,effort:s.effort||'',draft:includeDraft?s.draft:'',draftIncluded:includeDraft,draftRevision:s.draftRevision||'0',configRevision:s.configRevision||'0',revision:s.revision||'0',turnId:s.turnId,remoteRestricted:!!s.remote,
      canSend:restrictedProvider&&device.caps.includes('chat.write')&&(s.provider==='ollama'||device.caps.includes('providers.execute'))&&s.mode==='managed'&&(!s.remote||s.remote.deviceId===device.id),
      canConfigure:this.canConfigure(device,s),pinned:!!s.pinned,archived:!!s.archived,unread:!!s.unread,readAt:s.readAt??0,folderId:s.folderId??null,folderName:folder?.name??null,draftAttachmentCount,draftAttachmentHint:draftAttachmentCount?`${draftAttachmentCount} desktop draft attachment${draftAttachmentCount===1?' is':'s are'} waiting. Review or send from the desktop.`:null,
      updated:s.updated,activity:s.activity,agents:(s.agents || []).map(a=>({...a,task:a.task?.slice(0,1000),detail:a.detail?.slice(0,2000)})),parentId:s.parentId,tools:s.ollama?.tools||false,ollamaHost:s.provider==='ollama'?s.ollama?.host:undefined,error:s.error?'The desktop provider reported an error. Review Activity.':undefined};
  }
  canConfigure(device:Device,s:Session) {
    const supported=s.provider==='ollama'?this.ollamaAllowed(device,s.ollama?.host||''):s.provider==='codex'||s.provider==='claude'&&this.core.capabilities.claude?.remoteRestricted===true;
    const activeAgents=s.agents?.some(agent=>['starting','running','waiting'].includes(agent.status));
    const awaitingApproval=[...this.core.approvals.values()].some(approval=>approval.value.sessionId===s.id);
    return supported&&device.caps.includes('chat.write')&&(s.provider==='ollama'||device.caps.includes('providers.execute')&&!this.core.settings.paused)&&s.mode==='managed'&&!busy(s)&&!activeAgents&&!awaitingApproval&&s.remote?.deviceId===device.id;
  }
  approval(device:Device,id:string) {
    this.require(device,'approvals.answer');const a=this.core.approvals.get(id)?.value;
    if(!a)throw remoteError('APPROVAL_GONE','This request has already ended.');
    const session=this.session(device,a.sessionId);return {a,session};
  }
  approvalDto(device:Device,a:Approval) {
    const session=this.session(device,a.sessionId);
    const provider=['provider','permissions','cli'].includes(a.kind);
    const canAnswer=!!session.remote&&session.remote.deviceId===device.id&&session.effectivePolicy==='restricted'&&a.remoteAllow!==false&&(a.kind!=='image'||session.provider==='ollama'&&device.caps.includes('capture.preview'))&&(!provider||device.caps.includes('approvals.provider'));
    const base={id:a.id,sessionId:a.sessionId,kind:a.kind,title:a.title,detail:a.detail,...(a.url?{url:a.url}:{}),...(a.nativeThreadId?{nativeThreadId:a.nativeThreadId}:{}),choices:a.choices,questions:a.questions||[],fields:a.fields||{},time:a.time,revision:'1',turnId:session.turnId||''};
    const large=Buffer.byteLength(JSON.stringify(base))>64000;
    return {...base,...(large?{title:a.title.slice(0,200),detail:'This proposal is too large for mobile review. Review it on the desktop.',questions:[],fields:{}}:{}),digest:digest(base),canAnswer:canAnswer&&!large};
  }
  cursor(device:Device) {
    // Do not reveal another device's event count or global sequence.
    const payload=Buffer.from(JSON.stringify({device:device.id,scope:device.scopeVersion,epoch:this.registry.epoch,seq:this.registry.highWater(device.id)})).toString('base64url');
    // A HMAC-only cursor is opaque and deliberately resumes through an authoritative snapshot.
    return createHmac('sha256',this.core.store.get('remoteCursorKey','')).update(payload).digest('base64url');
  }
  permissions(device:Device) { const s=ordinarySettings(this.core.settings,this.execution(device,device.projects[0]));return {profile:s.profile,paused:s.paused,categories:s.categories,caps:device.caps,revision:this.core.store.get('settingsRevision','0'),restricted:true,grants:s.grants.filter(g=>device.projects.some(p=>p.path===g.cwd))}; }
  settings(device:Device) {this.current(device);const ollamaAllowed=this.ollamaAllowed(device,this.core.settings.ollama.host);return {personality:this.core.settings.personality,revision:this.core.store.get('settingsRevision','0'),webSearch:{enabled:this.core.settings.webSearch.enabled&&device.caps.includes('web'),provider:this.core.settings.webSearch.provider},defaultModel:ollamaAllowed?this.core.settings.ollama.model:'',ollamaHost:ollamaAllowed?ollamaHost(this.core.settings.ollama.host):''};}
  messages(device:Device,id:string,before?:string,limit=100) {
    this.session(device,id);return mobilePage(this.core.store,id,before,limit);
  }
  snapshot(device:Device,selected?:string) {
    this.require(device,'chat.read');
    const sessions=this.core.store.sessions().filter(s=>this.inScope(device,s));
    const ids=new Set(sessions.map(s=>s.id));
    const initial=sessions.slice(0,50),selectedSession=sessions.find(s=>s.id===selected);
    if(selectedSession&&!initial.some(s=>s.id===selected))initial.push(selectedSession);
    const messagePage=selectedSession?this.messages(device,selectedSession.id):{items:[],before:null};
    const snapshot={cursor:this.cursor(device),cacheEpoch:this.core.store.get('transcriptEpoch',this.registry.epoch),sessionIds:sessions.map(s=>s.id),nextSessionOffset:sessions.length>50?50:null,sessions:initial.map(s=>this.sessionDto(device,s,s.id===selected)),projects:device.projects,
      approvals:device.caps.includes('approvals.answer')?[...this.core.approvals.values()].filter(a=>ids.has(a.value.sessionId)).map(a=>this.approvalDto(device,a.value)):[],
      providers:Object.fromEntries(Object.entries(this.core.capabilities).map(([id,p]:[string,any])=>{const access=this.providerAccess(device,id,p),allowed=id==='ollama'?this.ollamaAllowed(device,this.core.settings.ollama.host):device.caps.includes('providers.execute');return [id,{available:p.available===true,models:allowed?p.models||[]:[],modelsStatus:allowed?p.modelsStatus||'unknown':'unavailable',...access}];})),
      permissions:this.permissions(device),settings:this.settings(device),messages:messagePage.items,messagesBefore:messagePage.before};
    // Reserve room for request/event envelopes. Extra history remains pageable.
    const tooLarge=()=>Buffer.byteLength(JSON.stringify(snapshot))>1024*1024-4096;
    while(tooLarge()&&snapshot.messages.length){snapshot.messages.shift();snapshot.messagesBefore=snapshot.messages[0]?.id??null;}
    while(tooLarge()&&snapshot.sessions.length>1){const index=snapshot.sessions.findLastIndex(s=>s.id!==selected);if(index<0)break;snapshot.sessions.splice(index,1);snapshot.nextSessionOffset=Math.min(snapshot.nextSessionOffset??50,index);}
    if(tooLarge())snapshot.approvals=snapshot.approvals.map(a=>({...a,detail:'Review this pending request on the desktop.',questions:[],fields:{},canAnswer:false}));
    if(tooLarge())throw remoteError('LIMIT_EXCEEDED','The desktop snapshot exceeds this protocol version’s limit.');
    return snapshot;
  }
  category(device:Device,projectId:string,category:string) {
    this.require(device,'desktop.control');const project=this.project(device,projectId),settings=ordinarySettings(this.core.settings,this.execution(device,project));
    if(settings.paused)throw remoteError('POLICY_PAUSED','Desktop actions are paused.');
    if(!categoryEnabled(settings,category))throw remoteError('CATEGORY_DISABLED','This desktop category is disabled.');
    return {project,settings};
  }
  async dispatch(device:Device,method:string,p:any,commandId?:string):Promise<any> {
    return this.core.withMutation(()=>this.dispatchInner(device,method,p,commandId));
  }
  private async dispatchInner(device:Device,method:string,p:any,commandId?:string):Promise<any> {
    this.current(device);
    switch(method) {
      case 'sync.open':return this.snapshot(device,p.selectedSessionId);
      case 'sync.ack':return true;
      case 'projects.list':this.require(device,'chat.read');return device.projects;
      case 'sessions.list': {
        this.require(device,'chat.read');const sessions=this.core.store.sessions().filter(s=>this.inScope(device,s)&&(!p.filter||`${s.title} ${s.provider} ${s.cwd}`.toLowerCase().includes(p.filter.toLowerCase())));
        return {items:sessions.slice(p.offset,p.offset+50).map(s=>this.sessionDto(device,s,false)),nextOffset:sessions.length>p.offset+50?p.offset+50:null};
      }
      case 'sessions.get':return this.sessionDto(device,this.session(device,p.sessionId));
      case 'sessions.messages':return this.messages(device,p.sessionId,p.before,p.limit);
      case 'sessions.messagePart':this.session(device,p.sessionId);return mobilePart(this.core.store,p);
      case 'sessions.create': {
        this.require(device,'chat.write');const project=this.project(device,p.projectId);
        if(p.provider!=='ollama')this.require(device,'providers.execute');
        if(p.provider==='claude'&&this.core.capabilities.claude?.remoteRestricted!==true)throw remoteError('PROVIDER_POLICY_UNSAFE','This Claude Code version cannot enforce Cere restricted mode. Update Claude Code on the desktop.');
        const host=p.provider==='ollama'?ollamaHost(this.core.settings.ollama.host):'';
        const check=()=>{this.current(device);if(p.provider==='ollama'&&(!this.ollamaAllowed(device,host)||ollamaHost(this.core.settings.ollama.host)!==host))throw remoteError('SCOPE_DENIED','The desktop Ollama server changed. Update device scopes locally.');};check();
        const session=await this.core.create({...p,cwd:project.path,trusted:true,...(host?{ollamaHost:host}:{})},check,{remote:this.execution(device,project),effectivePolicy:['ollama','claude'].includes(p.provider)?'restricted':'unknown',...(p.handoffDraft!==undefined?{draft:p.handoffDraft}:{})});
        return this.sessionDto(device,session);
      }
      case 'sessions.send': {
        this.require(device,'chat.write');const session=this.session(device,p.sessionId);
        if(!this.sessionDto(device,session).canSend)throw remoteError('PROVIDER_POLICY_UNSAFE','Stop and attach a supported restricted session before sending.');
        if(p.attachments.length)this.require(device,'attachments.write');
        const images=this.media.resolve(device,session.id,p.attachments);
        if(busy(session))throw remoteError('SESSION_BUSY','This session is busy.');
        if(device.caps.includes('web')===false&&p.webSearch)throw remoteError('SCOPE_DENIED','Web search is not granted.');
        if(this.core.store.sessions().filter(s=>s.remote?.deviceId===device.id&&busy(s)).length>=2)throw remoteError('RATE_LIMITED','Two remote turns are already active.');
        const turnId=randomUUID(),project=device.projects.find(pr=>pr.path===session.cwd)!;
        let accepting=false;
        try {
          await this.core.sendRemote({...p,id:session.id,turnId,images},this.execution(device,project),()=>this.current(device),()=>{accepting=true;},()=>{this.media.submitted(device,p.attachments);},()=>{accepting=false;});
          const result={commandId,status:'accepted',turnId};this.registry.finish(device.id,commandId!,{status:'completed',result});return result;
        } catch(error:any) {
          if(accepting||error?.code==='OUTCOME_UNKNOWN')throw remoteError('OUTCOME_UNKNOWN','The provider may have accepted this turn. Reconcile its status before sending again.');
          throw error;
        }
      }
      case 'sessions.stop':this.session(device,p.sessionId);return this.core.stop(p.sessionId);
      case 'sessions.disconnect':this.require(device,'chat.write');this.session(device,p.sessionId);return this.core.disconnect(p.sessionId);
      case 'sessions.rename': {
        this.require(device,'chat.write');const s=this.session(device,p.sessionId);
        if((s.revision||'0')!==p.expectedRevision)throw remoteError('REVISION_CONFLICT','Session changed. Review its current title.');
        return this.sessionDto(device,this.core.updateSession(s.id,{title:p.title}));
      }
      case 'sessions.organize': {
        this.require(device,'chat.write');const s=this.session(device,p.sessionId);
        if((s.revision||'0')!==p.expectedRevision)throw remoteError('REVISION_CONFLICT','Session changed. Review its organization.');
        if((p.pinned===undefined||p.pinned===!!s.pinned)&&(p.archived===undefined||p.archived===!!s.archived))throw remoteError('INVALID_ARGUMENT','Choose a session organization change.');
        const organized=await this.core.rpc('session.organize',{id:s.id,expectedRevision:p.expectedRevision,...(p.pinned===undefined?{}:{pinned:p.pinned}),...(p.archived===undefined?{}:{archived:p.archived})});
        return this.sessionDto(device,organized);
      }
      case 'drafts.get': {const s=this.session(device,p.sessionId);return {text:s.draft,revision:s.draftRevision||'0'};}
      case 'drafts.put': {this.require(device,'chat.write');const current=this.session(device,p.sessionId);if(current.draftAttachments?.length&&p.text!==current.draft)throw remoteError('REVISION_CONFLICT','This desktop draft has attachments. Edit it from the desktop or remove those attachments first.');const s=this.core.draft(p.sessionId,p.text,p.expectedRevision);return {text:s.draft,revision:s.draftRevision||'0'};}
      case 'providers.models': {
        this.require(device,'chat.read');const session=p.sessionId?this.session(device,p.sessionId):undefined;
        if(session&&session.provider!==p.provider)throw remoteError('INVALID_ARGUMENT','Choose this session’s provider.');
        if(p.provider!=='ollama')this.require(device,'providers.execute');
        const host=session?.ollama?.host||this.core.settings.ollama.host;
        if(p.provider==='ollama'&&!this.ollamaAllowed(device,host))throw remoteError('SCOPE_DENIED','This Ollama server is not granted to the device.');
        const currentOllama=p.provider==='ollama'&&ollamaHost(this.core.settings.ollama.host)===ollamaHost(host);
        const models=currentOllama?await this.core.refreshProviderModels('ollama'):p.provider==='ollama'?await ollamaModels(host):await this.core.refreshProviderModels(p.provider);this.current(device);return models;
      }
      case 'sessions.configure': {
        this.require(device,'chat.write');const s=this.session(device,p.sessionId);
        if(!this.canConfigure(device,s))throw remoteError('PROVIDER_POLICY_UNSAFE','This session cannot be configured from this device while it is active, detached, or outside restricted provider policy.');
        if((s.configRevision||'0')!==p.expectedConfigRevision)throw remoteError('REVISION_CONFLICT','Session configuration changed.');
        const project=device.projects.find(project=>project.path===s.cwd)!,execution=this.execution(device,project);
        return this.sessionDto(device,await this.core.configureSession({id:s.id,model:p.model,effort:p.effort,tools:p.tools,trusted:true,expectedConfigRevision:p.expectedConfigRevision},()=>{this.current(device);const current=this.session(device,s.id);if(!this.canConfigure(device,current))throw remoteError('AUTH_REVOKED','Remote configuration authority changed.');if((current.configRevision||'0')!==p.expectedConfigRevision)throw remoteError('REVISION_CONFLICT','Session configuration changed.');},execution));
      }
      case 'approvals.list':return this.snapshot(device).approvals;
      case 'approvals.get':return this.approvalDto(device,this.approval(device,p.approvalId).a);
      case 'approvals.preview':return this.media.preview(device,p);
      case 'attachments.begin':return this.media.begin(device,p);
      case 'attachments.status':return this.media.dto(this.media.get(device,p.attachmentId));
      case 'attachments.commit':return this.media.commit(device,p);
      case 'attachments.abort':return this.media.abort(device,p.attachmentId);
      case 'attachments.read':return this.media.read(device,p);
      case 'approvals.answer': {
        const {a,session}=this.approval(device,p.approvalId),dto=this.approvalDto(device,a);
        let verifiedImage:Buffer|undefined;
        if(dto.revision!==p.revision||dto.digest!==p.digest)throw remoteError('REVISION_CONFLICT','This proposal changed; review it again.');
        if(!['deny','cancel'].includes(p.choice)) {
          if(!dto.canAnswer)throw remoteError('PROVIDER_POLICY_UNSAFE','This request needs desktop review.');
          this.core.settingsFor(session.id);if(this.core.settings.paused)throw remoteError('POLICY_PAUSED','Desktop actions are paused.');
          if(a.kind==='image') {
            if(!p.imageDigest||!a.image||!this.media.previewReviewed(device,a.id,p.imageDigest))throw remoteError('REVISION_CONFLICT','Review the current capture before sharing.');
            verifiedImage=await readFile(a.image);
            if(bytesDigest(verifiedImage)!==p.imageDigest)throw remoteError('REVISION_CONFLICT','Review the current capture before sharing.');
            this.current(device);if(this.core.approvals.get(a.id)?.value!==a)throw remoteError('APPROVAL_GONE','Capture request ended.');this.core.settingsFor(session.id);
          }
          if(this.core.settings.paused)throw remoteError('POLICY_PAUSED','Desktop actions are paused.');
          if(!this.approvalDto(device,a).canAnswer)throw remoteError('PROVIDER_POLICY_UNSAFE','This request needs desktop review.');
        }
        return this.core.answer({id:a.id,choice:p.choice,answers:p.answers,...(verifiedImage?{verifiedImage}:{})});
      }
      case 'commands.status':return this.registry.status(device.id,p.commandId);
      case 'activity.list':this.session(device,p.sessionId);return mobilePage(this.core.store,p.sessionId,undefined,p.limit,true).items;
      case 'permissions.get':return this.permissions(device);
      case 'permissions.pause':await this.core.updateSettings({paused:true});return true;
      case 'devices.self':return {id:device.id,name:device.name,expiresAt:device.expiresAt,scopeVersion:device.scopeVersion,caps:device.caps,categories:device.categories,scriptIds:device.scriptIds,projects:device.projects,ollamaHosts:device.ollamaHosts};
      case 'permissions.reduce': {
        const current=this.current(device);if(p.expectedScopeVersion!==current.scopeVersion)throw remoteError('REVISION_CONFLICT','Device access changed. Review it again.');
        const subset=(requested:unknown,granted:string[])=>{if(requested===undefined)return [...granted];if(!Array.isArray(requested)||requested.some(v=>typeof v!=='string'||!granted.includes(v)))throw remoteError('SCOPE_DENIED','Mobile permission changes can only remove existing access.');return [...new Set(requested)] as string[];};
        const projectIds=subset(p.projectIds,current.projects.map(project=>project.id));
        const next={...current,caps:subset(p.caps,current.caps),categories:subset(p.categories,current.categories),scriptIds:subset(p.scriptIds,current.scriptIds),projects:current.projects.filter(project=>projectIds.includes(project.id)),ollamaHosts:subset(p.ollamaHosts,current.ollamaHosts||[]),expiresAt:p.expiresAt??current.expiresAt,scopeVersion:String(BigInt(current.scopeVersion)+1n)};
        if(!Number.isSafeInteger(next.expiresAt)||next.expiresAt<=Date.now()||next.expiresAt>current.expiresAt)throw remoteError('SCOPE_DENIED','Expiry can only be shortened.');
        this.registry.saveDevice(next);this.abortActions(device.id);
        this.registry.audit({deviceId:device.id,operation:'permissions.reduce',decision:'reduced',scopeVersion:next.scopeVersion});
        setImmediate(()=>this.scopeReduced?.(device.id));
        return{scopeVersion:next.scopeVersion,reconnectRequired:true,caps:next.caps,categories:next.categories,scriptIds:next.scriptIds,projectIds:next.projects.map(project=>project.id),ollamaHosts:next.ollamaHosts,expiresAt:next.expiresAt};
      }
      case 'devices.selfRevoke':setImmediate(()=>void this.revoke(device.id));return true;
      case 'settings.get':this.require(device,'chat.read');return this.settings(device);
      case 'settings.patch': {
        this.require(device,'settings.write');if(this.core.store.get('settingsRevision','0')!==p.expectedRevision)throw remoteError('REVISION_CONFLICT','Settings changed. Reload before saving.');
        if(p.defaultModel!==undefined&&!this.ollamaAllowed(device,this.core.settings.ollama.host))throw remoteError('SCOPE_DENIED','This Ollama server is not granted to the device.');
        await this.core.updateSettings({...(p.personality!==undefined?{personality:p.personality}:{}),...(p.defaultModel!==undefined?{ollama:{...this.core.settings.ollama,model:p.defaultModel}}:{}),...(p.searchProvider!==undefined?{webSearch:{...this.core.settings.webSearch,provider:p.searchProvider}}:{})});return this.settings(device);
      }
      case 'desktop.apps': {this.category(device,p.projectId,'apps');const apps=await applications();this.category(device,p.projectId,'apps');return apps;}
      case 'desktop.windows': {this.category(device,p.projectId,'windows');const items=await windows();this.category(device,p.projectId,'windows');return items.map((w:any)=>({address:w.address,title:w.title,app:w.class,workspace:w.workspace?.id}));}
      case 'desktop.status': {
        this.require(device,'desktop.control');const project=this.project(device,p.projectId),settings=ordinarySettings(this.core.settings,this.execution(device,project)),has=(c:string)=>categoryEnabled(settings,c);
        const result={audio:has('audio')?await audioStatus():{available:false},media:has('media')?await mediaStatus().catch(()=>({available:false})):{available:false},
          timers:has('timers')?this.core.store.timers().filter(t=>t.remoteProjectId===project.id):[],scripts:has('scripts')?settings.scripts.map(s=>({...s,definitionDigest:digest(s)})):[],actions:actionDefinitions.filter(d=>has(d.category)&&d.category!=='capture')};
        for(const category of settings.categories)if(has(category))this.category(device,p.projectId,category);return result;
      }
      case 'desktop.execute': {
        const def=validateAction(p.action,p.args),{project,settings}=this.category(device,p.projectId,def.category);
        if([...this.actions.values()].filter(a=>a.deviceId===device.id).length>=1)throw remoteError('RATE_LIMITED','Wait for this device’s active desktop action.');
        const controller=new AbortController(),executionId=randomUUID();
        const check=()=>{controller.signal.throwIfAborted();const current=this.category(device,p.projectId,def.category).settings;if(p.action==='script.run'&&digest(current.scripts.find(s=>s.id===p.args.id))!==p.definitionDigest)throw remoteError('REVISION_CONFLICT','The saved script changed.');if(p.action==='files.open'){const path=realpathSync(p.args.path),rel=relative(project.path,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw remoteError('SCOPE_DENIED','File is outside the approved project.');p.args.path=path;}};
        this.actions.set(executionId,{deviceId:device.id,controller,check});
        try {
        if(def.category==='capture')throw remoteError('SCOPE_DENIED','Capture preview has not been enabled by this gateway.');
        if(p.action==='files.open') {const path=await realpath(p.args.path),rel=relative(project.path,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw remoteError('SCOPE_DENIED','File is outside this approved project.');p.args={path};}
        if(p.action==='script.run') {const script=settings.scripts.find(s=>s.id===p.args.id);if(!script||digest(script)!==p.definitionDigest)throw remoteError('REVISION_CONFLICT','Saved script changed or is not granted.');}
        if(p.action==='media.control'&&!p.args.player)throw remoteError('INVALID_ARGUMENT','Choose the exact media player shown during review.');
        if(p.action.startsWith('windows.')&&p.args.address&&!(await windows()).some((w:any)=>w.address===p.args.address))throw remoteError('DESKTOP_UNAVAILABLE','That window no longer exists.');
        const current=this.category(device,p.projectId,def.category).settings;
        if(p.action==='script.run'&&digest(current.scripts.find(s=>s.id===p.args.id))!==p.definitionDigest)throw remoteError('REVISION_CONFLICT','Script changed during review.');
        if(p.action==='timer.start') {const timer={id:randomUUID(),label:p.args.label||'Timer',due:Date.now()+p.args.minutes*60000,remoteProjectId:project.id};this.core.store.timer(timer);this.core.changed();return timer;}
        const result=await desktopAction(p.action,p.args,current,controller.signal,check);if(def.readOnly)check();return result;
        } finally {this.actions.delete(executionId);}
      }
      case 'timers.cancel': {this.category(device,p.projectId,'timers');if(!this.core.store.timers().some(t=>t.id===p.timerId&&t.remoteProjectId===p.projectId))throw remoteError('SCOPE_DENIED','Timer is not available in this project.');this.core.store.removeTimer(p.timerId);this.core.changed();return true;}
      case 'memory.list':case 'memory.retrieve':case 'memory.save': {
        this.require(device,method==='memory.save'?'memory.write':'memory.read');const session=this.session(device,p.sessionId);if(session.provider!=='ollama')throw remoteError('SCOPE_DENIED','Memory requires an Ollama session.');
        if([...this.actions.values()].some(a=>a.deviceId===device.id))throw remoteError('RATE_LIMITED','Wait for this device’s active operation.');
        const controller=new AbortController(),check=()=>{this.current(device);if(this.core.settings.paused||!this.core.settings.memory.enabled)throw remoteError('POLICY_PAUSED','Memory is disabled or paused.');controller.signal.throwIfAborted();};
        check();const executionId=randomUUID();this.actions.set(executionId,{deviceId:device.id,controller,check});
        try {
        const result=method==='memory.list'?await this.core.memory.list(session,p.kind,p.offset,p.filter):method==='memory.retrieve'?await this.core.memory.recall(session,p.query,controller.signal):await this.core.memory.save(session,p.text,p.id,p.expectedRevision===undefined?undefined:Number(p.expectedRevision),false,controller.signal,check);
        if(method==='memory.save')return result;
        check();if(result&&typeof result==='object'){const {host,...safe}=result as any;return safe;}return result;
        } finally {this.actions.delete(executionId);}
      }
      default:return this.parity.dispatch(device,method,p);
    }
  }
}
export function safeError(error:any) {
  const code=typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'INVALID_ARGUMENT';
  const messages:Record<string,string>={INVALID_ARGUMENT:'The request could not be completed. Review the input and desktop diagnostics.',PROVIDER_POLICY_UNSAFE:'Provider restrictions could not be verified. Continue on the desktop.',REVISION_CONFLICT:'The resource changed. Reload and review before trying again.',SCOPE_DENIED:'This device does not have access to that operation.',SESSION_BUSY:'This session is busy. Stop it or wait.',APPROVAL_GONE:'This request has already ended.',AUTH_REVOKED:'Device access expired or was revoked.',OUTCOME_UNKNOWN:'The outcome is unknown; it will not be replayed.',CATEGORY_DISABLED:'This desktop category is disabled.',POLICY_PAUSED:'Desktop actions are paused.',IDEMPOTENCY_CONFLICT:'This command ID belongs to different input.'};
  return {code,message:messages[code]||'The desktop could not complete this operation.',retryable:false};
}
