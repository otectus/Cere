import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import QRCode from 'qrcode';
import { z } from 'zod';
import { digest, parsePairing, pairingUri, signed, verified } from './crypto.ts';
import { Identity, addresses, endpoints } from './identity.ts';
import { RemoteStore } from './store.ts';
import type { Device, Project } from './store.ts';
import { remoteError } from '../execution.ts';

export const caps = ['chat.read','chat.write','approvals.answer','providers.execute','approvals.provider','desktop.control','settings.write','memory.read','memory.write','web','capture.preview','attachments.write'] as const;
export const categories = ['apps','files','windows','audio','media','capture','timers','scripts','providers'] as const;
const b64=z.string().regex(/^[A-Za-z0-9_-]+$/), uuid=z.uuid();
const responseSchema=z.strictObject({type:z.literal('response'),v:z.literal(1),desktopId:uuid,pairingId:uuid,offerDigest:b64,nonce:b64.length(43),deviceId:uuid,name:z.string().min(1).max(48),keyVersion:z.literal(1),connectionKey:b64,actionKey:b64,deviceNonce:b64.length(43),connectionProof:b64,actionProof:b64});
const words: string[]=JSON.parse(readFileSync(new URL('../../protocol/mobile/v1/sas-words.json',import.meta.url),'utf8'));
export class Pairing {
  registry:RemoteStore; identity:Identity;
  constructor(registry:RemoteStore,identity:Identity) {this.registry=registry;this.identity=identity;}
  updateScopes(params:unknown):Device {
    const p=z.strictObject({id:uuid,projectPaths:z.array(z.string()).min(1).max(32),caps:z.array(z.enum(caps)),categories:z.array(z.enum(categories)),scriptIds:z.array(z.string()).max(100).default([])}).parse(params);
    const device=this.registry.live(p.id);if(!device)throw new Error('Re-pair an expired or revoked device.');
    const projects:Project[]=[...new Set(p.projectPaths.map(path=>realpathSync(path)))].map(path=>{if(!statSync(path).isDirectory())throw new Error('Choose a project directory');return device.projects.find(pr=>pr.path===path)||{id:randomUUID(),name:basename(path)||path,path};});
    const next={...device,projects,caps:p.caps,categories:p.categories,scriptIds:p.scriptIds,ollamaHosts:[this.registry.store.settings().ollama.host],scopeVersion:String(BigInt(device.scopeVersion)+1n)};
    this.registry.saveDevice(next);this.registry.audit({deviceId:device.id,operation:'device.scopes',decision:'updated',scopeVersion:next.scopeVersion,argsDigest:digest({projects:projects.map(p=>p.id),caps:p.caps,categories:p.categories,scriptIds:p.scriptIds})});return next;
  }
  async prepare(params:unknown) {
    const p=z.strictObject({addresses:z.array(z.string()),name:z.string().min(1).max(48).default('Cere'),port:z.number().int().min(1024).max(65535).default(8443),actionAuthentication:z.enum(['biometric','trusted-device']).default('biometric'),replacesDeviceId:uuid.optional()}).parse(params);
    if(p.replacesDeviceId&&!this.registry.live(p.replacesDeviceId))throw new Error('Choose a live paired device to replace.');
    if(Buffer.byteLength(p.name)>48)throw new Error('Desktop name must fit in 48 UTF-8 bytes');
    const config={...this.registry.config(),addresses:addresses(p.addresses),port:p.port,name:p.name};
    if(this.registry.devices().some(d=>this.registry.live(d.id)) && JSON.stringify(endpoints(config))!==JSON.stringify(endpoints(this.registry.config())))throw new Error('Changing paired endpoints requires local identity recovery and re-pairing.');
    await this.identity.ensure(config);
    this.registry.configure(config);
    const material=this.identity.material();
    const bare={type:'offer',v:1,desktopId:this.identity.id,name:p.name,certificate:material.certificate,spki:material.spki,identityKey:material.identityKey,endpoints:endpoints(config),pairingId:randomUUID(),nonce:randomBytes(32).toString('base64url'),expiresAt:Date.now()+300000,actionAuthentication:p.actionAuthentication,...(p.replacesDeviceId?{replacesDeviceId:p.replacesDeviceId}:{})};
    const offer={...bare,signature:signed(material.identity,{domain:'cere.mobile.pair.offer.v1',offer:bare})};
    const uri=pairingUri(offer);
    if(Buffer.byteLength(uri)>2000)throw new Error('Pairing offer is too large. Select fewer addresses or a shorter desktop name.');
    this.registry.store.db.prepare('INSERT INTO remote_pair_offers VALUES (?,?,?)').run(offer.pairingId,JSON.stringify(offer),offer.expiresAt);
    this.registry.audit({operation:'pair.prepare',decision:'prepared'});
    return {uri,expiresAt:offer.expiresAt,qr:await QRCode.toDataURL(uri,{errorCorrectionLevel:'M',width:480,margin:2})};
  }
  review(uri:string) {
    const response=responseSchema.parse(parsePairing(uri));
    const row=this.registry.store.db.prepare('SELECT data FROM remote_pair_offers WHERE id=? AND expires>?').get(response.pairingId,Date.now());
    if(!row)throw remoteError('AUTH_EXPIRED','Pairing offer expired or already used.');
    const offer=JSON.parse(String(row.data));
    const {connectionProof,actionProof,...body}=response;
    const transcript={domain:'cere.mobile.pair.response.v1',response:body};
    if(response.desktopId!==this.identity.id||response.offerDigest!==digest(offer)||response.nonce!==offer.nonce||response.connectionKey===response.actionKey||!verified(response.connectionKey,transcript,connectionProof)||!verified(response.actionKey,transcript,actionProof))throw remoteError('UNAUTHENTICATED','Pairing signatures do not match this offer.');
    const sas=[...createHash('sha256').update(digest(offer)+'.'+digest(response)).digest().subarray(0,6)].map(v=>words[v]).join(' ');
    return {response,sas,offer,fingerprint:digest({connectionKey:response.connectionKey,actionKey:response.actionKey})};
  }
  confirm(params:unknown):Device {
    const p=z.strictObject({response:z.string(),sas:z.string(),confirmed:z.literal(true),projectPaths:z.array(z.string()).min(1).max(32),caps:z.array(z.enum(caps)).default(['chat.read','chat.write','approvals.answer']),categories:z.array(z.enum(categories)).default([]),scriptIds:z.array(z.string()).max(100).default([])}).parse(params);
    const review=this.review(p.response);
    if(p.sas!==review.sas)throw remoteError('UNAUTHENTICATED','Compare the six words on both devices.');
    const previous=review.offer.replacesDeviceId?this.registry.live(review.offer.replacesDeviceId):undefined;
    if(review.offer.replacesDeviceId&&!previous)throw new Error('The device being replaced is no longer active. Prepare a new offer.');
    if(JSON.stringify(review.offer.endpoints)!==JSON.stringify(endpoints(this.registry.config()))||review.offer.certificate!==this.identity.material().certificate)throw new Error('Gateway identity changed. Prepare a fresh pairing offer.');
    if(this.registry.devices().filter(d=>this.registry.live(d.id)).length>=5&&!previous)throw new Error('At most five devices may be paired.');
    if(this.registry.device(review.response.deviceId))throw new Error('This device identity already exists; generate fresh phone keys.');
    const projects:Project[]=[...new Set(p.projectPaths.map(path=>realpathSync(path)))].map(path=>{if(!statSync(path).isDirectory())throw new Error('Choose a project directory');return previous?.projects.find(project=>project.path===path)||{id:randomUUID(),name:basename(path)||path,path};});
    const device:Device={id:review.response.deviceId,name:review.response.name,connectionKey:review.response.connectionKey,actionKey:review.response.actionKey,keyVersion:1,scopeVersion:'1',actionAuthentication:review.offer.actionAuthentication||'biometric',...(previous?{replacesDeviceId:previous.id,replacementPending:true}:{}),createdAt:Date.now(),expiresAt:Date.now()+90*86400000,projects,caps:p.caps,categories:p.categories,scriptIds:p.scriptIds,ollamaHosts:[this.registry.store.settings().ollama.host]};
    const db=this.registry.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if(previous){previous.revokedAt=Date.now();previous.scopeVersion=String(BigInt(previous.scopeVersion)+1n);this.registry.saveDevice(previous);}
      this.registry.saveDevice(device);this.registry.configure({...this.registry.config(),enabled:true});
      db.prepare('DELETE FROM remote_pair_offers WHERE id=?').run(review.response.pairingId);
      this.registry.audit({deviceId:device.id,operation:'pair.confirm',decision:'paired'});db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    return device;
  }
}
