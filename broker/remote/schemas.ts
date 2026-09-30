import { z } from 'zod';

export const uuid=z.uuid(), revision=z.string().regex(/^(0|[1-9][0-9]{0,18})$/), hash=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const str=z.string().max(4096),sessionId=uuid,projectId=uuid,provider=z.enum(['codex','claude','ollama']),empty=z.strictObject({});
const memoryRevision=z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(value=>BigInt(value)<=BigInt(Number.MAX_SAFE_INTEGER),'Memory revision exceeds exact integer range');
export const helloSchema=z.strictObject({v:z.literal(1),type:z.literal('hello'),protocolMin:z.number().int().min(0),protocolMax:z.number().int().min(0),desktopId:uuid,deviceId:uuid,keyVersion:z.literal(1),clientNonce:hash,appVersion:z.string().max(32)});
export const requestSchema=z.strictObject({v:z.literal(1),type:z.literal('request'),id:uuid,method:z.string().max(64),params:z.record(z.string(),z.unknown()),commandId:uuid.optional(),proof:z.strictObject({challengeId:uuid,signature:z.string().max(100)}).optional()});
export const methods:Record<string,z.ZodType>={
  'sync.open':z.strictObject({resumeCursor:str.optional(),selectedSessionId:sessionId.optional()}),'sync.ack':z.strictObject({cursor:str}),
  'sessions.list':z.strictObject({filter:z.string().max(200).optional(),offset:z.number().int().min(0).default(0)}),'sessions.get':z.strictObject({sessionId}),
  'projects.list':empty,'sessions.create':z.strictObject({provider,projectId,title:z.string().max(100).optional(),model:z.string().max(512).optional(),effort:z.string().max(32).optional(),tools:z.boolean().default(false)}),
  'sessions.messages':z.strictObject({sessionId,before:str.optional(),limit:z.number().int().min(1).max(100).default(100)}),
  'sessions.messagePart':z.strictObject({sessionId,messageId:z.string().min(1).max(256),revision,part:z.number().int().min(0).max(100000)}),
  'sessions.handoffPreview':z.strictObject({sessionId}),
  'sessions.handoffCreate':z.strictObject({sourceSessionId:sessionId,sourceDigest:hash,draft:z.string().min(1).max(100000),provider,projectId,model:z.string().max(512).optional(),effort:z.string().max(32).optional(),tools:z.boolean().default(false)}),
  'sessions.history':z.strictObject({projectId}),
  'sessions.import':z.strictObject({historyId:uuid,externalWriterStopped:z.literal(true)}),
  'sessions.send':z.strictObject({sessionId,text:z.string().min(1).max(100000),attachments:z.array(uuid).max(4).default([]),webSearch:z.boolean().default(false),expectedDraftRevision:revision,expectedConfigRevision:revision}),
  'sessions.stop':z.strictObject({sessionId}),'sessions.disconnect':z.strictObject({sessionId}),
  'sessions.rename':z.strictObject({sessionId,title:z.string().min(1).max(100),expectedRevision:revision}),
  'drafts.get':z.strictObject({sessionId}),'drafts.put':z.strictObject({sessionId,text:z.string().max(100000),expectedRevision:revision}),
  'providers.models':z.strictObject({provider,sessionId:sessionId.optional()}),
  'sessions.configure':z.strictObject({sessionId,model:z.string().max(512),tools:z.boolean(),expectedConfigRevision:revision}),
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
  'permissions.get':empty,'permissions.pause':empty,'devices.self':empty,'devices.selfRevoke':empty,
  'desktop.status':z.strictObject({projectId}),'desktop.apps':z.strictObject({projectId}),'desktop.windows':z.strictObject({projectId}),
  'desktop.execute':z.strictObject({projectId,action:z.string().max(64),args:z.record(z.string(),z.unknown()),definitionDigest:hash.optional()}),
  'timers.cancel':z.strictObject({projectId,timerId:uuid}),
  'settings.get':empty,'settings.patch':z.strictObject({expectedRevision:revision,personality:z.string().max(8000).optional(),defaultModel:z.string().max(512).optional(),searchProvider:z.enum(['auto','duckduckgo','brave','mojeek','searxng']).optional()}),
  'memory.list':z.strictObject({sessionId,kind:z.enum(['saved','conversation','assertions','episodes','entities']).default('saved'),offset:z.number().int().min(0).default(0),filter:z.string().max(1000).default('')}),
  'memory.retrieve':z.strictObject({sessionId,query:z.string().min(1).max(1000)}),
  'memory.save':z.strictObject({sessionId,text:z.string().min(1).max(4000),id:uuid.optional(),expectedRevision:memoryRevision.optional()}).refine(p=>!p.id||p.expectedRevision!==undefined,'Editing memory requires its reviewed revision'),
  'memory.inspect':z.strictObject({sessionId,id:uuid}),
  'memory.forgetPreview':z.strictObject({sessionId,id:uuid.optional()}),
  'memory.forget':z.strictObject({sessionId,id:uuid,selection:z.string().regex(/^[0-9a-f]{64}$/),expectedRevision:memoryRevision}),
  'memory.clear':z.strictObject({sessionId,confirmProjectId:projectId,selection:z.string().regex(/^[0-9a-f]{64}$/),expectedRevision:memoryRevision}),
  'memory.erasureStatus':z.strictObject({sessionId,jobId:uuid}),
};
export const mutations=new Set(['sessions.create','sessions.send','sessions.stop','sessions.disconnect','sessions.rename','drafts.put','sessions.configure','sessions.handoffCreate','sessions.import','approvals.answer','permissions.pause','devices.selfRevoke','desktop.execute','timers.cancel','settings.patch','memory.save','memory.forget','memory.clear','attachments.begin','attachments.commit','attachments.abort']);
const defensive=new Set(['sessions.stop','sessions.disconnect','sessions.rename','drafts.put','permissions.pause','devices.selfRevoke','attachments.abort']);
export function needsProof(method:string,params:any) { return mutations.has(method) && !defensive.has(method) && !(method==='approvals.answer'&&['deny','cancel'].includes(params.choice)); }
export function availableOperations(caps:string[]) {
  return Object.keys(methods).filter(method=>{
    const cap=method==='attachments.read'?'capture.preview':method.startsWith('attachments.')?'attachments.write':method==='approvals.preview'?'capture.preview':method.startsWith('approvals.')?'approvals.answer':method.startsWith('desktop.')||method.startsWith('timers.')?'desktop.control':['memory.save','memory.forget','memory.clear','memory.forgetPreview'].includes(method)?'memory.write':method.startsWith('memory.')?'memory.read':method==='settings.patch'?'settings.write':method==='sessions.history'?'providers.execute':['sessions.create','sessions.send','sessions.configure','sessions.rename','sessions.disconnect','sessions.handoffCreate','sessions.import','drafts.put'].includes(method)?'chat.write':'chat.read';
    return ['devices.self','devices.selfRevoke','permissions.pause','commands.status','commands.challenge'].includes(method)||caps.includes(cap);
  });
}
