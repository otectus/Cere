/**
 * Seeing images. The conversation's own model looks at an image when it accepts images and may receive
 * it; otherwise an explicitly configured vision helper does, and its answer is attributed to the helper
 * and handed to the conversation as an untrusted observation. Private images never fall back to a cloud
 * helper by themselves: the image's processing permission is checked against the helper's route before
 * anything is sent. OCR is a separate, local extraction that needs no model at all.
 *
 * The helper sees only the selected image (reduced to at most 1536 pixels on its longer side, which is
 * recorded) and the question; never the conversation, other files or credentials.
 */
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import type { Core } from '../core.ts';
import type { ArtifactStore, ArtifactVersion } from '../artifacts/store.ts';
import { isApiProvider } from '../provider-catalog.ts';
import { modelRoute, ollamaHost, ollamaJson } from '../ollama.ts';
import { routeAllowed, routeLabels, type ProcessingRoute } from '../tools/contracts.ts';
import { sessionRoute } from '../workspace/policy.ts';

export type VisionSettings = { provider: '' | 'ollama' | 'openai' | 'anthropic' | 'google' | 'compatible'; model: string };
export const visionLimits = { edge: 1536, answerChars: 6000, timeoutMs: 120_000, ocrMs: 60_000 };
export type Region = { left: number; top: number; width: number; height: number };

/** The selected image (or a region of it), oriented and reduced for analysis; the reduction is recorded. */
export async function analysisImage(data: Buffer, region?: Region) {
  let image = sharp(await sharp(data, { limitInputPixels: 64_000_000 }).rotate().png().toBuffer());
  const meta = await image.metadata();
  if (region) {
    if (![region.left, region.top, region.width, region.height].every(value => Number.isInteger(value) && value >= 0) || !region.width || !region.height || region.left + region.width > meta.width! || region.top + region.height > meta.height!)
      throw new Error(`The region must lie inside the ${meta.width}×${meta.height} image`);
    image = sharp(await image.extract(region).png().toBuffer());
  }
  const current = await image.metadata(), longest = Math.max(current.width!, current.height!);
  const reduced = longest > visionLimits.edge;
  const bytes = reduced ? await image.resize(visionLimits.edge, visionLimits.edge, { fit: 'inside' }).png().toBuffer() : await image.png().toBuffer();
  const out = await sharp(bytes).metadata();
  return { bytes, width: out.width!, height: out.height!, note: `${region ? `Region ${region.width}×${region.height} at (${region.left}, ${region.top}) of ${meta.width}×${meta.height}` : `${meta.width}×${meta.height}`}${reduced ? `, reduced to ${out.width}×${out.height} for analysis` : ''}` };
}

