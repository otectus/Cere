import type { Message } from './types.ts';
import type { Store } from './store.ts';

/**
 * Transcript transport bounds. Full history stays in SQLite; every page, live
 * message event and text chunk stays well inside the 8 MiB Node and 16 MiB
 * native line limits, including JSON escaping of multibyte and control text.
 */
export const MESSAGE_FRAME_BYTES = 1024 * 1024;
export const PAGE_BYTES = 1024 * 1024;
export const CHUNK_CHARACTERS = 256 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** A UTF-16 prefix that never ends inside a surrogate pair. */
function prefix(text: string, length: number) {
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/**
 * The transport copy of one message. An exceptionally large body is shortened for
 * display with an explicit marker; clients fetch the complete text in chunks.
 */
export function transportMessage(message: Message): Message & { truncated?: boolean; bytes?: number } {
  if (bytes(message) <= MESSAGE_FRAME_BYTES) return message;
  const total = Buffer.byteLength(message.text, 'utf8');
  const marker = `\n\n[Message shortened for display: ${total.toLocaleString('en-US')} bytes. Copy retrieves the complete text.]`;
  let low = 0, high = message.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes({ ...message, text: prefix(message.text, middle) + marker, truncated: true, bytes: total }) <= MESSAGE_FRAME_BYTES) low = middle;
    else high = middle - 1;
  }
  return { ...message, text: prefix(message.text, low) + marker, truncated: true, bytes: total };
}

/** Newest page before a cursor, in chronological order and within the byte budget. */
export function messagePage(store: Store, sessionId: string, before?: unknown, maxBytes = PAGE_BYTES) {
  store.session(sessionId);
  if (before !== undefined && before !== null && (!Number.isSafeInteger(before) || (before as number) < 1)) throw new Error('Invalid transcript cursor');
  const budget = Math.min(PAGE_BYTES, Math.max(64 * 1024, Number.isSafeInteger(maxBytes) ? maxBytes : PAGE_BYTES));
  const messages: Message[] = [];
  let used = 256, cursor = (before as number | undefined) ?? null, more = false;
  // Rows are fetched in bounded batches so a long history is never materialized at once.
  for (;;) {
    const rows = store.messageRows(sessionId, cursor, 200);
    if (!rows.length) break;
    let full = false;
    for (const row of rows) {
      const message = transportMessage(JSON.parse(row.data));
      const size = bytes(message) + 1;
      if (messages.length && used + size > budget) { full = true; break; }
      messages.push(message); used += size; cursor = row.cursor;
    }
    if (full) { more = true; break; }
    if (rows.length < 200) break;
  }
  if (!more && cursor !== null) more = store.messageRows(sessionId, cursor, 1).length > 0;
  return { messages: messages.reverse(), before: more ? cursor : null, hasMore: more };
}

/** A bounded slice of one stored message's complete text. */
export function messageChunk(store: Store, sessionId: string, messageId: unknown, offset: unknown = 0) {
  if (typeof messageId !== 'string' || !Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Invalid message chunk request');
  const message = store.messageById(messageId);
  if (!message || message.sessionId !== sessionId) throw new Error('Message no longer exists');
  const start = offset as number;
  let end = Math.min(message.text.length, start + CHUNK_CHARACTERS);
  const code = message.text.charCodeAt(end - 1);
  if (end < message.text.length && code >= 0xd800 && code <= 0xdbff) end--;
  return { id: message.id, offset: start, text: message.text.slice(start, end), next: end < message.text.length ? end : null, length: message.text.length };
}
