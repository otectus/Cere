import { readFileSync, existsSync } from 'node:fs';
import { avatarCatalog, avatarRoutes } from '../broker/avatars.ts';

const asset = (name: string) => new URL('../assets/' + name, import.meta.url);
for (const avatar of avatarCatalog) {
  const rig = JSON.parse(readFileSync(asset(avatar.rig), 'utf8'));
  if (!existsSync(asset(avatar.portrait)) || typeof rig.texture !== 'string' ||
      !/^[a-zA-Z0-9_-]+\.png$/.test(rig.texture) || !existsSync(asset(rig.texture)))
    throw new Error(`${avatar.id}: missing portrait or surface texture`);
  for (const route of avatarRoutes)
    if (!Array.isArray(rig.surfaceSequences?.routes?.[route]?.frames) || rig.surfaceSequences.routes[route].frames.length < 2)
      throw new Error(`${avatar.id}: missing ${route} frames`);
}
console.log(`Validated ${avatarCatalog.length} avatar entries and their runtime assets.`);
