/**
 * M01 behavior profiles: how one conversation's assistant is asked to behave, resolved in a fixed
 * order and rendered by one function for every provider. A profile is style, not authority: its
 * text and traits shape tone, and its tool ceiling can only withhold Cere tools the conversation
 * already has. Nothing here grants a category, a grant, a bypass or a memory scope.
 *
 * Resolution is deterministic: the conversation's own style, else its project's, else the global
 * personality; then an optional posture for one turn or pinned to the conversation. Name, avatar,
 * voice, model and memory scope stay independent of all of it.
 */
import { personalityInstructions } from './personality.ts';
import { constraintInstructions, type StyleConstraint } from './style-checks.ts';

export const traitNames = ['verbosity', 'formality', 'warmth', 'humor', 'directness'] as const;
export type TraitName = typeof traitNames[number];
/** -2…2; 0 or absent is neutral and adds no instruction. */
export type Traits = Partial<Record<TraitName, number>>;
/**
 * false withholds that family of Cere tools; absent leaves it as the conversation has it. `recall`
 * false also skips automatic memory recall; capture still follows the memory settings.
 */
export type ToolCeiling = { desktop?: boolean; delegation?: boolean; web?: boolean; memory?: boolean; extensions?: boolean; recall?: boolean };
export type BehaviorProfile = {
  id: string; label: string; text: string; traits: Traits; instructions: string; ceiling: ToolCeiling; posture: boolean;
  revision: string; created: number; updated: number; builtin?: boolean;
  checkpoints?: { revision: string; label: string; created: number; text: string; traits: Traits; instructions: string; ceiling: ToolCeiling; posture: boolean; constraints?: string[] }[];
  /** M02 deterministic output checks; they annotate replies and never change them. */
  constraints?: string[];
};

const traitText: Record<TraitName, Record<string, string>> = {
  verbosity: { '-2': 'Keep replies very short: a sentence or two unless more is asked for.', '-1': 'Prefer short replies.', '1': 'Give fuller explanations than usual.', '2': 'Be thorough and detailed.' },
  formality: { '-2': 'Use a very casual register.', '-1': 'Use a casual register.', '1': 'Use a formal register.', '2': 'Use a very formal, professional register.' },
  warmth: { '-2': 'Keep a reserved, matter-of-fact tone.', '-1': 'Keep emotional language light.', '1': 'Be warm and encouraging.', '2': 'Be especially warm, patient and encouraging.' },
  humor: { '-2': 'Avoid humor entirely.', '-1': 'Use humor sparingly.', '1': 'Light humor is welcome.', '2': 'Be playful and witty where it fits.' },
  directness: { '-2': 'Soften disagreement and offer options gently.', '-1': 'Lean diplomatic.', '1': 'Be direct; state conclusions first.', '2': 'Be blunt and concise about problems.' },
};

/** Built-in postures for one turn or a pinned stretch of a conversation. */
export const builtinPostures: BehaviorProfile[] = [
  { id: 'posture:research', label: 'Research', text: '', traits: { directness: 1 }, instructions: 'Research posture: separate what sources say from your own inference, cite sources for factual claims, and say what you could not verify.', ceiling: {}, posture: true },
  { id: 'posture:review', label: 'Review', text: '', traits: { directness: 1 }, instructions: 'Review posture: critique the work in front of you. Lead with the most serious problems, give evidence, and do not make changes or take desktop actions.', ceiling: { desktop: false, delegation: false, extensions: false }, posture: true },
  { id: 'posture:plan', label: 'Plan', text: '', traits: {}, instructions: 'Planning posture: produce an ordered plan with dependencies, risks and how each step will be checked. Do not carry the plan out or take desktop actions.', ceiling: { desktop: false, delegation: false, extensions: false }, posture: true },
  { id: 'posture:explain', label: 'Explain', text: '', traits: { verbosity: 1, warmth: 1 }, instructions: 'Teaching posture: explain step by step, define terms, and check understanding with a short summary.', ceiling: {}, posture: true },
  { id: 'posture:brief', label: 'Brief', text: '', traits: { verbosity: -2 }, instructions: 'Brief posture: answer in as few words as accuracy allows.', ceiling: {}, posture: true },
  { id: 'posture:no-memory', label: 'Without memory', text: '', traits: {}, instructions: 'Answer from this conversation alone; do not rely on stored memory.', ceiling: { recall: false, memory: false }, posture: true },
].map(profile => ({ ...profile, revision: '1', created: 0, updated: 0, builtin: true }));

export function validTraits(value: unknown): Traits {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(traitNames as readonly string[]).includes(key))) throw new Error('Traits are verbosity, formality, warmth, humor and directness');
  const traits: Traits = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    if (!Number.isInteger(level) || (level as number) < -2 || (level as number) > 2) throw new Error('Trait levels run from -2 to 2; 0 is neutral');
    if (level !== 0) traits[key as TraitName] = level as number;
  }
  return traits;
}
export function validCeiling(value: unknown): ToolCeiling {
  if (value === undefined || value === null) return {};
  const keys = ['desktop', 'delegation', 'web', 'memory', 'extensions', 'recall'];
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || Object.values(value).some(flag => typeof flag !== 'boolean'))
    throw new Error('Tool limits can only withhold desktop, delegation, web, memory or extension tools, or automatic memory recall');
  // Only withholding is stored: a true value cannot grant anything, so it is dropped.
  return Object.fromEntries(Object.entries(value as Record<string, boolean>).filter(([, flag]) => flag === false)) as ToolCeiling;
}

