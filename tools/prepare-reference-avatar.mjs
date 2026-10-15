#!/usr/bin/env node
// Import the original reference pixels, using the generated extraction only
// as a matte. Do not substitute the extraction model's repainted RGB.
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const crop = { left: 0, top: 170, width: 430, height: 760 };
const input = 'artwork/cere-reference-exact/';
const source = await sharp('reference/cere.png').extract(crop).ensureAlpha().raw().toBuffer();
const matte = await sharp(input + 'extraction.png').extract(crop).extractChannel(3).raw().toBuffer();
const blink = await sharp(input + 'blink-edit.png').extract(crop).ensureAlpha().raw().toBuffer();
const { width, height } = crop;
const open = Buffer.from(source);

// The generated matte is registered to the source, but its outer antialiasing
// sometimes includes a few pixels of the grey studio backdrop. Refine only
// that narrow edge band using the ORIGINAL backdrop/foreground colors.
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const pixel = y * width + x, offset = pixel * 4;
  let alpha = matte[pixel], low = alpha;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = x + dx, yy = y + dy;
    const a = xx < 0 || xx >= width || yy < 0 || yy >= height ? 0 : matte[yy * width + xx];
    low = Math.min(low, a);
  }
  const r = source[offset], g = source[offset + 1], b = source[offset + 2];
  if (low < 220) {
    const backdrop = r > 100 && b >= r && b >= g - 3 && g >= r - 3;
    if (backdrop) alpha = Math.round(alpha * Math.max(0, Math.min(1, (b - r - 30) / 30)));
  }
  open[offset + 3] = alpha < 3 ? 0 : alpha;
}

const closed = Buffer.from(open);
const eyeRegions = [[128, 393 - crop.top, 84, 64], [233, 392 - crop.top, 89, 66]];
for (const [left, top, w, h] of eyeRegions) {
  for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) {
    const at = (y * width + x) * 4;
    // Keep the original blue fringe in front of the eyelid patch.
    const eyeX = left < 200 ? 174 : 273;
    const insideEye = ((x - eyeX) / 32) ** 2 + ((y + crop.top - 427) / 27) ** 2 < 1;
    if (!insideEye && open[at + 2] > 130 && open[at + 2] - open[at] > 45 && open[at + 2] - open[at + 1] > 20) continue;
    const edge = Math.min(x - left, left + w - 1 - x, y - top, top + h - 1 - y);
    const blend = Math.min(1, edge / 4);
    for (let c = 0; c < 3; c++) closed[at + c] = Math.round(open[at + c] * (1 - blend) + blink[at + c] * blend);
  }
}
const png = data => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
const openPng = await png(open), closedPng = await png(closed);
const atlas = Buffer.alloc(width * 2 * height * 4);
for (let y = 0; y < height; y++) {
  open.copy(atlas, y * width * 8, y * width * 4, (y + 1) * width * 4);
  closed.copy(atlas, y * width * 8 + width * 4, y * width * 4, (y + 1) * width * 4);
}
await sharp(atlas, { raw: { width: width * 2, height, channels: 4 } })
  .png().toFile('assets/cere-reference-surface.png');
await writeFile(input + 'front.png', openPng);
await writeFile(input + 'blink.png', closedPng);
console.log('Prepared original-reference surface and registered blink, 860x760.');
