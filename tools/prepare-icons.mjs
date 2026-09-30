import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const sizes = [16, 22, 24, 32, 48, 64, 128, 256, 512];

if (process.argv.length !== 4) {
  throw new Error('usage: node tools/prepare-icons.mjs INPUT.png OUTPUT_HICOLOR_DIR');
}

const input = resolve(process.argv[2]);
const outputRoot = resolve(process.argv[3]);
const source = sharp(input, { failOn: 'error' });
const metadata = await source.metadata();

if (metadata.format !== 'png') throw new Error(`Icon master must be PNG: ${input}`);
if (!metadata.width || metadata.width !== metadata.height) {
  throw new Error(`Icon master must be square: ${metadata.width || 0}x${metadata.height || 0}`);
}
if (!metadata.hasAlpha) throw new Error('Icon master must have an alpha channel');

for (const size of sizes) {
  const output = join(outputRoot, `${size}x${size}`, 'apps', 'cere.png');
  await mkdir(dirname(output), { recursive: true });
  await sharp(input, { failOn: 'error' })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toFile(output);

  const generated = await sharp(output).metadata();
  if (generated.format !== 'png' || generated.width !== size || generated.height !== size || !generated.hasAlpha) {
    throw new Error(`Invalid generated icon: ${output}`);
  }
}
