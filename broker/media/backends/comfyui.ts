/**
 * ComfyUI: a configured server that runs the user's reviewed workflows. Cere binds a few named inputs
 * (prompt, negative prompt, seed, size, image, mask) in an API-format workflow the user imported, submits
 * it once with a prompt ID chosen and recorded before dispatch, observes progress, and downloads only the
 * declared output node's images through the validated downloader on the configured origin.
 *
 * Cancellation never touches anyone else's work: a queued job is removed by its own ID and the removal is
 * verified; a running job is interrupted only when the user has declared that the server interrupts by
 * prompt ID (older servers interrupt whatever runs). Otherwise Cere stops waiting and says the job may
 * still be running. Nothing installs models, nodes or packages.
 */
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { capability, type ProcessingRoute } from '../../tools/contracts.ts';
import { downloadImage } from '../download.ts';
import { whiteMeansEdit } from '../transforms.ts';
import { BackendRefusal, type BackendContext, type ImageBackend, type ImageCapabilities, type ImageEvent, type ImageRequest, type ResolvedInputs, type ValidatedImageRequest } from '../contracts.ts';

export type ComfyBinding = { node: string; input: string };
export type ComfyWorkflow = {
  id: string; name: string; digest: string; operation: 'generate' | 'edit' | 'masked-edit' | 'upscale';
  bindings: { prompt?: ComfyBinding; negative?: ComfyBinding; seed?: ComfyBinding; width?: ComfyBinding; height?: ComfyBinding; image?: ComfyBinding; mask?: ComfyBinding; output: { node: string } };
  nodes: string[]; cloudNodes: string[]; unknownNodes: string[];
  /** The user confirmed that the custom nodes in this workflow process locally. */
  reviewedLocal: boolean; created: number;
};
/** Core ComfyUI nodes that run on the server itself. Anything else is unknown until the user reviews it. */
export const localNodes = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced', 'CheckpointLoaderSimple', 'CheckpointLoader', 'CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPSetLastLayer',
  'EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyHunyuanLatentVideo', 'VAEDecode', 'VAEEncode', 'VAEEncodeForInpaint', 'VAELoader', 'SaveImage', 'PreviewImage', 'LoadImage', 'LoadImageMask', 'ImageScale', 'ImageScaleBy',
  'ImageScaleToTotalPixels', 'ImageInvert', 'ImagePadForOutpaint', 'ImageCrop', 'ImageBlur', 'ImageSharpen', 'ImageCompositeMasked', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'LatentUpscale', 'LatentUpscaleBy',
  'SetLatentNoiseMask', 'InpaintModelConditioning', 'LoraLoader', 'LoraLoaderModelOnly', 'ControlNetLoader', 'ControlNetApply', 'ControlNetApplyAdvanced', 'UNETLoader', 'DualCLIPLoader', 'CLIPLoader', 'TripleCLIPLoader',
  'FluxGuidance', 'ModelSamplingFlux', 'ModelSamplingSD3', 'ModelSamplingDiscrete', 'BasicGuider', 'CFGGuider', 'RandomNoise', 'KSamplerSelect', 'BasicScheduler', 'ConditioningZeroOut', 'ConditioningCombine',
  'ConditioningSetArea', 'ConditioningConcat', 'GrowMask', 'FeatherMask', 'InvertMask', 'SolidMask', 'MaskToImage', 'ImageToMask', 'RepeatLatentBatch', 'LatentFromBatch', 'StyleModelLoader', 'StyleModelApply',
  'CLIPVisionLoader', 'CLIPVisionEncode', 'unCLIPConditioning', 'DifferentialDiffusion', 'PerturbedAttentionGuidance', 'FreeU_V2', 'PrimitiveNode', 'Reroute']);
const cloudPattern = /(Api(Node)?$|^OpenAI|Dalle|GPTImage|Ideogram|FluxPro|Stability|Luma|Recraft|Kling|Pika|Pixverse|Minimax|Runway|Gemini|Veo|Vidu|Moonvalley|Tripo|Rodin|ByteDance|Hailuo|Rodin|Topaz|Bria)/;
const workflowLimits = { bytes: 2 * 1024 * 1024, nodes: 500 };

