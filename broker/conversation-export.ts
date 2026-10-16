/**
 * M15: a conversation, or the messages the user selected, as Markdown or plain text. Only visible
 * user and assistant messages are exported (tool activity only on request), with the reply's source
 * links. Memory citation markers follow the display setting. Attachments appear by name only; their
 * contents are never copied. The text is returned to the interface, which saves it through the
 * system save dialog, so the broker never writes to a path of its own choosing.
 */
import type { Store } from './store.ts';
import { stripMemoryCitations } from './citations.ts';

export const exportLimitBytes = 8 * 1024 * 1024;
type Options = { messageIds?: unknown; format?: unknown; includeTools?: unknown; showCitations?: unknown; confirmTemporary?: unknown };

export function exportConversation(store: Store, sessionId: string, assistantName: string, p: Options) {
  const session = store.session(sessionId);
  if (session.temporary && p.confirmTemporary !== true) throw new Error('This is a temporary conversation. Confirm that you want to keep a copy of it.');
  const format = p.format === undefined ? 'markdown' : p.format;
  if (format !== 'markdown' && format !== 'text') throw new Error('Export as Markdown or plain text');
  let selected: Set<string> | undefined;
  if (p.messageIds !== undefined) {
    if (!Array.isArray(p.messageIds) || !p.messageIds.length || p.messageIds.length > 2000 || p.messageIds.some(id => typeof id !== 'string')) throw new Error('Select the messages to export');
    selected = new Set(p.messageIds as string[]);
  }
  const roles = new Set(['user', 'assistant', ...(p.includeTools === true ? ['tool'] : [])]);
  const messages = store.messages(sessionId).filter(message => roles.has(message.role) && message.text.trim() && (!selected || selected.has(message.id)) && !message.kind?.startsWith('queue'));
  if (selected && messages.length !== selected.size) throw new Error('Some selected messages are no longer in this conversation');
  if (!messages.length) throw new Error('There is nothing to export yet');
  const markdown = format === 'markdown', when = (time: number) => new Date(time).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const author = (role: string) => role === 'user' ? 'You' : role === 'tool' ? 'Tool activity' : assistantName;
  const parts: string[] = markdown
    ? [`# ${session.title}`, '', `_Exported from Cere on ${when(Date.now())} · ${session.provider}${session.model ? ' · ' + session.model : ''} · ${session.cwd}_`]
    : [session.title, `Exported from Cere on ${when(Date.now())} · ${session.provider}${session.model ? ' · ' + session.model : ''} · ${session.cwd}`];
  for (const message of messages) {
    const text = p.showCitations === true ? message.text : stripMemoryCitations(message.text);
    parts.push('', markdown ? `## ${author(message.role)} · ${when(message.time)}` : `${author(message.role)} · ${when(message.time)}`, '');
    // A tool transcript is shown verbatim; Markdown keeps it from being read as formatting.
    parts.push(markdown && message.role === 'tool' ? '```text\n' + text.replaceAll('```', '`​``') + '\n```' : text);
    if (message.sources?.length) parts.push('', markdown ? 'Sources:' : 'Sources:', ...message.sources.map(source => markdown ? `- [${source.title.replace(/[[\]]/g, '')}](${source.url})` : `- ${source.title}: ${source.url}`));
  }
  const text = parts.join('\n') + '\n';
  if (Buffer.byteLength(text) > exportLimitBytes) throw new Error('This export is larger than 8 MB. Select fewer messages.');
  const safe = session.title.replace(/[\/\\:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Conversation';
  return { text, messages: messages.length, filename: safe + (markdown ? '.md' : '.txt'), format };
}
