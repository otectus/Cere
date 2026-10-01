import { randomUUID } from 'node:crypto';
import { open, readFile, unlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { privateDir } from '../paths.ts';
import { remoteError } from '../execution.ts';
import { bytesDigest } from './crypto.ts';
import type { Router } from './router.ts';
import type { Device } from './store.ts';

type Media={id:string;uploadId:string;deviceId:string;sessionId:string;size:number;offset:number;mime:string;sha256:string;status:'uploading'|'ready'|'submitted';expiresAt:number;submittedAt?:number;path:string;width?:number;height?:number};
type Preview={id:string;deviceId:string;approvalId:string;revision:string;digest:string;imageDigest:string;expiresAt:number;bytes:Buffer};
export class MediaStore {
  router:Router;directory:string;busy=new Set<string>();previews=new Map<string,Preview>();
  decoding=false;
  constructor(router:Router) {this.router=router;this.directory=join(router.core.store.directory,'remote-media');privateDir(this.directory);router.core.store.db.exec('CREATE TABLE IF NOT EXISTS remote_media(id TEXT PRIMARY KEY,data TEXT NOT NULL)');}
  all():Media[] {return this.router.core.store.db.prepare('SELECT data FROM remote_media').all().map(r=>JSON.parse(String(r.data)));}
  save(media:Media) {this.router.core.store.db.prepare('INSERT OR REPLACE INTO remote_media VALUES (?,?)').run(media.id,JSON.stringify(media));}
  get(device:Device,id:string) {this.router.current(device);const media=this.all().find(m=>m.deviceId===device.id&&(m.id===id||m.uploadId===id));if(!media||media.expiresAt<Date.now())throw remoteError('ATTACHMENT_INVALID','Attachment is missing or expired.');this.router.session(device,media.sessionId);return media;}
  dto(m:Media) {return {attachmentId:m.id,uploadId:m.uploadId,size:m.size,offset:m.offset,mime:m.mime,sha256:m.sha256,status:m.status,width:m.width,height:m.height,expiresAt:m.expiresAt};}
  async begin(device:Device,p:any) {
    this.router.require(device,'attachments.write');this.router.session(device,p.sessionId);
    const all=this.all(),owned=all.filter(m=>m.deviceId===device.id),existing=owned.filter(m=>m.expiresAt>Date.now()&&m.status!=='submitted');
    if(owned.length>=256||owned.reduce((n,m)=>n+m.size,0)+p.size>512*1024*1024||all.reduce((n,m)=>n+m.size,0)+p.size>2*1024*1024*1024)throw remoteError('LIMIT_EXCEEDED','Retained image quota exceeded. Clear this device’s retained images on the desktop.');
    if(existing.reduce((n,m)=>n+m.size,0)+p.size>100*1024*1024||existing.filter(m=>m.status==='uploading').length>=4)throw remoteError('LIMIT_EXCEEDED','Device upload quota exceeded.');
    const directory=join(this.directory,device.id);privateDir(directory);
    const m:Media={id:randomUUID(),uploadId:randomUUID(),deviceId:device.id,sessionId:p.sessionId,size:p.size,offset:0,mime:p.mime,sha256:p.sha256,status:'uploading',expiresAt:Date.now()+15*60000,path:join(directory,randomUUID()+'.image')};
    this.save(m); // Reserve quota before filesystem awaits.
    try{const file=await open(m.path,'wx',0o600);await file.close();this.router.current(device);return this.dto(m);}catch(error){await unlink(m.path).catch(()=>{});this.router.core.store.db.prepare('DELETE FROM remote_media WHERE id=?').run(m.id);throw error;}
  }
  async chunk(device:Device,bytes:Buffer) {
    this.router.require(device,'attachments.write');
    if(bytes.length<=24||bytes.length>24+256*1024)throw remoteError('LIMIT_EXCEEDED','Invalid upload chunk.');
    const hex=bytes.subarray(0,16).toString('hex'),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const offset=bytes.readBigUInt64BE(16),m=this.get(device,id),body=bytes.subarray(24);
    if(m.status!=='uploading'||offset!==BigInt(m.offset)||m.offset+body.length>m.size||this.busy.has(m.id))throw remoteError('ATTACHMENT_INVALID','Resume at the committed upload offset.');
    this.busy.add(m.id);
    try {const file=await open(m.path,'r+');try {this.router.current(device);const written=await file.write(body,0,body.length,m.offset);if(written.bytesWritten!==body.length)throw remoteError('ATTACHMENT_INVALID','The complete chunk could not be written.');await file.sync();}finally{await file.close();}this.get(device,m.id);m.offset+=body.length;this.save(m);return this.dto(m);}
    finally{this.busy.delete(m.id);}
  }
  async commit(device:Device,p:any) {
    this.router.require(device,'attachments.write');const m=this.get(device,p.attachmentId);
    if(m.status==='ready')return this.dto(m);
    if(m.status!=='uploading')throw remoteError('ATTACHMENT_INVALID','This attachment was already submitted.');
    if(m.offset!==m.size||this.busy.has(m.id))throw remoteError('ATTACHMENT_INVALID','Upload is incomplete.');
    if(this.decoding)throw remoteError('SESSION_BUSY','Another image is being validated.');
    this.busy.add(m.id);this.decoding=true;
    try {
      const bytes=await readFile(m.path);if(bytes.length!==m.size||bytesDigest(bytes)!==m.sha256)throw remoteError('ATTACHMENT_INVALID','Image hash does not match.');
      const magic=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':'';
      if(magic!==m.mime)throw remoteError('ATTACHMENT_INVALID','Unsupported image content.');
      const image=sharp(bytes,{limitInputPixels:40_000_000,animated:false,failOn:'error'}),metadata=await image.metadata();
      const mime: string|undefined=({png:'image/png',jpeg:'image/jpeg',webp:'image/webp'} as Record<string,string>)[metadata.format||''];
      if(!mime||mime!==m.mime||!metadata.width||!metadata.height||metadata.width>16384||metadata.height>16384||(metadata.pages||1)>1)throw remoteError('ATTACHMENT_INVALID','Unsupported image or dimensions.');
      // Fully decode before accepting. Header-only inspection cannot reject corrupt payloads.
      await image.clone().raw().toBuffer();this.get(device,m.id);
      m.width=metadata.width;m.height=metadata.height;m.status='ready';m.expiresAt=Date.now()+3600000;this.save(m);return this.dto(m);
    } catch(error){await this.abort(device,m.id).catch(()=>{});throw error;}finally{this.busy.delete(m.id);this.decoding=false;}
  }
  async abort(device:Device,id:string) {const m=this.get(device,id);if(m.status==='submitted')throw remoteError('ATTACHMENT_INVALID','Submitted image is retained with its session.');await unlink(m.path).catch(()=>{});this.router.core.store.db.prepare('DELETE FROM remote_media WHERE id=?').run(m.id);return true;}
  resolve(device:Device,sessionId:string,ids:string[]) {
    if(new Set(ids).size!==ids.length)throw remoteError('ATTACHMENT_INVALID','Duplicate attachment.');
    const items=ids.map(id=>this.get(device,id));
    if(items.some(m=>m.sessionId!==sessionId||m.status!=='ready')||items.reduce((n,m)=>n+m.size,0)>20*1024*1024)throw remoteError('ATTACHMENT_INVALID','Attachment scope or total size is invalid.');
    return items.map(m=>m.path);
  }
  submitted(device:Device,ids:string[]) {for(const id of ids){const m=this.get(device,id);m.status='submitted';m.submittedAt=Date.now();m.expiresAt=Number.MAX_SAFE_INTEGER;this.save(m);}}
  async preview(device:Device,p:any) {
    this.router.require(device,'capture.preview');const {a}=this.router.approval(device,p.approvalId),dto=this.router.approvalDto(device,a);
    if(dto.revision!==p.revision||dto.digest!==p.digest||a.kind!=='image'||!a.image)throw remoteError('REVISION_CONFLICT','Capture request changed.');
    if(this.decoding)throw remoteError('SESSION_BUSY','Another image is being validated.');
    if([...this.previews.values()].filter(v=>v.deviceId===device.id&&v.expiresAt>Date.now()).length>=4)throw remoteError('LIMIT_EXCEEDED','Close old previews before opening another.');
    this.decoding=true;
    try {
    if((await stat(a.image)).size>20*1024*1024)throw remoteError('LIMIT_EXCEEDED','Capture is too large to preview.');
    const original=await readFile(a.image),imageDigest=bytesDigest(original);
    const bytes=await sharp(original,{limitInputPixels:40_000_000}).resize({width:1400,height:1400,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
    if(bytes.length>1024*1024)throw remoteError('LIMIT_EXCEEDED','Capture preview is too large.');
    this.router.current(device);const current=this.router.approval(device,p.approvalId).a;
    if(this.router.approvalDto(device,current).digest!==p.digest)throw remoteError('REVISION_CONFLICT','Capture changed.');
    const id=randomUUID(),expiresAt=Date.now()+300000;
    this.previews.set(id,{id,deviceId:device.id,approvalId:a.id,revision:p.revision,digest:p.digest,imageDigest,expiresAt,bytes});
    return {readId:id,size:bytes.length,mime:'image/jpeg',sha256:bytesDigest(bytes),imageDigest,expiresAt};
    } finally {this.decoding=false;}
  }
  previewReviewed(device:Device,approvalId:string,imageDigest:string) {return [...this.previews.values()].some(p=>p.deviceId===device.id&&p.approvalId===approvalId&&p.imageDigest===imageDigest&&p.expiresAt>Date.now());}
  read(device:Device,p:any):Buffer {
    this.router.require(device,'capture.preview');const preview=this.previews.get(p.readId);
    if(!preview||preview.deviceId!==device.id||preview.expiresAt<Date.now())throw remoteError('ATTACHMENT_INVALID','Preview expired.');
    const current=this.router.approval(device,preview.approvalId);if(this.router.approvalDto(device,current.a).digest!==preview.digest)throw remoteError('REVISION_CONFLICT','Capture request changed.');
    if(p.offset>=preview.bytes.length)throw remoteError('INVALID_ARGUMENT','Preview offset is outside the image.');
    const header=Buffer.alloc(24);Buffer.from(p.readId.replaceAll('-',''),'hex').copy(header);header.writeBigUInt64BE(BigInt(p.offset),16);
    return Buffer.concat([header,preview.bytes.subarray(p.offset,p.offset+p.length)]);
  }
  async purge(deviceId?:string) {
    for(const [id,p]of this.previews)if(p.expiresAt<Date.now()||p.deviceId===deviceId||!this.router.core.approvals.has(p.approvalId))this.previews.delete(id);
    const sessions=new Map(this.router.core.store.sessions().map(s=>[s.id,s]));
    for(const m of this.all()) {
      const session=sessions.get(m.sessionId);
      // Ollama persists the ingested bytes in its authoritative conversation context.
      // Native providers retain path inputs until the session is removed or the owner
      // explicitly clears/revokes this device's media after stopping its work.
      const ingested=m.status==='submitted'&&session?.provider==='ollama'&&session.status==='idle'&&Date.now()-(m.submittedAt||Date.now())>60000;
      if(!this.busy.has(m.id)&&(!session||!this.router.registry.live(m.deviceId)||m.deviceId===deviceId||ingested||m.status!=='submitted'&&m.expiresAt<Date.now())) {
        await unlink(m.path).catch(()=>{});this.router.core.store.db.prepare('DELETE FROM remote_media WHERE id=?').run(m.id);
      }
    }
    const known=new Set(this.all().map(m=>m.path));
    for(const dir of await readdir(this.directory,{withFileTypes:true}))if(dir.isDirectory()&&/^[0-9a-f-]{36}$/.test(dir.name)) {
      for(const file of await readdir(join(this.directory,dir.name),{withFileTypes:true}))if(file.isFile()) {
        const path=join(this.directory,dir.name,file.name);
        if(!known.has(path)&&Date.now()-(await stat(path).catch(()=>({mtimeMs:Date.now()}))).mtimeMs>15*60000)await unlink(path).catch(()=>{});
      }
    }
  }
}
