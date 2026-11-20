/**
 * Model-facing image tools. Any tool-capable conversation (a text-only local model included) can ask a
 * configured image backend for work; the backend, the route, the cost note and the inputs are shown to
 * the user before a model-started job runs, unless the user gave that connection a daily budget for
 * models. Results come back as artifact references; a text model may describe the prompt and metadata,
 * and the pixels only through an attributed vision pass.
 */
import { z } from 'zod';
import { completed, declined, failed, routeLabels, type ToolResultV1 } from '../tools/contracts.ts';
import type { ToolSpec } from '../tools/registry.ts';
import type { Workbench } from '../workbench.ts';
import { terminalStates, type Operation } from '../operations/store.ts';
import { BackendRefusal } from './contracts.ts';
import { inspect, transform, validSteps } from './transforms.ts';
import { analysisImage, ocr } from './vision.ts';

const id = z.string().regex(/^[0-9a-f-]{36}$/);
const reference = z.strictObject({ artifactId: id, versionId: id, role: z.enum(['edit-base', 'subject', 'composition', 'style']).optional() });
const options = {
  connectionId: id.optional().describe('Image connection from images_capabilities; the first enabled one when omitted'),
  count: z.int().min(1).max(4).optional(), size: z.string().max(20).optional().describe('Exact pixels such as 1536x1024, where the backend takes sizes'),
  aspectRatio: z.string().max(10).optional().describe('Such as 16:9, where the backend takes aspect ratios'), imageSize: z.enum(['1K', '2K', '4K']).optional(),
  format: z.enum(['png', 'jpeg', 'webp']).optional(), background: z.enum(['transparent', 'opaque', 'auto']).optional(), quality: z.string().max(10).optional(),
  seed: z.int().min(0).max(2 ** 32 - 1).optional(), negativePrompt: z.string().max(4000).optional(),
};
const region = z.strictObject({ left: z.int().min(0), top: z.int().min(0), width: z.int().min(1), height: z.int().min(1) }).optional().describe('Pixels of the oriented image');

export function describeOperation(operation: Operation) {
  return { operationId: operation.id, state: operation.state, label: operation.label, ...(operation.results.length ? { images: operation.results.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId })) } : {}),
    ...(operation.progress ? { progress: operation.progress } : {}), ...(operation.error ? { error: operation.error.message } : {}), ...(operation.cancellation ? { cancellation: operation.cancellation.note } : {}),
    ...(operation.recovery ? { recovery: operation.recovery } : {}), ...((operation.details?.adjustments as string[] | undefined)?.length ? { adjustments: operation.details!.adjustments } : {}),
    ...(operation.state === 'unknown' ? { note: 'Outcome unknown: it may have completed and been billed. Do not start it again unless the user asks.' } : {}) };
}

