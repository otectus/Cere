import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import { validatePersonality } from './personality.ts';
import { validCeiling, validTraits, type BehaviorProfile } from './behavior.ts';
import { validConstraints } from './style-checks.ts';

/**
 * Saved styles (Q01), evolved into behavior profiles (M01, schema 2): personality text plus optional
 * neutral-by-default traits, standing instructions, a tool ceiling that can only withhold, and
 * whether the style can be used as a posture. The catalog never applies anything itself: changing
 * or deleting an entry leaves the saved personality, name, avatar, voice, models and permissions as
 * they were; only the editor's Save or an explicit project/conversation binding uses a style.
 * Stored as one versioned meta value; a restore keeps this machine's catalog (recovery.ts machineMeta).
 */
export const presetStoreKey = 'behaviorPresets';
export const presetLimit = 50;
export const presetLabelMaxLength = 80;
export type BehaviorPreset = BehaviorProfile;
export type BehaviorPresetCatalog = { schema: 2; revision: string; items: BehaviorPreset[] };

const emptyCatalog = (): BehaviorPresetCatalog => ({ schema: 2, revision: '0', items: [] });
/** A schema 1 saved style becomes a profile with neutral traits and no limits. */
const upgraded = (item: any): BehaviorPreset => ({ traits: {}, instructions: '', ceiling: {}, posture: false, ...item });
const next = (revision: string) => String(BigInt(revision || '0') + 1n);

export function presetLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length > presetLabelMaxLength * 2 || /[\uD800-\uDFFF\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
    throw new Error(`Name the style with up to ${presetLabelMaxLength} characters, without control characters or line breaks`);
  const label = value.trim();
  if (!label || label.length > presetLabelMaxLength) throw new Error(`Name the style with 1–${presetLabelMaxLength} characters`);
  return label;
}
function strict(p: unknown, keys: string[]): Record<string, unknown> {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(key => !keys.includes(key))) throw new Error('Invalid style preset request');
  return p as Record<string, unknown>;
}

