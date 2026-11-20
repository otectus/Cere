/**
 * Image work for every conversation, independent of its chat model: a text-only Ollama conversation can
 * ask a configured image backend for a picture. Manual Workbench actions call the same service.
 *
 * One operation, one visible result: each request gets a durable operation record before anything is
 * sent, a budget reservation, a single submission, and one result card that is updated in place. Outputs
 * are kept as artifacts the moment they arrive. A refusal, a missing image and a corrupt image are
 * different outcomes; a request whose answer was lost is `unknown` and is never sent again by itself.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../paths.ts';
import type { Core } from '../core.ts';
import type { ArtifactStore, ArtifactVersion } from '../artifacts/store.ts';
import { OperationStore, terminalStates, type Operation } from '../operations/store.ts';
import { routeAllowed, routeLabels, type ArtifactRef, type ProcessingRoute } from '../tools/contracts.ts';
import { BackendRefusal, type ImageBackend, type ImageCapabilities, type ImageEvent, type ImageRequest, type ResolvedInputs } from './contracts.ts';
import { OpenAiImages, openaiImageModels } from './backends/openai.ts';
import { GoogleImages, googleImageModels } from './backends/google.ts';
import { analyzeWorkflow, ComfyImages, type ComfyWorkflow } from './backends/comfyui.ts';
import { verifyImage } from './download.ts';
import { inspect, normalizeMask, protectOutside } from './transforms.ts';
import { ExtensionSecrets } from '../extensions.ts';
import sharp from 'sharp';

/** Connection lists built by the broker itself (workflow imports); only these may carry workflow records. */
export const trustedConnectionLists = new WeakSet<object>();

export type ImageConnection = {
  id: string; name: string; kind: 'openai' | 'google' | 'comfyui'; model: string; enabled: boolean;
  /** ComfyUI only: the exact server origin, where it processes, and whether it interrupts by prompt ID. */
  origin?: string; route?: ProcessingRoute; targetedInterrupt?: boolean;
  workflows?: ComfyWorkflow[]; workflowId?: string;
  /** A model may start jobs on this connection without asking each time, up to this many images a day. */
  budget: { imagesPerDay: number; modelMayStart: boolean };
  billingAcknowledged?: boolean;
  revision: number;
};
export const mediaLimits = { connections: 8, workflows: 16, waitMs: 90_000, deadlineMs: 30 * 60_000, progressMs: 300 };
const uuid = /^[0-9a-f-]{36}$/;

