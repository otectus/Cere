/**
 * A06: styles and recipes as portable packages. A package carries text and settings only: never
 * credentials, grants, bindings, permission switches or local history. A style's tool ceiling can only
 * withhold, and a recipe's permissions are descriptions, so nothing imported can widen authority.
 * Importing is previewed first; the reviewed preview is bound to the package text by its digest.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Core } from './core.ts';

export const packageFormat = 'cere-package', packageSchema = 1, packageLimitBytes = 1024 * 1024;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export class ProfilePackages {
  core: Core;
  private previews = new Map<string, {
    digest: string; text: string; targets: string; profileIds: string[]; recipeIds: string[];
    expires: number; timer: NodeJS.Timeout;
  }>();
  discard(token: string) {
    const entry = this.previews.get(token);
    if (entry) clearTimeout(entry.timer);
    this.previews.delete(token);
  }
  close() { for (const token of this.previews.keys()) this.discard(token); }
  constructor(core: Core) { this.core = core; }
  export(p: any) {
    const profiles = Array.isArray(p?.profiles) ? p.profiles.filter((id: unknown) => typeof id === 'string') : [];
    const recipes = Array.isArray(p?.recipes) ? p.recipes.filter((id: unknown) => typeof id === 'string') : [];
    if (!profiles.length && !recipes.length) throw new Error('Choose styles or recipes to export');
    const items = this.core.presets.catalog().items.filter(item => profiles.includes(item.id))
      .map(({ id, label, text, traits, instructions, ceiling, posture, constraints }) => ({ id, label, text, traits, instructions, ceiling, posture, constraints: constraints || [] }));
    const text = JSON.stringify({ format: packageFormat, schema: packageSchema, created: new Date().toISOString(), profiles: items, recipes: this.core.workflows.exportRecipes(recipes) }, null, 2) + '\n';
    return { text, filename: 'cere-styles-and-recipes.json', profiles: items.length, recipes: recipes.length };
  }
  private parse(text: unknown) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > packageLimitBytes) throw new Error('Choose a package file of up to 1 MB');
    let value: any;
    try { value = JSON.parse(text); } catch { throw new Error('This is not a Cere package (invalid JSON)'); }
    if (value?.format !== packageFormat) throw new Error('This is not a Cere package');
    if (!Number.isInteger(value.schema) || value.schema > packageSchema || value.schema < 1) throw new Error('This package was made by a newer version of Cere. Update Cere to import it.');
    const allowed = ['format', 'schema', 'created', 'profiles', 'recipes'];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('This package has fields Cere does not import; nothing was imported');
    if (!Array.isArray(value.profiles ?? []) || !Array.isArray(value.recipes ?? []) || (value.profiles?.length || 0) > 50 || (value.recipes?.length || 0) > 100) throw new Error('Invalid package contents');
    return value;
  }
  /** A package file the user chose; only a regular file of up to 1 MB is read. */
  private async read(path: unknown) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw new Error('Choose a package file');
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Choose a package file');
      if (info.size > packageLimitBytes) throw new Error('Choose a package file of up to 1 MB');
      const buffer = Buffer.allocUnsafe(info.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, buffer.length - used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > info.size) throw new Error('The package file changed. Preview it again.');
      return buffer.toString('utf8', 0, used);
    } finally { await file.close(); }
  }
  /** Validates every item and reports what would be new or changed, without saving anything. */
  async preview(p: any) {
    if (p?.path !== undefined && p?.text !== undefined) throw new Error('Preview a package from text or from a file, not both');
    const text = p?.path !== undefined ? await this.read(p.path) : p?.text;
    const value = this.parse(text);
    const profiles = this.core.presets.planImport(value.profiles ?? []).items;
    const recipes = this.core.workflows.planRecipeImport(value.recipes ?? []).items;
    const token = randomUUID(), hash = digest(text);
    // Eight outstanding packages bound retained source text to 8 MiB across all clients.
    while (this.previews.size >= 8) this.discard(this.previews.keys().next().value!);
    const ttl = 10 * 60_000;
    this.previews.set(token, { digest: hash, text, targets: JSON.stringify([profiles, recipes]),
      profileIds: profiles.map(item => item.id), recipeIds: recipes.map(item => item.id),
      expires: Date.now() + ttl, timer: setTimeout(() => this.discard(token), ttl).unref() });
    return { token, digest: hash, profiles, recipes, note: 'Packages never include API keys, permissions, project grants or bindings. Imported styles can only withhold tools.' };
  }
  import(p: any) {
    const preview = this.previews.get(p?.token);
    this.discard(p?.token);
    if (!preview || preview.expires <= Date.now() || preview.digest !== p?.digest) throw new Error('Preview the package again before importing');
    const value = this.parse(preview.text);
    const result = this.core.store.transaction(() => {
      const profiles = this.core.presets.planImport((value.profiles ?? []).map((item: any, index: number) => ({ ...item, id: preview.profileIds[index] })));
      const recipes = this.core.workflows.planRecipeImport((value.recipes ?? []).map((item: any, index: number) => ({ ...item, id: preview.recipeIds[index] })));
      if (JSON.stringify([profiles.items, recipes.items]) !== preview.targets) {
        throw Object.assign(new Error('A saved style or recipe changed. Preview the package again.'), { code: 'REVISION_CONFLICT' });
      }
      if (profiles.items.some(item => item.action !== 'unchanged')) profiles.save();
      if (recipes.items.some(item => item.action !== 'unchanged')) recipes.save();
      return { profiles: profiles.items, recipes: recipes.items };
    });
    if ([...result.profiles, ...result.recipes].some(item => item.action !== 'unchanged')) this.core.changed();
    return result;
  }
}
