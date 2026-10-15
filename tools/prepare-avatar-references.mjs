#!/usr/bin/env node
// Use generated extraction alpha and local eyelid edits; keep original RGB.
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
const directory = 'artwork/avatars';
const sources = JSON.parse(await readFile(`${directory}/sources.json`, 'utf8'));
for (const [id, source] of Object.entries(sources)) {
  const [left, top, width, height] = source.crop;
  const crop = { left, top, width, height };
  const open = await sharp(`reference/${id}.png`).extract(crop).ensureAlpha().raw().toBuffer();
  const matte = await sharp(`${directory}/${id}/extraction.png`).extract(crop).extractChannel(3).raw().toBuffer();
  const edit = await sharp(`${directory}/${id}/blink-edit.png`).extract(crop).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, i = p * 4;
    let low = matte[p], alpha = matte[p];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      low = Math.min(low, xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : matte[yy * width + xx]);
    }
    const [r, g, b] = open.subarray(i, i + 3), chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (low < 220 && r > 100 && g > 100 && b > 100 && chroma < 30)
      alpha = Math.round(alpha * Math.max(0, (chroma - 12) / 18));
    open[i + 3] = alpha < 8 ? 0 : alpha;
  }
  const closed = Buffer.from(open);
  for (const [ex, ey, ew, eh] of source.eyes) {
    for (let y = ey - top; y < ey - top + eh; y++) for (let x = ex - left; x < ex - left + ew; x++) {
      const i = (y * width + x) * 4;
      const edge = Math.min(x - ex + left, ex - left + ew - 1 - x, y - ey + top, ey - top + eh - 1 - y);
      const mix = Math.min(1, edge / 4);
      for (let c = 0; c < 3; c++) closed[i + c] = Math.round(open[i + c] * (1 - mix) + edit[i + c] * mix);
    }
  }
  for (const [name, data] of [['front', open], ['blink', closed]])
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(`${directory}/${id}/${name}.png`);
  console.log(`${id}: original front pixels and registered blink prepared`);
}

// Cere uses its existing registered blue-fringe matte refinement.
{
const crop = { left: 0, top: 170, width: 430, height: 760 };
const input = 'artwork/avatars/cere/';
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
await writeFile(input + 'front.png', openPng);
await writeFile(input + 'blink.png', closedPng);
}
