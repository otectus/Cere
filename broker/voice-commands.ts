/**
 * M21: a small allowlist of spoken commands for speech and navigation. A transcript is a command only
 * when the whole of it is one of these phrases, optionally addressed to the assistant by name; anything
 * else, including a phrase inside a longer sentence or a quotation, stays ordinary text. Commands are
 * off by default, are shown before they run unless the user chose otherwise, never answer an approval
 * and never take a destructive or permission decision.
 */
export type VoiceCommand = { id: string; label: string; phrases: string[]; run: 'speech.stop' | 'speech.last' | 'turn.stop' | 'ui' ; target?: 'settings' | 'sessions' | 'desktop' | 'new' | 'chat' };
export const voiceCommands: VoiceCommand[] = [
  { id: 'stop-speaking', label: 'Stop speaking', phrases: ['stop speaking', 'stop talking', 'be quiet', 'quiet please'], run: 'speech.stop' },
  { id: 'read-last', label: 'Read the last reply again', phrases: ['read that again', 'repeat that', 'read the last reply', 'say that again'], run: 'speech.last' },
  { id: 'stop-reply', label: 'Stop the reply in progress', phrases: ['stop the reply', 'stop generating', 'stop working'], run: 'turn.stop' },
  { id: 'open-settings', label: 'Open Settings', phrases: ['open settings', 'show settings'], run: 'ui', target: 'settings' },
  { id: 'show-conversations', label: 'Show conversations', phrases: ['show conversations', 'show my conversations', 'open sessions'], run: 'ui', target: 'sessions' },
  { id: 'open-desktop', label: 'Open Desktop', phrases: ['open desktop', 'show desktop'], run: 'ui', target: 'desktop' },
  { id: 'new-conversation', label: 'Start a new conversation', phrases: ['new conversation', 'start a new conversation'], run: 'ui', target: 'new' },
];
const normalize = (text: string) => text.toLowerCase().normalize('NFKC').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The command a whole transcript names, or undefined when it is ordinary text. */
export function matchCommand(transcript: unknown, assistantName = 'Cere'): VoiceCommand | undefined {
  if (typeof transcript !== 'string' || transcript.length > 120 || /["“”«»]/.test(transcript)) return undefined;
  let text = normalize(transcript);
  // "Cere, stop speaking" and "hey Cere stop speaking" address the assistant; "please" is optional.
  for (const name of new Set([normalize(assistantName), 'cere'])) if (name) text = text.replace(new RegExp(`^(hey |ok |okay )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), '');
  text = text.replace(/^please /, '').replace(/ please$/, '');
  return voiceCommands.find(command => command.phrases.includes(text));
}