export class Vision {
  core: Core; artifacts: ArtifactStore;
  fetch: typeof fetch = (...args) => fetch(...args);
  constructor(core: Core, artifacts: ArtifactStore) { this.core = core; this.artifacts = artifacts; }
  settings(): VisionSettings { return this.core.settings.workbench?.vision || { provider: '', model: '' }; }
  /** Whether the conversation model itself takes images: an Ollama vision model, or an API declared or known to. */
  async nativeImages(sessionId: string, signal?: AbortSignal) {
    const session = this.core.store.session(sessionId);
    if (session.provider === 'ollama') { const info = await ollamaJson(session.ollama!.host, 'show', { model: session.model }, signal).catch(() => null); return !!info?.capabilities?.includes('vision'); }
    if (session.provider === 'compatible') return this.core.chatConnections.endpoint(session).images === true;
    return isApiProvider(session.provider);
  }
  /** Where the configured helper processes images. */
  async helperRoute(signal?: AbortSignal): Promise<ProcessingRoute> {
    const helper = this.settings();
    if (!helper.provider) return 'unknown';
    if (helper.provider === 'ollama') {
      const host = ollamaHost(this.core.settings.ollama.host), verified = await modelRoute(host, helper.model, signal);
      if (!verified.verified) return 'unknown';
      if (verified.route === 'cloud') return 'cloud';
      const name = new URL(host).hostname.replace(/^\[|\]$/g, '');
      return name === 'localhost' || name === '::1' || /^127\./.test(name) ? 'local' : 'remote';
    }
    if (helper.provider === 'compatible') return this.core.settings.compatible.processing || 'unknown';
    return 'cloud';
  }
  /**
   * Plans how a question about an image can be answered for this conversation, without sending anything:
   * the conversation model, the helper, or neither (with the reason and what still works locally).
   */
  async plan(sessionId: string, version: ArtifactVersion, signal?: AbortSignal) {
    const session = this.core.store.session(sessionId);
    const conversation = await sessionRoute(session, this.core.settings, signal, this.core.chatConnections.endpoint(session));
    if (await this.nativeImages(sessionId, signal) && routeAllowed(conversation.route, version.policy)) return { via: 'conversation' as const, route: conversation.route };
    const helper = this.settings();
    if (helper.provider && helper.model) {
      const route = await this.helperRoute(signal);
      if (routeAllowed(route, version.policy)) return { via: 'helper' as const, route, helper };
      return { via: 'none' as const, reason: `The vision helper runs on ${routeLabels[route]}, but ${version.name} may only be processed on ${version.policy.remote ? 'this computer or your own servers' : 'this computer'}. It was not sent. OCR and image facts still work locally.` };
    }
    return { via: 'none' as const, reason: (await this.nativeImages(sessionId, signal)) ? `This conversation’s model runs on ${routeLabels[conversation.route]}, which ${version.name}’s permissions do not allow, and no vision helper is set.` : 'This conversation’s model cannot see images and no vision helper is set (Settings → Connections → Images). OCR and image facts still work locally.' };
  }
  /** Asks the configured helper one bounded question about one image. Its answer is the helper's observation. */
  async ask(image: Buffer, question: string, signal: AbortSignal, beforeDispatch: () => void) {
    const helper = this.settings(), base64 = image.toString('base64');
    const prompt = `${question.slice(0, 2000)}\n\nDescribe only what is visible. Say when text or details are unreadable instead of guessing.`;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(visionLimits.timeoutMs)]);
    beforeDispatch();
    let answer = '';
    if (helper.provider === 'ollama') {
      const value = await ollamaJson(this.core.settings.ollama.host, 'chat', { model: helper.model, stream: false, messages: [{ role: 'user', content: prompt, images: [base64] }] }, timeout);
      answer = String(value?.message?.content || '');
    } else {
      const provider = helper.provider as 'openai' | 'anthropic' | 'google' | 'compatible', key = provider === 'compatible' ? this.core.apiAccess('compatible').key() : this.core.credentials.key(provider);
      if (!key && provider !== 'compatible') throw new Error(`Add an API key for the vision helper (${provider})`);
      const request: { url: string; headers: Record<string, string>; body: unknown } = provider === 'openai' ? { url: 'https://api.openai.com/v1/responses', headers: { Authorization: `Bearer ${key}` }, body: { model: helper.model, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: `data:image/png;base64,${base64}` }] }] } }
        : provider === 'anthropic' ? { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: { model: helper.model, max_tokens: 1500, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }, { type: 'text', text: prompt }] }] } }
        : provider === 'google' ? { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(helper.model)}:generateContent`, headers: { 'x-goog-api-key': key }, body: { contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: base64 } }] }] } }
        : { url: this.core.settings.compatible.baseUrl.replace(/\/+$/, '') + '/chat/completions', headers: key ? { Authorization: `Bearer ${key}` } : {}, body: { model: helper.model, stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }] }] } };
      const response = await this.fetch(request.url, { method: 'POST', redirect: 'error', signal: timeout, headers: { 'Content-Type': 'application/json', ...request.headers }, body: JSON.stringify(request.body) });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`The vision helper rejected the request (HTTP ${response.status})`); }
      const value: any = JSON.parse((await response.text()).slice(0, 2 * 1024 * 1024));
      answer = provider === 'openai' ? (value.output || []).flatMap((item: any) => item?.content || []).filter((part: any) => part?.type === 'output_text').map((part: any) => part.text).join('\n')
        : provider === 'anthropic' ? (value.content || []).filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n')
        : provider === 'google' ? (value.candidates?.[0]?.content?.parts || []).filter((part: any) => typeof part?.text === 'string' && !part.thought).map((part: any) => part.text).join('\n')
        : String(value.choices?.[0]?.message?.content || '');
    }
    answer = answer.trim();
    if (!answer) throw new Error('The vision helper returned no answer');
    return answer.slice(0, visionLimits.answerChars);
  }
}

/** Local OCR with Tesseract, when installed. Lines keep their boxes in the analysed image's pixels. */
export async function ocr(image: Buffer, languages: string, signal: AbortSignal) {
  if (!/^[a-z_]{3,}(\+[a-z_]{3,}){0,4}$/.test(languages)) throw new Error('OCR languages are Tesseract codes such as eng or eng+deu');
  const output = await new Promise<string>((resolve, reject) => {
    let child;
    try { child = spawn('tesseract', ['stdin', 'stdout', '-l', languages, 'tsv'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', OMP_THREAD_LIMIT: '2' } }); }
    catch { return reject(Object.assign(new Error('OCR needs Tesseract. Install the tesseract package and a language pack such as tesseract-data-eng.'), { code: 'unavailable' })); }
    let out = '', errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), visionLimits.ocrMs);
    signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.on('error', (error: any) => { clearTimeout(timer); reject(error?.code === 'ENOENT' ? Object.assign(new Error('OCR needs Tesseract. Install the tesseract package and a language pack such as tesseract-data-eng.'), { code: 'unavailable' }) : error); });
    child.stdout.on('data', (chunk: Buffer) => { out += chunk; if (out.length > 4 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', (chunk: Buffer) => { if (errors.length < 2000) errors += chunk; });
    child.on('close', (code: number) => {
      clearTimeout(timer);
      if (signal.aborted) return reject(signal.reason);
      if (code !== 0) return reject(Object.assign(new Error(/Failed loading language|Error opening data file/.test(errors) ? `The Tesseract language data for “${languages}” is not installed (for English, install tesseract-data-eng).` : 'Tesseract could not read this image: ' + errors.trim().split('\n').at(-1)?.slice(0, 200)), { code: /language/.test(errors) ? 'missing_language' : 'ocr_failed' }));
      resolve(out);
    });
    child.stdin.on('error', () => {}); child.stdin.end(image);
  });
  const lines = new Map<string, { text: string[]; left: number; top: number; right: number; bottom: number; confidence: number[] }>();
  for (const row of output.split('\n').slice(1)) {
    const cells = row.split('\t');
    if (cells.length < 12 || cells[0] !== '5' || !cells[11].trim()) continue;
    const [block, paragraph, line] = [cells[2], cells[3], cells[4]], key = `${block}.${paragraph}.${line}`;
    const left = Number(cells[6]), top = Number(cells[7]), width = Number(cells[8]), height = Number(cells[9]), confidence = Number(cells[10]);
    const entry = lines.get(key) || { text: [], left, top, right: left + width, bottom: top + height, confidence: [] };
    entry.text.push(cells[11]); entry.left = Math.min(entry.left, left); entry.top = Math.min(entry.top, top); entry.right = Math.max(entry.right, left + width); entry.bottom = Math.max(entry.bottom, top + height);
    if (confidence >= 0) entry.confidence.push(confidence);
    lines.set(key, entry);
  }
  // Tesseract's own word confidences are reported as given; Cere computes no confidence of its own.
  return [...lines.values()].map(entry => ({ text: entry.text.join(' '), box: { left: entry.left, top: entry.top, width: entry.right - entry.left, height: entry.bottom - entry.top },
    ...(entry.confidence.length ? { tesseractConfidence: Math.round(entry.confidence.reduce((a, b) => a + b, 0) / entry.confidence.length) } : {}) }));
}