/** Validates the connection list from a settings patch; revisions bump on any change so old approvals retire. */
export function validConnections(value: unknown, previous: ImageConnection[]): ImageConnection[] {
  if (!Array.isArray(value) || value.length > mediaLimits.connections) throw new Error(`Configure up to ${mediaLimits.connections} image connections`);
  // Workflows are imported and reviewed through their own requests; a settings patch from a client keeps the stored ones.
  const trusted = trustedConnectionLists.has(value);
  return value.map((item: any) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid image connection');
    const kind = item.kind;
    if (!['openai', 'google', 'comfyui'].includes(kind)) throw new Error('An image connection uses OpenAI, Google or ComfyUI');
    const name = typeof item.name === 'string' && item.name.trim() && item.name.trim().length <= 60 && !/[\x00-\x1f]/.test(item.name) ? item.name.trim() : '';
    if (!name) throw new Error('Name the image connection (up to 60 characters)');
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (kind !== 'comfyui' && (!model || model.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(model))) throw new Error('Choose or type the image model ID');
    let origin: string | undefined;
    if (kind === 'comfyui') {
      let url: URL; try { url = new URL(String(item.origin || '')); } catch { throw new Error('Enter the ComfyUI address, such as http://127.0.0.1:8188'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use the ComfyUI server origin only, such as http://127.0.0.1:8188');
      origin = url.origin;
      if (item.route !== undefined && !['local', 'remote', 'cloud', 'unknown'].includes(item.route)) throw new Error('Choose where the ComfyUI server runs');
    }
    const id = typeof item.id === 'string' && uuid.test(item.id) ? item.id : randomUUID(), before = previous.find(connection => connection.id === id);
    const budget = item.budget || {};
    if (budget.imagesPerDay !== undefined && (!Number.isInteger(budget.imagesPerDay) || budget.imagesPerDay < 0 || budget.imagesPerDay > 500)) throw new Error('A daily image budget is 0–500 (0 means models must always ask)');
    const next: ImageConnection = { id, name, kind, model: kind === 'comfyui' ? '' : model, enabled: item.enabled !== false,
      ...(kind === 'comfyui' ? { origin, route: item.route || (/^(127\.|localhost$|\[?::1\]?$)/.test(new URL(origin!).hostname) ? 'local' : 'remote'), targetedInterrupt: item.targetedInterrupt === true, workflows: trusted && Array.isArray(item.workflows) ? item.workflows : before?.workflows || [], ...(typeof item.workflowId === 'string' ? { workflowId: item.workflowId } : before?.workflowId ? { workflowId: before.workflowId } : {}) } : {}),
      budget: { imagesPerDay: budget.imagesPerDay ?? before?.budget.imagesPerDay ?? 20, modelMayStart: budget.modelMayStart === true },
      ...(item.billingAcknowledged === true || before?.billingAcknowledged ? { billingAcknowledged: true } : {}), revision: before?.revision || 1 };
    const material = (c?: ImageConnection) => c ? JSON.stringify([c.kind, c.model, c.origin, c.route, c.targetedInterrupt, c.enabled, c.budget, c.workflowId]) : '';
    if (before && material(before) !== material(next)) next.revision = before.revision + 1;
    return next;
  });
}

type Waiter = { resolve: () => void };
export class MediaService {
  core: Core; artifacts: ArtifactStore; operations: OperationStore; secrets: ExtensionSecrets;
  /** The user's current image selection per conversation, so "this image" means what is selected. */
  selections = new Map<string, ArtifactRef>();
  private controllers = new Map<string, AbortController>();
  private running = new Set<Promise<unknown>>();
  /** Set at shutdown: a dispatched job keeps its recorded state so the next start reconciles it by status. */
  private closing = false;
  private partials = new Map<string, string>();
  private gpuBusy = false; private gpuQueue: Waiter[] = [];
  private lastProgress = new Map<string, number>();
  fetch: typeof fetch = (...args) => fetch(...args);
  constructor(core: Core, artifacts: ArtifactStore, operations: OperationStore) {
    this.core = core; this.artifacts = artifacts; this.operations = operations;
    this.secrets = new ExtensionSecrets(join(core.store.directory, 'credentials'), 'image-connection-secrets.json');
  }
  connections(): ImageConnection[] { return this.core.settings.workbench?.imageConnections || []; }
  connection(id: unknown): ImageConnection {
    const list = this.connections().filter(connection => connection.enabled);
    const found = typeof id === 'string' && id ? list.find(connection => connection.id === id) : list[0];
    if (!found) throw new BackendRefusal('no_connection', list.length ? 'That image connection does not exist or is turned off' : 'No image backend is set up. Add one in Settings → Connections → Images.');
    return found;
  }
  private workflowsDir() { return privateDir(join(this.core.store.directory, 'media', 'workflows')); }
  async graph(workflow: ComfyWorkflow) { return JSON.parse(await readFile(join(this.workflowsDir(), workflow.id + '.json'), 'utf8')); }
  async backend(connection: ImageConnection, workflowId?: string): Promise<ImageBackend> {
    if (connection.kind === 'openai') return new OpenAiImages(connection.model);
    if (connection.kind === 'google') return new GoogleImages(connection.model);
    const workflow = (connection.workflows || []).find(item => item.id === (workflowId || connection.workflowId)) || (connection.workflows || [])[0];
    if (!workflow) throw new BackendRefusal('no_workflow', `Import a reviewed workflow for ${connection.name} first`);
    return new ComfyImages({ origin: connection.origin!, route: connection.route || 'unknown', targetedInterrupt: !!connection.targetedInterrupt, workflows: connection.workflows || [], token: () => this.secret(connection.id) }, workflow, await this.graph(workflow));
  }
  private secret(connectionId: string) { try { return this.secrets.values(connectionId).TOKEN || ''; } catch { return ''; } }
  /** A ComfyUI access token, kept in an owner-only file and sent only to that connection's origin. */
  setToken(connectionId: unknown, token: unknown) {
    const connection = this.connection(connectionId);
    if (connection.kind !== 'comfyui') throw new Error('OpenAI and Google connections use the API keys in Settings → Connections');
    this.secrets.set(connection.id, 'TOKEN', typeof token === 'string' ? token : '');
    return { set: !!this.secret(connection.id) };
  }
  key(connection: ImageConnection) { return connection.kind === 'openai' ? this.core.credentials.key('openai') : connection.kind === 'google' ? this.core.credentials.key('google') : this.secret(connection.id); }
  async capabilities(connectionId?: unknown, workflowId?: string) { const connection = this.connection(connectionId); return { connection: this.publicConnection(connection), capabilities: (await this.backend(connection, workflowId)).describe() }; }
  publicConnection(connection: ImageConnection) {
    const { id, name, kind, model, origin, route, targetedInterrupt, workflowId, budget, billingAcknowledged, revision, enabled } = connection;
    return { id, name, kind, model, origin, route: kind === 'comfyui' ? route : 'cloud', targetedInterrupt, workflowId, budget, billingAcknowledged: !!billingAcknowledged, revision, enabled,
      workflows: (connection.workflows || []).map(({ id, name, operation, digest, cloudNodes, unknownNodes, reviewedLocal, bindings }) => ({ id, name, operation, digest: digest.slice(0, 12), cloudNodes, unknownNodes, reviewedLocal, bindings: Object.keys(bindings) })),
      hasKey: !!this.key(connection) || kind === 'comfyui', suggestions: kind === 'openai' ? openaiImageModels : kind === 'google' ? googleImageModels : [] };
  }

  // ---------- workflows ----------
  async importWorkflow(connectionId: unknown, name: unknown, graph: unknown) {
    const connection = this.connection(connectionId);
    if (connection.kind !== 'comfyui') throw new Error('Workflows belong to ComfyUI connections');
    if ((connection.workflows || []).length >= mediaLimits.workflows) throw new Error(`Keep up to ${mediaLimits.workflows} workflows per server`);
    const parsed = typeof graph === 'string' ? (() => { try { return JSON.parse(graph); } catch { throw new Error('The workflow is not valid JSON'); } })() : graph;
    const analysis = analyzeWorkflow(parsed, typeof name === 'string' && name.trim() ? name.trim() : 'Workflow');
    const workflow: ComfyWorkflow = { ...analysis, id: randomUUID(), reviewedLocal: false, created: Date.now() };
    await writeFile(join(this.workflowsDir(), workflow.id + '.json'), JSON.stringify(parsed), { mode: 0o600, flag: 'wx' });
    await this.saveConnection({ ...connection, workflows: [...(connection.workflows || []), workflow], workflowId: connection.workflowId || workflow.id, revision: connection.revision + 1 });
    let check: unknown = null;
    try { check = await (await this.backend({ ...connection, workflows: [workflow] }, workflow.id) as ComfyImages).check(this.fetch, AbortSignal.timeout(10_000)); } catch (error: any) { check = { error: error.message }; }
    return { workflow, check };
  }
  async reviewWorkflow(connectionId: unknown, workflowId: unknown, p: { reviewedLocal?: unknown; remove?: unknown }) {
    const connection = this.connection(connectionId), workflows = connection.workflows || [], workflow = workflows.find(item => item.id === workflowId);
    if (!workflow) throw new Error('That workflow no longer exists');
    if (p.remove === true) { await rm(join(this.workflowsDir(), workflow.id + '.json'), { force: true }); return this.saveConnection({ ...connection, workflows: workflows.filter(item => item.id !== workflow.id), workflowId: connection.workflowId === workflow.id ? workflows.find(item => item.id !== workflow.id)?.id : connection.workflowId, revision: connection.revision + 1 }); }
    if (typeof p.reviewedLocal !== 'boolean') throw new Error('Say whether the custom nodes run locally');
    return this.saveConnection({ ...connection, workflows: workflows.map(item => item.id === workflow.id ? { ...item, reviewedLocal: p.reviewedLocal as boolean } : item), revision: connection.revision + 1 });
  }
  private async saveConnection(connection: ImageConnection) {
    const list = this.connections().map(item => item.id === connection.id ? connection : item);
    trustedConnectionLists.add(list);
    await this.core.updateSettings({ workbench: { imageConnections: list } });
    return this.publicConnection(connection);
  }
  async test(connectionId: unknown) {
    const connection = this.connection(connectionId), signal = AbortSignal.timeout(15_000);
    if (connection.kind === 'comfyui') return (await this.backend(connection) as ComfyImages).check(this.fetch, signal);
    // A free metadata request: confirms the key works and the model is visible, without making an image.
    const key = this.key(connection);
    if (!key) throw new Error(`Add a ${connection.kind === 'openai' ? 'OpenAI' : 'Google AI'} API key in Settings → Connections`);
    const url = connection.kind === 'openai' ? 'https://api.openai.com/v1/models/' + encodeURIComponent(connection.model) : 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(connection.model);
    const response = await this.fetch(url, { headers: connection.kind === 'openai' ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }, redirect: 'error', signal });
    await response.body?.cancel().catch(() => {});
    return { reachable: response.ok, status: response.status, note: response.ok ? 'The key works and the model is listed for your account. No image was made.' : response.status === 404 ? 'The model is not listed for your account.' : 'The provider refused the key or the request.' };
  }

  // ---------- requests ----------
  /** References and masks the conversation may use, decoded and checked; another conversation's image is refused. */
  async resolve(sessionId: string, request: ImageRequest, route: ProcessingRoute): Promise<{ inputs: ResolvedInputs; versions: ArtifactVersion[] }> {
    const versions: ArtifactVersion[] = [], references: ResolvedInputs['references'] = [];
    for (const reference of request.references) {
      const { version, data } = await this.artifacts.bytes(sessionId, reference.artifactId, reference.versionId);
      if (version.kind !== 'image' && version.kind !== 'plot') throw new BackendRefusal('not_image', `${version.name} is not an image`);
      if (!routeAllowed(route, version.policy)) throw new BackendRefusal('destination', `${version.name} may only be processed on ${version.policy.remote ? 'this computer or your own servers' : 'this computer'}; this backend runs on ${routeLabels[route]}.`);
      const facts = await inspect(data);
      if (facts.frames) throw new BackendRefusal('animated', `${version.name} is animated or has several pages; export one frame first`);
      // Masks are drawn on the image as it is displayed, so a backend receives it already oriented.
      const oriented = facts.exifOrientation ? await sharp(data).rotate().png().toBuffer() : data;
      references.push({ bytes: oriented, mime: facts.exifOrientation ? 'image/png' : version.mime, width: facts.width, height: facts.height, role: reference.role });
      versions.push(version);
    }
    let mask: ResolvedInputs['mask'];
    if (request.mask) {
      const base = references.find(ref => ref.role === 'edit-base') || references[0];
      if (!base) throw new BackendRefusal('missing_reference', 'A mask needs the image it was drawn on');
      const { version, data } = await this.artifacts.bytes(sessionId, request.mask.artifactId, request.mask.versionId);
      const normalized = await normalizeMask(data, { width: base.width, height: base.height }).catch((error: Error) => { throw new BackendRefusal('mask_mismatch', error.message); });
      mask = { bytes: normalized.bytes, width: base.width, height: base.height }; versions.push(version);
    }
    return { inputs: { references, ...(mask ? { mask } : {}) }, versions };
  }
  validRequest(value: any): ImageRequest {
    if (!value || typeof value !== 'object') throw new BackendRefusal('invalid', 'Describe the image request');
    const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
    if (!prompt || prompt.length > 8000) throw new BackendRefusal('invalid', 'Write a prompt of up to 8,000 characters');
    const references = Array.isArray(value.references) ? value.references.slice(0, 16).map((ref: any) => {
      if (!ref || !uuid.test(ref.artifactId) || !uuid.test(ref.versionId)) throw new BackendRefusal('invalid', 'Name each reference by its artifact and version ID');
      return { artifactId: ref.artifactId, versionId: ref.versionId, role: ['edit-base', 'subject', 'composition', 'style'].includes(ref.role) ? ref.role : 'subject' };
    }) : [];
    const operation = value.operation || (value.mask ? 'masked-edit' : references.length ? 'edit' : 'generate');
    if (!['generate', 'edit', 'masked-edit', 'extend', 'reference'].includes(operation)) throw new BackendRefusal('invalid', 'Unknown image operation');
    if (operation !== 'generate' && !references.length) throw new BackendRefusal('missing_reference', 'Choose the image to edit');
    if (operation !== 'generate' && !references.some((ref: any) => ref.role === 'edit-base')) references[0].role = 'edit-base';
    const count = value.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new BackendRefusal('invalid', 'Make 1–4 images at a time');
    const mask = value.mask && uuid.test(value.mask.artifactId) && uuid.test(value.mask.versionId) ? { artifactId: value.mask.artifactId, versionId: value.mask.versionId, ...(Number.isInteger(value.mask.feather) ? { feather: Math.max(0, Math.min(64, value.mask.feather)) } : {}) } : undefined;
    const pick = (key: string, max = 40) => typeof value[key] === 'string' && value[key].length <= max ? value[key] : undefined;
    return { operation, prompt, ...(pick('negativePrompt', 4000) ? { negativePrompt: pick('negativePrompt', 4000) } : {}), references, ...(mask ? { mask } : {}),
      ...(pick('size') ? { size: pick('size') } : {}), ...(pick('aspectRatio') ? { aspectRatio: pick('aspectRatio') } : {}), ...(pick('imageSize') ? { imageSize: pick('imageSize') } : {}),
      format: ['png', 'jpeg', 'webp'].includes(value.format) ? value.format : 'png', ...(['transparent', 'opaque', 'auto'].includes(value.background) ? { background: value.background } : {}),
      ...(pick('quality') ? { quality: pick('quality') } : {}), count, ...(Number.isInteger(value.seed) && value.seed >= 0 && value.seed < 2 ** 32 ? { seed: value.seed } : {}),
      ...(value.protectOutside === true ? { protectOutside: true } : {}), ...(value.partials === true ? { partials: true } : {}) };
  }
  /**
   * Prepares one image operation: validated against the backend's capabilities (unsupported settings are
   * refused or visibly adjusted), inputs resolved and authorized, budget checked. The same request
   * prepared twice yields the same operation, so two clicks start one job.
   */
  async prepare(sessionId: string, raw: unknown, p: { connectionId?: unknown; workflowId?: string; origin: Operation['origin']; turnId?: string }) {
    const session = this.core.store.session(sessionId);
    if (session.temporary) throw new BackendRefusal('temporary', 'Temporary conversations stay text-only');
    if (session.remote) throw new BackendRefusal('remote', 'Images are started from the desktop');
    if (this.core.settings.paused) throw new BackendRefusal('paused', 'Cere actions are paused');
    const connection = this.connection(p.connectionId), backend = await this.backend(connection, p.workflowId), capabilities = backend.describe();
    const request = this.validRequest(raw);
    const { request: validated, adjustments } = backend.validate(request);
    if (validated.mask && capabilities.maskBehavior === 'none' && !validated.protectOutside) throw new BackendRefusal('unsupported_parameter', 'This backend has no mask input; turn on keeping pixels outside the selection unchanged');
    const { inputs, versions } = await this.resolve(sessionId, validated, capabilities.route);
    const digest = OperationStore.digest({ sessionId, connection: connection.id, revision: connection.revision, workflow: p.workflowId || connection.workflowId || '', request: validated });
    const existing = this.operations.findPrepared(sessionId, digest);
    if (existing) return { operation: existing, capabilities, adjustments, duplicate: true };
    if (connection.budget.imagesPerDay && this.operations.imagesToday(connection.id) + validated.count > connection.budget.imagesPerDay && p.origin !== 'user')
      throw new BackendRefusal('budget', `${connection.name}’s daily budget of ${connection.budget.imagesPerDay} images is used up. Raise it in Settings, or start it yourself from the Workbench.`);
    const operation = this.operations.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: validated.operation === 'generate' ? 'image.generate' : 'image.edit', origin: p.origin,
      label: (validated.operation === 'generate' ? 'Image: ' : 'Image edit: ') + validated.prompt.slice(0, 80), payloadDigest: digest,
      witness: { route: capabilities.route, connectionRevision: connection.revision, inputs: versions.map(version => ({ id: version.versionId, policy: version.policyId })) },
      inputs: validated.references.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId, purpose: ref.role })),
      backend: { connectionId: connection.id, kind: connection.kind, model: capabilities.model, ...(connection.kind === 'comfyui' ? { workflow: p.workflowId || connection.workflowId } : {}), revision: connection.revision, route: capabilities.route },
      details: { request: { ...validated, prompt: validated.prompt.slice(0, 2000) }, adjustments, billed: capabilities.billed, notes: capabilities.notes } });
    return { operation, capabilities, adjustments, duplicate: false, inputs };
  }
  /** Starts a prepared operation once. Approval (when needed) has already happened. */
  async start(operationId: string, waitMs = 0) {
    let operation = this.operations.get(operationId);
    if (operation.state !== 'prepared' && operation.state !== 'awaiting_approval') return operation;
    const connection = this.connection(operation.backend!.connectionId);
    if (connection.revision !== operation.backend!.revision) { this.operations.transition(operation.id, 'expired', { error: { code: 'connection_changed', message: 'The image connection changed after this was prepared; prepare it again' } }); throw new BackendRefusal('connection_changed', 'The image connection changed; nothing was sent'); }
    const count = Number((operation.details?.request as any)?.count) || 1;
    this.operations.reserve(operation, { images: count });
    operation = this.operations.transition(operation.id, 'queued', { reservation: { images: count, state: 'held' } });
    const controller = new AbortController(); this.controllers.set(operation.id, controller);
    // The outcome is recorded on the operation itself; this promise only tracks that the work ended.
    const finished: Promise<unknown> = this.execute(operation.id, controller.signal).catch(() => {}).finally(() => { this.controllers.delete(operationId); this.running.delete(finished); });
    this.running.add(finished);
    this.card(operation);
    if (waitMs > 0) await Promise.race([finished, new Promise(resolve => setTimeout(resolve, waitMs).unref())]);
    return this.operations.get(operation.id);
  }
  /** One local GPU-heavy job at a time; cloud jobs run alongside. */
  private async gpuSlot(local: boolean, signal: AbortSignal) {
    if (!local) return () => {};
    if (this.gpuBusy) await new Promise<void>((resolve, reject) => { const waiter = { resolve }; this.gpuQueue.push(waiter); signal.addEventListener('abort', () => { this.gpuQueue = this.gpuQueue.filter(item => item !== waiter); reject(signal.reason); }, { once: true }); });
    this.gpuBusy = true;
    if (this.core.settings.workbench?.lowMemory) await this.core.jobs.yieldToForeground(signal).catch(() => {});
    return () => { this.gpuBusy = false; this.gpuQueue.shift()?.resolve(); };
  }
  private async execute(operationId: string, signal: AbortSignal) {
    let operation = this.operations.get(operationId), dispatched = false, release = () => {};
    const removeJob = this.core.jobs.add('image', operation.label, () => { void this.cancel(operationId); }, () => operation.progress?.max ? { done: operation.progress.value || 0, total: operation.progress.max } : undefined);
    const results: ArtifactRef[] = [];
    try {
      const connection = this.connection(operation.backend!.connectionId), backend = await this.backend(connection, operation.backend!.workflow);
      const request = { ...(operation.details!.request as ImageRequest), connectionId: connection.id, connectionRevision: connection.revision, adjustments: (operation.details!.adjustments as string[]) || [] };
      release = await this.gpuSlot(operation.backend!.route === 'local' && connection.kind === 'comfyui', signal);
      const { inputs, versions } = await this.resolve(operation.sessionId, request, operation.backend!.route);
      const original = request.protectOutside ? inputs.references.find(ref => ref.role === 'edit-base') || inputs.references[0] : undefined;
      operation = this.operations.transition(operation.id, 'dispatching');
      const context = {
        signal, fetch: this.fetch, key: () => this.key(connection),
        // Authorization is checked again immediately before anything leaves the broker.
        beforeDispatch: () => {
          signal.throwIfAborted();
          if (this.core.settings.paused) throw new BackendRefusal('paused', 'Cere actions were paused before sending');
          const current = this.connection(connection.id);
          if (current.revision !== connection.revision) throw new BackendRefusal('connection_changed', 'The image connection changed before sending');
          for (const version of versions) if (!routeAllowed(operation.backend!.route, this.artifacts.version(operation.sessionId, version.artifactId, version.versionId).policy)) throw new BackendRefusal('destination', 'An input’s processing permission changed before sending');
        },
        dispatched: (remoteId?: string) => { dispatched = true; if (remoteId) operation = this.operations.update(operation.id, { remoteId }); },
      };
      for await (const event of backend.run(request, inputs, context)) {
        if (event.type === 'accepted' && operation.state === 'dispatching') { operation = this.operations.transition(operation.id, 'running', event.remoteId ? { remoteId: event.remoteId } : {}); this.card(operation); }
        else if (event.type === 'queued') operation = this.progress(operation, { note: `Queued${event.position ? ' (position ' + event.position + ')' : ''}` });
        else if (event.type === 'progress') operation = this.progress(operation, { value: event.value, max: event.max, note: event.note });
        else if (event.type === 'partial') { this.partials.set(operation.id, 'data:image/png;base64,' + (await verifyImage(event.bytes).then(v => v.bytes, () => Buffer.alloc(0))).toString('base64')); operation = this.progress(operation, { note: `Preview ${event.index + 1} (provisional)` }); }
        else if (event.type === 'usage') { operation = this.operations.update(operation.id, { usage: { ...operation.usage, ...event.usage } }); this.operations.recordUsage(operation, event.usage, connection.kind); }
        else if (event.type === 'text') operation = this.operations.update(operation.id, { details: { ...operation.details, backendText: event.text.slice(0, 2000) } });
        else if (event.type === 'continuation') operation = this.operations.update(operation.id, { details: { ...operation.details, continuation: event.id } });
        else if (event.type === 'warning') operation = this.operations.update(operation.id, { details: { ...operation.details, warnings: [...((operation.details?.warnings as string[]) || []), event.message].slice(-10) } });
        else if (event.type === 'image') {
          // Each output is verified and kept immediately; nothing depends on a provider URL staying alive.
          const verified = await verifyImage(event.bytes);
          let bytes = verified.bytes, mime = verified.mime, protectedNote = '';
          if (original && inputs.mask) {
            try { bytes = await protectOutside(original.bytes, bytes, inputs.mask.bytes, request.mask?.feather || 0); mime = 'image/png'; protectedNote = 'Pixels outside the selection were restored from the original'; }
            catch (error: any) { protectedNote = error.message; }
          }
          const version = await this.artifacts.install({ sessionId: operation.sessionId, bytes, mime, name: `${request.operation === 'generate' ? 'image' : 'edit'}-${operation.id.slice(0, 8)}-${event.index + 1}.${mime.slice(6)}`,
            source: 'model-generation', operationId: operation.id, turnId: operation.turnId, policy: this.artifacts.inherit(operation.sessionId, versions.map(v => ({ artifactId: v.artifactId, versionId: v.versionId }))),
            parents: versions.map(v => ({ artifactId: v.artifactId, versionId: v.versionId, relation: v.kind === 'image' && request.mask?.versionId === v.versionId ? 'mask' : 'reference' })),
            provenance: { kind: 'generation', backend: connection.kind, connection: connection.name, model: operation.backend!.model || '', route: operation.backend!.route, prompt: request.prompt.slice(0, 4000),
              ...(event.revisedPrompt ? { revisedPrompt: event.revisedPrompt } : {}), parameters: JSON.stringify({ size: request.size, aspectRatio: request.aspectRatio, imageSize: request.imageSize, quality: request.quality, format: request.format, background: request.background, seed: request.seed, count: request.count }),
              ...(protectedNote ? { protection: protectedNote } : {}), operationId: operation.id } });
          results.push({ artifactId: version.artifactId, versionId: version.versionId, purpose: 'generated' });
          operation = this.operations.update(operation.id, { details: { ...operation.details, produced: results.length } });
          this.card({ ...operation, results });
        }
      }
      if (!results.length) throw new BackendRefusal('no_image', 'The backend finished without an image');
      operation = this.operations.transition(operation.id, 'completed', { results });
      this.operations.settle(operation.id, 'settled');
      this.partials.delete(operation.id);
      this.core.emit('notice', { kind: 'complete', sessionId: operation.sessionId, text: results.length === 1 ? 'Image ready' : `${results.length} images ready` });
    } catch (error: any) {
      // Shutting down: nothing is decided here. A dispatched job stays recorded as it was, for reconciliation.
      if (this.closing) { if (!dispatched && !terminalStates.includes(this.operations.get(operationId).state)) this.operations.transition(operationId, 'interrupted', { recovery: 'Cere closed before this was sent; nothing was sent.' }); return; }
      const current = this.operations.get(operationId);
      const known = error instanceof BackendRefusal || !dispatched;
      const cancelled = signal.aborted;
      let state: Operation['state'] = cancelled ? (dispatched ? 'unknown' : 'cancelled') : known ? 'failed' : 'unknown';
      if (cancelled && dispatched && current.cancellation?.confirmed) state = 'cancelled';
      const message = cancelled ? (current.cancellation?.note || 'Stopped') : String(error?.message || error).slice(0, 600);
      if (!terminalStates.includes(current.state)) {
        const from = current.state;
        if (from === 'queued' && state === 'unknown') state = 'cancelled';
        operation = this.operations.transition(current.id, from === 'cancel_requested' && state === 'failed' ? 'failed' : state, { results, error: { code: error?.code || (cancelled ? 'cancelled' : 'failed'), message } });
      }
      // A known refusal or a stop before sending costs nothing to the local budget; an uncertain one stays counted.
      this.operations.settle(operationId, state === 'unknown' ? 'unknown' : results.length ? 'settled' : 'released');
    } finally { release(); removeJob(); if (!this.core.closed) this.card(this.operations.get(operationId)); }
  }
  private progress(operation: Operation, progress: { value?: number; max?: number; note?: string }) {
    // Progress is coalesced to a few updates a second; it never invents a percentage.
    const now = Date.now();
    if (now - (this.lastProgress.get(operation.id) || 0) < mediaLimits.progressMs && !progress.note) return operation;
    this.lastProgress.set(operation.id, now);
    return this.operations.update(operation.id, { progress: { ...progress, at: now } });
  }
  /** Cancels owned work as far as the backend can confirm; the outcome says which. */
  async cancel(operationId: unknown) {
    const operation = this.operations.get(operationId);
    if (terminalStates.includes(operation.state)) return operation;
    if (['prepared', 'awaiting_approval', 'queued'].includes(operation.state)) {
      this.controllers.get(operation.id)?.abort(new Error('Cancelled before sending'));
      if (!terminalStates.includes(this.operations.get(operation.id).state)) this.operations.transition(operation.id, 'cancelled', { cancellation: { requested: Date.now(), confirmed: true, note: 'Cancelled before it was sent' } });
      this.operations.settle(operation.id, 'released');
      return this.operations.get(operation.id);
    }
    let result = { confirmed: false, note: 'Cere stopped waiting; the backend may still finish this request, which may be billed.' };
    try {
      if (operation.remoteId && operation.backend) {
        const backend = await this.backend(this.connection(operation.backend.connectionId), operation.backend.workflow);
        if (backend.cancel) result = await backend.cancel(operation.remoteId, { fetch: this.fetch, signal: AbortSignal.timeout(15_000) });
      }
    } catch (error: any) { result = { confirmed: false, note: 'The backend could not be asked to cancel: ' + error.message }; }
    const current = this.operations.get(operation.id);
    if (!terminalStates.includes(current.state)) this.operations.transition(current.id, 'cancel_requested', { cancellation: { requested: Date.now(), confirmed: result.confirmed, note: result.note } });
    this.controllers.get(operation.id)?.abort(new Error(result.note));
    return this.operations.get(operation.id);
  }
  /** After a restart: jobs with a backend ID are checked by status; nothing is submitted again. */
  async reconcile(operation: Operation) {
    try {
      const backend = await this.backend(this.connection(operation.backend!.connectionId), operation.backend!.workflow);
      if (!backend.query || !operation.remoteId) return;
      const status = await backend.query(operation.remoteId, { fetch: this.fetch, signal: AbortSignal.timeout(20_000) });
      const current = this.operations.get(operation.id);
      if (status.state === 'completed' && status.images?.length) {
        const results: ArtifactRef[] = [];
        for (const [index, image] of status.images.entries()) {
          const version = await this.artifacts.install({ sessionId: operation.sessionId, bytes: image.bytes, mime: image.mime, name: `image-${operation.id.slice(0, 8)}-${index + 1}.png`, source: 'model-generation', operationId: operation.id,
            provenance: { kind: 'generation', backend: operation.backend!.kind, model: operation.backend!.model || '', route: operation.backend!.route, prompt: String((operation.details?.request as any)?.prompt || '').slice(0, 4000), recovered: true, operationId: operation.id } });
          results.push({ artifactId: version.artifactId, versionId: version.versionId, purpose: 'generated' });
        }
        this.operations.transition(current.id, current.state === 'running' || current.state === 'unknown' || current.state === 'cancel_requested' || current.state === 'dispatching' ? 'completed' : current.state, { results, recovery: 'Recovered after a restart by checking its status; nothing was submitted again.' });
        this.operations.settle(operation.id, 'settled');
      } else if (status.state === 'failed') { this.operations.transition(current.id, 'failed', { error: { code: 'workflow_failed', message: status.error || 'failed' }, recovery: 'Checked after a restart.' }); this.operations.settle(operation.id, 'released'); }
      else if (status.state === 'missing') { this.operations.transition(current.id, 'unknown', { recovery: 'After a restart, the backend no longer lists this job; its outcome is unknown and it was not sent again.' }); this.operations.settle(operation.id, 'unknown'); }
      else { this.operations.update(current.id, { details: { ...current.details, reconciling: false, observable: status.state } }); void this.follow(current.id); }
    } catch (error: any) { this.operations.update(operation.id, { details: { ...operation.details, reconciling: false, reconcileError: String(error?.message || error).slice(0, 300) } }); }
    finally { this.card(this.operations.get(operation.id)); }
  }
  /** Keeps checking a recovered job that is still queued or running, by status only. */
  private async follow(operationId: string) {
    const operation = this.operations.get(operationId);
    const controller = new AbortController(); this.controllers.set(operationId, controller);
    try {
      for (let attempt = 0; attempt < 1800 && !controller.signal.aborted; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000).unref());
        const current = this.operations.get(operationId);
        if (terminalStates.includes(current.state)) return;
        await this.reconcile(current);
        if (terminalStates.includes(this.operations.get(operationId).state)) return;
      }
    } finally { this.controllers.delete(operationId); void operation; }
  }
  partial(operationId: string) { return this.partials.get(operationId) || ''; }
  /** One result card per operation, updated in place: repeated polls never add another. */
  card(operation: Operation) {
    try {
      const states: Record<string, string> = { prepared: 'Prepared', awaiting_approval: 'Waiting for your approval', queued: 'Queued', dispatching: 'Sending', running: 'Generating', cancel_requested: 'Cancelling',
        completed: 'Complete', failed: 'Failed', cancelled: 'Cancelled', declined: 'Declined', expired: 'Expired', interrupted: 'Interrupted', unknown: 'Outcome unknown' };
      const lines = [`${operation.label}`, `${states[operation.state] || operation.state}${operation.backend ? ' · ' + (this.connections().find(c => c.id === operation.backend!.connectionId)?.name || operation.backend.kind) + ' · ' + routeLabels[operation.backend.route] : ''}`];
      if (operation.error && operation.state !== 'completed') lines.push(operation.error.message);
      if (operation.cancellation?.note && operation.state !== 'completed') lines.push(operation.cancellation.note);
      if (operation.recovery) lines.push(operation.recovery);
      if ((operation.details?.adjustments as string[] | undefined)?.length) lines.push('Adjusted: ' + (operation.details!.adjustments as string[]).join('; '));
      this.core.putMessage({ id: `${operation.sessionId}:op:${operation.id}`, sessionId: operation.sessionId, role: 'workbench', kind: 'operation', operationId: operation.id, time: operation.created,
        text: lines.join('\n'), ...(operation.results.length ? { artifacts: operation.results.slice(0, 16) } : {}) });
    } catch { /* the conversation is gone */ }
  }
  /** The user's selected image in a conversation, so "this image" resolves to it and to nothing else. */
  select(sessionId: string, ref: unknown) {
    if (ref === null) { this.selections.delete(sessionId); return true; }
    const value = ref as ArtifactRef;
    const version = this.artifacts.version(sessionId, value?.artifactId, value?.versionId);
    this.selections.set(sessionId, { artifactId: version.artifactId, versionId: version.versionId, purpose: 'selected' });
    return true;
  }
  cancelAll() { for (const controller of this.controllers.values()) controller.abort(new Error('Cere is closing')); }
  /** Stops waiting on every job, leaves dispatched ones recorded for reconciliation, and settles before the store closes. */
  async close(boundMs = 3000) {
    this.closing = true; this.cancelAll();
    await Promise.race([Promise.allSettled([...this.running]), new Promise(resolve => setTimeout(resolve, boundMs).unref())]);
  }
  async ensureDirectories() { await mkdir(this.workflowsDir(), { recursive: true }); }
  capabilitiesSummary(capabilities: ImageCapabilities) {
    const state = (value: { state: string; note?: string }) => value.state + (value.note ? ` (${value.note})` : '');
    return { backend: capabilities.backend, model: capabilities.model, processes: routeLabels[capabilities.route], billed: capabilities.billed, generate: state(capabilities.generate), edit: state(capabilities.edit), mask: state(capabilities.mask), maskBehavior: capabilities.maskBehavior,
      references: capabilities.maxReferences, formats: capabilities.formats, transparency: state(capabilities.transparency), sizes: capabilities.sizes, ...(capabilities.customSize ? { customSize: capabilities.customSize } : {}),
      ...(capabilities.aspectRatios ? { aspectRatios: capabilities.aspectRatios } : {}), ...(capabilities.imageSizes ? { imageSizes: capabilities.imageSizes } : {}), ...(capabilities.qualities ? { qualities: capabilities.qualities } : {}),
      maxCount: capabilities.maxCount, seed: state(capabilities.seed), negativePrompt: state(capabilities.negativePrompt), notes: capabilities.notes };
  }
}
