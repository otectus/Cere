import { generateKeyPairSync, X509Certificate, createPublicKey, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { privateDir } from '../paths.ts';
import { exec } from '../desktop.ts';
import { bytesDigest } from './crypto.ts';
import { remoteError } from '../execution.ts';
import type { RemoteStore, RemoteConfig } from './store.ts';

export function addresses(values: unknown): string[] {
  if (!Array.isArray(values)||!values.length||values.length>3||values.some(a=>typeof a!=='string'||!isIP(a)||['0.0.0.0','::'].includes(a))) throw remoteError('INVALID_ARGUMENT','Choose one to three explicit LAN or WireGuard IP addresses.');
  const local=Object.values(networkInterfaces()).flat().filter(Boolean).map(v=>v!.address);
  if(values.some(a=>!local.includes(a)))throw remoteError('DESKTOP_UNAVAILABLE','A selected address is not on a current desktop interface.');
  return [...new Set(values)];
}
export const endpoints = (config:RemoteConfig) => config.addresses.map(a=>`wss://${isIP(a)===6?'['+a+']':a}:${config.port}/mobile/v1`);
export class Identity {
  directory:string; registry:RemoteStore;
  constructor(registry:RemoteStore) { this.registry=registry; this.directory=join(registry.store.directory,'remote-identity'); }
  get id():string { return this.registry.store.get('remoteDesktopId',''); }
  reset() {rmSync(this.directory,{recursive:true,force:true});this.registry.store.set('remoteDesktopId','');this.registry.store.db.exec('DELETE FROM remote_pair_offers');}
  async ensure(config:RemoteConfig) {
    privateDir(this.directory);
    if(!this.id)this.registry.store.set('remoteDesktopId',randomUUID());
    const identityPath=join(this.directory,'identity.pem'),key=join(this.directory,'tls.pem'),cert=join(this.directory,'tls.crt');
    if(!existsSync(identityPath)) {
      const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
      writeFileSync(identityPath,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    }
    if (!existsSync(cert)) {
      const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
      writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
      await exec('openssl',['req','-new','-x509','-sha256','-days','365','-key',key,'-out',cert,'-subj','/CN=Cere Mobile Gateway','-addext','subjectAltName='+config.addresses.map(a=>'IP:'+a).join(',')],{timeout:10000});
      chmodSync(cert,0o600);
    }
    const certificate=new X509Certificate(readFileSync(cert));
    if(config.addresses.some(a=>!certificate.checkIP(a)))throw remoteError('INVALID_ARGUMENT','Address is absent from the certificate. Re-pair with the original addresses or reset identity locally.');
    if(Date.parse(certificate.validTo)<Date.now())throw remoteError('AUTH_EXPIRED','The desktop certificate expired. Renew the desktop identity locally.');
  }
  // Local, explicitly confirmed maintenance. Keep the signing identity and TLS key;
  // existing phones must import the new pinned certificate through replacement pairing.
  async renewCertificate(config:RemoteConfig) {
    addresses(config.addresses);
    const key=join(this.directory,'tls.pem'),cert=join(this.directory,'tls.crt'),next=join(this.directory,'tls.next.crt');
    if(!existsSync(key)) {await this.ensure(config);return;}
    try {
      await exec('openssl',['req','-new','-x509','-sha256','-days','365','-key',key,'-out',next,'-subj','/CN=Cere Mobile Gateway','-addext','subjectAltName='+config.addresses.map(a=>'IP:'+a).join(',')],{timeout:10000});
      const certificate=new X509Certificate(readFileSync(next));
      if(config.addresses.some(a=>!certificate.checkIP(a)))throw new Error('Renewed certificate does not match the selected addresses');
      chmodSync(next,0o600);renameSync(next,cert);
    } finally {rmSync(next,{force:true});}
  }
  material() {
    const key=readFileSync(join(this.directory,'tls.pem'),'utf8'), cert=readFileSync(join(this.directory,'tls.crt'),'utf8'), identity=readFileSync(join(this.directory,'identity.pem'),'utf8');
    const certificate=new X509Certificate(cert),spki=certificate.publicKey.export({type:'spki',format:'der'});
    return {key,cert,identity,certificate:certificate.raw.toString('base64url'),spki:bytesDigest(spki),identityKey:createPublicKey(identity).export({type:'spki',format:'der'}).toString('base64url')};
  }
}
