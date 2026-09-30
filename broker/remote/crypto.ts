import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { remoteError } from '../execution.ts';

const canonicalize = createRequire(import.meta.url)('canonicalize') as (value: unknown) => string | undefined;
export const canonical = (value: unknown): string => {
  const encoded = canonicalize(value); if (encoded === undefined) throw remoteError('INVALID_ARGUMENT','Invalid JSON value');
  return encoded;
};
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url');
export const bytesDigest = (value: Uint8Array) => createHash('sha256').update(value).digest('base64url');
export function publicKey(encoded: string) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{100,160}$/.test(encoded)) throw remoteError('INVALID_ARGUMENT','Invalid device public key');
  const key = createPublicKey({key:Buffer.from(encoded,'base64url'),format:'der',type:'spki'});
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw remoteError('INVALID_ARGUMENT','Expected a P-256 key');
  if (key.export({type:'spki',format:'der'}).toString('base64url') !== encoded) throw remoteError('INVALID_ARGUMENT','Noncanonical device public key');
  return key;
}
export function verified(key: string, transcript: unknown, signature: string) {
  try {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{90,100}$/.test(signature)) return false;
    return verify('sha256', Buffer.from(canonical(transcript)), publicKey(key), Buffer.from(signature,'base64url'));
  } catch { return false; }
}
export function signed(key: string, transcript: unknown) { return sign('sha256', Buffer.from(canonical(transcript)), key).toString('base64url'); }
export function pairingUri(value: unknown) {
  const uri = 'cere-pair://v1/' + Buffer.from(canonical(value)).toString('base64url');
  if (Buffer.byteLength(uri)>2000) throw remoteError('LIMIT_EXCEEDED','Pairing QR exceeds 2,000 bytes. Shorten the desktop name or address list.');
  return uri;
}
export function parsePairing(uri: string): any {
  if (typeof uri !== 'string' || Buffer.byteLength(uri)>2000 || !/^cere-pair:\/\/v1\/[A-Za-z0-9_-]+$/.test(uri)) throw remoteError('INVALID_ARGUMENT','Invalid Cere pairing URI');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(uri.slice('cere-pair://v1/'.length),'base64url')));
}
