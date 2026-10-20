import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { bytesDigest } from './crypto.ts';

const assets = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
/** The expression cells of a portrait sheet (4 columns, 3 rows), in the order qml/CerePortrait.qml uses. */
export const portraitFrames = { neutral: 0, curious: 1, thinking: 2, happy: 3, cheeky: 4, skeptical: 5, tender: 6, concerned: 7, surprised: 8, focused: 9, sleepy: 10 } as const;
const cell = 96, reduced = new Map<string, { sha256: string; data: string }>();

/**
 * W11 (F93): the desktop's selected portrait for the phone's static status avatar: the sheet of
 * expressions reduced to 96-pixel cells, with the colors the desktop draws around it. The phone
 * chooses the cell from the conversation's state as the desktop does; it never animates it.
 */
export async function portraitSheet(avatarId: string) {
  const catalog = JSON.parse(await readFile(join(assets, 'avatars.json'), 'utf8')) as { id: string; label: string; portrait?: string }[];
  const avatar = catalog.find(entry => entry.id === avatarId) || catalog.find(entry => entry.id === 'cere') || catalog[0];
  const file = avatar.portrait || 'cere-portraits.png';
  if (!/^[\w-]+\.png$/.test(file)) throw new Error('Invalid portrait file');
  let image = reduced.get(file);
  if (!image) {
    const bytes = await sharp(join(assets, file), { limitInputPixels: 16_000_000 }).resize({ width: cell * 4, height: cell * 3, fit: 'fill' }).webp({ quality: 85, alphaQuality: 90 }).toBuffer();
    image = { sha256: bytesDigest(bytes), data: bytes.toString('base64') };
    reduced.set(file, image);
  }
  const palettes = JSON.parse(await readFile(join(assets, 'palettes.json'), 'utf8')) as Record<string, Record<string, string>>;
  const colors = palettes[avatar.id] || palettes.cere || {};
  const palette = Object.fromEntries(['portraitTop', 'portraitBottom', 'portraitAccent', 'portraitAttention', 'portraitWarm', 'portraitBorder']
    .filter(key => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(colors[key] || '')).map(key => [key, colors[key]]));
  return { avatarId: avatar.id, label: avatar.label.slice(0, 40), columns: 4, rows: 3, cell, frames: portraitFrames, palette, mime: 'image/webp', sha256: image.sha256, data: image.data };
}
