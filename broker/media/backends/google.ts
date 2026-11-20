/**
 * Google Gemini native image output through the Interactions API, as documented on 2026-11-20
 * (aistudio.google.com/docs/image-generation): POST v1beta/interactions with an `input` list of text and
 * image blocks and an image `response_format`. Responses are read from `steps[].content[]` (and the
 * `output_image`/`output_text` conveniences when present); text and images are both kept. Gemini has no
 * mask input, so a masked edit relies on Cere's protected-region compositing. Every generated image
 * carries Google's SynthID watermark.
 */
import { capability } from '../../tools/contracts.ts';
import { BackendRefusal, type BackendContext, type ImageBackend, type ImageCapabilities, type ImageEvent, type ImageRequest, type ResolvedInputs, type ValidatedImageRequest } from '../contracts.ts';
import { providerError } from './openai.ts';

export const googleImageModels = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];
export const googleApiRevision = '2026-05-20';
const documented = 'Gemini image generation documentation, checked 2026-11-20; not verified against your account';
const aspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export function googleCapabilities(model: string): ImageCapabilities {
  const known = googleImageModels.includes(model), state = known ? 'declared' as const : 'unknown' as const;
  return {
    backend: 'google', model, route: 'cloud',
    generate: capability(state, documented), edit: capability(state, documented),
    mask: capability('unsupported', documented, 'Gemini takes no mask; Cere can keep pixels outside your selection by compositing'), maskBehavior: 'none',
    maxReferences: 14, formats: ['png', 'jpeg'], transparency: capability('unsupported', documented),
    sizes: [], aspectRatios: [...aspectRatios, ...(/nano-banana-2\.1|3\.1-flash-image/.test(model) ? ['1:4', '4:1', '1:8', '8:1'] : [])], imageSizes: ['1K', '2K', '4K'],
    maxCount: 4, partials: capability('unsupported', documented), seed: capability('unsupported', documented), negativePrompt: capability('unsupported', documented),
    usage: capability('unknown', documented), cancel: capability('unsupported', documented, 'Stopping ends Cere’s wait; a request Google already received may still complete and be billed'), query: capability('unsupported', documented),
    notes: ['Requests are billed to your Google AI account.', 'Every generated image carries a SynthID watermark.', 'Several images are made as separate requests.'], billed: true,
  };
}
export function validateGoogle(capabilities: ImageCapabilities, request: ImageRequest) {
  const adjustments: string[] = [], next = { ...request };
  const refuse = (message: string): never => { throw new BackendRefusal('unsupported_parameter', message); };
  if (request.negativePrompt) refuse('Gemini does not take a separate negative prompt; describe what to avoid in the prompt');
  if (request.seed !== undefined) refuse('Gemini image models do not take a seed');
  if (request.background === 'transparent') refuse('Gemini does not make transparent backgrounds; generate on a plain background and remove it locally, or use another backend');
  if (!capabilities.formats.includes(request.format)) refuse('Gemini returns PNG or JPEG');
  if (request.size) refuse('Gemini takes an aspect ratio (such as 16:9) and an image size (1K, 2K or 4K), not exact pixels');
  if (request.aspectRatio && !capabilities.aspectRatios!.includes(request.aspectRatio)) refuse(`Aspect ratio is one of ${capabilities.aspectRatios!.join(', ')}`);
  if (request.imageSize && !capabilities.imageSizes!.includes(request.imageSize)) refuse('Image size is 1K, 2K or 4K');
  if (request.count < 1 || request.count > capabilities.maxCount) refuse(`Make 1–${capabilities.maxCount} images at a time`);
  if (request.references.length > capabilities.maxReferences) refuse(`Use at most ${capabilities.maxReferences} reference images`);
  if (request.mask && !request.protectOutside) refuse('Gemini has no mask input. Turn on “Keep pixels outside the selection unchanged” to apply the edit only inside your selection.');
  if (request.partials) { next.partials = false; adjustments.push('Gemini sends no previews; the finished image appears when ready'); }
  if (request.quality) { next.quality = undefined; adjustments.push('Gemini has no quality setting; image size controls detail'); }
  return { request: next, adjustments };
}
/** Reads image and text blocks from an Interactions response, tolerating the documented convenience fields. */
export function parseInteraction(value: any) {
  const images: { data: string; mime: string }[] = [], texts: string[] = [];
  const block = (item: any) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'image' && typeof item.data === 'string') images.push({ data: item.data, mime: typeof item.mime_type === 'string' ? item.mime_type : 'image/png' });
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  };
  for (const step of Array.isArray(value?.steps) ? value.steps : []) if (step?.type === 'model_output') for (const item of Array.isArray(step.content) ? step.content : []) block(item);
  if (!images.length && value?.output_image && typeof value.output_image.data === 'string') images.push({ data: value.output_image.data, mime: value.output_image.mime_type || 'image/png' });
  if (!texts.length && typeof value?.output_text === 'string') texts.push(value.output_text);
  return { id: typeof value?.id === 'string' ? value.id : '', images, text: texts.join('\n').slice(0, 8000), blocked: value?.status === 'blocked' || value?.status === 'failed' };
}

