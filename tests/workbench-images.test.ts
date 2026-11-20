import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { downloadImage, verifyImage } from '../broker/media/download.ts';
import { changedOutside } from '../broker/media/transforms.ts';
import { parseInteraction } from '../broker/media/backends/google.ts';
import { call, until, workbenchFixture } from './fixtures/workbench.ts';
import { fakeComfy, json, png, providerFetch, sse, workflow } from './fixtures/image-backends.ts';

const b64 = (bytes: Buffer) => bytes.toString('base64');
async function imageSession(f: Awaited<ReturnType<typeof workbenchFixture>>, model = 'text-tools:latest', capabilities: Record<string, boolean> = { images: true }) {
  return f.core.create({ provider: 'ollama', model, cwd: f.project, capabilities });
}
async function openaiConnection(core: Core, extra: Record<string, unknown> = {}) {
  await core.updateSettings({ workbench: { imageConnections: [{ name: 'OpenAI images', kind: 'openai', model: 'gpt-image-2.6-sunburst', budget: { imagesPerDay: 10, modelMayStart: false }, ...extra }] } });
  process.env.OPENAI_API_KEY = 'test-openai-key';
  return core.settings.workbench.imageConnections[0];
}
async function importImage(core: Core, sessionId: string, bytes: Buffer, name = 'photo.png', destinations?: Record<string, boolean>) {
  const { mkdtemp } = await import('node:fs/promises'), { join } = await import('node:path'), { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'cere-image-')); const path = join(directory, name);
  await writeFile(path, bytes);
  return core.rpc('artifacts.import', { sessionId, path, ...(destinations ? { destinations } : {}) });
}
const approvalOf = async (core: Core, kind: string) => { await until(() => [...core.approvals.values()].some(item => item.value.kind === kind)); return [...core.approvals.values()].find(item => item.value.kind === kind)!.value; };

test('IM01 a text-only Ollama conversation gets one image job from the configured backend, and no invented pixels', async t => {
  const f = await workbenchFixture(t, [() => call('images_generate', { prompt: 'A banner with a lighthouse', size: '1536x1024' }), () => ({ content: 'Here is the banner.' })]);
  await openaiConnection(f.core);
  const backend = providerFetch({ 'https://api.openai.com/v1/images/generations': async () => json({ data: [{ b64_json: b64(await png(1536, 1024)) }], usage: { input_tokens: 12, output_tokens: 4000, total_tokens: 4012 }, output_format: 'png' }) });
  f.core.workbench.media.fetch = backend.fetch;
  const session = await imageSession(f);
  await f.core.send({ id: session.id, text: 'Make me a banner' });
  const approval = await approvalOf(f.core, 'media-job');
  assert.match(approval.detail, /OpenAI images/); assert.match(approval.detail, /may be billed/); assert.match(approval.detail, /a cloud service/);
  f.core.answer({ id: approval.id, choice: 'allow' });
  await f.finished(session.id);
  assert.equal(backend.calls.length, 1, 'exactly one submission');
  assert.equal(backend.calls[0].body.model, 'gpt-image-2.6-sunburst'); assert.equal(backend.calls[0].headers.authorization, 'Bearer test-openai-key');
  const result = f.toolResults().find((r: any) => r.name === 'images_generate')!.value;
  assert.equal(result.status, 'completed'); assert.match(result.summary, /have not seen their pixels/);
  assert.equal(result.artifacts.length, 1);
  const card = f.core.store.messages(session.id).find(message => message.kind === 'operation')!;
  assert.equal(card.role, 'workbench'); assert.match(card.text, /Complete/); assert.deepEqual(card.artifacts, result.artifacts);
  const version = f.core.workbench.artifacts.version(session.id, result.artifacts[0].artifactId);
  assert.equal(version.image?.width, 1536); assert.equal(version.provenance.prompt, 'A banner with a lighthouse'); assert.equal(version.source, 'model-generation');
  assert.equal(f.core.workbench.operations.usage(session.id)[0].total_tokens, 4012, 'reported usage is recorded');
});

