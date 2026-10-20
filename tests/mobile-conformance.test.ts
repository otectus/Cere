/**
 * W15: golden response and event fixtures. A real gateway, paired the same way a phone pairs, answers
 * representative operations over a real WebSocket; every frame is recorded exactly as sent, with
 * volatile values (IDs, digests, times, paths, build) normalized, and compared with
 * protocol/mobile/v1/conformance.json. Android's ConformanceTest decodes every recorded frame with the
 * phone's own models, so a DTO change that the phone cannot read fails on both sides.
 * Regenerate after an intended protocol change with CERE_UPDATE_CONFORMANCE=1, then review the diff.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { canonical, digest, parsePairing, pairingUri } from '../broker/remote/crypto.ts';
import type { Hooks } from '../broker/providers.ts';

const golden = new URL('../protocol/mobile/v1/conformance.json', import.meta.url);
const keypair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = (pair: ReturnType<typeof keypair>) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const proof = (pair: ReturnType<typeof keypair>, value: unknown) => sign('sha256', Buffer.from(canonical(value)), pair.privateKey).toString('base64url');
async function port() { const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const p = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return p; }

/** Stable placeholders: each distinct ID, digest or reference keeps its own number across all frames. */
function normalizer(project: string) {
  const seen = new Map<string, string>();
  const placeholder = (kind: string, value: string) => { const key = kind + value; if (!seen.has(key)) seen.set(key, `<${kind}:${[...seen.keys()].filter(k => k.startsWith(kind)).length + 1}>`); return seen.get(key)!; };
  const walk = (value: any, key = ''): any => {
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    if (typeof value === 'number') return value > 1e12 && value < 1e14 ? 0 : value;
    if (typeof value !== 'string') return value;
    if (key === 'brokerBuild') return '<build>';
    if (key === 'version' && /^\d+\.\d+\.\d+$/.test(value)) return '<version>';
    if (key === 'commit') return '<commit>';
    // The test's own fixed message IDs are deterministic and stay readable.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !value.startsWith('11111111-1111-4111-8111-')) return placeholder('uuid', value);
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return placeholder('digest', value);
    if (/^[A-Za-z0-9_-]{22}$/.test(value) && /agent|id/i.test(key)) return placeholder('ref', value);
    return value.split(project).join('<project>');
  };
  return (frame: unknown) => {
    const normalized = walk(frame);
    // Placeholders keep each field's type: the phone decodes these frames.
    if (normalized?.build) normalized.build = { version: '<version>', commit: '<commit>', dirty: false };
    return normalized;
  };
}

