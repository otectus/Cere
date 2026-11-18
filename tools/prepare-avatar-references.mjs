#!/usr/bin/env node
// Use generated extraction alpha and local eyelid edits; keep original RGB.
import sharp from 'sharp';
import { sheetComponents } from './avatar-sheet.mjs';
import { authoringAvatars } from '../broker/avatars.ts';
const directory = 'artwork/avatars';
for (const {id, authoring: source} of authoringAvatars(process.argv.slice(2))) {
  const [left, top, width, height] = source.crop;
  const crop = { left, top, width, height };
  const open = await sharp(`reference/${id}.png`).extract(crop).ensureAlpha().raw().toBuffer();
  let matte;
  if (source.matteGrid) {
    const grid = source.matteGrid;
    const component = sheetComponents(await sharp(`${directory}/${id}/extraction.png`).ensureAlpha().raw().toBuffer({resolveWithObject:true}), grid.columns, grid.rows)[grid.index];
    matte = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = x + left - component.source[0], sy = y + top - component.source[1];
      if (sx >= 0 && sy >= 0 && sx < component.info.width && sy < component.info.height)
        matte[y * width + x] = component.data[(sy * component.info.width + sx) * 4 + 3];
    }
  } else matte = await sharp(`${directory}/${id}/extraction.png`).extract(crop).extractChannel(3).raw().toBuffer();
  const edit = await sharp(`${directory}/${id}/blink-edit.png`).extract(crop).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, i = p * 4;
    let low = matte[p], alpha = matte[p];
    const radius = source.matteRadius ?? 2;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      low = Math.min(low, xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : matte[yy * width + xx]);
    }
    const [r, g, b] = open.subarray(i, i + 3), chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (source.refineNeutralBackdrop !== false && low < 220 && r > 100 && g > 100 && b > 100 && chroma < 30)
      alpha = Math.round(alpha * Math.max(0, (chroma - 12) / 18));
    // Witty's lavender studio background can remain in the narrow fringe of
    // the generated matte. Refine that edge using original background colours;
    // mint accents, warm violet hair highlights and all original RGB stay intact.
    if (source.edgeBackdrop === 'lavender' && low < 220 && r > 90 && g > 90 &&
        b - Math.max(r, g) > 18 && Math.abs(r - g) < 24)
      alpha = Math.round(alpha * Math.max(0, (Math.abs(r - g) - 8) / 16));
    if (source.matteRefinement === 'blue-fringe' && low < 220) {
      const backdrop = r > 100 && b >= r && b >= g - 3 && g >= r - 3;
      if (backdrop) alpha = Math.round(alpha * Math.max(0, Math.min(1, (b - r - 30) / 30)));
    }
    open[i + 3] = alpha < (source.alphaCutoff ?? 8) ? 0 : alpha;
  }
  const closed = Buffer.from(open);
  for (const [eye, [ex, ey, ew, eh]] of source.eyes.entries()) {
    for (let y = ey - top; y < ey - top + eh; y++) for (let x = ex - left; x < ex - left + ew; x++) {
      const i = (y * width + x) * 4;
      if (source.protectBlueFringe) {
        const [cx, cy, rx, ry] = source.protectBlueFringe[eye];
        const inside = ((x + left - cx) / rx) ** 2 + ((y + top - cy) / ry) ** 2 < 1;
        if (!inside && open[i + 2] > 130 && open[i + 2] - open[i] > 45 && open[i + 2] - open[i + 1] > 20) continue;
      }
      const edge = Math.min(x - ex + left, ex - left + ew - 1 - x, y - ey + top, ey - top + eh - 1 - y);
      const mix = Math.min(1, edge / 4);
      for (let c = 0; c < 3; c++) closed[i + c] = Math.round(open[i + c] * (1 - mix) + edit[i + c] * mix);
    }
  }
  for (const [name, data] of [['front', open], ['blink', closed]])
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(`${directory}/${id}/${name}.png`);
  console.log(`${id}: original front pixels and registered blink prepared`);
}
