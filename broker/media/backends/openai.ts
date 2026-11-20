/**
 * OpenAI Images API (generations and edits), usable from any conversation model. Capabilities follow the
 * API reference as checked on 2026-11-20 (developers.openai.com/api/reference/resources/images); they are
 * declared, not verified against an account. A model ID typed by the user gets only the common subset.
 *
 * The mask Cere sends follows OpenAI's convention: same size as the first image, transparent where it may
 * change. OpenAI documents masking as prompt guidance, so Cere labels it a guide, not an exact boundary.
 */
import { consumeSse } from '../../api-providers.ts';
import { capability } from '../../tools/contracts.ts';
import { openaiMask } from '../transforms.ts';
import { BackendRefusal, type BackendContext, type ImageBackend, type ImageCapabilities, type ImageEvent, type ImageRequest, type ResolvedInputs, type ValidatedImageRequest } from '../contracts.ts';

export const openaiImageModels = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest'];
const documented = 'OpenAI Images API reference, checked 2026-11-20; not verified against your account';
const standardSizes = ['auto', '1024x1024', '1536x1024', '1024x1536'];

export function openaiCapabilities(model: string): ImageCapabilities {
  const known = openaiImageModels.includes(model), family2 = /^gpt-image-2(\.\d+)?(-|$)/.test(model), premium = /^gpt-image-2\.5-(sunburst|flare)/.test(model);
  const retired = /^gpt-image-1$/.test(model) || /^dall-e-/.test(model);
  const state = known ? 'declared' as const : 'unknown' as const;
  return {
    backend: 'openai', model, route: 'cloud',
    generate: retired ? capability('unsupported', documented, 'This model was retired; choose a current model') : capability(state, documented),
    edit: retired ? capability('unsupported', documented) : capability(state, documented),
    mask: capability(state, documented, 'Applied to the first image as guidance; OpenAI may not follow the mask shape exactly'), maskBehavior: 'guide',
    maxReferences: 16, formats: ['png', 'jpeg', 'webp'],
    transparency: capability(known ? 'declared' : 'unknown', documented, model === 'gpt-image-2' ? 'Transparent backgrounds are in preview for this model' : 'Needs PNG or WebP output'),
    sizes: standardSizes, ...(family2 ? { customSize: { multiple: 16, minAspect: 1 / 3, maxAspect: 3, maxWidth: 3840, maxHeight: 3840 } } : {}),
    qualities: premium ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto', 'low', 'medium', 'high'],
    maxCount: 4, partials: capability(state, documented, 'Up to three provisional previews while one image is made'),
    seed: capability('unsupported', documented), negativePrompt: capability('unsupported', documented), usage: capability('declared', documented),
    cancel: capability('unsupported', documented, 'Stopping ends Cere’s wait; a request OpenAI already received may still complete and be billed'),
    query: capability('unsupported', documented),
    notes: ['Requests are billed to your OpenAI account.', ...(family2 ? ['Sizes above 2560×1440 are experimental.'] : []), ...(retired ? ['This model was retired by OpenAI.'] : [])], billed: true,
  };
}
const fail = (code: string, message: string): never => { throw new BackendRefusal(code, message); };
export function validateOpenai(capabilities: ImageCapabilities, request: ImageRequest) {
  const adjustments: string[] = [], next = { ...request };
  if (capabilities.generate.state === 'unsupported') fail('unsupported_model', capabilities.generate.note || 'This model cannot make images');
  if (request.negativePrompt) fail('unsupported_parameter', 'OpenAI does not take a separate negative prompt; describe what to avoid in the prompt');
  if (request.seed !== undefined) fail('unsupported_parameter', 'OpenAI image models do not take a seed');
  if (!capabilities.formats.includes(request.format)) fail('unsupported_parameter', `Choose ${capabilities.formats.join(', ')}`);
  if (request.background === 'transparent' && request.format === 'jpeg') fail('unsupported_parameter', 'Transparent backgrounds need PNG or WebP output');
  if (request.count < 1 || request.count > capabilities.maxCount) fail('unsupported_parameter', `Make 1–${capabilities.maxCount} images at a time`);
  if (request.quality && !capabilities.qualities!.includes(request.quality)) fail('unsupported_parameter', `Quality is one of ${capabilities.qualities!.join(', ')} for this model`);
  if (request.size && !capabilities.sizes.includes(request.size)) {
    const match = /^(\d+)x(\d+)$/.exec(request.size), custom = capabilities.customSize;
    if (!match || !custom) fail('unsupported_parameter', `Size is one of ${capabilities.sizes.join(', ')} for this model`);
    const width = Number(match![1]), height = Number(match![2]);
    if (width % custom!.multiple || height % custom!.multiple || width / height < custom!.minAspect || width / height > custom!.maxAspect || Math.max(width, height) > custom!.maxWidth || width * height > 3840 * 2160)
      fail('unsupported_parameter', 'A custom size needs both sides divisible by 16, an aspect ratio between 1:3 and 3:1, and at most 3840×2160');
  }
  if (request.aspectRatio || request.imageSize) fail('unsupported_parameter', 'OpenAI takes a size such as 1536x1024, not an aspect ratio');
  if (request.references.length > capabilities.maxReferences) fail('unsupported_parameter', `Use at most ${capabilities.maxReferences} reference images`);
  if (request.partials && request.count > 1) { next.partials = false; adjustments.push('Previews are shown only when making one image; this request makes several, so it shows none'); }
  return { request: next, adjustments };
}
const dataUrl = (bytes: Buffer, mime: string) => `data:${mime};base64,${bytes.toString('base64')}`;
/** Bounded, scrubbed provider error text: the code and a short message, never a raw body. */
export async function providerError(response: Response, label: string) {
  let detail = '';
  try {
    const text = (await response.text()).slice(0, 4096), value = JSON.parse(text), error = value?.error || {};
    detail = [error.code, error.type].filter((item: unknown) => typeof item === 'string').join(' · ') + (typeof error.message === 'string' ? ': ' + error.message : '');
  } catch { /* non-JSON bodies are withheld */ }
  detail = detail.replace(/(sk|key|token|bearer)[-_ ]?[A-Za-z0-9._-]{8,}/gi, '[redacted]').replace(/[\x00-\x1f]/g, ' ').slice(0, 300);
  const refusal = /moderation|safety|content_policy|policy_violation/i.test(detail);
  return new BackendRefusal(refusal ? 'refused' : response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'unauthorized' : 'rejected',
    `${label} (HTTP ${response.status}) ${refusal ? 'declined this request' : 'rejected the request'}${detail ? ': ' + detail : ''}`);
}