test('IM02 an edit uses the explicitly selected version, never another conversation’s newer image', async t => {
  const f = await workbenchFixture(t);
  await openaiConnection(f.core);
  const backend = providerFetch({ 'https://api.openai.com/v1/images/edits': async () => json({ data: [{ b64_json: b64(await png(64, 48, '#00ff00')) }] }) });
  f.core.workbench.media.fetch = backend.fetch;
  const a = await imageSession(f), b = await imageSession(f);
  const mine = await importImage(f.core, a.id, await png(64, 48, '#ff0000'), 'mine.png', { cloud: true });
  const theirs = await importImage(f.core, b.id, await png(64, 48, '#0000ff'), 'theirs.png', { cloud: true });
  await f.core.rpc('images.select', { sessionId: a.id, ref: { artifactId: mine.artifactId, versionId: mine.versionId } });
  await assert.rejects(f.core.rpc('images.generate', { sessionId: a.id, connectionId: f.core.settings.workbench.imageConnections[0].id, acknowledgeBilling: true, request: { prompt: 'warmer', references: [{ artifactId: theirs.artifactId, versionId: theirs.versionId, role: 'edit-base' }] } }), /not available in this conversation/);
  const started = await f.core.rpc('images.generate', { sessionId: a.id, connectionId: f.core.settings.workbench.imageConnections[0].id, acknowledgeBilling: true, request: { prompt: 'warmer', references: [{ artifactId: mine.artifactId, versionId: mine.versionId, role: 'edit-base' }] } });
  await until(() => f.core.workbench.operations.get(started.operationId).state === 'completed');
  const sent = Buffer.from(backend.calls[0].body.images[0].image_url.split(',')[1], 'base64');
  const pixel = await sharp(sent).extract({ left: 1, top: 1, width: 1, height: 1 }).raw().toBuffer();
  assert.deepEqual([...pixel.subarray(0, 3)], [255, 0, 0], 'the selected red image was sent, not the newer blue one');
  const result = f.core.workbench.operations.get(started.operationId).results[0];
  const versions = f.core.workbench.artifacts.versions(a.id, result.artifactId);
  assert.equal(versions[0].parents[0].versionId, mine.versionId, 'the new version records its base');
});

test('IM03/IM17 unsupported capabilities and parameters are refused or visibly adjusted before anything is sent', async t => {
  const f = await workbenchFixture(t);
  await f.core.updateSettings({ workbench: { imageConnections: [{ name: 'Gemini', kind: 'google', model: 'gemini-3.1-flash-image', budget: { imagesPerDay: 5, modelMayStart: false } }, { name: 'OpenAI', kind: 'openai', model: 'gpt-image-2.6-sunburst', budget: { imagesPerDay: 5, modelMayStart: false } }] } });
  process.env.GEMINI_API_KEY = 'test-google-key'; process.env.OPENAI_API_KEY = 'test-openai-key';
  const backend = providerFetch({});
  f.core.workbench.media.fetch = backend.fetch;
  const session = await imageSession(f);
  const [google, openai] = f.core.settings.workbench.imageConnections;
  const local = await importImage(f.core, session.id, await png(64, 48));
  await assert.rejects(f.core.rpc('images.preview', { sessionId: session.id, connectionId: f.core.settings.workbench.imageConnections[1].id, request: { prompt: 'x', references: [{ ...local, role: 'edit-base' }] } }), /may only be processed on this computer/, 'a local-only image never goes to a cloud backend');
  const base = await importImage(f.core, session.id, await png(64, 48), 'shared.png', { cloud: true }), mask = await f.core.rpc('images.mask', { sessionId: session.id, artifactId: base.artifactId, versionId: base.versionId, mask: b64(await png(64, 48, '#ffffff')) });
  const preview = (connectionId: string, request: Record<string, unknown>) => f.core.rpc('images.preview', { sessionId: session.id, connectionId, request });
  await assert.rejects(preview(google.id, { prompt: 'remove the sign', references: [{ ...base, role: 'edit-base' }], mask: { artifactId: mask.artifactId, versionId: mask.versionId } }), /no mask input/);
  await assert.rejects(preview(google.id, { prompt: 'x', background: 'transparent' }), /transparent/);
  await assert.rejects(preview(openai.id, { prompt: 'x', seed: 4 }), /do not take a seed/);
  await assert.rejects(preview(openai.id, { prompt: 'x', size: '1000x1000' }), /divisible by 16/);
  const adjusted = await preview(openai.id, { prompt: 'x', count: 3, partials: true });
  assert.match(adjusted.adjustments[0], /Previews are shown only when making one image/);
  const kept = await preview(google.id, { prompt: 'x', references: [{ ...base, role: 'edit-base' }], mask: { artifactId: mask.artifactId, versionId: mask.versionId }, protectOutside: true });
  assert.equal(kept.request.protectOutside, true);
  assert.equal(backend.calls.length, 0, 'nothing reached a backend');
});

