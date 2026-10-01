import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { paths, privateDir } from './paths.ts';
import { defaultSettings } from './types.ts';
import type { Session, Message, Settings, SessionFolder } from './types.ts';
export class Store {
  db: DatabaseSync;
  volatile = new DatabaseSync(':memory:');
  directory: string;
  private sessionsRevision=0;
  catalogRevision=0;
  private snapshotCache?:{revision:number;selected:string;rows:Session[]};
  constructor(directory = paths().state) {
    this.directory = directory;
    this.volatile.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
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
    // Additive migration: old clients can still read sessions; new indexes contain no
    // transcript copies, so forgetting continues to use the canonical message rows.
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_folders (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (cwd TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_bookmarks (message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_status ON sessions(json_extract(data,'$.status'));
      CREATE INDEX IF NOT EXISTS sessions_visible_order ON sessions(COALESCE(json_extract(data,'$.archived'),0),json_extract(data,'$.updated') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS sessions_order ON sessions(json_extract(data,'$.updated') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS sessions_folder ON sessions(json_extract(data,'$.folderId'));
      CREATE INDEX IF NOT EXISTS sessions_project ON sessions(json_extract(data,'$.cwd'));`);
  }
  get<T>(key: string, fallback: T): T {
    const row = this.volatile.prepare('SELECT value FROM meta WHERE key=?').get(key)||this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) : fallback;
  }
  set(key: string, value: unknown) {
    const temporary=this.volatile.prepare('SELECT id FROM sessions').all().some(row=>key.includes(String(row.id))||(value as any)?.sessionId===row.id);
    (temporary?this.volatile:this.db).prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
  }
  temporary(id:string): boolean { return !!this.volatile.prepare('SELECT 1 FROM sessions WHERE id=?').get(id); }
  sessionDatabase(id:string) { return this.temporary(id)?this.volatile:this.db; }
  discardTemporary(id:string) {
    if(!this.temporary(id))throw new Error('Only temporary conversations can be discarded here');
    this.volatile.prepare('DELETE FROM messages WHERE session_id=?').run(id);
    for(const row of this.volatile.prepare('SELECT key,value FROM meta').all())if(String(row.key).includes(id)||JSON.parse(String(row.value))?.sessionId===id)this.volatile.prepare('DELETE FROM meta WHERE key=?').run(String(row.key));
    this.volatile.prepare('DELETE FROM sessions WHERE id=?').run(id);this.sessionsRevision++;this.catalogRevision++;
  }
  settings(): Settings {
    const saved = this.get<Partial<Settings>>('settings', {});
    return { ...structuredClone(defaultSettings), ...saved,
      speechProviders: { ...defaultSettings.speechProviders, ...saved.speechProviders },
      indextts: { ...defaultSettings.indextts, ...saved.indextts },
      elevenlabs: { ...defaultSettings.elevenlabs, ...saved.elevenlabs },
      telemetry: { ...defaultSettings.telemetry, ...saved.telemetry },
      ollama: { ...defaultSettings.ollama, host: process.env.CERE_OLLAMA_HOST || process.env.OLLAMA_HOST || defaultSettings.ollama.host, ...saved.ollama },
      webSearch: { ...defaultSettings.webSearch, ...saved.webSearch },
      memory: { ...defaultSettings.memory, ...saved.memory } };
  }
  sessions(): Session[] { return [...this.db.prepare('SELECT data FROM sessions').all(),...this.volatile.prepare('SELECT data FROM sessions').all()].map(r => JSON.parse(r.data as string)).sort((a,b) => b.updated-a.updated); }
  sessionCount(): number { return Number(this.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n)+Number(this.volatile.prepare('SELECT count(*) AS n FROM sessions').get()!.n); }
  snapshotSessions(selected: string[] = []): Session[] {
    const ids=[...new Set(selected.filter(Boolean))].sort().slice(0,10),key=JSON.stringify(ids);
    if(this.snapshotCache?.revision===this.sessionsRevision&&this.snapshotCache.selected===key)return this.snapshotCache.rows;
    const rows=[...this.db.prepare("SELECT data FROM sessions WHERE COALESCE(json_extract(data,'$.archived'),0)=0 ORDER BY json_extract(data,'$.updated') DESC,id DESC LIMIT 200").all(),
      ...this.db.prepare("SELECT data FROM sessions WHERE json_extract(data,'$.status') IN ('starting','working','waiting','stopping')").all(),
      ...ids.flatMap(id=>{const row=this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);return row?[row]:[];}),
      ...this.volatile.prepare('SELECT data FROM sessions').all()];
    const unique=new Map(rows.map(r=>{const s=JSON.parse(String(r.data)) as Session;return[s.id,s]}));
    const result=[...unique.values()].sort((a,b)=>b.updated-a.updated||b.id.localeCompare(a.id));
    this.snapshotCache={revision:this.sessionsRevision,selected:key,rows:result};return result;
  }
  sessionPage(p: any = {}): { sessions: Session[]; next?: {updated:number;id:string}; total: number } {
    const limit = p.limit === undefined ? 100 : p.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Session page size must be 1–200');
    const where: string[] = [], values: (string|number)[] = [];
    if(p.unread!==undefined&&typeof p.unread!=='boolean')throw new Error('Invalid unread filter');
    if(p.unread)where.push("json_extract(data,'$.unread')=1");
    if (p.archived !== undefined && typeof p.archived !== 'boolean') throw new Error('Invalid archive filter');
    where.push("COALESCE(json_extract(data,'$.archived'),0)=?"); values.push(p.archived === true ? 1 : 0);
    if (p.pinned !== undefined) { if (typeof p.pinned !== 'boolean') throw new Error('Invalid pin filter'); where.push("COALESCE(json_extract(data,'$.pinned'),0)=?"); values.push(p.pinned ? 1 : 0); }
    for (const [key,expr] of [['folderId',"COALESCE(json_extract(data,'$.folderId'),'')"],['cwd',"json_extract(data,'$.cwd')"]]) if (key in p) {
      if (p[key] !== null && typeof p[key] !== 'string') throw new Error('Invalid session filter');
      where.push(expr+'=?'); values.push(p[key] || '');
    }
    if (p.filter) {
      if (typeof p.filter !== 'string' || p.filter.length > 1000) throw new Error('Invalid search');
      where.push("instr(lower(json_extract(data,'$.title')||' '||json_extract(data,'$.cwd')||' '||json_extract(data,'$.provider')),lower(?))>0"); values.push(p.filter);
    }
    const countSql='SELECT count(*) AS n FROM sessions WHERE '+where.join(' AND ');
    const total = Number(this.db.prepare(countSql).get(...values)!.n)+Number(this.volatile.prepare(countSql).get(...values)!.n);
    if (p.before) {
      if (!Number.isFinite(p.before.updated) || typeof p.before.id !== 'string') throw new Error('Invalid session cursor');
      where.push("(json_extract(data,'$.updated')<? OR (json_extract(data,'$.updated')=? AND id<?))");
      values.push(p.before.updated,p.before.updated,p.before.id);
    }
    const sql="SELECT data FROM sessions WHERE "+where.join(' AND ')+" ORDER BY json_extract(data,'$.updated') DESC,id DESC LIMIT ?";
    const rows = [...this.db.prepare(sql).all(...values,limit+1),...this.volatile.prepare(sql).all(...values,limit+1)].map(r=>JSON.parse(String(r.data)) as Session).sort((a,b)=>b.updated-a.updated||b.id.localeCompare(a.id));
    const sessions = rows.slice(0,limit), last = sessions.at(-1);
    return {sessions,total,...(rows.length>limit && last ? {next:{updated:last.updated,id:last.id}} : {})};
  }
  folders(): SessionFolder[] { return this.db.prepare('SELECT data FROM session_folders ORDER BY lower(json_extract(data,\'$.name\')),id').all().map(r=>JSON.parse(String(r.data))); }
  saveFolder(folder: SessionFolder) { this.db.prepare('INSERT INTO session_folders VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(folder.id,JSON.stringify(folder)); }
  transaction<T>(work:()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=work();this.db.exec('COMMIT');return result; }
    catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  session(id: string): Session {
    const row = this.sessionDatabase(id).prepare('SELECT data FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error('Session no longer exists'); return JSON.parse(row.data as string);
  }
  saveSession(s: Session) {
    this.sessionsRevision++;
    const db=s.temporary?this.volatile:this.db;
    const row = db.prepare('SELECT data FROM sessions WHERE id=?').get(s.id);
    const previous: Session | undefined = row ? JSON.parse(row.data as string) : undefined;
    const catalog=(value:Session)=>JSON.stringify([value.title,value.cwd,value.folderId,value.pinned,value.archived,value.unread]);
    if(!previous||catalog(previous)!==catalog(s))this.catalogRevision++;
    s.revision = String(BigInt(previous?.revision || '0') + 1n);
    s.draftRevision = String(BigInt(previous?.draftRevision || '0') + (previous && (previous.draft !== s.draft || JSON.stringify(previous.draftAttachments||[])!==JSON.stringify(s.draftAttachments||[])) ? 1n : 0n));
    const config = (v: Session) => JSON.stringify([v.title,v.model,v.effort,v.ollama,v.api,v.mode,v.remote]);
    s.configRevision = String(BigInt(previous?.configRevision || '0') + (previous && config(previous) !== config(s) ? 1n : 0n));
    db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(s.id, JSON.stringify(s));
  }
  messages(id: string): Message[] { return this.sessionDatabase(id).prepare('SELECT data FROM messages WHERE session_id=? ORDER BY rowid').all(id).map(r => JSON.parse(r.data as string)); }
  messageById(id: string): Message | undefined { const row=this.volatile.prepare('SELECT data FROM messages WHERE id=?').get(id)||this.db.prepare('SELECT data FROM messages WHERE id=?').get(id);return row?JSON.parse(row.data as string):undefined; }
  searchMessages(query: string, cwd?:string, limit=50, bookmarks=false) {
    if (typeof query!=='string'||query.length>500||(!query.trim()&&!bookmarks)) throw new Error('Enter a search of 1–500 characters');
    if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error('Invalid search limit');
    const rows=this.db.prepare(`SELECT m.data,s.data AS session FROM messages m JOIN sessions s ON s.id=m.session_id
      ${bookmarks?'JOIN message_bookmarks b ON b.message_id=m.id':''}
      WHERE instr(lower(json_extract(m.data,'$.text')),lower(?))>0 AND (? IS NULL OR json_extract(s.data,'$.cwd')=?)
      ORDER BY m.rowid DESC LIMIT ?`).all(query.trim(),cwd??null,cwd??null,limit);
    return rows.map(r=>{const m=JSON.parse(String(r.data)),s=JSON.parse(String(r.session));const index=m.text.toLowerCase().indexOf(query.trim().toLowerCase());return {id:m.id,sessionId:m.sessionId,title:s.title,cwd:s.cwd,time:m.time,text:m.text.slice(Math.max(0,index-100),Math.max(0,index-100)+500)};});
  }
  bookmarks(): {messageId:string;sessionId:string}[] { return this.db.prepare('SELECT message_id AS messageId,session_id AS sessionId FROM message_bookmarks ORDER BY created DESC LIMIT 500').all() as any; }
  /** Newest-first rows before an insertion cursor; callers bound the page by bytes. */
  messageRows(id: string, before: number | null, limit: number): { cursor: number; data: string }[] {
    return this.sessionDatabase(id).prepare('SELECT rowid AS cursor,data FROM messages WHERE session_id=? AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?').all(id, before, before, limit) as any;
  }
  message(m: Message) {
    m.revision = String(BigInt(this.messageById(m.id)?.revision || '0') + 1n);
    m.turnId ||= this.session(m.sessionId).turnId;
    this.sessionDatabase(m.sessionId).prepare('INSERT INTO messages VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(m.id, m.sessionId, JSON.stringify(m));
  }
  activity(data: unknown) {
    if((data as any)?.sessionId&&this.temporary((data as any).sessionId))return;
    this.db.prepare('INSERT INTO activity(time,data) VALUES (?,?)').run(Date.now(), JSON.stringify(data));
    this.db.exec('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 500)');
  }
  activities() { return this.db.prepare('SELECT time,data FROM activity ORDER BY id DESC LIMIT 100').all().map(r => ({time:r.time, ...JSON.parse(r.data as string)})); }
  timers(): any[] { return this.db.prepare('SELECT data FROM timers').all().map(r => JSON.parse(r.data as string)); }
  timer(t: any) { this.db.prepare('INSERT OR REPLACE INTO timers VALUES (?,?)').run(t.id, JSON.stringify(t)); }
  /** True only for the caller whose DELETE actually claimed the timer. */
  removeTimer(id: string): boolean { return Number(this.db.prepare('DELETE FROM timers WHERE id=?').run(id).changes) > 0; }
  close() { this.db.close();this.volatile.close(); }
}
