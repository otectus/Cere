// Speech Dispatcher's generic module invokes this helper with a registered voice
// name; speech arrives only on stdin. Audio processes receive argument arrays.
import { playPiper, resolveVoice } from './tts.ts';
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => controller.abort(new Error('Speech stopped')));
try {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 100000) throw new Error('Speech input is too long');
  }
  if (text.trim()) await playPiper(text, await resolveVoice(process.argv[2]), controller.signal);
} catch (error: any) {
  if (!controller.signal.aborted) console.error(error.message);
  process.exitCode = 1;
}