test('W15 gateway responses and events match the golden conformance fixtures Android decodes', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-conformance-')), project = join(directory, 'project');
  await mkdir(project);
  const hooks = new Map<string, Hooks>();
  const core = new Core(new Store(join(directory, 'state')), (session, h) => { hooks.set(session.id, h); return { async send(_text, _images, options) { h.policy?.(true); options?.beforeAccept?.(); options?.onDispatched?.(); options?.onAccepted?.(); }, async interrupt() {}, async close() {} }; });
  const gateway = new MobileGateway(core);
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await gateway.close(); await core.close(); await rm(directory, { recursive: true, force: true }); });
  // Deterministic provider catalog: detection is not run in tests.
  core.capabilities = { codex: { available: true, version: '0.0.0-fixture', models: [{ id: 'fixture-model', displayName: 'Fixture model', efforts: [{ id: 'low', displayName: 'Low' }], defaultEffort: 'low', isDefault: true }], modelsStatus: 'ready' }, claude: { available: false, modelsStatus: 'unavailable' } } as any;
  await core.updateSettings({ showMemoryCitations: false, ollama: { host: 'http://127.0.0.1:9' } });
  await gateway.start();
  const pairing: any = await gateway.local('remote.preparePair', { addresses: ['127.0.0.1'], name: 'Conformance desktop', port: await port() });
  const offer = parsePairing(pairing.uri), connection = keypair(), action = keypair(), deviceId = randomUUID();
  const body = { type: 'response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: digest(offer), nonce: offer.nonce, deviceId, name: 'Conformance phone', keyVersion: 1, connectionKey: pub(connection), actionKey: pub(action), deviceNonce: randomBytes(32).toString('base64url') };
  const transcript = { domain: 'cere.mobile.pair.response.v1', response: body };
  const response = pairingUri({ ...body, connectionProof: proof(connection, transcript), actionProof: proof(action, transcript) });
  const review: any = await gateway.local('remote.reviewPair', { response });
  await gateway.local('remote.confirmPair', { response, sas: review.sas, confirmed: true, projectPaths: [project], caps: ['chat.read', 'chat.write', 'providers.execute', 'approvals.answer', 'approvals.provider', 'settings.write'], categories: [], scriptIds: [] });
  const device = gateway.registry.live(deviceId)!;

  // A recording client: every text frame, in arrival order.
  const ws = new WebSocket(offer.endpoints[0], 'cere.mobile.v1', { ca: gateway.identity.material().cert }); sockets.push(ws);
  const frames: any[] = [], waiting = new Map<string, (frame: any) => void>(), events: any[] = [];
  let pending: ((frame: any) => void) | undefined;
  ws.on('message', (bytes, binary) => { if (binary) return; const frame = JSON.parse(String(bytes)); frames.push(frame); if (frame.type === 'event') { events.push(frame); return; } if (frame.type === 'response' && waiting.has(frame.id)) { waiting.get(frame.id)!(frame); waiting.delete(frame.id); return; } pending?.(frame); });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const next = () => new Promise<any>(resolve => { pending = frame => { pending = undefined; resolve(frame); }; });
  const hello = { v: 1, type: 'hello', protocolMin: 0, protocolMax: 0, desktopId: offer.desktopId, deviceId, keyVersion: 1, clientNonce: randomBytes(32).toString('base64url'), appVersion: 'conformance' };
  let reply = next(); ws.send(JSON.stringify(hello)); const { v, type, ...challenge } = await reply;
  reply = next(); ws.send(JSON.stringify({ v: 1, type: 'auth', challengeId: challenge.challengeId, signature: proof(connection, { domain: 'cere.mobile.auth.v1', helloDigest: digest(hello), challenge, desktopId: offer.desktopId, deviceId, keyVersion: 1, epoch: challenge.epoch }) }));
  const welcome = await reply;
  const request = (method: string, params: any = {}, commandId?: string, actionProof?: any) => new Promise<any>(resolve => { const id = randomUUID(); waiting.set(id, resolve); ws.send(JSON.stringify({ v: 1, type: 'request', id, method, params, ...(commandId ? { commandId } : {}), ...(actionProof ? { proof: actionProof } : {}) })); });
  const signed = async (method: string, params: any) => {
    const commandId = randomUUID(), issued = (await request('commands.challenge', { method, paramsDigest: digest(params), commandId })).result;
    const signature = proof(action, { domain: 'cere.mobile.action.v1', desktopId: offer.desktopId, deviceId, keyVersion: 1, scopeVersion: device.scopeVersion, epoch: welcome.epoch, authSessionId: welcome.authSessionId, challengeId: issued.challengeId, nonce: issued.nonce, method, paramsDigest: digest(params), commandId });
    return { response: await request(method, params, commandId, { challengeId: issued.challengeId, signature }), commandId };
  };

  // Content: a phone-owned conversation with Unicode, a table, a hidden citation, sources, a message
  // past the preview limit, tool activity and an agent's pending request.
  const projectId = device.projects[0].id;
  const created = (await signed('sessions.create', { provider: 'codex', projectId, title: 'Ünïcode 🦊 conformance', tools: false })).response.result;
  await signed('sessions.send', { sessionId: created.id, text: 'Start the check', attachments: [], webSearch: false, expectedDraftRevision: created.draftRevision, expectedConfigRevision: created.configRevision });
  const at = Date.now(), message = (id: string, role: string, kind: string, text: string, extra: any = {}) => core.putMessage({ id, sessionId: created.id, role, kind, text, time: at + frames.length, ...extra } as any);
  message('11111111-1111-4111-8111-000000000001', 'user', 'text', 'Compare the 漢字 results | in a table');
  message('11111111-1111-4111-8111-000000000002', 'assistant', 'text', '| a | b |\n|---|---|\n| 1 | 🦊 |\n\nYou prefer Ruff [evidence:ea105855-1459-41da-b270-d370d2b54457].', { sources: [{ title: 'Ruff docs', url: 'https://docs.astral.sh/ruff/' }, { title: 'Unsafe', url: 'javascript:alert(1)' }] });
  for (let n = 0; n < 3; n++) message(`11111111-1111-4111-8111-00000000010${n}`, 'tool', 'tool', `tool step ${n}\nliteral <output> & "quotes"`);
  message('11111111-1111-4111-8111-000000000004', 'assistant', 'text', 'x'.repeat(20000) + ' end');
  core.updateSession(created.id, { agents: [{ id: 'native-thread-secret-1', name: 'Scout', task: 'Inspect', status: 'waiting', updated: at }] });
  void hooks.get(created.id)!.approve({ kind: 'provider', title: 'Run the checks', detail: 'npm test', choices: ['allow', 'deny'], nativeRequestId: 'native-request-1', nativeThreadId: 'native-thread-secret-1' } as any);
  await new Promise(resolve => setTimeout(resolve, 50));
  // A desktop conversation outside the phone's project, for the scope error.
  const outside = await core.create({ provider: 'codex', cwd: directory, trusted: true, title: 'Outside' });

  const cases: { name: string; decode: string; frame: any }[] = [];
  const record = (name: string, decode: string, frame: any) => cases.push({ name, decode, frame });
  record('welcome', 'Welcome', welcome);
  const snapshot = await request('sync.open', { selectedSessionId: created.id }); record('sync.open', 'SyncSnapshot', snapshot);
  record('sessions.list withIds', 'SessionPage', await request('sessions.list', { withIds: true }));
  record('sessions.batch', 'SessionBatch', await request('sessions.batch', { sessionIds: [created.id, outside.id] }));
  const current = await request('sessions.get', { sessionId: created.id }); record('sessions.get', 'Session', current);
  const page = await request('sessions.messages', { sessionId: created.id, limit: 2 }); record('sessions.messages', 'MessagePage', page);
  const long = page.result.items.find((item: any) => item.id === '11111111-1111-4111-8111-000000000004');
  record('sessions.messagePart', 'MessagePart', await request('sessions.messagePart', { sessionId: created.id, messageId: long.id, revision: long.revision, part: 0 }));
  const activity = await request('activity.page', { sessionId: created.id, limit: 2 }); record('activity.page', 'MessagePage', activity);
  record('activity.page continued', 'MessagePage', await request('activity.page', { sessionId: created.id, before: activity.result.before, limit: 2 }));
  record('activity.list', 'MessageList', await request('activity.list', { sessionId: created.id, limit: 2 }));
  record('approvals.list', 'ApprovalList', await request('approvals.list'));
  record('settings.get', 'JsonObject', await request('settings.get'));
  record('permissions.get', 'JsonObject', await request('permissions.get'));
  record('devices.self', 'JsonObject', await request('devices.self'));
  record('projects.list', 'ProjectList', await request('projects.list'));
  const draft = await signed('drafts.put', { sessionId: created.id, text: 'Draft ✓', expectedRevision: current.result.draftRevision });
  record('drafts.put', 'JsonObject', draft.response); record('commands.status', 'JsonObject', await request('commands.status', { commandId: draft.commandId }));
  // W10: a desktop draft attachment, as the open conversation lists it and as the phone reviews it.
  await writeFile(join(directory, 'notes ✓.txt'), 'Notes ✓\n');
  const notes = await core.attachments.import(created.id, join(directory, 'notes ✓.txt'));
  record('sessions.get with desktop draft attachments', 'Session', await request('sessions.get', { sessionId: created.id }));
  record('drafts.attachmentPreview text', 'JsonObject', await request('drafts.attachmentPreview', { sessionId: created.id, attachmentId: notes.id }));
  // W11: a pinned reply, and the list of pins.
  record('messages.bookmark', 'Message', (await signed('messages.bookmark', { sessionId: created.id, messageId: '11111111-1111-4111-8111-000000000002', bookmarked: true })).response);
  record('messages.bookmarks', 'MessagePage', await request('messages.bookmarks', { sessionId: created.id }));
  record('sessions.behavior', 'JsonObject', await request('sessions.behavior', { sessionId: created.id }));
  record('workflows.status', 'JsonObject', await request('workflows.status', { sessionId: created.id }));
  record('error SCOPE_DENIED', 'Error', await request('sessions.get', { sessionId: outside.id }));
  record('error REVISION_CONFLICT', 'Error', (await signed('sessions.rename', { sessionId: created.id, title: 'Renamed', expectedRevision: '999' })).response);
  record('error INVALID_ARGUMENT', 'Error', await request('sessions.unknown', {}));
  // Events whose timing is under the test's control; snapshot.changed is paced, so any one will do.
  core.putMessage({ id: '11111111-1111-4111-8111-000000000005', sessionId: created.id, role: 'assistant', kind: 'text', text: 'Streaming [evidence:ea10', time: at + 99 } as any);
  core.emit('notice', { kind: 'complete', sessionId: created.id, text: 'done' });
  const eventNamed = async (check: (event: any) => boolean) => { for (let n = 0; n < 200; n++) { const found = events.find(check); if (found) return found; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Expected event did not arrive'); };
  record('event message.upsert', 'Event', await eventNamed(event => event.name === 'message.upsert' && event.data.id === '11111111-1111-4111-8111-000000000005'));
  record('event notice', 'Event', await eventNamed(event => event.name === 'notice' && event.data.kind === 'complete'));
  const changed = await eventNamed(event => event.name === 'snapshot.changed');
  record('event snapshot.changed', 'Event', { ...changed, cursor: '<cursor>' });

  const normalize = normalizer(project);
  const actual = { schema: 1, note: 'Generated by tests/mobile-conformance.test.ts from a real gateway; regenerate with CERE_UPDATE_CONFORMANCE=1 and review the diff. Android ConformanceTest decodes every frame.', cases: cases.map(entry => ({ name: entry.name, decode: entry.decode, frame: normalize(entry.frame) })),
    // Hand-written frames a future desktop may send: unknown fields, an unknown event, unknown status
    // and kind strings and a revision past 64 bits. The phone must read them without failing.
    forwardCompatible: [
      { name: 'unknown fields and values', decode: 'Session', frame: { v: 1, type: 'response', id: '<uuid:1>', result: { id: '<uuid:2>', provider: 'future-provider', title: 'Τίτλος', status: 'future-status', revision: '123456789012345678901234567890', futureField: { nested: [1, 2] }, agents: [{ id: '<ref:1>', name: 'A', status: 'future', updated: 0, extra: true }] } } },
      { name: 'unknown event', decode: 'Event', frame: { v: 1, type: 'event', eventId: '<uuid:3>', cursor: '<digest:1>', name: 'future.event', resourceRevision: '1', data: { anything: 'goes' }, extra: 1 } },
      { name: 'message with unknown kind', decode: 'Message', frame: { v: 1, type: 'event', eventId: '<uuid:4>', cursor: '<digest:1>', name: 'message.upsert', resourceRevision: '18446744073709551617', data: { id: 'm', sessionId: '<uuid:2>', role: 'assistant', kind: 'future-kind', text: '🦊', revision: '18446744073709551617', time: 0, sources: [{ title: 'T', url: 'https://example.com', extra: 1 }], futureField: 1 } } },
    ] };

  // Invariants that hold however the fixture is regenerated.
  assert.equal(welcome.protocol.major, 1); assert.ok(welcome.features.includes('activity.page'));
  assert.match(welcome.brokerBuild, /^\d+\.\d+\.\d+(\+[0-9a-f]{12}(\.dirty)?)?\/mobile-v1$/);
  const wire = JSON.stringify(frames);
  assert.ok(!wire.includes('native-thread-secret-1') && !wire.includes('native-request-1'), 'no native thread or request ID reaches the phone');
  const approval = snapshot.result.approvals[0], agent = snapshot.result.sessions.find((s: any) => s.id === created.id).agents[0];
  assert.equal(approval.agentId, agent.id, 'the request names its agent by the same opaque reference');
  assert.equal(snapshot.result.settings.showMemoryCitations, false);
  assert.ok(page.result.items.length === 2 && page.result.before, 'messages page with a continuation');
  assert.equal(activity.result.items.length, 2); assert.ok(activity.result.before, 'activity is pageable');
  assert.deepEqual(cases.find(entry => entry.name === 'sessions.batch')!.frame.result.missing, [outside.id]);
  assert.deepEqual(cases.find(entry => entry.name === 'sessions.get with desktop draft attachments')!.frame.result.draftAttachments.map((a: any) => [a.name, a.kind, 'path' in a]), [['notes ✓.txt', 'text', false]]);

  if (process.env.CERE_UPDATE_CONFORMANCE === '1') { await writeFile(golden, JSON.stringify(actual, null, 2) + '\n'); return; }
  const expected = JSON.parse(await readFile(golden, 'utf8'));
  assert.deepEqual(actual, expected, 'gateway frames changed: review the protocol change, then regenerate with CERE_UPDATE_CONFORMANCE=1');
});