test('IM04/IM05 masks follow the displayed orientation; protected-region edits keep every outside pixel', async t => {
  const f = await workbenchFixture(t);
  await openaiConnection(f.core);
  const backend = providerFetch({ 'https://api.openai.com/v1/images/edits': async () => json({ data: [{ b64_json: b64(await png(40, 60, '#ffff00')) }] }) });
  f.core.workbench.media.fetch = backend.fetch;
  const session = await imageSession(f);
  // Stored 60×40 with EXIF orientation 6: displayed 40×60.
  const noise = Buffer.alloc(60 * 40 * 3); for (let i = 0; i < noise.length; i++) noise[i] = (i * 31) % 251;
  const stored = await sharp(noise, { raw: { width: 60, height: 40, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
  const photo = await importImage(f.core, session.id, stored, 'rotated.jpg', { cloud: true });
  await assert.rejects(f.core.rpc('images.mask', { sessionId: session.id, ...photo, mask: b64(await png(60, 40, '#ffffff')) }), /40×60/, 'a mask in stored orientation is refused');
  const maskRaw = Buffer.alloc(40 * 60); for (let y = 10; y < 30; y++) for (let x = 5; x < 25; x++) maskRaw[y * 40 + x] = 255;
  const mask = await f.core.rpc('images.mask', { sessionId: session.id, ...photo, mask: b64(await sharp(maskRaw, { raw: { width: 40, height: 60, channels: 1 } }).png().toBuffer()) });
  const started = await f.core.rpc('images.generate', { sessionId: session.id, connectionId: f.core.settings.workbench.imageConnections[0].id, acknowledgeBilling: true,
    request: { prompt: 'remove it', references: [{ ...photo, role: 'edit-base' }], mask: { artifactId: mask.artifactId, versionId: mask.versionId }, protectOutside: true } });
  await until(() => ['completed', 'failed'].includes(f.core.workbench.operations.get(started.operationId).state));
  const operation = f.core.workbench.operations.get(started.operationId);
  assert.equal(operation.state, 'completed', operation.error?.message);
  const sent = backend.calls[0].body, image = Buffer.from(sent.images[0].image_url.split(',')[1], 'base64'), sentMask = Buffer.from(sent.mask.image_url.split(',')[1], 'base64');
  assert.deepEqual([(await sharp(image).metadata()).width, (await sharp(image).metadata()).height], [40, 60], 'the image went out already oriented');
  const maskMeta = await sharp(sentMask).metadata();
  assert.deepEqual([maskMeta.width, maskMeta.height, maskMeta.hasAlpha], [40, 60, true]);
  const alpha = async (x: number, y: number) => (await sharp(sentMask).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())[3];
  assert.equal(await alpha(10, 20), 0, 'OpenAI’s mask is transparent where it may edit'); assert.equal(await alpha(35, 5), 255);
  const { data: result } = await f.core.workbench.artifacts.bytes(session.id, operation.results[0].artifactId, operation.results[0].versionId);
  const original = await sharp(stored).rotate().png().toBuffer(), maskPng = await sharp(maskRaw, { raw: { width: 40, height: 60, channels: 1 } }).png().toBuffer();
  assert.equal(await changedOutside(original, result, maskPng), 0, 'every pixel outside the selection matches the original');
  assert.match(String(f.core.workbench.artifacts.version(session.id, operation.results[0].artifactId).provenance.protection), /restored from the original/);
});

test('IM06 a transparent image exported to JPEG needs an explicit background', async t => {
  const f = await workbenchFixture(t);
  const session = await imageSession(f);
  const clear = await importImage(f.core, session.id, await png(32, 32, '#336699', 0.4));
  await assert.rejects(f.core.rpc('images.transform', { sessionId: session.id, ...clear, steps: [{ op: 'format', format: 'jpeg' }] }), /transparency, which JPEG cannot store/);
  const flat = await f.core.rpc('images.transform', { sessionId: session.id, ...clear, steps: [{ op: 'format', format: 'jpeg', flatten: '#ffffff' }] });
  assert.equal(flat.mime, 'image/jpeg'); assert.equal(flat.image.alpha, false); assert.match(String(flat.provenance.notes), /flattened onto #ffffff/);
  const pixelArt = await f.core.rpc('images.transform', { sessionId: session.id, ...clear, steps: [{ op: 'resize', width: 128, height: 128, kernel: 'nearest' }] });
  assert.equal(pixelArt.image.width, 128); assert.match(String(pixelArt.provenance.notes), /nearest-neighbor/);
});

test('IM07/IM08 previews then a failure keep no result; a lost response is unknown and never resent', async t => {
  const f = await workbenchFixture(t);
  await openaiConnection(f.core);
  const preview = b64(await png(16, 16, '#999999'));
  let mode = 'fail';
  const backend = providerFetch({ 'https://api.openai.com/v1/images/generations': async () => {
    if (mode === 'fail') return sse([{ type: 'image_generation.partial_image', b64_json: preview, partial_image_index: 0 }, { type: 'image_generation.partial_image', b64_json: preview, partial_image_index: 1 }, { type: 'error', error: { message: 'boom' } }]);
    throw new TypeError('socket hang up');
  } });
  f.core.workbench.media.fetch = backend.fetch;
  const session = await imageSession(f), connectionId = f.core.settings.workbench.imageConnections[0].id;
  const first = await f.core.rpc('images.generate', { sessionId: session.id, connectionId, acknowledgeBilling: true, request: { prompt: 'a', partials: true } });
  await until(() => ['failed', 'completed', 'unknown'].includes(f.core.workbench.operations.get(first.operationId).state));
  const failed = f.core.workbench.operations.get(first.operationId);
  assert.equal(failed.state, 'failed'); assert.deepEqual(failed.results, []);
  assert.equal(f.core.workbench.artifacts.list(session.id).artifacts.length, 0, 'provisional previews are never kept as results');
  mode = 'lost';
  const second = await f.core.rpc('images.generate', { sessionId: session.id, connectionId, request: { prompt: 'b' } });
  await until(() => ['failed', 'completed', 'unknown'].includes(f.core.workbench.operations.get(second.operationId).state));
  const lost = f.core.workbench.operations.get(second.operationId);
  assert.equal(lost.state, 'unknown'); assert.match(lost.error!.message, /may or may not have arrived/);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(backend.calls.length, 2, 'the uncertain request was not sent again');
  await assert.rejects(f.core.rpc('operations.retry', { id: lost.id }), /Confirm/);
  assert.equal(f.core.workbench.operations.imagesToday(connectionId), 1, 'the uncertain request still counts against the budget; the refused one does not');
});

test('IM09/IM10 ComfyUI: a restart reconciles by status without resubmitting; cancelling never touches another user’s job', async t => {
  const f = await workbenchFixture(t);
  const comfy = await fakeComfy(t, { runMs: 100000, others: [{ id: 'someone-else', running: true }] });
  await f.core.updateSettings({ workbench: { imageConnections: [{ name: 'Studio', kind: 'comfyui', origin: comfy.origin, route: 'local', budget: { imagesPerDay: 0, modelMayStart: false } }] } });
  const connectionId = f.core.settings.workbench.imageConnections[0].id;
  const imported = await f.core.rpc('images.importWorkflow', { connectionId, name: 'Text to image', graph: workflow() });
  assert.deepEqual(imported.check.missingNodes, []); assert.equal(imported.workflow.operation, 'generate'); assert.equal(imported.workflow.bindings.prompt.node, '6');
  const session = await imageSession(f);
  const started = await f.core.rpc('images.generate', { sessionId: session.id, connectionId, request: { prompt: 'a red fox', size: '768x512', seed: 7 } });
  await until(() => comfy.state.prompts.length === 1 && f.core.workbench.operations.get(started.operationId).state === 'running');
  const submitted = comfy.state.prompts[0];
  assert.equal(submitted.prompt['6'].inputs.text, 'a red fox'); assert.equal(submitted.prompt['5'].inputs.width, 768); assert.equal(submitted.prompt['3'].inputs.seed, 7);
  assert.equal(f.core.workbench.operations.get(started.operationId).remoteId, submitted.prompt_id, 'the prompt ID was recorded before submission');
  // Our job waits behind someone else's running job: cancelling removes only ours from the queue.
  const cancelled = await f.core.rpc('operations.cancel', { id: started.operationId });
  await until(() => ['cancelled', 'unknown'].includes(f.core.workbench.operations.get(started.operationId).state));
  assert.deepEqual(comfy.state.deletes, [submitted.prompt_id]); assert.deepEqual(comfy.state.interrupts, [], 'no interrupt was sent');
  assert.ok(comfy.state.running.includes('someone-else'), 'the other user’s job still runs'); assert.match(cancelled.cancellation, /Removed from the ComfyUI queue/);
  // A running job of ours is not interrupted on a server without targeted interrupt.
  comfy.state.running = [];
  const second = await f.core.rpc('images.generate', { sessionId: session.id, connectionId, request: { prompt: 'a blue fox', seed: 8 } });
  await until(() => comfy.state.running.length === 1 && f.core.workbench.operations.get(second.operationId).state === 'running');
  await f.core.rpc('operations.cancel', { id: second.operationId });
  await until(() => ['cancelled', 'unknown'].includes(f.core.workbench.operations.get(second.operationId).state));
  assert.deepEqual(comfy.state.interrupts, []); assert.match(f.core.workbench.operations.get(second.operationId).cancellation!.note, /does not interrupt the server/);
  // A restart while a known job runs: status is checked and the finished image is recovered, without a second submission.
  const third = await f.core.rpc('images.generate', { sessionId: session.id, connectionId, request: { prompt: 'a green fox', seed: 9 } });
  await until(() => comfy.state.prompts.length === 3 && f.core.workbench.operations.get(third.operationId).state === 'running');
  const remoteId = comfy.state.prompts[2].prompt_id;
  await f.core.close();
  await comfy.finish(remoteId);
  const reopened = new Core(new Store(f.state)); t.after(() => reopened.close());
  await until(() => reopened.workbench.operations.get(third.operationId).state === 'completed', 10000);
  assert.equal(comfy.state.prompts.length, 3, 'nothing was submitted again');
  assert.match(reopened.workbench.operations.get(third.operationId).recovery!, /nothing was submitted again/);
});

test('IM10b with targeted interrupt declared, Cere interrupts only its own running job by ID', async t => {
  const f = await workbenchFixture(t);
  const comfy = await fakeComfy(t, { runMs: 100000, targetedInterrupt: true });
  await f.core.updateSettings({ workbench: { imageConnections: [{ name: 'Studio', kind: 'comfyui', origin: comfy.origin, route: 'local', targetedInterrupt: true, budget: { imagesPerDay: 0, modelMayStart: false } }] } });
  const connectionId = f.core.settings.workbench.imageConnections[0].id;
  await f.core.rpc('images.importWorkflow', { connectionId, name: 'T2I', graph: workflow() });
  const session = await imageSession(f);
  const started = await f.core.rpc('images.generate', { sessionId: session.id, connectionId, request: { prompt: 'x' } });
  await until(() => comfy.state.running.length === 1 && f.core.workbench.operations.get(started.operationId).state === 'running');
  await f.core.rpc('operations.cancel', { id: started.operationId });
  await until(() => ['cancelled', 'unknown'].includes(f.core.workbench.operations.get(started.operationId).state));
  assert.deepEqual(comfy.state.interrupts, [{ prompt_id: comfy.state.prompts[0].prompt_id }]);
  assert.equal(f.core.workbench.operations.get(started.operationId).state, 'cancelled');
});

test('IM11/IM12 the media downloader blocks private and redirected destinations and bounds what it decodes', async () => {
  const resolve = async (host: string) => host === 'public.example' ? ['93.184.216.34'] : host === 'sneaky.example' ? ['10.0.0.5'] : ['127.0.0.1'];
  const target = await png(8, 8);
  const seen: { url: string; headers: any }[] = [];
  const fetcher = (async (url: any, init: any) => { seen.push({ url: String(url), headers: init.headers }); return String(url).includes('redirect') ? new Response(null, { status: 302, headers: { location: 'https://sneaky.example/x.png' } }) : new Response(target); }) as typeof fetch;
  const signal = new AbortController().signal;
  await assert.rejects(downloadImage('http://127.0.0.1:9999/x.png', { origin: 'http://127.0.0.1:8188', resolve, fetch: fetcher }, signal), /HTTPS/);
  await assert.rejects(downloadImage('https://sneaky.example/x.png', { resolve, fetch: fetcher }, signal), /private network/);
  await assert.rejects(downloadImage('https://public.example/redirect.png', { resolve, fetch: fetcher, origin: 'https://public.example', headers: { Authorization: 'Bearer secret' } }, signal), /private network/);
  assert.equal(seen.length, 1, 'the redirect target was refused before any request');
  const fine = await downloadImage('http://127.0.0.1:8188/view?x', { origin: 'http://127.0.0.1:8188', headers: { Authorization: 'Bearer t' }, fetch: fetcher }, signal);
  assert.equal(fine.width, 8); assert.equal(seen.at(-1)!.headers.Authorization, 'Bearer t', 'credentials go only to the configured origin');
  await assert.rejects(verifyImage(Buffer.from('not an image')), /not a valid image/);
  await assert.rejects(verifyImage((await png(64, 64)).subarray(0, 60)), /truncated|not a valid image/);
  const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#000000' } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 2_000_000); await assert.rejects(verifyImage(bomb), /more pixels than Cere decodes/);
  const frames = await sharp({ create: { width: 8, height: 16, channels: 4, background: '#ff0000' } }).webp({ pageHeight: 8 } as any).toBuffer().catch(() => null);
  if (frames && ((await sharp(frames, { animated: true }).metadata()).pages || 1) > 1) await assert.rejects(verifyImage(frames), /animated/);
});

test('IM13 Gemini image parts and text are both kept', async t => {
  const f = await workbenchFixture(t);
  await f.core.updateSettings({ workbench: { imageConnections: [{ name: 'Gemini', kind: 'google', model: 'gemini-3.1-flash-image', budget: { imagesPerDay: 5, modelMayStart: false } }] } });
  process.env.GEMINI_API_KEY = 'test-google-key';
  const image = b64(await png(32, 32, '#00aa00'));
  const backend = providerFetch({ 'https://generativelanguage.googleapis.com/v1beta/interactions': () => json({ id: 'interaction-1', steps: [{ type: 'thought', summary: 'thinking' }, { type: 'model_output', content: [{ type: 'text', text: 'A green square, as asked.' }, { type: 'image', mime_type: 'image/png', data: image }] }] }) });
  f.core.workbench.media.fetch = backend.fetch;
  const session = await imageSession(f);
  const started = await f.core.rpc('images.generate', { sessionId: session.id, connectionId: f.core.settings.workbench.imageConnections[0].id, acknowledgeBilling: true, request: { prompt: 'a green square', aspectRatio: '1:1', imageSize: '1K' } });
  await until(() => f.core.workbench.operations.get(started.operationId).state === 'completed');
  const operation = f.core.workbench.operations.get(started.operationId);
  assert.equal(operation.details!.backendText, 'A green square, as asked.'); assert.equal(operation.details!.continuation, 'interaction-1'); assert.equal(operation.results.length, 1);
  const body = backend.calls[0].body;
  assert.deepEqual(body.response_format, { type: 'image', mime_type: 'image/png', aspect_ratio: '1:1', image_size: '1K' }); assert.equal(backend.calls[0].headers['api-revision'], '2026-05-20');
  assert.deepEqual(parseInteraction({ output_image: { data: image }, output_text: 'x' }).images.length, 1, 'the convenience fields are read too');
  const refused = providerFetch({ 'https://generativelanguage.googleapis.com/v1beta/interactions': () => json({ id: 'i2', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I can’t make that.' }] }] }) });
  f.core.workbench.media.fetch = refused.fetch;
  const second = await f.core.rpc('images.generate', { sessionId: session.id, connectionId: f.core.settings.workbench.imageConnections[0].id, request: { prompt: 'something' } });
  await until(() => ['failed', 'completed'].includes(f.core.workbench.operations.get(second.operationId).state));
  assert.match(f.core.workbench.operations.get(second.operationId).error!.message, /answered without an image: I can’t make that/);
});

test('IM14 a cloud vision helper never receives a local-only image; the reason and local options are returned', async t => {
  const f = await workbenchFixture(t);
  await f.core.updateSettings({ workbench: { vision: { provider: 'openai', model: 'gpt-vision-fixture' } } });
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const backend = providerFetch({});
  f.core.workbench.vision.fetch = backend.fetch;
  const session = await imageSession(f);
  const local = await importImage(f.core, session.id, await png(32, 32));
  const version = f.core.workbench.artifacts.version(session.id, local.artifactId);
  const plan = await f.core.workbench.vision.plan(session.id, version);
  assert.equal(plan.via, 'none'); assert.match((plan as any).reason, /may only be processed on this computer/); assert.match((plan as any).reason, /OCR and image facts still work locally/);
  const allowed = await importImage(f.core, session.id, await png(32, 32), 'shareable.png', { cloud: true });
  assert.equal((await f.core.workbench.vision.plan(session.id, f.core.workbench.artifacts.version(session.id, allowed.artifactId))).via, 'helper');
  assert.equal(backend.calls.length, 0);
});

test('IM16 two clients pressing Generate on the same request start one operation and one submission', async t => {
  const f = await workbenchFixture(t);
  await openaiConnection(f.core, { billingAcknowledged: true });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const backend = providerFetch({ 'https://api.openai.com/v1/images/generations': async () => { await gate; return json({ data: [{ b64_json: b64(await png()) }] }); } });
  f.core.workbench.media.fetch = backend.fetch;
  const session = await imageSession(f), connectionId = f.core.settings.workbench.imageConnections[0].id;
  const request = { prompt: 'same', size: '1024x1024' };
  const [first, second] = await Promise.all([f.core.rpc('images.generate', { sessionId: session.id, connectionId, request }), f.core.rpc('images.generate', { sessionId: session.id, connectionId, request })]);
  assert.equal(first.operationId, second.operationId); assert.ok(first.duplicate || second.duplicate);
  release();
  await until(() => f.core.workbench.operations.get(first.operationId).state === 'completed');
  assert.equal(backend.calls.length, 1);
});

test('IM18 the gallery returns after a restart with verified bytes; altered bytes are reported, not served', async t => {
  const f = await workbenchFixture(t);
  const session = await imageSession(f);
  const imported = await importImage(f.core, session.id, await png(300, 200, '#123456'));
  await f.core.close();
  const reopened = new Core(new Store(f.state)); t.after(() => reopened.close());
  const listed = reopened.workbench.artifacts.list(session.id).artifacts;
  assert.equal(listed.length, 1); assert.equal(listed[0].latest.image?.width, 300);
  const thumbnail = await reopened.rpc('artifacts.thumbnail', { sessionId: session.id, artifactId: imported.artifactId });
  assert.match(thumbnail.data, /^data:image\/png;base64,/);
  const path = reopened.workbench.artifacts.objectPath(imported.sha256);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('x')]));
  await assert.rejects(reopened.workbench.artifacts.bytes(session.id, imported.artifactId), /no longer match/);
  const other = await reopened.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, capabilities: { images: true } });
  assert.throws(() => reopened.workbench.artifacts.version(other.id, imported.artifactId), /not available in this conversation/, 'an ID from another conversation grants nothing');
});

test('IM15 an MCP image becomes an artifact; structured content and resource links stay available, nothing is fetched', async t => {
  const f = await workbenchFixture(t);
  const { fileURLToPath } = await import('node:url');
  const image = (await png(20, 10, '#22aa22')).toString('base64');
  await f.core.updateSettings({ extensions: [{ name: 'Media', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-media-server.mjs', import.meta.url)), image], cwd: f.directory, enabled: true, secrets: [], projects: [], allowed: ['render'], timeoutSeconds: 5 }] });
  const session = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, tools: true, trusted: true });
  await f.core.extensions.ensure(session.id);
  const result: any = await f.core.callTool(session.id, 'ext_media_render', {}, new AbortController().signal);
  assert.equal(result.schema, 1); assert.equal(result.artifacts.length, 1);
  assert.equal(result.data.structured, JSON.stringify({ points: 3, max: 30 }));
  assert.deepEqual(result.data.resourceLinks, [{ name: 'data.csv', uri: 'https://example.com/data.csv' }]);
  assert.match(result.data.output, /Rendered\.[\s\S]*kept as artifact [0-9a-f-]{36}[\s\S]*not fetched/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(image.slice(0, 40).replace(/[+/]/g, '.')), 'the bytes are not inlined into the result');
  const version = f.core.workbench.artifacts.version(session.id, result.artifacts[0].artifactId);
  assert.deepEqual([version.image?.width, version.provenance.kind, version.provenance.tool], [20, 'mcp', 'render']);
});
