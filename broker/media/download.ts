/**
 * The media downloader: the only way Cere fetches image bytes a backend points to. It is not the web
 * reader. Its policy: the configured backend origin is reachable as configured (a local or LAN ComfyUI
 * server included); any other URL must be HTTPS to a host that resolves only to public addresses.
 * Redirects are followed by hand, each hop re-validated, and credentials go only to the configured
 * origin, never across a redirect. Bytes, pixels and frames are bounded before anything is kept.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import sharp from 'sharp';
import { publicAddress } from '../web.ts';

export const downloadLimits = { bytes: 50 * 1024 * 1024, redirects: 3, pixels: 64_000_000, timeoutMs: 120_000 };
export type DownloadPolicy = { origin?: string; headers?: Record<string, string>; resolve?: (host: string) => Promise<string[]>; fetch?: typeof fetch; maxBytes?: number };

async function allowed(url: URL, policy: DownloadPolicy) {
  if (policy.origin && url.origin === policy.origin) return;
  if (url.protocol !== 'https:') throw Object.assign(new Error('Media from outside the configured server must use HTTPS'), { code: 'blocked_url' });
  if (url.username || url.password) throw Object.assign(new Error('Media URLs cannot carry credentials'), { code: 'blocked_url' });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await (policy.resolve ? policy.resolve(host) : lookup(host, { all: true }).then(rows => rows.map(row => row.address)));
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw Object.assign(new Error('Media URLs that reach this computer or a private network are blocked'), { code: 'blocked_url' });
}
/** Fetches one image under the policy; returns its bytes after checking they decode within the limits. */
export async function downloadImage(value: string, policy: DownloadPolicy, signal: AbortSignal) {
  let url: URL;
  try { url = new URL(value); } catch { throw Object.assign(new Error('The backend returned an invalid media address'), { code: 'blocked_url' }); }
  const limit = policy.maxBytes ?? downloadLimits.bytes;
  for (let hop = 0; hop <= downloadLimits.redirects; hop++) {
    await allowed(url, policy);
    // Authorization is attached only for the configured origin itself.
    const headers = policy.origin && url.origin === policy.origin ? policy.headers || {} : {};
    const response = await (policy.fetch || fetch)(url, { redirect: 'manual', headers, signal: AbortSignal.any([signal, AbortSignal.timeout(downloadLimits.timeoutMs)]) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location) throw Object.assign(new Error('The media server redirected without a destination'), { code: 'blocked_url' });
      url = new URL(location, url); continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Object.assign(new Error(`The media server answered HTTP ${response.status}`), { code: 'download_failed' }); }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > limit) { await response.body?.cancel().catch(() => {}); throw Object.assign(new Error('The image is larger than Cere accepts'), { code: 'too_large' }); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > limit) throw Object.assign(new Error('The image is larger than Cere accepts'), { code: 'too_large' }); chunks.push(Buffer.from(chunk)); }
    return verifyImage(Buffer.concat(chunks));
  }
  throw Object.assign(new Error('The media server redirected too many times'), { code: 'blocked_url' });
}
/**
 * Bounded decoding of returned bytes: a malformed, oversized, decompression-bomb or animated result is a
 * clear failure, not an artifact. Animated or multi-page images are refused rather than silently cut.
 */
export async function verifyImage(bytes: Buffer, maxBytes = downloadLimits.bytes) {
  if (bytes.length > maxBytes) throw Object.assign(new Error('The image is larger than Cere accepts'), { code: 'too_large' });
  let metadata;
  try { metadata = await sharp(bytes, { limitInputPixels: downloadLimits.pixels, animated: true }).metadata(); }
  catch (error: any) { throw Object.assign(new Error(/pixel limit/i.test(error?.message || '') ? 'The image has more pixels than Cere decodes (64 megapixels)' : 'The returned data is not a valid image'), { code: /pixel limit/i.test(error?.message || '') ? 'too_large' : 'malformed' }); }
  if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw Object.assign(new Error('The returned data is not a PNG, JPEG or WebP image'), { code: 'malformed' });
  if (metadata.width * metadata.height > downloadLimits.pixels) throw Object.assign(new Error('The image has more pixels than Cere decodes (64 megapixels)'), { code: 'too_large' });
  if ((metadata.pages || 1) > 1) throw Object.assign(new Error('The backend returned an animated or multi-page image; Cere keeps still images only'), { code: 'animated' });
  // A full decode proves the data is complete; a truncated file fails here, not later in the gallery.
  try { await sharp(bytes, { limitInputPixels: downloadLimits.pixels, failOn: 'error' }).raw().toBuffer(); }
  catch { throw Object.assign(new Error('The returned image is truncated or corrupt'), { code: 'malformed' }); }
  return { bytes, mime: 'image/' + metadata.format, width: metadata.width, height: metadata.height, alpha: !!metadata.hasAlpha };
}
