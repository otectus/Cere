import { z } from 'zod';

export const uuid=z.uuid(), revision=z.string().regex(/^(0|[1-9][0-9]{0,18})$/), hash=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// A phone names any provider it may run; whether it may run it is decided by the device's grants.
const str=z.string().max(4096),sessionId=uuid,projectId=uuid,provider=z.enum(['codex','claude','ollama','openai','anthropic','google','compatible']),empty=z.strictObject({});
const memoryRevision=z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(value=>BigInt(value)<=BigInt(Number.MAX_SAFE_INTEGER),'Memory revision exceeds exact integer range');
export const helloSchema=z.strictObject({v:z.literal(1),type:z.literal('hello'),protocolMin:z.number().int().min(0),protocolMax:z.number().int().min(0),desktopId:uuid,deviceId:uuid,keyVersion:z.literal(1),clientNonce:hash,appVersion:z.string().max(32)});
export const requestSchema=z.strictObject({v:z.literal(1),type:z.literal('request'),id:uuid,method:z.string().max(64),params:z.record(z.string(),z.unknown()),commandId:uuid.optional(),proof:z.strictObject({challengeId:uuid,signature:z.string().max(100)}).optional()});
export const methods:Record<string,z.ZodType>={
  'sync.open':z.strictObject({resumeCursor:str.optional(),selectedSessionId:sessionId.optional()}),'sync.ack':z.strictObject({cursor:str}),
  'sessions.list':z.strictObject({filter:z.string().max(200).optional(),offset:z.number().int().min(0).default(0),withIds:z.boolean().default(false)}),'sessions.get':z.strictObject({sessionId}),
  'sessions.batch':z.strictObject({sessionIds:z.array(sessionId).min(1).max(50)}),
  'projects.list':empty,'sessions.create':z.strictObject({provider,projectId,title:z.string().max(100).optional(),model:z.string().max(512).optional(),effort:z.string().max(32).optional(),tools:z.boolean().default(false)}),
  'sessions.messages':z.strictObject({sessionId,before:str.optional(),limit:z.number().int().min(1).max(100).default(100)}),
  'sessions.messagePart':z.strictObject({sessionId,messageId:z.string().min(1).max(256),revision,part:z.number().int().min(0).max(100000)}),
  'sessions.handoffPreview':z.strictObject({sessionId}),
  'sessions.handoffCreate':z.strictObject({sourceSessionId:sessionId,sourceDigest:hash,draft:z.string().min(1).max(100000),provider,projectId,model:z.string().max(512).optional(),effort:z.string().max(32).optional(),tools:z.boolean().default(false)}),
  'sessions.history':z.strictObject({projectId,provider:z.enum(['codex','claude']).default('codex')}),
  'sessions.import':z.strictObject({historyId:uuid,externalWriterStopped:z.literal(true)}),
  // desktopAttachments: the desktop draft's own attachments, as the phone reviewed them (W10).
  'sessions.send':z.strictObject({sessionId,text:z.string().min(1).max(100000),attachments:z.array(uuid).max(4).default([]),desktopAttachments:z.array(z.strictObject({id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)})).max(8).optional(),webSearch:z.boolean().default(false),expectedDraftRevision:revision,expectedConfigRevision:revision}),
  'sessions.stop':z.strictObject({sessionId}),'sessions.disconnect':z.strictObject({sessionId}),'sessions.read':z.strictObject({sessionId}),
  'sessions.rename':z.strictObject({sessionId,title:z.string().min(1).max(100),expectedRevision:revision}),
  'sessions.organize':z.strictObject({sessionId,expectedRevision:revision,pinned:z.boolean().optional(),archived:z.boolean().optional()}).refine(p=>p.pinned!==undefined||p.archived!==undefined,'Choose a session organization change'),
  'drafts.get':z.strictObject({sessionId}),'drafts.put':z.strictObject({sessionId,text:z.string().max(100000),expectedRevision:revision,desktopAttachmentIds:z.array(uuid).max(8).optional()}),
  'drafts.attachmentPreview':z.strictObject({sessionId,attachmentId:uuid}),
  // W11: pinned replies, the desktop's message bookmarks, in the phone's conversations.
  'messages.bookmark':z.strictObject({sessionId,messageId:z.string().min(1).max(200),bookmarked:z.boolean()}),
  'messages.bookmarks':z.strictObject({sessionId:sessionId.optional(),limit:z.number().int().min(1).max(50).default(50)}),
  // W11: read-only views of a conversation's effective style and of its results and schedules; pausing
  // a schedule only reduces what runs.
  'sessions.behavior':z.strictObject({sessionId}),
  'workflows.status':z.strictObject({sessionId,limit:z.number().int().min(1).max(20).default(10)}),
  'workflows.pauseSchedule':z.strictObject({sessionId,scheduleId:z.string().min(1).max(100),expectedRevision:revision}),
  // W11: the desktop's portrait for the phone's status avatar (F93), Open on desktop for a linked
  // terminal (F11), a scoped workspace card (F80) and sanitized memory health (F77).
  'desktop.portrait':z.strictObject({known:hash.optional()}),
  'sessions.focusTerminal':z.strictObject({sessionId}),
  'desktop.workspace':z.strictObject({projectId}),
  'memory.health':z.strictObject({sessionId}),
  'providers.models':z.strictObject({provider,sessionId:sessionId.optional()}),
  'sessions.configure':z.strictObject({sessionId,model:z.string().max(512),effort:z.string().max(32).optional(),tools:z.boolean(),expectedConfigRevision:revision}),
  'approvals.list':empty,'approvals.get':z.strictObject({approvalId:uuid}),
  'approvals.answer':z.strictObject({approvalId:uuid,revision,digest:hash,choice:z.enum(['allow','deny','answer','cancel']),answers:z.record(z.string().max(150),z.strictObject({answers:z.array(z.string().max(100000)).max(32)})).default({}),imageDigest:hash.optional()}),
  'approvals.preview':z.strictObject({approvalId:uuid,revision,digest:hash}),
  'attachments.begin':z.strictObject({sessionId,size:z.number().int().min(1).max(10*1024*1024),mime:z.enum(['image/png','image/jpeg','image/webp']),sha256:hash}),
  'attachments.status':z.strictObject({attachmentId:uuid}),
  'attachments.commit':z.strictObject({attachmentId:uuid}),
  'attachments.abort':z.strictObject({attachmentId:uuid}),
  'attachments.read':z.strictObject({readId:uuid,offset:z.number().int().min(0),length:z.number().int().min(1).max(256*1024)}),
  'commands.challenge':z.strictObject({method:z.string().max(64),paramsDigest:hash,commandId:uuid}),
  'commands.status':z.strictObject({commandId:uuid}),'activity.list':z.strictObject({sessionId,limit:z.number().int().min(1).max(100).default(100)}),
  'activity.page':z.strictObject({sessionId,before:z.string().min(1).max(256).optional(),limit:z.number().int().min(1).max(100).default(100)}),
  'permissions.get':empty,'permissions.pause':empty,
  'permissions.reduce':z.strictObject({expectedScopeVersion:revision,caps:z.array(z.string().max(64)).max(32).optional(),categories:z.array(z.string().max(64)).max(32).optional(),scriptIds:z.array(z.string().max(200)).max(100).optional(),projectIds:z.array(uuid).max(32).optional(),ollamaHosts:z.array(z.string().max(4096)).max(32).optional(),expiresAt:z.number().int().positive().optional()}),'devices.self':empty,'devices.selfRevoke':empty,
  'desktop.status':z.strictObject({projectId}),'desktop.apps':z.strictObject({projectId}),'desktop.windows':z.strictObject({projectId}),
  'desktop.execute':z.strictObject({projectId,action:z.string().max(64),args:z.record(z.string(),z.unknown()),definitionDigest:hash.optional()}),
  'timers.cancel':z.strictObject({projectId,timerId:uuid}),
  'captures.start':z.strictObject({projectId,edit:z.boolean().default(false)}),'captures.status':z.strictObject({captureId:uuid}),
  'captures.preview':z.strictObject({captureId:uuid}),'captures.discard':z.strictObject({captureId:uuid}),
  'captures.attach':z.strictObject({captureId:uuid,sessionId,imageDigest:hash}),
  'settings.get':empty,'settings.patch':z.strictObject({expectedRevision:revision,personality:z.string().max(8000).optional(),defaultModel:z.string().max(512).optional(),searchProvider:z.enum(['auto','duckduckgo','brave','mojeek','searxng']).optional()}),
  'memory.list':z.strictObject({sessionId,kind:z.enum(['saved','conversation','assertions','episodes','entities']).default('saved'),offset:z.number().int().min(0).default(0),filter:z.string().max(1000).default('')}),
  'memory.retrieve':z.strictObject({sessionId,query:z.string().min(1).max(1000)}),
  'memory.save':z.strictObject({sessionId,text:z.string().min(1).max(4000),id:uuid.optional(),expectedRevision:memoryRevision.optional()}).refine(p=>!p.id||p.expectedRevision!==undefined,'Editing memory requires its reviewed revision'),
  'memory.inspect':z.strictObject({sessionId,id:uuid}),
  'memory.forgetPreview':z.strictObject({sessionId,id:uuid.optional()}),
  'memory.forget':z.strictObject({sessionId,id:uuid,selection:z.string().regex(/^[0-9a-f]{64}$/),expectedRevision:memoryRevision}),
  'memory.clear':z.strictObject({sessionId,confirmProjectId:projectId,selection:z.string().regex(/^[0-9a-f]{64}$/),expectedRevision:memoryRevision}),
  'memory.erasureStatus':z.strictObject({sessionId,jobId:uuid}),
  // W09: typed graph changes, each witnessed by the person's statement and bound to the reviewed revision.
  'memory.timeline':z.strictObject({sessionId,id:uuid}),
  'memory.correct':z.strictObject({sessionId,id:uuid,expectedRevision:memoryRevision,statement:z.string().min(1).max(2000),change:z.strictObject({
    objectName:z.string().min(1).max(200).optional(),value:z.union([z.string().max(2000),z.number().finite(),z.boolean()]).optional(),polarity:z.enum(['positive','negative']).optional(),
    validMode:z.enum(['bounded','known_current','atemporal','unknown']).optional(),validFromUs:z.number().int().nullable().optional(),validToUs:z.number().int().nullable().optional()}).refine(c=>Object.keys(c).length>0,'Choose what to correct')}),
  'memory.resolveConflict':z.strictObject({sessionId,id:uuid,expectedRevision:memoryRevision,statement:z.string().min(1).max(2000)}),
  'memory.identity':z.strictObject({sessionId,leftId:uuid,rightId:uuid,decision:z.enum(['same','not_same','possible']),statement:z.string().min(1).max(2000)}),
  'memory.freezeEpisode':z.strictObject({sessionId,id:uuid}),
};
/**
 * Behaviour a client can rely on beyond the operation list, named in welcome. A client checks for a
 * feature before using it and keeps its older behaviour otherwise; an absent feature is never an error.
 */