export class BehaviorPresets {
  store: Store; changed: () => void;
  constructor(store: Store, changed: () => void) { this.store = store; this.changed = changed; }
  catalog(): BehaviorPresetCatalog {
    const value = this.store.get<any>(presetStoreKey, null);
    if (value === null) return emptyCatalog();
    // A newer Cere may have extended the catalog; refuse rather than rewrite what it saved.
    if (!value || ![1, 2].includes(value.schema) || !Array.isArray(value.items)) throw new Error('These saved styles were written by a newer version of Cere. Update Cere before editing them.');
    return { schema: 2, revision: value.revision, items: value.items.map(upgraded) };
  }
  /** What every state snapshot carries: enough for clients to know when to reload the list. */
  summary() { try { const catalog = this.catalog(); return { revision: catalog.revision, count: catalog.items.length }; } catch { return { revision: 'unsupported', count: 0 }; } }
  private write(catalog: BehaviorPresetCatalog) { this.store.set(presetStoreKey, catalog); this.changed(); return catalog; }
  dispatch(method: string, p: any = {}) {
    if (method === 'presets.list') { strict(p, []); return this.catalog(); }
    if (method === 'presets.save') return this.save(p);
    if (method === 'presets.delete') return this.remove(p);
    if (method === 'presets.checkpoint') return this.checkpoint(p);
    if (method === 'presets.restore') return this.restore(p);
    throw new Error('Unknown style preset operation');
  }
  /**
   * A06: one style from a package, through the same validators as an edit. The same id is updated in
   * place when it differs; checkpoints and local history are never imported or overwritten.
   */
  importProfile(input: any, dryRun: boolean): { id: string; label: string; action: 'new' | 'changed' | 'unchanged' } {
    if (!input || typeof input !== 'object') throw new Error('Invalid style in package');
    const catalog = this.catalog(), label = presetLabel(input.label), text = validatePersonality(typeof input.text === 'string' ? input.text : null);
    if (typeof input.text !== 'string') throw new Error(`The style ${label} has no text`);
    const fields = { label, text, traits: validTraits(input.traits), instructions: typeof input.instructions === 'string' ? input.instructions.slice(0, 4000).trim() : '',
      ceiling: validCeiling(input.ceiling), posture: input.posture === true, constraints: validConstraints(input.constraints) };
    const index = catalog.items.findIndex(item => item.id === input.id);
    const existing = index >= 0 ? catalog.items[index] : undefined;
    const same = (item: BehaviorPreset) => JSON.stringify([item.label, item.text, item.traits, item.instructions, item.ceiling, item.posture, item.constraints || []]) === JSON.stringify([fields.label, fields.text, fields.traits, fields.instructions, fields.ceiling, fields.posture, fields.constraints]);
    const action = !existing ? 'new' : same(existing) ? 'unchanged' : 'changed';
    const id = existing?.id || (typeof input.id === 'string' && /^[0-9a-f-]{36}$/.test(input.id) ? input.id : randomUUID());
    if (!existing && catalog.items.some(item => item.label.toLowerCase() === label.toLowerCase())) throw new Error(`A saved style already has the name ${label}`);
    if (!dryRun && action !== 'unchanged') {
      const time = Date.now(), items = [...catalog.items];
      if (existing) items[index] = { ...existing, ...fields, revision: next(existing.revision), updated: time };
      else { if (items.length >= presetLimit) throw new Error(`Keep at most ${presetLimit} saved styles`); items.push({ id, ...fields, revision: '1', created: time, updated: time }); }
      this.write({ schema: 2, revision: next(catalog.revision), items });
    }
    return { id, label, action };
  }
  /** Styles for resolution; an unreadable (newer) catalog resolves as if empty, with the global personality. */
  profiles(): BehaviorPreset[] { try { return this.catalog().items; } catch { return []; } }
  /**
   * Creates a style (expectedRevision is the catalog's) or replaces one (expectedItemRevision is the
   * style's). A field left out of a replacement keeps its saved value.
   */
  private save(input: unknown) {
    const p = strict(input, ['id', 'label', 'text', 'expectedRevision', 'expectedItemRevision', 'traits', 'instructions', 'ceiling', 'posture', 'constraints']);
    if (p.text === null) throw new Error('Choose the text to save; a style cannot store a reset');
    const catalog = this.catalog(), label = presetLabel(p.label), text = validatePersonality(p.text);
    const fields: Partial<BehaviorPreset> = {};
    if ('traits' in p) fields.traits = validTraits(p.traits);
    if ('ceiling' in p) fields.ceiling = validCeiling(p.ceiling);
    if ('constraints' in p) fields.constraints = validConstraints(p.constraints);
    if ('posture' in p) { if (typeof p.posture !== 'boolean') throw new Error('Choose whether the style can be a posture'); fields.posture = p.posture; }
    if ('instructions' in p) {
      if (typeof p.instructions !== 'string' || p.instructions.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(p.instructions)) throw new Error('Standing instructions are up to 4,000 characters without control characters');
      fields.instructions = p.instructions.trim();
    }
    const duplicate = (id?: string) => catalog.items.some(item => item.id !== id && item.label.toLocaleLowerCase('en-US') === label.toLocaleLowerCase('en-US'));
    const time = Date.now();
    if (p.id === undefined) {
      if (p.expectedRevision !== catalog.revision) throw Object.assign(new Error('Saved styles changed in another window. Reload them before adding one.'), { code: 'REVISION_CONFLICT' });
      if (catalog.items.length >= presetLimit) throw new Error(`Keep at most ${presetLimit} saved styles. Delete one first.`);
      if (duplicate()) throw new Error('A saved style already has this name');
      const item: BehaviorPreset = { id: randomUUID(), label, text, traits: {}, instructions: '', ceiling: {}, posture: false, ...fields, revision: '1', created: time, updated: time };
      this.write({ schema: 2, revision: next(catalog.revision), items: [...catalog.items, item] });
      return item;
    }
    const index = catalog.items.findIndex(item => item.id === p.id);
    if (index < 0) throw new Error('This saved style no longer exists');
    const current = catalog.items[index];
    if (p.expectedItemRevision !== current.revision) throw Object.assign(new Error('This saved style changed in another window. Reload it before saving.'), { code: 'REVISION_CONFLICT' });
    if (duplicate(current.id)) throw new Error('A saved style already has this name');
    const item: BehaviorPreset = { ...current, ...fields, label, text, revision: next(current.revision), updated: time };
    const items = [...catalog.items]; items[index] = item;
    this.write({ schema: 2, revision: next(catalog.revision), items });
    return item;
  }
  /** M02: an immutable copy of a style's current content. Checkpoints are never edited or removed one by one. */
  private checkpoint(input: unknown) {
    const p = strict(input, ['id', 'expectedItemRevision', 'label']), catalog = this.catalog();
    const index = catalog.items.findIndex(item => item.id === p.id);
    if (index < 0) throw new Error('This saved style no longer exists');
    const current = catalog.items[index];
    if (p.expectedItemRevision !== current.revision) throw Object.assign(new Error('This saved style changed in another window. Reload it before saving a checkpoint.'), { code: 'REVISION_CONFLICT' });
    const checkpoints = current.checkpoints || [];
    if (checkpoints.length >= 30) throw new Error('A style keeps at most 30 checkpoints');
    if (checkpoints.some(point => point.revision === current.revision)) throw new Error('This revision already has a checkpoint');
    const label = p.label === undefined || p.label === '' ? `Revision ${current.revision}` : presetLabel(p.label);
    const point = { revision: current.revision, label, created: Date.now(), text: current.text, traits: { ...current.traits }, instructions: current.instructions, ceiling: { ...current.ceiling }, posture: current.posture, ...(current.constraints ? { constraints: [...current.constraints] } : {}) };
    const items = [...catalog.items]; items[index] = { ...current, checkpoints: [...checkpoints, point] };
    this.write({ schema: 2, revision: next(catalog.revision), items });
    return point;
  }
  /** Restoring a checkpoint writes its content as a new revision; the checkpoint and older history stay as they were. */
  private restore(input: unknown) {
    const p = strict(input, ['id', 'expectedItemRevision', 'checkpointRevision']), catalog = this.catalog();
    const index = catalog.items.findIndex(item => item.id === p.id);
    if (index < 0) throw new Error('This saved style no longer exists');
    const current = catalog.items[index];
    if (p.expectedItemRevision !== current.revision) throw Object.assign(new Error('This saved style changed in another window. Reload it before restoring.'), { code: 'REVISION_CONFLICT' });
    const point = (current.checkpoints || []).find(item => item.revision === p.checkpointRevision);
    if (!point) throw new Error('This checkpoint no longer exists');
    const item: BehaviorPreset = { ...current, text: point.text, traits: { ...point.traits }, instructions: point.instructions, ceiling: { ...point.ceiling }, posture: point.posture,
      ...(point.constraints ? { constraints: [...point.constraints] } : { constraints: [] }), revision: next(current.revision), updated: Date.now() };
    const items = [...catalog.items]; items[index] = item;
    this.write({ schema: 2, revision: next(catalog.revision), items });
    return item;
  }
  private remove(input: unknown) {
    const p = strict(input, ['id', 'expectedItemRevision']), catalog = this.catalog();
    const current = catalog.items.find(item => item.id === p.id);
    if (!current) throw new Error('This saved style no longer exists');
    if (p.expectedItemRevision !== current.revision) throw Object.assign(new Error('This saved style changed in another window. Reload it before deleting.'), { code: 'REVISION_CONFLICT' });
    return this.write({ schema: 2, revision: next(catalog.revision), items: catalog.items.filter(item => item.id !== current.id) });
  }
}
