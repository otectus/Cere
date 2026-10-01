import type { Store } from '../store.ts';
import { remoteError } from '../execution.ts';

const previewChars=16384,partChars=32768,pageBytes=384*1024;
// SQLite slices Unicode scalar values, preserving non-BMP characters in every part.
// Only bounded previews cross into JS while listing a long transcript.
const projection=`rowid AS cursor,json_remove(data,'$.text','$.sources') AS metadata,
 substr(json_extract(data,'$.text'),1,${previewChars}) AS text,
 length(json_extract(data,'$.text')) AS chars,
 length(CAST(json_extract(data,'$.text') AS BLOB)) AS bytes,
 json_extract(data,'$.sources') AS sources`;
function dto(row:any) {
  const m=JSON.parse(row.metadata);
  const sources=row.sources?JSON.parse(row.sources).slice(0,20).map((s:any)=>({title:String(s.title||'').slice(0,256),url:String(s.url||'').slice(0,4096)})):undefined;
  return {id:m.id,sessionId:m.sessionId,role:m.role,kind:m.kind,text:row.text||'',time:m.time,revision:m.revision||'0',turnId:m.turnId,sources,
    ...(row.chars>previewChars?{contentTruncated:true,contentBytes:row.bytes,contentChars:row.chars,textParts:{count:Math.ceil(row.chars/partChars),partChars,encoding:'unicode-scalar'}}:{})};
}
export function mobileMessage(store:Store,sessionId:string,messageId:string) {
  const row=store.db.prepare(`SELECT ${projection} FROM messages WHERE session_id=? AND id=?`).get(sessionId,messageId);
  if(!row)throw remoteError('INVALID_ARGUMENT','Message is no longer available.');return dto(row);
}
export function mobilePage(store:Store,sessionId:string,before?:string,limit=100,activity=false) {
  const cursor=before?store.db.prepare('SELECT rowid AS cursor FROM messages WHERE session_id=? AND id=?').get(sessionId,before)?.cursor:null;
  if(before&&!cursor)throw remoteError('INVALID_ARGUMENT','Message page is no longer available.');
  // Page the two surfaces independently: a long tool run must not push every
  // conversational reply out of the first phone page.
  const conversation="json_extract(data,'$.role') IN ('user','assistant') AND COALESCE(json_extract(data,'$.kind'),'text') IN ('text','message','','question','answer','queued','queue-cancelled')";
  const filter=`AND ${activity?`NOT (${conversation})`:`(${conversation})`}`;
  const rows=store.db.prepare(`SELECT ${projection} FROM messages WHERE session_id=? AND (? IS NULL OR rowid<?) ${filter} ORDER BY rowid DESC LIMIT ?`).iterate(sessionId,cursor??null,cursor??null,limit+1);
  const items:ReturnType<typeof dto>[]=[];let used=0,more=false;
  for(const row of rows){const item=dto(row),size=Buffer.byteLength(JSON.stringify(item));if(items.length>=limit||items.length&&used+size>pageBytes){more=true;break;}items.push(item);used+=size;}
  return {items:items.reverse(),before:more?items[0]?.id:null};
}
export function mobilePart(store:Store,p:{sessionId:string;messageId:string;revision:string;part:number}) {
  const row=store.db.prepare(`SELECT json_extract(data,'$.revision') AS revision,length(json_extract(data,'$.text')) AS chars,
    substr(json_extract(data,'$.text'),?,?) AS content FROM messages WHERE session_id=? AND id=?`).get(p.part*partChars+1,partChars,p.sessionId,p.messageId);
  if(!row)throw remoteError('INVALID_ARGUMENT','Message is no longer available.');
  if((row.revision||'0')!==p.revision)throw remoteError('REVISION_CONFLICT','Message changed; load its current revision.');
  const count=Math.max(1,Math.ceil(Number(row.chars)/partChars));
  if(p.part>=count)throw remoteError('INVALID_ARGUMENT','Message part is outside the valid range.');
  return {messageId:p.messageId,revision:p.revision,part:p.part,count,content:row.content,encoding:'unicode-scalar'};
}
