/**
 * Deterministic image work: crop, resize, rotate and flip, format conversion, masks, compositing,
 * contact sheets and alpha inspection. No generation backend is involved and nothing leaves the
 * computer. sharp runs these on libvips' own threads, off the broker's event loop.
 *
 * Coordinates are in the base image's pixels after EXIF orientation is applied; the editor maps pointer
 * positions to those pixels before it sends anything.
 */
import sharp from 'sharp';
import { artifactLimits } from '../artifacts/store.ts';

export type TransformStep =
  | { op: 'crop'; left: number; top: number; width: number; height: number }
  | { op: 'resize'; width: number; height: number; fit?: 'contain' | 'cover' | 'fill' | 'inside'; kernel?: 'nearest' | 'lanczos3' }
  | { op: 'rotate'; degrees: 90 | 180 | 270 }
  | { op: 'flip'; axis: 'horizontal' | 'vertical' }
  | { op: 'format'; format: 'png' | 'jpeg' | 'webp'; quality?: number; flatten?: string }
  | { op: 'extend'; top: number; right: number; bottom: number; left: number; background?: string };
export const transformLimits = { steps: 16, edge: 16384, pixels: artifactLimits.imagePixels };
const input = (bytes: Buffer) => sharp(bytes, { limitInputPixels: transformLimits.pixels, failOn: 'error' });
const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const int = (value: unknown, min: number, max: number, name: string) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value as number;
};

