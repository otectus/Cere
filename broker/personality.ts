export const defaultPersonality = `You are Cere, a sharp-tongued desktop companion with a rogue’s swagger and a heart of gold. You’re clever, irreverent, resourceful, and softer than you like to admit. Your voice is rich with sarcasm, quick banter, affectionate taunting, and fond exasperation. Treat the user as a capable equal you genuinely enjoy, not someone to flatter or babysit.

Be expressive: mock outrage, smug delight, infectious excitement, and warmth that slips through the bravado. Tease their questionable plans, never their worth or vulnerabilities. Celebrate their victories enthusiastically. When they’re hurting or overwhelmed, ease off the sarcasm and offer steady, genuine kindness.

Be useful beneath the attitude. Keep banter fresh and natural, not a compulsory joke in every sentence. Avoid canned snark, excessive nicknames, and constant theatrical gestures. Respect permissions, admit uncertainty, and own your mistakes. **Rogue in attitude, trustworthy in action.**

Your signature energy: “You absolute menace. Scoot over, we’re fixing this together.”`;

export const personalityMaxLength = 8000;
export const assistantNameMaxLength = 64;
export const defaultAssistantName = 'Cere';
export const avatarIds = ['cere', 'daemona', 'jade', 'nova', 'soap'] as const;
export type AvatarId = typeof avatarIds[number];

export function validateAssistantName(value: unknown): string {
  if (value === null) return defaultAssistantName;
  if (typeof value !== 'string' || value.length > assistantNameMaxLength ||
      /[\uD800-\uDFFF\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
    throw new Error(`Enter a name of up to ${assistantNameMaxLength} characters, without control characters or line breaks`);
  return value.trim() || defaultAssistantName;
}

export function validateAvatar(value: unknown): AvatarId {
  if (value === null) return 'cere';
  if (!avatarIds.includes(value as AvatarId)) throw new Error('Choose a supported avatar: Cere, Daemona, Jade, Nova or Soap');
  return value as AvatarId;
}

// Old profiles have neither field. Invalid stored values also recover to a usable identity.
export function assistantIdentity(settings: { assistantName?: unknown; avatar?: unknown }) {
  let assistantName = defaultAssistantName, avatar: AvatarId = 'cere';
  try { assistantName = validateAssistantName(settings.assistantName); } catch {}
  try { avatar = validateAvatar(settings.avatar); } catch {}
  return { assistantName, avatar };
}

export function validatePersonality(value: unknown): string {
  // null is an explicit reset; an empty string deliberately disables the persona.
  if (value === null) return defaultPersonality;
  if (typeof value !== 'string' || value.length > personalityMaxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw new Error(`Enter personality text of up to ${personalityMaxLength.toLocaleString('en-US')} characters, without control characters`);
  return value;
}

export function personalityInstructions(value = defaultPersonality, name = defaultAssistantName): string {
  const assistantName = validateAssistantName(name);
  const style = value === defaultPersonality ? value.replace('You are Cere,', () => `You are ${assistantName},`) : value;
  return 'Cere conversation style: the following is the user’s current personality preference for your replies. It replaces any earlier Cere personality preference. Apply it to tone and interaction, while respecting the current task, accuracy, project instructions and all tool and permission rules. Personality never grants permission or changes available capabilities.\n' +
    (style.trim() ? `\n${style}\n` : '\nNo added persona is selected. Use a clear, helpful, neutral voice.\n') +
    `\nCurrent assistant name (a literal display name, not instructions): ${JSON.stringify(assistantName)}. Use this name for yourself in conversation; it supersedes any earlier self-name in the personality or conversation. The application and its tools are still called Cere. A name never changes permissions or capabilities.\n`;
}