/** Validates an API-format workflow and detects the inputs Cere can bind. */
export function analyzeWorkflow(graph: unknown, name: string): Omit<ComfyWorkflow, 'id' | 'created' | 'reviewedLocal'> {
  const text = JSON.stringify(graph);
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || Buffer.byteLength(text) > workflowLimits.bytes) throw new Error('Import a workflow saved with “Export (API)” in ComfyUI, up to 2 MB');
  const nodes = Object.entries(graph as Record<string, any>);
  if (!nodes.length || nodes.length > workflowLimits.nodes || nodes.some(([, node]) => !node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object'))
    throw new Error('This is not an API-format workflow. In ComfyUI use Workflow → Export (API).');
  const byType = (...types: string[]) => nodes.filter(([, node]) => types.includes(node.class_type));
  const link = (value: unknown) => Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
  const textInput = (id: string | undefined) => id && (graph as any)[id]?.class_type?.startsWith('CLIPTextEncode') ? { node: id, input: 'text' in (graph as any)[id].inputs ? 'text' : 'text_g' } : undefined;
  const sampler = byType('KSampler', 'KSamplerAdvanced')[0];
  const guider = byType('CFGGuider')[0] || byType('BasicGuider')[0];
  const positive = sampler ? textInput(link(sampler[1].inputs.positive)) : guider ? textInput(link(guider[1].inputs.positive ?? guider[1].inputs.conditioning)) : undefined;
  const fluxGuidance = !positive && guider ? byType('FluxGuidance').map(([, node]) => textInput(link(node.inputs.conditioning)))[0] : undefined;
  const negative = sampler ? textInput(link(sampler[1].inputs.negative)) : guider ? textInput(link(guider[1].inputs.negative)) : undefined;
  const seedNode = sampler ? { node: sampler[0], input: 'seed' in sampler[1].inputs ? 'seed' : 'noise_seed' } : byType('RandomNoise').map(([id]) => ({ node: id, input: 'noise_seed' }))[0];
  const latent = byType('EmptyLatentImage', 'EmptySD3LatentImage')[0];
  const images = byType('LoadImage'), masks = byType('LoadImageMask');
  const output = byType('SaveImage')[0];
  if (!output) throw new Error('The workflow needs a SaveImage node; Cere downloads only that output');
  const operation: ComfyWorkflow['operation'] = (masks.length || images.length > 1) && images.length ? 'masked-edit' : images.length ? (sampler || guider ? 'edit' : 'upscale') : 'generate';
  if (operation !== 'upscale' && !(positive || fluxGuidance)) throw new Error('Cere could not find the prompt text input (a CLIPTextEncode connected to the sampler)');
  const types = [...new Set(nodes.map(([, node]) => String(node.class_type)))].sort();
  return {
    name: name.slice(0, 80), digest: createHash('sha256').update(text).digest('hex'), operation,
    bindings: { ...(positive || fluxGuidance ? { prompt: (positive || fluxGuidance)! } : {}), ...(negative ? { negative } : {}), ...(seedNode ? { seed: seedNode } : {}),
      ...(latent ? { width: { node: latent[0], input: 'width' }, height: { node: latent[0], input: 'height' } } : {}),
      ...(images[0] ? { image: { node: images[0][0], input: 'image' } } : {}),
      ...(masks[0] ? { mask: { node: masks[0][0], input: 'image' } } : images[1] ? { mask: { node: images[1][0], input: 'image' } } : {}),
      output: { node: output[0] } },
    nodes: types, cloudNodes: types.filter(type => !localNodes.has(type) && cloudPattern.test(type)), unknownNodes: types.filter(type => !localNodes.has(type) && !cloudPattern.test(type)),
  };
}
/** Where a workflow processes: partner/API nodes are cloud; unreviewed custom nodes are unknown. */
export function workflowRoute(workflow: ComfyWorkflow, serverRoute: ProcessingRoute): ProcessingRoute {
  if (workflow.cloudNodes.length) return 'cloud';
  if (workflow.unknownNodes.length && !workflow.reviewedLocal) return 'unknown';
  return serverRoute;
}

export type ComfyConnection = { origin: string; route: ProcessingRoute; targetedInterrupt: boolean; workflows: ComfyWorkflow[]; token?: () => string };
const opaque = (value: unknown) => typeof value === 'string' && value.length < 300 && !value.includes('..') && !value.startsWith('/') && !/[\x00-\x1f\\]/.test(value);

export class ComfyImages implements ImageBackend {
  connection: ComfyConnection; workflow: ComfyWorkflow; graph: Record<string, any>;
  constructor(connection: ComfyConnection, workflow: ComfyWorkflow, graph: Record<string, any>) { this.connection = connection; this.workflow = workflow; this.graph = graph; }
  private headers(extra: Record<string, string> = {}) { const token = this.connection.token?.() || ''; return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }; }
  describe(): ImageCapabilities {
    const w = this.workflow, local = 'Your reviewed ComfyUI workflow';
    const route = workflowRoute(w, this.connection.route);
    return {
      backend: 'comfyui', model: w.name, route,
      generate: capability(w.operation === 'generate' ? 'supported' : 'unsupported', local), edit: capability(w.operation === 'edit' || w.operation === 'masked-edit' || w.operation === 'upscale' ? 'supported' : 'unsupported', local),
      mask: capability(w.bindings.mask ? 'supported' : 'unsupported', local, w.bindings.mask ? 'The workflow decides how closely the mask is followed' : undefined), maskBehavior: w.bindings.mask ? 'guide' : 'none',
      maxReferences: w.bindings.image ? 1 : 0, formats: ['png'], transparency: capability('unknown', local, 'Depends on the workflow'),
      sizes: [], ...(w.bindings.width ? { customSize: { multiple: 8, minAspect: 1 / 4, maxAspect: 4, maxWidth: 4096, maxHeight: 4096 } } : {}),
      maxCount: 4, partials: capability('unsupported', local), seed: capability(w.bindings.seed ? 'supported' : 'unsupported', local, 'The same seed is not a promise of identical pixels across models or versions'),
      negativePrompt: capability(w.bindings.negative ? 'supported' : 'unsupported', local), usage: capability('unsupported', local),
      cancel: capability('supported', local, this.connection.targetedInterrupt ? 'Queued jobs are removed; a running job is interrupted by its ID' : 'Queued jobs are removed; a running job is not interrupted, because that could stop someone else’s work'),
      query: capability('supported', local),
      notes: [route === 'cloud' ? `This workflow uses cloud nodes (${w.cloudNodes.join(', ')}); content leaves your server.` : route === 'unknown' ? `This workflow uses custom nodes Cere has not reviewed (${w.unknownNodes.slice(0, 6).join(', ')}); confirm they run locally to treat it as local.` : 'Runs on your ComfyUI server.'],
      billed: route === 'cloud',
    };
  }
  validate(request: ImageRequest) {
    const capabilities = this.describe(), adjustments: string[] = [], next = { ...request };
    const refuse = (message: string): never => { throw new BackendRefusal('unsupported_parameter', message); };
    if (request.operation === 'generate' && capabilities.generate.state !== 'supported') refuse(`The workflow “${this.workflow.name}” edits images; choose a generation workflow`);
    if (request.operation !== 'generate' && capabilities.edit.state !== 'supported') refuse(`The workflow “${this.workflow.name}” only generates; choose an editing workflow`);
    if (request.mask && !this.workflow.bindings.mask && !request.protectOutside) refuse('This workflow has no mask input. Choose a masked-edit workflow, or keep pixels outside the selection by compositing.');
    if (request.negativePrompt && !this.workflow.bindings.negative) refuse('This workflow has no negative prompt input');
    if (request.seed !== undefined && !this.workflow.bindings.seed) refuse('This workflow has no seed input');
    if (request.format !== 'png') refuse('ComfyUI saves PNG; convert afterwards if you need another format');
    if (request.background === 'transparent') refuse('Transparency depends on the workflow; Cere cannot request it');
    if (request.aspectRatio || request.imageSize || request.quality) refuse('ComfyUI takes exact sizes, such as 1024x768');
    if (request.size) {
      const match = /^(\d+)x(\d+)$/.exec(request.size);
      if (!match || !this.workflow.bindings.width) refuse('This workflow has no size input');
      const width = Number(match![1]), height = Number(match![2]);
      if (width % 8 || height % 8 || width > 4096 || height > 4096 || width < 64 || height < 64) refuse('Sizes are multiples of 8 from 64 to 4096');
    }
    if (request.references.length > 1) { next.references = request.references.slice(0, 1); adjustments.push('This workflow takes one input image; only the edit base is used'); }
    if (request.partials) { next.partials = false; adjustments.push('ComfyUI previews are not shown; the finished image appears when ready'); }
    return { request: next, adjustments };
  }
  /** Checks the server and the workflow's dependencies; missing nodes or models are reported, never installed. */
  async check(fetcher: typeof fetch, signal: AbortSignal) {
    const json = async (path: string) => { const response = await fetcher(this.connection.origin + path, { headers: this.headers(), redirect: 'error', signal }); if (!response.ok) throw new Error(`ComfyUI answered HTTP ${response.status} for ${path}`); return response.json(); };
    const stats = await json('/system_stats').catch((error: Error) => { throw new BackendRefusal('offline', `ComfyUI is not reachable at ${this.connection.origin}: ${error.message}`); });
    const info = await json('/object_info');
    const missingNodes = this.workflow.nodes.filter(type => !info[type]);
    const missingModels: string[] = [];
    for (const node of Object.values(this.graph)) {
      const spec = info[node.class_type]?.input?.required || {};
      for (const [key, value] of Object.entries(node.inputs || {})) if (typeof value === 'string' && Array.isArray(spec[key]?.[0]) && !spec[key][0].includes(value) && /(_name|model|ckpt|lora|vae|unet|clip)/i.test(key)) missingModels.push(`${node.class_type}.${key}: ${value}`);
    }
    return { version: String(stats?.system?.comfyui_version || 'unknown'), devices: (stats?.devices || []).map((device: any) => ({ name: String(device.name || '').slice(0, 100), vramTotal: Number(device.vram_total) || 0, vramFree: Number(device.vram_free) || 0 })), missingNodes, missingModels };
  }
  private async upload(bytes: Buffer, context: BackendContext, kind: string) {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `cere-${kind}-${randomUUID().slice(0, 8)}.png`);
    form.append('type', 'input'); form.append('subfolder', 'cere'); form.append('overwrite', 'false');
    const response = await context.fetch(this.connection.origin + '/upload/image', { method: 'POST', body: form, headers: this.headers(), redirect: 'error', signal: context.signal });
    if (!response.ok) throw new BackendRefusal('upload_failed', `ComfyUI did not accept the ${kind} image (HTTP ${response.status})`);
    const value: any = await response.json();
    if (!opaque(value?.name) || (value.subfolder && !opaque(value.subfolder))) throw new BackendRefusal('upload_failed', 'ComfyUI returned an unexpected file name for the upload');
    return value.subfolder ? `${value.subfolder}/${value.name}` : value.name;
  }
  async *run(request: ValidatedImageRequest, inputs: ResolvedInputs, context: BackendContext): AsyncIterable<ImageEvent> {
    const b = this.workflow.bindings;
    for (let index = 0; index < request.count; index++) {
      const graph = structuredClone(this.graph);
      const set = (binding: ComfyBinding | undefined, value: unknown) => { if (binding && graph[binding.node]) graph[binding.node].inputs[binding.input] = value; };
      context.beforeDispatch();
      if (b.image && inputs.references[0]) set(b.image, await this.upload(inputs.references[0].bytes, context, 'image'));
      if (b.mask && inputs.mask) { set(b.mask, await this.upload(await whiteMeansEdit(inputs.mask.bytes), context, 'mask')); if (graph[b.mask.node]?.inputs && 'channel' in graph[b.mask.node].inputs) graph[b.mask.node].inputs.channel = 'red'; }
      set(b.prompt, request.prompt); if (request.negativePrompt) set(b.negative, request.negativePrompt);
      const seed = request.seed !== undefined ? request.seed + index : Math.floor(Math.random() * 2 ** 32);
      set(b.seed, seed);
      if (request.size) { const [width, height] = request.size.split('x').map(Number); set(b.width, width); set(b.height, height); }
      // The prompt ID is chosen and recorded before submission, so a lost answer can be reconciled by status.
      const promptId = randomUUID(), clientId = 'cere-' + randomUUID();
      context.beforeDispatch();
      context.dispatched(promptId);
      let response: Response;
      try {
        response = await context.fetch(this.connection.origin + '/prompt', { method: 'POST', redirect: 'error', signal: context.signal, headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: promptId }) });
      } catch (error) { context.signal.throwIfAborted(); throw Object.assign(new Error('ComfyUI did not answer the submission. Cere will check its status instead of submitting again.'), { code: 'unreachable', cause: error }); }
      const value: any = await response.json().catch(() => ({}));
      if (!response.ok || (value?.node_errors && Object.keys(value.node_errors).length)) {
        const detail = [value?.error?.message, ...Object.values(value?.node_errors || {}).flatMap((node: any) => (node?.errors || []).map((error: any) => `${node.class_type || 'node'}: ${error.message}${error.details ? ' (' + error.details + ')' : ''}`))].filter(Boolean).join('; ').slice(0, 600);
        throw new BackendRefusal(/not found|missing|does not exist/i.test(detail) ? 'missing_dependency' : 'workflow_rejected', `ComfyUI rejected the workflow${detail ? ': ' + detail : ''}`);
      }
      yield { type: 'accepted', remoteId: promptId };
      yield* this.observe(promptId, clientId, context);
      yield { type: 'progress', note: `Seed ${seed}` };
    }
  }
  /** Follows one job to its end: queue position, sampler progress, then the declared outputs. */
  async *observe(promptId: string, clientId: string, context: BackendContext): AsyncIterable<ImageEvent> {
    const progress: ImageEvent[] = [];
    let socket: WebSocket | undefined;
    try {
      socket = new WebSocket(this.connection.origin.replace(/^http/, 'ws') + '/ws?clientId=' + encodeURIComponent(clientId), { headers: this.headers(), maxPayload: 1 << 20 });
      socket.on('error', () => {});
      socket.on('message', (data, binary) => {
        if (binary) return;
        try { const message = JSON.parse(String(data)); if (message?.type === 'progress' && message.data?.prompt_id === promptId && progress.length < 50) progress.push({ type: 'progress', value: Number(message.data.value) || 0, max: Number(message.data.max) || 0 }); } catch { /* ignored */ }
      });
    } catch { socket = undefined; }
    try {
      let missing = 0, lastQueued = -1;
      for (;;) {
        context.signal.throwIfAborted();
        while (progress.length) yield progress.shift()!;
        const status = await this.query(promptId, context);
        if (status.state === 'completed') { for (const [index, image] of (status.images || []).entries()) yield { type: 'image', bytes: image.bytes, mime: image.mime, index }; if (!status.images?.length) throw new BackendRefusal('no_image', 'The workflow finished without an image at its SaveImage node'); return; }
        if (status.state === 'failed') throw new BackendRefusal(/out of memory|cuda|allocat|oom/i.test(status.error || '') ? 'out_of_memory' : 'workflow_failed', /out of memory|cuda|allocat|oom/i.test(status.error || '') ? `ComfyUI ran out of GPU memory. Try a smaller size, one image at a time, or another backend. (${(status.error || '').slice(0, 200)})` : `The workflow failed: ${(status.error || 'no details').slice(0, 400)}`);
        if (status.state === 'queued' && status.position !== lastQueued) { lastQueued = status.position ?? 0; yield { type: 'queued', position: status.position }; }
        if (status.state === 'missing' && ++missing > 30) throw Object.assign(new Error('ComfyUI no longer lists this job. It may have been removed or the server restarted; its outcome is unknown.'), { code: 'lost' });
        if (status.state !== 'missing') missing = 0;
        await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true }); });
      }
    } finally { socket?.terminate(); }
  }
  async query(remoteId: string, context: Pick<BackendContext, 'fetch' | 'signal'>): Promise<{ state: 'queued' | 'running' | 'completed' | 'failed' | 'missing'; images?: { bytes: Buffer; mime: string }[]; error?: string; position?: number }> {
    const get = async (path: string) => { const response = await context.fetch(this.connection.origin + path, { headers: this.headers(), redirect: 'error', signal: context.signal }); if (!response.ok) throw new Error(`ComfyUI answered HTTP ${response.status}`); return response.json() as Promise<any>; };
    const history = await get('/history/' + encodeURIComponent(remoteId)), entry = history?.[remoteId];
    if (entry) {
      const status = entry.status || {};
      if (status.status_str === 'error') {
        const failure = (status.messages || []).find((message: any) => message?.[0] === 'execution_error')?.[1];
        return { state: 'failed', error: String(failure?.exception_message || failure?.exception_type || 'execution error') };
      }
      if (status.completed === false && status.status_str !== 'success') return { state: 'running' };
      const outputs = entry.outputs?.[this.workflow.bindings.output.node]?.images || [];
      const images: { bytes: Buffer; mime: string }[] = [];
      for (const image of outputs.slice(0, 8)) {
        if (!opaque(image?.filename) || (image.subfolder && !opaque(image.subfolder)) || !['output', 'temp'].includes(image.type)) continue;
        const url = `${this.connection.origin}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=${encodeURIComponent(image.type)}`;
        const verified = await downloadImage(url, { origin: this.connection.origin, headers: this.headers(), fetch: context.fetch }, context.signal);
        images.push({ bytes: verified.bytes, mime: verified.mime });
      }
      return { state: 'completed', images };
    }
    const queue = await get('/queue');
    const pending = (queue?.queue_pending || []).findIndex((item: any) => item?.[1] === remoteId);
    if (pending >= 0) return { state: 'queued', position: pending + 1 };
    if ((queue?.queue_running || []).some((item: any) => item?.[1] === remoteId)) return { state: 'running' };
    return { state: 'missing' };
  }
  async cancel(remoteId: string, context: Pick<BackendContext, 'fetch' | 'signal'>) {
    const post = (path: string, body: unknown) => context.fetch(this.connection.origin + path, { method: 'POST', redirect: 'error', signal: context.signal, headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    const state = await this.query(remoteId, context).catch(() => ({ state: 'missing' as const }));
    if (state.state === 'queued') {
      await post('/queue', { delete: [remoteId] });
      const after = await this.query(remoteId, context).catch(() => ({ state: 'missing' as const }));
      return after.state === 'queued' ? { confirmed: false, note: 'ComfyUI still lists the job as queued; it may run.' } : { confirmed: true, note: 'Removed from the ComfyUI queue before it started.' };
    }
    if (state.state === 'running') {
      if (!this.connection.targetedInterrupt) return { confirmed: false, note: 'It is already running on the ComfyUI server. Cere does not interrupt the server, because that could stop someone else’s job. Stop it in ComfyUI if needed.' };
      await post('/interrupt', { prompt_id: remoteId });
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const after = await this.query(remoteId, context).catch(() => ({ state: 'missing' as const }));
        if (after.state !== 'running') return { confirmed: after.state !== 'completed', note: after.state === 'completed' ? 'It finished before the interruption took effect.' : 'Interrupted by its prompt ID.' };
      }
      return { confirmed: false, note: 'ComfyUI still reports the job running after the interruption request.' };
    }
    return { confirmed: false, note: state.state === 'completed' ? 'It had already finished.' : 'ComfyUI does not list this job.' };
  }
}
