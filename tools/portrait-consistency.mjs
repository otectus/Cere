// Keep expression changes local to the face. Image-generated grids otherwise
// vary the character's hair, costume, silhouette and scene lighting by cell.
const CHANNELS = 4;

function bounds(image) {
  const {data, info: {width, height}} = image;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * CHANNELS + 3] >= 12) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  if (right < left) throw Error('portrait cell is empty');
  return {left, top, right, bottom, width: right - left + 1, height: bottom - top + 1};
}

function sample(data, width, height, x, y, channel) {
  const xx = Math.max(0, Math.min(width - 1, Math.round(x))),
        yy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return data[(yy * width + xx) * CHANNELS + channel];
}

function luminance(data, width, height, x, y) {
  return .2126 * sample(data, width, height, x, y, 0) + .7152 * sample(data, width, height, x, y, 1) +
      .0722 * sample(data, width, height, x, y, 2);
}

function edge(data, width, height, x, y) {
  return Math.abs(luminance(data, width, height, x + 1, y) - luminance(data, width, height, x - 1, y)) +
      Math.abs(luminance(data, width, height, x, y + 1) - luminance(data, width, height, x, y - 1)) +
      Math.abs(sample(data, width, height, x + 1, y, 3) - sample(data, width, height, x - 1, y, 3)) * .8 +
      Math.abs(sample(data, width, height, x, y + 1, 3) - sample(data, width, height, x, y - 1, 3)) * .8;
}

function faceGeometry(neutral) {
  const b = bounds(neutral), cx = (b.left + b.right) / 2, cy = b.top + b.height * .46;
  return {cx, cy, rx: Math.max(38, b.width * .29), ry: Math.max(42, b.height * .27), bounds: b};
}

function registrationScore(neutral, source, geometry, scale, tx, ty) {
  const {data: a, info: {width, height}} = neutral, {data: b} = source,
                                {cx, cy, rx, ry, bounds: box} = geometry;
  let score = 0, count = 0;
  for (let y = Math.max(2, box.top); y <= Math.min(height - 3, box.bottom); y += 3)
    for (let x = Math.max(2, box.left); x <= Math.min(width - 3, box.right); x += 3) {
      const face = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (face < 1.08) continue;
      const sx = cx + (x - cx) / scale + tx, sy = cy + (y - cy) / scale + ty;
      if (sx < 2 || sx >= width - 2 || sy < 2 || sy >= height - 2) continue;
      const alphaA = sample(a, width, height, x, y, 3), alphaB = sample(b, width, height, sx, sy, 3);
      const edgeA = edge(a, width, height, x, y), edgeB = edge(b, width, height, sx, sy);
      score += Math.abs(alphaA - alphaB) * 1.4 + Math.abs(edgeA - edgeB);
      count++;
    }
  return score / Math.max(1, count);
}

function registration(neutral, source, geometry) {
  let best = {scale: 1, tx: 0, ty: 0, score: Infinity};
  for (let scale = .94; scale <= 1.0601; scale += .01) {
    const score = registrationScore(neutral, source, geometry, scale, 0, 0);
    if (score < best.score) best = {scale, tx: 0, ty: 0, score};
  }
  for (let ty = -10; ty <= 10; ty++)
    for (let tx = -10; tx <= 10; tx++) {
      const score = registrationScore(neutral, source, geometry, best.scale, tx, ty);
      if (score < best.score) best = {scale: best.scale, tx, ty, score};
    }
  return best;
}

function alignedPixel(image, geometry, transform, x, y, channel) {
  const {data, info: {width, height}} = image, {cx, cy} = geometry, {scale, tx, ty} = transform;
  const sx = cx + (x - cx) / scale + tx, sy = cy + (y - cy) / scale + ty;
  return sample(data, width, height, sx, sy, channel);
}

function median(values) {
  values.sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : 0;
}

function lightingOffsets(neutral, source, geometry, transform) {
  const {data, info: {width, height}} = neutral, {cx, cy, rx, ry} = geometry, differences = [[], [], []];
  for (let y = 1; y < height - 1; y += 2)
    for (let x = 1; x < width - 1; x += 2) {
      const radius = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (radius < 1.05 || radius > 2.2) continue;
      if (data[(y * width + x) * 4 + 3] < 220 || alignedPixel(source, geometry, transform, x, y, 3) < 220)
        continue;
      // Estimate the cast from adjacent hair and clothing. A blush or an
      // opening eye can legitimately change the colour inside the face.
      if (edge(data, width, height, x, y) > 38) continue;
      for (let c = 0; c < 3; c++)
        differences[c].push(
            data[(y * width + x) * 4 + c] - alignedPixel(source, geometry, transform, x, y, c));
    }
  return differences.map(median).map(value => Math.max(-28, Math.min(28, value)));
}

function correctedCell(neutral, source, geometry) {
  const transform = registration(neutral, source, geometry),
        offsets = lightingOffsets(neutral, source, geometry, transform);
  const {data: base, info: {width, height}} = neutral, {cx, cy, rx, ry} = geometry, out = Buffer.from(base);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const radius = Math.hypot((x - cx) / rx, (y - cy) / ry);
      // The inner face is authored by the expression. A soft twelve-percent rim
      // joins it to the exact neutral hair, costume, silhouette and lighting.
      const weight = Math.max(0, Math.min(1, (1 - radius) / .12));
      if (!weight) continue;
      const at = (y * width + x) * 4;
      if (!base[at + 3]) continue;
      // Resample in premultiplied space. Keep the master silhouette even where
      // the expression artwork has a translucent fringe inside the face region.
      const sx = cx + (x - cx) / transform.scale + transform.tx,
            sy = cy + (y - cy) / transform.scale + transform.ty;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const rgb = [0, 0, 0];
      let coverage = 0;
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const u = x0 + dx, v = y0 + dy;
          if (u < 0 || u >= width || v < 0 || v >= height) continue;
          const i = (v * width + u) * 4,
                k = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * source.data[i + 3] / 255;
          coverage += k;
          for (let c = 0; c < 3; c++) rgb[c] += k * source.data[i + c];
        }
      if (!coverage) continue;
      for (let c = 0; c < 3; c++) {
        const value = Math.max(0, Math.min(255, rgb[c] / coverage + offsets[c]));
        out[at + c] = Math.round(base[at + c] + weight * coverage * (value - base[at + c]));
      }
    }
  return {data: out, info: {width, height, channels: 4}, registration: transform};
}

/** Register every expression to neutral and retain variation only inside the face. */
export function stabilizePortraitCells(cells, reviewedFace) {
  if (cells.length !== 12) throw Error('portrait sheet needs twelve cells');
  const neutral = cells[0], geometry = {...faceGeometry(neutral), ...reviewedFace},
        registrations = [{scale: 1, tx: 0, ty: 0, score: 0}];
  const corrected = [neutral];
  for (const source of cells.slice(1)) {
    const result = correctedCell(neutral, source, geometry);
    corrected.push({data: result.data, info: result.info});
    registrations.push(result.registration);
  }
  return {cells: corrected, registrations, geometry};
}