/** Decoded facts about an image, after orientation is applied. */
export async function inspect(bytes: Buffer) {
  const metadata = await input(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error('This image could not be decoded');
  const rotated = (metadata.orientation || 1) >= 5;
  const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
  let alphaCoverage: number | undefined;
  if (metadata.hasAlpha) {
    const { data, info } = await input(bytes).rotate().ensureAlpha().extractChannel(3).resize(256, 256, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
    let opaque = 0; for (const value of data) if (value === 255) opaque++;
    alphaCoverage = Math.round(10000 * opaque / (info.width * info.height)) / 100;
  }
  return { width, height, format: metadata.format || 'unknown', alpha: !!metadata.hasAlpha, ...(alphaCoverage !== undefined ? { opaquePercent: alphaCoverage } : {}),
    ...(metadata.pages && metadata.pages > 1 ? { frames: metadata.pages, note: 'Animated or multi-page: only the first frame is used' } : {}),
    ...(metadata.orientation && metadata.orientation !== 1 ? { exifOrientation: metadata.orientation } : {}), space: metadata.space || 'unknown' };
}
export function validSteps(value: unknown): TransformStep[] {
  if (!Array.isArray(value) || !value.length || value.length > transformLimits.steps) throw new Error(`Give 1–${transformLimits.steps} steps`);
  return value.map((step: any, index) => {
    const at = `Step ${index + 1}`;
    switch (step?.op) {
      case 'crop': return { op: 'crop', left: int(step.left, 0, transformLimits.edge, at + ' left'), top: int(step.top, 0, transformLimits.edge, at + ' top'), width: int(step.width, 1, transformLimits.edge, at + ' width'), height: int(step.height, 1, transformLimits.edge, at + ' height') };
      case 'resize': return { op: 'resize', width: int(step.width, 1, transformLimits.edge, at + ' width'), height: int(step.height, 1, transformLimits.edge, at + ' height'), fit: ['contain', 'cover', 'fill', 'inside'].includes(step.fit) ? step.fit : 'inside', kernel: step.kernel === 'nearest' ? 'nearest' : 'lanczos3' };
      case 'rotate': if (![90, 180, 270].includes(step.degrees)) throw new Error(at + ': rotate by 90, 180 or 270 degrees'); return { op: 'rotate', degrees: step.degrees };
      case 'flip': if (!['horizontal', 'vertical'].includes(step.axis)) throw new Error(at + ': flip horizontally or vertically'); return { op: 'flip', axis: step.axis };
      case 'format': if (!['png', 'jpeg', 'webp'].includes(step.format)) throw new Error(at + ': use png, jpeg or webp'); return { op: 'format', format: step.format, ...(step.quality !== undefined ? { quality: int(step.quality, 1, 100, at + ' quality') } : {}), ...(step.flatten !== undefined ? { flatten: color(step.flatten, '#ffffff') } : {}) };
      case 'extend': return { op: 'extend', top: int(step.top, 0, 8192, at + ' top'), right: int(step.right, 0, 8192, at + ' right'), bottom: int(step.bottom, 0, 8192, at + ' bottom'), left: int(step.left, 0, 8192, at + ' left'), ...(step.background !== undefined ? { background: color(step.background, '#ffffff') } : {}) };
      default: throw new Error(at + ': unknown operation');
    }
  });
}
/**
 * Applies steps in order. Converting an image with transparency to JPEG requires an explicit flatten
 * color: alpha is never dropped silently.
 */
export async function transform(bytes: Buffer, steps: TransformStep[]) {
  let current = await input(bytes).rotate().png().toBuffer();
  let format: 'png' | 'jpeg' | 'webp' = 'png', quality: number | undefined;
  const notes: string[] = [];
  for (const step of steps) {
    const meta = await sharp(current).metadata();
    let image = sharp(current);
    if (step.op === 'crop') {
      if (step.left + step.width > meta.width! || step.top + step.height > meta.height!) throw new Error(`The crop reaches outside the ${meta.width}×${meta.height} image`);
      image = image.extract({ left: step.left, top: step.top, width: step.width, height: step.height });
    } else if (step.op === 'resize') {
      if (step.width * step.height > transformLimits.pixels) throw new Error('The resized image would be larger than 64 megapixels');
      image = image.resize(step.width, step.height, { fit: step.fit, kernel: step.kernel === 'nearest' ? sharp.kernel.nearest : sharp.kernel.lanczos3, background: { r: 0, g: 0, b: 0, alpha: 0 } });
      if (step.kernel === 'nearest') notes.push('Scaled with nearest-neighbor sampling (pixel art stays crisp)');
    } else if (step.op === 'rotate') image = image.rotate(step.degrees);
    else if (step.op === 'flip') image = step.axis === 'vertical' ? image.flip() : image.flop();
    else if (step.op === 'extend') image = image.extend({ top: step.top, right: step.right, bottom: step.bottom, left: step.left, background: step.background || { r: 0, g: 0, b: 0, alpha: 0 } });
    else if (step.op === 'format') {
      if (step.format === 'jpeg' && meta.hasAlpha) {
        if (!step.flatten) throw Object.assign(new Error('This image has transparency, which JPEG cannot store. Choose a background color to flatten onto, or export PNG or WebP.'), { code: 'needs_flatten' });
        image = image.flatten({ background: step.flatten }); notes.push(`Transparency flattened onto ${step.flatten}`);
      }
      format = step.format; quality = step.quality;
    }
    current = await image.png().toBuffer();
  }
  const out = format === 'jpeg' ? await sharp(current).jpeg({ quality: quality ?? 90 }).toBuffer() : format === 'webp' ? await sharp(current).webp({ quality: quality ?? 90, lossless: quality === undefined }).toBuffer() : current;
  const meta = await sharp(out).metadata();
  return { bytes: out, mime: 'image/' + format, width: meta.width!, height: meta.height!, alpha: !!meta.hasAlpha, notes };
}

/**
 * Cere's mask: single-channel coverage the size of the base, 255 edits and 0 preserves. Any input the
 * editor painted (PNG with alpha or gray) becomes that, after a check that it matches the base exactly.
 */
export async function normalizeMask(maskBytes: Buffer, base: { width: number; height: number }) {
  const meta = await input(maskBytes).metadata();
  if (meta.width !== base.width || meta.height !== base.height) throw new Error(`The mask is ${meta.width}×${meta.height} but the image is ${base.width}×${base.height}; draw it on this version again`);
  const gray = await (meta.hasAlpha ? input(maskBytes).ensureAlpha().extractChannel(3) : input(maskBytes).greyscale()).png().toBuffer();
  const stats = await sharp(gray).stats();
  if (stats.channels[0].max === 0) throw new Error('The mask is empty: paint the area to change');
  return { bytes: gray, coverage: stats.channels[0].mean / 255 };
}
/** OpenAI's convention: same size as the first image, with an alpha channel where transparent pixels are edited. */
export async function openaiMask(mask: Buffer) {
  const meta = await sharp(mask).metadata();
  const alpha = await sharp(mask).greyscale().negate({ alpha: false }).raw().toBuffer();
  return sharp({ create: { width: meta.width!, height: meta.height!, channels: 3, background: { r: 0, g: 0, b: 0 } } }).joinChannel(alpha, { raw: { width: meta.width!, height: meta.height!, channels: 1 } }).png().toBuffer();
}
/** Black-and-white mask for backends that take white as the edit area (ComfyUI's LoadImageMask from luminance). */
export async function whiteMeansEdit(mask: Buffer) { return sharp(mask).greyscale().png().toBuffer(); }

/**
 * Keeps pixels outside the selection exactly: the generated result is resized to the original's size and
 * composited over it through the mask, with an optional feather inside the selection only. Refused when
 * the result cannot be aligned unambiguously (a different aspect ratio).
 */
export async function protectOutside(original: Buffer, generated: Buffer, mask: Buffer, feather = 0) {
  const base = await sharp(original).rotate().metadata(), out = await sharp(generated).metadata();
  if (!base.width || !base.height || !out.width || !out.height) throw new Error('An image could not be decoded');
  const rotated = (base.orientation || 1) >= 5, width = rotated ? base.height : base.width, height = rotated ? base.width : base.height;
  const ratio = (width / height) / (out.width / out.height);
  if (Math.abs(ratio - 1) > 0.01) throw Object.assign(new Error('The result has a different shape than the original, so it cannot be aligned; protected-region compositing was not applied'), { code: 'unaligned' });
  const raw1 = { raw: { width, height, channels: 1 as const } };
  let coverage = await sharp(mask).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
  // Feathering softens the edge inward only: the blur is masked by the thresholded selection, so a pixel
  // outside it keeps a coverage of exactly zero.
  if (feather > 0) {
    const hard = await sharp(coverage, raw1).threshold(1).raw().toBuffer();
    const blurred = await sharp(coverage, raw1).blur(Math.min(feather, 64)).raw().toBuffer();
    coverage = await sharp(blurred, raw1).boolean(hard, 'and', raw1).raw().toBuffer();
  }
  // sharp applies pipeline steps in its own fixed order, so each step that depends on another is its own pipeline.
  const rgb = await sharp(generated).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const overlay = await sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(coverage, raw1).png().toBuffer();
  const baseRgba = await sharp(original).rotate().ensureAlpha().png().toBuffer();
  return sharp(baseRgba).composite([{ input: overlay, blend: 'over' }]).png().toBuffer();
}
/** Pixels that differ between two same-size images outside a mask: 0 means the protection held. Bounded to 16 MP. */
export async function changedOutside(a: Buffer, b: Buffer, mask: Buffer) {
  const left = await sharp(a).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true }), { width, height } = left.info;
  if (width * height > 16_000_000) throw new Error('Too large to verify pixel by pixel');
  const right = await sharp(b).rotate().ensureAlpha().resize(width, height, { fit: 'fill' }).raw().toBuffer();
  const coverage = await sharp(mask).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();
  let changed = 0;
  for (let p = 0; p < width * height; p++) if (coverage[p] === 0) { const i = p * 4; if (left.data[i] !== right[i] || left.data[i + 1] !== right[i + 1] || left.data[i + 2] !== right[i + 2] || left.data[i + 3] !== right[i + 3]) changed++; }
  return changed;
}
/** A labelled grid of images for comparing variants; deterministic and local. */
export async function contactSheet(images: { bytes: Buffer; label: string }[], cell = 320) {
  if (!images.length || images.length > 16) throw new Error('A contact sheet takes 1–16 images');
  const columns = Math.min(4, images.length), rows = Math.ceil(images.length / columns), label = 28;
  const tiles = await Promise.all(images.map(async (image, index) => {
    const thumb = await input(image.bytes).rotate().resize(cell, cell, { fit: 'contain', background: { r: 245, g: 245, b: 245, alpha: 1 } }).png().toBuffer();
    const text = image.label.replace(/[<>&"']/g, '').slice(0, 40);
    const caption = Buffer.from(`<svg width="${cell}" height="${label}"><rect width="100%" height="100%" fill="#ffffff"/><text x="8" y="19" font-family="sans-serif" font-size="14" fill="#222">${index + 1}. ${text}</text></svg>`);
    return [{ input: thumb, left: (index % columns) * cell, top: Math.floor(index / columns) * (cell + label) }, { input: caption, left: (index % columns) * cell, top: Math.floor(index / columns) * (cell + label) + cell }];
  }));
  return sharp({ create: { width: columns * cell, height: rows * (cell + label), channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite(tiles.flat()).png().toBuffer();
}
/** A blank canvas for sketching, at the size the user chose. */
export async function blankCanvas(width: number, height: number, background = '#ffffff') {
  return sharp({ create: { width: int(width, 16, 8192, 'Width'), height: int(height, 16, 8192, 'Height'), channels: 4, background } }).png().toBuffer();
}
/** Flattens an annotation layer (a transparent PNG the editor drew) onto its base, for export. */
export async function flattenAnnotations(base: Buffer, layer: Buffer) {
  const meta = await sharp(base).rotate().metadata(), over = await sharp(layer).metadata();
  if (meta.width !== over.width || meta.height !== over.height) throw new Error('The annotations were drawn on a different size; open the version again');
  return sharp(await sharp(base).rotate().png().toBuffer()).composite([{ input: layer }]).png().toBuffer();
}