export const protocolFeatures=['activity.page','sessions.batch','search.ids','message.sources','citations.display','agent.refs','captures','drafts.desktopAttachments','messages.bookmarks','workflows.status','sessions.behavior','desktop.portrait','desktop.workspace','memory.health','sessions.focusTerminal','history.claude'] as const;
export const mutations=new Set(['sessions.focusTerminal','workflows.pauseSchedule','messages.bookmark','captures.start','captures.discard','captures.attach','memory.correct','memory.resolveConflict','memory.identity','memory.freezeEpisode','sessions.create','sessions.send','sessions.stop','sessions.disconnect','sessions.read','sessions.rename','sessions.organize','drafts.put','sessions.configure','sessions.handoffCreate','sessions.import','approvals.answer','permissions.pause','permissions.reduce','devices.selfRevoke','desktop.execute','timers.cancel','settings.patch','memory.save','memory.forget','memory.clear','attachments.begin','attachments.commit','attachments.abort']);
const defensive=new Set(['workflows.pauseSchedule','messages.bookmark','captures.discard','sessions.stop','sessions.disconnect','sessions.read','sessions.rename','sessions.organize','drafts.put','permissions.pause','permissions.reduce','devices.selfRevoke','attachments.abort']);
export function needsProof(method:string,params:any) { return mutations.has(method) && !defensive.has(method) && !(method==='approvals.answer'&&['deny','cancel'].includes(params.choice)); }
export function availableOperations(caps:string[]) {
  return Object.keys(methods).filter(method=>{
    const cap=method==='attachments.read'||method==='captures.preview'?'capture.preview':method==='captures.attach'||method.startsWith('attachments.')?'attachments.write':method==='approvals.preview'?'capture.preview':method.startsWith('captures.')?'desktop.control':method.startsWith('approvals.')?'approvals.answer':method==='desktop.portrait'?'chat.read':method.startsWith('desktop.')||method.startsWith('timers.')||method==='sessions.focusTerminal'?'desktop.control':['memory.save','memory.forget','memory.clear','memory.forgetPreview','memory.correct','memory.resolveConflict','memory.identity','memory.freezeEpisode'].includes(method)?'memory.write':method.startsWith('memory.')?'memory.read':method==='settings.patch'?'settings.write':method==='sessions.history'?'providers.execute':['sessions.create','sessions.send','sessions.configure','sessions.rename','sessions.organize','sessions.disconnect','sessions.handoffCreate','sessions.import','drafts.put','messages.bookmark','workflows.pauseSchedule'].includes(method)?'chat.write':'chat.read';
    return ['devices.self','devices.selfRevoke','permissions.pause','permissions.reduce','commands.status','commands.challenge'].includes(method)||caps.includes(cap);
  });
}
