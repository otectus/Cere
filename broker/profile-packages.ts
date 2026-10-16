/**
 * A06: styles and recipes as portable packages. A package carries text and settings only: never
 * credentials, grants, bindings, permission switches or local history. A style's tool ceiling can only
 * withhold, and a recipe's permissions are descriptions, so nothing imported can widen authority.
 * Importing is previewed first; the reviewed preview is bound to the package text by its digest.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { Core } from './core.ts';

export const packageFormat = 'cere-package', packageSchema = 1, packageLimitBytes = 1024 * 1024;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export class ProfilePackages {
  core: Core; previews = new Map<string, { digest: string; text: string; expires: number }>();
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
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Choose a package file');
      if (info.size > packageLimitBytes) throw new Error('Choose a package file of up to 1 MB');
      return (await file.readFile()).toString('utf8');
    } finally { await file.close(); }
  }
  /** Validates every item and reports what would be new or changed, without saving anything. */
  async preview(p: any) {
    if (p?.path !== undefined && p?.text !== undefined) throw new Error('Preview a package from text or from a file, not both');
    const text = p?.path !== undefined ? await this.read(p.path) : p?.text;
    const value = this.parse(text);
    const profiles = (value.profiles || []).map((item: any) => this.core.presets.importProfile(item, true));
    const recipes = (value.recipes || []).map((item: any) => this.core.workflows.importRecipe(item, true));
    const token = randomUUID();
    this.previews.set(token, { digest: digest(text), text, expires: Date.now() + 10 * 60_000 });
    return { token, digest: digest(text), profiles, recipes, note: 'Packages never include API keys, permissions, project grants or bindings. Imported styles can only withhold tools.' };
  }
  import(p: any) {
    const preview = this.previews.get(p?.token); this.previews.delete(p?.token);
    if (!preview || preview.expires < Date.now() || preview.digest !== p?.digest) throw new Error('Preview the package again before importing');
    const value = this.parse(preview.text);
    return { profiles: (value.profiles || []).map((item: any) => this.core.presets.importProfile(item, false)), recipes: (value.recipes || []).map((item: any) => this.core.workflows.importRecipe(item, false)) };
  }
}