export function registerImageTools(workbench: Workbench) {
  const { registry } = workbench;
  const media = () => workbench.media, artifacts = () => workbench.artifacts;
  const imagesAvailable = (session: any) => workbench.imagesAvailable(session);
  const guard = (run: (context: Parameters<ToolSpec['run']>[0], args: any) => Promise<ToolResultV1>) => async (context: Parameters<ToolSpec['run']>[0], args: any) => {
    try { return await run(context, args); }
    catch (error: any) {
      if (context.signal.aborted) throw error;
      if (error instanceof BackendRefusal) return failed(error.code, error.message, ['invalid', 'unsupported_parameter', 'missing_reference', 'mask_mismatch'].includes(error.code) ? 'explicit' : 'never');
      return failed('failed', String(error?.message || error).slice(0, 600), 'never');
    }
  };
  /** Prepares, asks the user when needed, starts, and waits a bounded time; a long job returns pending. */
  const runJob = async (context: Parameters<ToolSpec['run']>[0], request: Record<string, unknown>, connectionId?: string): Promise<ToolResultV1> => {
    const prepared = await media().prepare(context.sessionId, request, { connectionId, origin: 'model', turnId: context.turnId });
    let operation = prepared.operation;
    if (prepared.duplicate) return completed('This exact request is already in progress; nothing new was started.', describeOperation(operation), { operationId: operation.id });
    const connection = media().connection(operation.backend!.connectionId), count = Number(request.count) || 1;
    const covered = connection.budget.modelMayStart && connection.budget.imagesPerDay > 0 && workbench.operations.imagesToday(connection.id) + count <= connection.budget.imagesPerDay;
    if (!covered) {
      operation = workbench.operations.transition(operation.id, 'awaiting_approval');
      media().card(operation);
      const refs = (prepared.inputs?.references || []).length;
      const answer = await workbench.core.approval(context.sessionId, { kind: 'media-job', title: `${request.operation === 'generate' || !refs ? 'Make' : 'Edit'} ${count} image${count === 1 ? '' : 's'} with ${connection.name}?`,
        detail: [`Prompt: ${String(request.prompt).slice(0, 1500)}`, `Backend: ${connection.name} (${prepared.capabilities.model}) · processes on ${routeLabels[prepared.capabilities.route]}`, prepared.capabilities.billed ? 'This request may be billed to your account.' : 'Runs on your own server.',
          refs ? `Uses ${refs} of this conversation’s images` : '', ...(prepared.adjustments.length ? ['Adjusted: ' + prepared.adjustments.join('; ')] : []), ...prepared.capabilities.notes].filter(Boolean).join('\n'),
        choices: ['allow', 'deny'], fields: { operationId: operation.id, digest: operation.payloadDigest, reviewComplete: true } });
      if (answer.choice !== 'allow') {
        workbench.operations.transition(operation.id, 'declined');
        media().card(workbench.operations.get(operation.id));
        return declined(answer.cancelled ? 'The turn was stopped before the image request was approved; nothing was sent.' : 'The user declined this image request; nothing was sent.', { operationId: operation.id });
      }
    }
    operation = await media().start(operation.id, 90_000);
    if (!terminalStates.includes(operation.state)) return { schema: 1, status: 'pending', summary: `Still ${operation.state === 'queued' ? 'queued' : 'working'}. The result card updates when it finishes; check with operations_status. Do not start it again.`, data: describeOperation(operation), operationId: operation.id };
    if (operation.state === 'completed') return completed(`${operation.results.length} image${operation.results.length === 1 ? '' : 's'} made and kept as artifacts. You have not seen their pixels; use images_analyze if you need to describe them.`, describeOperation(operation), { artifacts: operation.results, operationId: operation.id });
    return { schema: 1, status: operation.state === 'unknown' ? 'unknown' : 'failed', summary: operation.error?.message || operation.recovery || `The request ended ${operation.state}.`, data: describeOperation(operation), operationId: operation.id,
      error: { code: operation.error?.code || operation.state, message: operation.error?.message || operation.state, retry: 'never' } };
  };

  registry.register({
    name: 'images_capabilities', family: 'images', core: true, effects: { read: true },
    description: 'The image backends set up for this conversation (with what each can do and whether it is billed), whether images can be analysed, and whether OCR is available.',
    input: z.strictObject({}), available: imagesAvailable,
    run: guard(async ({ sessionId, signal }) => {
      const connections = [];
      for (const connection of media().connections().filter(item => item.enabled)) {
        try { const backend = await media().backend(connection); connections.push({ connectionId: connection.id, name: connection.name, ...media().capabilitiesSummary(backend.describe()), modelMayStart: connection.budget.modelMayStart }); }
        catch (error: any) { connections.push({ connectionId: connection.id, name: connection.name, unavailable: error.message }); }
      }
      const vision = workbench.vision.settings();
      return completed(connections.length ? `${connections.length} image backend${connections.length === 1 ? '' : 's'}.` : 'No image backend is set up; the user can add one in Settings → Connections → Images.', {
        connections, analysis: (await workbench.vision.nativeImages(sessionId, signal)) ? 'This conversation’s model can look at images it may receive' : vision.provider ? `A vision helper (${vision.provider} ${vision.model}) can describe images` : 'No way to look at image pixels is set up',
        ocr: 'Local OCR with Tesseract when installed', selected: media().selections.get(sessionId) || null });
    }),
  });
  registry.register({
    name: 'images_list', family: 'images', core: true, effects: { read: true },
    description: 'This conversation’s images and their versions, newest first, with the image the user has selected. Use these IDs; never guess one.',
    input: z.strictObject({ limit: z.int().min(1).max(40).optional() }), available: imagesAvailable,
    run: guard(async ({ sessionId }, args) => {
      const page = artifacts().list(sessionId, { kind: 'image', limit: args.limit || 20 }), selected = media().selections.get(sessionId);
      const images = page.artifacts.map(item => ({ artifactId: item.id, name: item.name, versions: artifacts().versions(sessionId, item.id).map((version, index) => ({ version: index + 1, versionId: version.versionId, ...(version.image ? { size: `${version.image.width}×${version.image.height}`, alpha: version.image.alpha } : {}), source: version.source, ...(typeof version.provenance.prompt === 'string' ? { prompt: version.provenance.prompt.slice(0, 200) } : {}) })),
        ...(selected?.artifactId === item.id ? { selectedVersionId: selected.versionId } : {}) }));
      return completed(`${images.length} image${images.length === 1 ? '' : 's'} in this conversation${selected ? '; the user selected one' : ''}.`, { images });
    }),
  });
  registry.register({
    name: 'images_generate', family: 'images', core: true, effects: { network: true, spend: true },
    description: 'Make new images from a prompt with a configured image backend. The user sees the backend and cost before it runs (unless they set a budget). Returns artifact IDs; you will not see the pixels unless you analyse them.',
    input: z.strictObject({ prompt: z.string().min(1).max(8000), ...options }), available: imagesAvailable,
    run: guard(async (context, args) => { const { connectionId, ...request } = args; return runJob(context, { ...request, operation: 'generate', references: [] }, connectionId); }),
  });
  registry.register({
    name: 'images_edit', family: 'images', core: true, effects: { network: true, spend: true },
    description: 'Edit images: give the exact artifact and version IDs (from images_list) as references, the first with role "edit-base". Optional mask (an artifact the user painted) and protectOutside to keep pixels outside it unchanged. Creates new versions; originals stay.',
    input: z.strictObject({ prompt: z.string().min(1).max(8000), references: z.array(reference).min(1).max(16), mask: z.strictObject({ artifactId: id, versionId: id, feather: z.int().min(0).max(64).optional() }).optional(), protectOutside: z.boolean().optional(), ...options }),
    available: imagesAvailable,
    run: guard(async (context, args) => { const { connectionId, ...request } = args; return runJob(context, { ...request, operation: request.mask ? 'masked-edit' : 'edit' }, connectionId); }),
  });
  registry.register({
    name: 'images_transform', family: 'images', effects: { write: true },
    description: 'Deterministic local edits that make a new version: crop, resize (kernel "nearest" for pixel art), rotate, flip, extend the canvas, or convert format (JPEG from a transparent image needs a flatten color). No backend, no cost.',
    input: z.strictObject({ artifactId: id, versionId: id, steps: z.array(z.record(z.string(), z.unknown())).min(1).max(16) }), available: imagesAvailable,
    run: guard(async ({ sessionId, turnId }, args) => {
      const { version, data } = await artifacts().bytes(sessionId, args.artifactId, args.versionId);
      if (version.kind !== 'image' && version.kind !== 'plot') return failed('not_image', `${version.name} is not an image`, 'never');
      const result = await transform(data, validSteps(args.steps));
      const next = await artifacts().install({ sessionId, turnId, artifactId: version.artifactId, bytes: result.bytes, mime: result.mime, name: version.name.replace(/\.[a-z]+$/i, '') + '.' + result.mime.slice(6), source: 'derived', policy: version.policy,
        parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: 'transform' }], provenance: { kind: 'transform', steps: JSON.stringify(args.steps).slice(0, 2000), notes: result.notes } });
      return completed(`New version ${result.width}×${result.height} ${result.mime.slice(6).toUpperCase()}${result.notes.length ? ' (' + result.notes.join('; ') + ')' : ''}.`, { artifactId: next.artifactId, versionId: next.versionId, width: result.width, height: result.height, alpha: result.alpha },
        { artifacts: [{ artifactId: next.artifactId, versionId: next.versionId, purpose: 'transformed' }] });
    }),
  });
  registry.register({
    name: 'images_inspect', family: 'images', core: true, effects: { read: true },
    description: 'Facts about one image version: dimensions, format, transparency and opaque coverage, frames, orientation, and how it was made (prompt, backend, parameters). Deterministic; no pixels are described.',
    input: z.strictObject({ artifactId: id, versionId: id.optional() }), available: imagesAvailable,
    run: guard(async ({ sessionId }, args) => {
      const { version, data } = await artifacts().bytes(sessionId, args.artifactId, args.versionId);
      const facts = version.kind === 'image' || version.kind === 'plot' ? await inspect(data) : null;
      return workbench.restricted(completed(`${version.name}: ${facts ? `${facts.width}×${facts.height} ${facts.format}${facts.alpha ? (facts.opaquePercent !== undefined && facts.opaquePercent >= 100 ? ' with an alpha channel but no transparent pixels' : ' with transparency') : ''}` : version.mime}.`, { artifactId: version.artifactId, versionId: version.versionId, name: version.name, ...(facts || {}), source: version.source, provenance: version.provenance, created: new Date(version.createdAt).toISOString() }), version.policy);
    }),
  });
  registry.register({
    name: 'images_analyze', family: 'images', core: true, effects: { read: true, network: true },
    description: 'Look at an image or a region of it to answer a question. If this conversation’s model can see images, the image is attached for you; otherwise the configured vision helper answers and you must attribute what it reports. Private images are never sent where their permissions do not allow.',
    input: z.strictObject({ artifactId: id, versionId: id.optional(), question: z.string().min(1).max(2000), region }), available: imagesAvailable,
    run: guard(async ({ sessionId, signal }, args) => {
      const { version, data } = await artifacts().bytes(sessionId, args.artifactId, args.versionId);
      const plan = await workbench.vision.plan(sessionId, version, signal);
      if (plan.via === 'none') return declined(plan.reason, { artifactId: version.artifactId, versionId: version.versionId });
      const prepared = await analysisImage(data, args.region);
      if (plan.via === 'conversation') {
        workbench.mediaInputs.set(`${version.artifactId}:${version.versionId}:${sessionId}`, prepared.bytes);
        return workbench.restricted(completed(`The image is attached after this result for you to look at (${prepared.note}).`, { artifactId: version.artifactId, versionId: version.versionId, showModel: [{ artifactId: version.artifactId, versionId: version.versionId, purpose: 'analysis' }], image: prepared.note }), version.policy);
      }
      const answer = await workbench.vision.ask(prepared.bytes, args.question, signal, () => { const latest = artifacts().version(sessionId, version.artifactId, version.versionId); if (latest.policyId !== version.policyId) throw new Error('The image’s permissions changed before sending'); });
      return workbench.restricted(completed(`The vision helper (${plan.helper!.provider} ${plan.helper!.model}, on ${routeLabels[plan.route]}) reports — attribute this to the helper; you did not see the image yourself.`, { helperObservation: answer, image: prepared.note, untrusted: true }), version.policy);
    }),
  });
  registry.register({
    name: 'images_ocr', family: 'images', effects: { read: true },
    description: 'Extract visible text from an image or a region locally with Tesseract (when installed), line by line with positions. Nothing leaves the computer.',
    input: z.strictObject({ artifactId: id, versionId: id.optional(), region }), available: imagesAvailable,
    run: guard(async ({ sessionId, signal }, args) => {
      const { version, data } = await artifacts().bytes(sessionId, args.artifactId, args.versionId);
      const prepared = await analysisImage(data, args.region);
      const lines = await ocr(prepared.bytes, workbench.core.settings.workbench?.ocr?.languages || 'eng', signal);
      return workbench.restricted(completed(lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'} of text found (${prepared.note}).` : `No text was found (${prepared.note}). That does not prove the image has none; small or stylized text can be missed.`,
        { lines: lines.slice(0, 400), ...(lines.length > 400 ? { truncated: true } : {}) }), version.policy);
    }),
  });
  registry.register({
    name: 'operations_status', family: 'operations', core: true, effects: { read: true },
    description: 'The current state of an image job or run started in this conversation, with its results. Checking never starts anything again.',
    input: z.strictObject({ operationId: id }), available: session => workbench.families(session).has('operations') ? '' : 'Unavailable',
    run: guard(async ({ sessionId }, args) => {
      const operation = workbench.operations.get(args.operationId);
      if (operation.sessionId !== sessionId) return declined('That operation belongs to another conversation.');
      return completed(`${operation.label}: ${operation.state}.`, describeOperation(operation), { ...(operation.results.length ? { artifacts: operation.results } : {}), operationId: operation.id });
    }),
  });
  registry.register({
    name: 'operations_cancel', family: 'operations', effects: { write: true },
    description: 'Cancel an image job or run of this conversation as far as its backend can confirm; the result says whether it was confirmed.',
    input: z.strictObject({ operationId: id }), available: session => workbench.families(session).has('operations') ? '' : 'Unavailable',
    run: guard(async ({ sessionId }, args) => {
      const operation = workbench.operations.get(args.operationId);
      if (operation.sessionId !== sessionId) return declined('That operation belongs to another conversation.');
      const after = operation.kind === 'codelab.run' || operation.kind === 'command.run' ? await workbench.cancelRun(operation.id) : await media().cancel(operation.id);
      return completed(after.cancellation?.confirmed ? 'Cancelled.' : after.cancellation?.note || `It is ${after.state}.`, describeOperation(after));
    }),
  });
}