export class GoogleImages implements ImageBackend {
  model: string; base: string;
  constructor(model: string, base = 'https://generativelanguage.googleapis.com/v1beta/') { this.model = model; this.base = base; }
  describe() { return googleCapabilities(this.model); }
  validate(request: ImageRequest) { return validateGoogle(this.describe(), request); }
  async *run(request: ValidatedImageRequest, inputs: ResolvedInputs, context: BackendContext): AsyncIterable<ImageEvent> {
    const key = context.key();
    if (!key) throw new BackendRefusal('missing_key', 'Add a Google AI API key in Settings → Connections');
    const input = [{ type: 'text', text: request.prompt }, ...inputs.references.map(ref => ({ type: 'image', mime_type: ref.mime, data: ref.bytes.toString('base64') }))];
    const body = { model: this.model, input, response_format: { type: 'image', mime_type: 'image/' + request.format, ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}), ...(request.imageSize ? { image_size: request.imageSize } : {}) } };
    let produced = 0;
    // One request per image: Gemini returns one image per interaction.
    for (let index = 0; index < request.count; index++) {
      context.signal.throwIfAborted();
      context.beforeDispatch();
      context.dispatched();
      let response: Response;
      try {
        response = await context.fetch(this.base + 'interactions', { method: 'POST', redirect: 'error', signal: context.signal,
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', 'Api-Revision': googleApiRevision }, body: JSON.stringify(body) });
      } catch (error) { context.signal.throwIfAborted(); throw Object.assign(new Error('Google could not be reached. The request may or may not have arrived; it was not sent again.'), { code: 'unreachable', cause: error }); }
      if (!response.ok) throw await providerError(response, 'Google AI');
      yield { type: 'accepted' };
      let text = '', size = 0;
      for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > 100 * 1024 * 1024) throw new Error('The Google response was larger than Cere accepts'); text += Buffer.from(chunk).toString('utf8'); }
      let value: any;
      try { value = JSON.parse(text); } catch { throw Object.assign(new Error('Google returned an unreadable response; the image may have been made and billed'), { code: 'malformed' }); }
      const parsed = parseInteraction(value);
      if (parsed.id) yield { type: 'continuation', id: parsed.id };
      if (parsed.text) yield { type: 'text', text: parsed.text };
      if (Number.isFinite(value?.usage?.total_tokens)) yield { type: 'usage', usage: { total_tokens: value.usage.total_tokens } };
      if (!parsed.images.length) throw new BackendRefusal(parsed.blocked ? 'refused' : 'no_image', parsed.blocked ? 'Google declined this request' : `Google answered without an image${parsed.text ? ': ' + parsed.text.slice(0, 300) : ''}`);
      for (const image of parsed.images) yield { type: 'image', bytes: Buffer.from(image.data, 'base64'), mime: image.mime, index: produced++ };
    }
  }
}