export class OpenAiImages implements ImageBackend {
  model: string; base: string;
  constructor(model: string, base = 'https://api.openai.com/v1/') { this.model = model; this.base = base; }
  describe() { return openaiCapabilities(this.model); }
  validate(request: ImageRequest) { return validateOpenai(this.describe(), request); }
  async *run(request: ValidatedImageRequest, inputs: ResolvedInputs, context: BackendContext): AsyncIterable<ImageEvent> {
    const editing = request.operation !== 'generate';
    const body: Record<string, unknown> = { model: this.model, prompt: request.prompt, n: request.count, output_format: request.format,
      ...(request.size ? { size: request.size } : {}), ...(request.quality ? { quality: request.quality } : {}), ...(request.background ? { background: request.background } : {}) };
    if (editing) {
      if (!inputs.references.length) throw new BackendRefusal('missing_reference', 'Choose the image to edit');
      // The edit base goes first: OpenAI applies a mask to the first image.
      const ordered = [...inputs.references.filter(ref => ref.role === 'edit-base'), ...inputs.references.filter(ref => ref.role !== 'edit-base')];
      body.images = ordered.map(ref => ({ image_url: dataUrl(ref.bytes, ref.mime) }));
      if (inputs.mask) body.mask = { image_url: dataUrl(await openaiMask(inputs.mask.bytes), 'image/png') };
    }
    const stream = !!request.partials && request.count === 1;
    if (stream) { body.stream = true; body.partial_images = 2; }
    const key = context.key();
    if (!key) throw new BackendRefusal('missing_key', 'Add an OpenAI API key in Settings → Connections');
    context.beforeDispatch();
    context.dispatched();
    let response: Response;
    try {
      response = await context.fetch(this.base + (editing ? 'images/edits' : 'images/generations'), { method: 'POST', redirect: 'error', signal: context.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) { context.signal.throwIfAborted(); throw Object.assign(new Error('OpenAI could not be reached. The request may or may not have arrived; it was not sent again.'), { code: 'unreachable', cause: error }); }
    if (!response.ok) throw await providerError(response, 'OpenAI');
    yield { type: 'accepted' };
    let index = 0;
    if (stream) {
      // Events are passed on as they arrive, so provisional previews show while the image is made.
      const queue: ImageEvent[] = []; let wake: (() => void) | undefined, finished = false, failure: unknown;
      void consumeSse(response, value => {
        if (/partial_image$/.test(value?.type) && typeof value.b64_json === 'string') queue.push({ type: 'partial', bytes: Buffer.from(value.b64_json, 'base64'), index: Number(value.partial_image_index) || 0 });
        else if (/completed$/.test(value?.type) && typeof value.b64_json === 'string') { queue.push({ type: 'image', bytes: Buffer.from(value.b64_json, 'base64'), mime: 'image/' + request.format, index: index++ }); if (value.usage) queue.push({ type: 'usage', usage: flatUsage(value.usage) }); }
        else if (value?.type === 'error' || value?.error) throw new BackendRefusal('stream_error', 'OpenAI reported an error while making the image');
        wake?.();
      }).then(() => { finished = true; wake?.(); }, error => { failure = error; finished = true; wake?.(); });
      for (;;) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (finished) break;
        await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
      }
      if (failure) throw failure;
      if (!index) throw new BackendRefusal('no_image', 'OpenAI finished without a final image; previews are not kept as results');
      return;
    }
    let text = '', size = 0;
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > 200 * 1024 * 1024) throw new Error('The OpenAI response was larger than Cere accepts'); text += Buffer.from(chunk).toString('utf8'); }
    let value: any;
    try { value = JSON.parse(text); } catch { throw Object.assign(new Error('OpenAI returned an unreadable response; the images may have been made and billed'), { code: 'malformed' }); }
    const images = Array.isArray(value?.data) ? value.data : [];
    for (const item of images) if (typeof item?.b64_json === 'string') yield { type: 'image', bytes: Buffer.from(item.b64_json, 'base64'), mime: 'image/' + (value.output_format || request.format), index: index++, ...(typeof item.revised_prompt === 'string' ? { revisedPrompt: item.revised_prompt.slice(0, 4000) } : {}) };
    if (value?.usage) yield { type: 'usage', usage: flatUsage(value.usage) };
    if (!index) throw new BackendRefusal('no_image', 'OpenAI answered without an image');
  }
}
function flatUsage(usage: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) if (Number.isFinite(usage?.[key])) out[key] = usage[key];
  for (const [group, value] of Object.entries({ input: usage?.input_tokens_details, output: usage?.output_tokens_details })) if (value && typeof value === 'object') for (const [key, count] of Object.entries(value as any)) if (Number.isFinite(count)) out[`${group}_${key}`] = count as number;
  return out;
}