/**
 * Trait combinations that pull against each other, after PyPersona's three conservative pairs.
 * They are warnings for the person choosing a style: they never block it or change what is sent.
 */
export function traitConflicts(traits: Traits): string[] {
  const level = (name: TraitName) => traits[name] ?? 0, conflicts: string[] = [];
  if (level('warmth') <= -1 && level('humor') === 2) conflicts.push('A reserved tone with very playful humor may come across as mixed signals.');
  if (level('formality') >= 1 && level('humor') === 2) conflicts.push('A formal register with very playful humor may clash.');
  if (level('directness') === 2 && level('warmth') >= 1) conflicts.push('Blunt directness with a warm tone may come across as mixed signals.');
  return conflicts;
}

export type ResolvedBehavior = {
  text: string; source: 'session' | 'project' | 'global';
  profile: { id: string; label: string; revision: string } | null;
  posture: { id: string; label: string; revision: string; pinned: boolean; instructions: string } | null;
  traits: Traits; instructions: string; ceiling: ToolCeiling; constraints: StyleConstraint[]; warnings: string[];
  /** traitConflicts of the merged traits, posture included. */
  conflicts: string[];
};

/**
 * One conversation's behavior for its next turn. A missing or no-longer-existing profile falls back
 * to the next level with a visible warning, never silently.
 */
export function resolveBehavior(p: { personality: string; profiles: BehaviorProfile[]; projectProfileId?: string; sessionProfileId?: string; instructions?: string; postureId?: string; pinned?: boolean }): ResolvedBehavior {
  const warnings: string[] = [];
  const find = (id: string | undefined, what: string) => {
    if (!id) return undefined;
    const profile = [...p.profiles, ...builtinPostures].find(item => item.id === id);
    if (!profile) warnings.push(`The ${what} style no longer exists; using the next level instead.`);
    return profile;
  };
  const session = find(p.sessionProfileId, 'conversation'), project = session ? undefined : find(p.projectProfileId, 'project');
  const base = session || project;
  const posture = find(p.postureId, 'posture');
  const traits: Traits = { ...(base?.traits || {}), ...(posture?.traits || {}) };
  const ceiling: ToolCeiling = { ...(base?.ceiling || {}) };
  // Postures narrow further: any withheld family stays withheld.
  for (const [key, flag] of Object.entries(posture?.ceiling || {})) if (flag === false) ceiling[key as keyof ToolCeiling] = false;
  return {
    text: base ? base.text : p.personality, source: session ? 'session' : project ? 'project' : 'global',
    profile: base ? { id: base.id, label: base.label, revision: base.revision } : null,
    posture: posture ? { id: posture.id, label: posture.label, revision: posture.revision, pinned: !!p.pinned, instructions: posture.instructions || posture.text } : null,
    traits, instructions: [base?.instructions || '', (p.instructions || '').trim()].filter(Boolean).join('\n\n'), ceiling,
    constraints: [...new Set([...(base?.constraints || []), ...(posture?.constraints || [])])] as StyleConstraint[], warnings, conflicts: traitConflicts(traits),
  };
}

/**
 * The one rendering every provider receives. With no profile, traits, instructions or posture it is
 * exactly the existing personality block, byte for byte.
 */
export function behaviorInstructions(resolved: ResolvedBehavior, name: string): string {
  let block = personalityInstructions(resolved.text, name);
  const traitLines = traitNames.filter(key => resolved.traits[key]).map(key => '- ' + traitText[key][String(resolved.traits[key])]);
  if (traitLines.length) block += '\nConversation preferences (style only; they never change permissions or tools):\n' + traitLines.join('\n') + '\n';
  if (resolved.instructions) block += '\nStanding instructions for this conversation, from the user (they never grant permissions or tools):\n' + resolved.instructions + '\n';
  if (resolved.posture) block += `\nCurrent posture: ${resolved.posture.label}, ${resolved.posture.pinned ? 'pinned to this conversation until the user changes it' : 'for this turn only'}. ${resolved.posture.instructions}\n`;
  block += constraintInstructions(resolved.constraints);
  const withheld = Object.entries(resolved.ceiling).filter(([key, flag]) => flag === false && key !== 'recall').map(([key]) => key === 'extensions' ? 'extension' : key);
  if (withheld.length) block += `\nThis style withholds Cere's ${withheld.join(', ')} tools for now; do not ask for them. The user can change the style.\n`;
  if (resolved.ceiling.recall === false) block += '\nThis style withholds automatic memory recall: no stored memory is supplied, so do not rely on it.\n';
  return block;
}
