import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Identity, colours and authoring registration belong to the same entry. The
// PNGs and baked rigs remain separate assets; adding an ID never requires code.
const id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const png = z.string().regex(/^[a-zA-Z0-9_-]+\.png$/);
const rig = z.string().regex(/^[a-zA-Z0-9_-]+\.json$/);
const point = z.tuple([z.number(), z.number()]);
const rect = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const ellipse = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]);
export const avatarRoutes = ['wave', 'thinking', 'present', 'celebrate', 'shy', 'carry'] as const;
const route = z.enum(avatarRoutes);
const eyePose = z.object({ closed: z.boolean().optional(), eyes: z.array(ellipse.nullable()).min(1).max(2).optional() }).strict();
const landmarks = z.object({ closed: z.boolean().optional(), eyes: z.array(point).min(1).max(2) }).strict();
export const avatarAuthoringSchema = z.object({
  crop: rect, eyes: z.array(rect).min(1).max(2), bounds: rect,
  color: z.enum(['amber', 'bluegray', 'brown', 'cyan', 'green', 'olive', 'purple', 'red']),
  alphaCutoff: z.number().int().min(0).max(255).optional(),
  matteRadius: z.number().int().nonnegative().optional(),
  matteGrid: z.object({ columns: z.number().int().positive(), rows: z.number().int().positive(), index: z.number().int().nonnegative() }).strict().optional(),
  matteRefinement: z.enum(['blue-fringe']).optional(),
  edgeBackdrop: z.enum(['lavender']).optional(),
  refineNeutralBackdrop: z.boolean().optional(), protectBlueFringe: z.array(rect).optional(),
  originalOffset: point.optional(), frameHeight: z.number().int().positive().optional(),
  referenceHeight: z.number().positive().optional(), componentCells: z.boolean().optional(),
  sheetEyes: z.array(rect).min(1).max(2).optional(),
  sheetLandmarks: z.partialRecord(route, z.array(landmarks.nullable()).length(16)).optional(),
  cellOrder: z.partialRecord(route, z.array(z.number().int().min(0).max(15)).length(16)).optional(),
  normalizedRoutes: z.array(route).optional(),
  heldEyeSource: z.array(ellipse).min(1).max(2).optional(),
  heldEyes: z.partialRecord(z.enum([...avatarRoutes, 'shyHover']), eyePose).optional(),
  portraitFace: z.object({
    cx: z.number().min(0).max(255), cy: z.number().min(0).max(255),
    rx: z.number().positive().max(128), ry: z.number().positive().max(128),
  }).strict().optional(),
  portraitComponents: z.boolean().optional(),
  portraitCoreThreshold: z.number().int().min(0).max(255).optional(),
  portraitCoreErode: z.number().int().min(0).max(4).optional(),
}).strict();

export const paletteTokens = [
  'background', 'sidebar', 'surface', 'raised', 'input', 'selected', 'codeSurface', 'userBubble',
  'approvalSurface', 'questionSurface', 'warningSurface', 'dangerSurface', 'questionBadge', 'permissionBadge',
  'overlayScrim', 'line', 'subtle', 'userBubbleBorder', 'border', 'borderHover', 'borderStrong', 'primaryBorder',
  'dangerBorder', 'warningBorder', 'approvalBorder', 'activeBorder', 'scrollThumb', 'scrollThumbHover',
  'text', 'muted', 'accent', 'accentText', 'success', 'danger', 'amber', 'warm', 'portraitSurface',
  'portraitTop', 'portraitBottom', 'portraitBorder', 'portraitAccent', 'portraitWarm', 'portraitAttention',
  'portraitSpeech', 'stageSurface', 'stageBorder', 'stageSpotlight', 'stageSpotlightBorder', 'badgeSurface', 'petShadow',
] as const;
const palette = z.record(z.enum(paletteTokens), z.string().regex(/^#(?:[a-f0-9]{6}|[a-f0-9]{8})$/));
export const avatarSchema = z.object({
  id, label: z.string().trim().min(1).max(80), description: z.string().trim().min(1),
  themeLabel: z.string().trim().min(1), portrait: png, rig,
  default: z.boolean(), aliases: z.array(id), palette, authoring: avatarAuthoringSchema,
}).strict();
export const avatarManifestSchema = z.array(avatarSchema).min(1).superRefine((entries, ctx) => {
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) for (const name of [entry.id, ...entry.aliases]) {
    if (names.has(name)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `Duplicate avatar ID or alias: ${name}` });
    names.add(name);
  }
  if (entries.filter(entry => entry.default).length !== 1)
    ctx.addIssue({ code: 'custom', message: 'The avatar manifest needs exactly one default' });
});
export type Avatar = z.infer<typeof avatarSchema>;
// IDs are data, validated at the boundary, rather than a second handwritten enum.
export type AvatarId = Avatar['id'];
export function parseAvatarManifest(value: unknown): Avatar[] { return avatarManifestSchema.parse(value); }
export const avatarCatalog = parseAvatarManifest(JSON.parse(readFileSync(new URL('../assets/avatars.json', import.meta.url), 'utf8')));
export const avatarIds: readonly AvatarId[] = Object.freeze(avatarCatalog.map(entry => entry.id));
export const defaultAvatar = avatarCatalog.find(entry => entry.default)!.id;
const byId = new Map(avatarCatalog.flatMap(entry => [entry.id, ...entry.aliases].map(name => [name, entry] as const)));
export function validateAvatar(value: unknown): AvatarId {
  if (value === null) return defaultAvatar;
  const entry = typeof value === 'string' ? byId.get(value) : undefined;
  if (!entry) throw new Error(`Choose a supported avatar: ${avatarCatalog.map(entry => entry.label).join(', ')}`);
  return entry.id;
}
export function avatarFor(value: unknown): Avatar {
  return (typeof value === 'string' ? byId.get(value) : undefined) || byId.get(defaultAvatar)!;
}
export function authoringAvatars(ids: string[]): Avatar[] {
  return ids.length ? ids.map(value => {
    if (!avatarIds.includes(value)) throw new Error(`Unknown avatar source: ${value}`);
    return byId.get(value)!;
  }) : avatarCatalog;
}
