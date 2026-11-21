/**
 * A stand-in phone for network-return pairing tests: answers a cere-pair offer with fresh keys over
 * the pinned gateway, prints the six words it computed on the first line, and exits 0 when the
 * desktop confirms (1 when it closes the offer, 2 on timeout).
 *
 *   node tests/fixtures/phone-network-answer.ts 'cere-pair://v1/…'
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign, createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { canonical, digest, parsePairing, pairingUri } from '../../broker/remote/crypto.ts';

const offer = parsePairing(process.argv[2] || '') as any;
const keypair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = (pair: ReturnType<typeof keypair>) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const connection = keypair(), action = keypair();
const body = { type: 'response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: digest(offer), nonce: offer.nonce, deviceId: randomUUID(), name: 'Fixture phone', keyVersion: 1,
  connectionKey: pub(connection), actionKey: pub(action), deviceNonce: randomBytes(32).toString('base64url') };
const transcript = { domain: 'cere.mobile.pair.response.v1', response: body };
const proof = (pair: ReturnType<typeof keypair>) => sign('sha256', Buffer.from(canonical(transcript)), pair.privateKey).toString('base64url');
const response = { ...body, connectionProof: proof(connection), actionProof: proof(action) };
const words: string[] = JSON.parse(readFileSync(new URL('../../protocol/mobile/v1/sas-words.json', import.meta.url), 'utf8'));
console.log([...createHash('sha256').update(digest(offer) + '.' + digest(response)).digest().subarray(0, 6)].map(v => words[v]).join(' '));
// Pinned to the certificate the offer carries, as the phone is.
const certificate = new X509Certificate(Buffer.from(offer.certificate, 'base64url')).toString();
const socket = new WebSocket(offer.endpoints[0], 'cere.mobile.v1', { ca: certificate });
const timer = setTimeout(() => { console.log('timeout'); process.exit(2); }, 60_000);
socket.on('open', () => socket.send(JSON.stringify({ v: 1, type: 'pair.response', response: pairingUri(response) })));
socket.on('message', data => {
  const frame = JSON.parse(String(data));
  console.log(frame.type + (frame.reason ? ' ' + frame.reason : ''));
  if (frame.type === 'pair.confirmed') { clearTimeout(timer); socket.close(); process.exit(0); }
  if (frame.type === 'pair.closed') { clearTimeout(timer); process.exit(1); }
});
socket.on('error', error => { console.log('error ' + error.message); });
