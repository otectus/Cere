import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { paths, privateDir } from './paths.ts';
import { defaultSettings } from './types.ts';
import type { Session, Message, Settings } from './types.ts';
export class Store {
  db: DatabaseSync;
  directory: string;
  constructor(directory = paths().state) {
    this.directory = directory;
    privateDir(directory);
    const file = join(directory, 'cere.sqlite');
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY,time INTEGER,data TEXT);
      CREATE TABLE IF NOT EXISTS timers (id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL,
      text TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      embedding_key TEXT NOT NULL DEFAULT '', vector TEXT);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,kind,updated);`);
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('schema', '1');
    const version = this.get<string | number>('schema', '1');
    if (version !== 1 && version !== '1') throw new Error('Unsupported database version');
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) : fallback;
  }
  set(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  settings(): Settings {
    const saved = this.get<Partial<Settings>>('settings', {});
    return { ...structuredClone(defaultSettings), ...saved,
      ollama: { ...defaultSettings.ollama, host: process.env.CERE_OLLAMA_HOST || process.env.OLLAMA_HOST || defaultSettings.ollama.host, ...saved.ollama },
      webSearch: { ...defaultSettings.webSearch, ...saved.webSearch },
      memory: { ...defaultSettings.memory, ...saved.memory } };
  }
  sessions(): Session[] { return this.db.prepare('SELECT data FROM sessions').all().map(r => JSON.parse(r.data as string)).sort((a,b) => b.updated-a.updated); }
  session(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error('Session no longer exists'); return JSON.parse(row.data as string);
  }
  saveSession(s: Session) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(s.id, JSON.stringify(s)); }
  messages(id: string): Message[] { return this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY rowid').all(id).map(r => JSON.parse(r.data as string)); }
  messageById(id: string): Message | undefined { const row=this.db.prepare('SELECT data FROM messages WHERE id=?').get(id);return row?JSON.parse(row.data as string):undefined; }
  message(m: Message) { this.db.prepare('INSERT INTO messages VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(m.id, m.sessionId, JSON.stringify(m)); }
  activity(data: unknown) {
    this.db.prepare('INSERT INTO activity(time,data) VALUES (?,?)').run(Date.now(), JSON.stringify(data));
    this.db.exec('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 500)');
  }
  activities() { return this.db.prepare('SELECT time,data FROM activity ORDER BY id DESC LIMIT 100').all().map(r => ({time:r.time, ...JSON.parse(r.data as string)})); }
  timers(): any[] { return this.db.prepare('SELECT data FROM timers').all().map(r => JSON.parse(r.data as string)); }
  timer(t: any) { this.db.prepare('INSERT OR REPLACE INTO timers VALUES (?,?)').run(t.id, JSON.stringify(t)); }
  removeTimer(id: string) { this.db.prepare('DELETE FROM timers WHERE id=?').run(id); }
  close() { this.db.close(); }
}
