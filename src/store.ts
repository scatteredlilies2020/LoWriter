import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError } from './shared.ts';
import type { Conversation, Message, Mode, Job } from './shared.ts';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('rp','coding')), revision INTEGER NOT NULL DEFAULT 0, project TEXT, trusted INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_page ON messages(conversation,id);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), status TEXT NOT NULL, text TEXT NOT NULL, error TEXT NOT NULL, actions TEXT NOT NULL, revision INTEGER NOT NULL, created TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(conversation) WHERE status='running';
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, path TEXT NOT NULL, before_text TEXT NOT NULL, after_hash TEXT NOT NULL, created TEXT NOT NULL, project TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    if (!this.db.prepare('PRAGMA table_info(checkpoints)').all().some(row => row.name === 'project')) this.db.exec("ALTER TABLE checkpoints ADD COLUMN project TEXT NOT NULL DEFAULT ''");
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(row => row.name === 'edited')) this.db.exec('ALTER TABLE messages ADD COLUMN edited TEXT');
    this.db.prepare("UPDATE jobs SET status='interrupted', error='Service restarted. Partial candidate retained; request was not replayed.' WHERE status='running'").run();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  conversations(): Conversation[] { return this.db.prepare('SELECT * FROM conversations ORDER BY created DESC LIMIT 100').all() as unknown as Conversation[]; }
  conversation(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as Conversation;
    if (!row) throw new AppError('Conversation not found.', 404);
    return row;
  }
  create(mode: Mode, title: string): Conversation {
    if (mode !== 'rp' && mode !== 'coding') throw new AppError('Invalid workspace mode.');
    const id = randomUUID();
    this.db.prepare('INSERT INTO conversations(id,title,mode,created) VALUES(?,?,?,?)').run(id, title.slice(0, 100), mode, new Date().toISOString());
    return this.conversation(id);
  }
  messages(id: string, before = Number.MAX_SAFE_INTEGER, limit = 40): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation=? AND id<? ORDER BY id DESC LIMIT ?').all(id, before, Math.min(80, Math.max(1, limit))) as unknown as Message[]).reverse();
  }
  editMessage(id: string, messageId: number, content: string, expected: number): Message {
    if (!Number.isSafeInteger(messageId) || messageId < 1 || !Number.isSafeInteger(expected) || expected < 0 || typeof content !== 'string' || !content.trim() || content.length > 64000) throw new AppError('Invalid message edit.');
    return this.transaction(() => {
      const c = this.conversation(id);
      if (c.revision !== expected) throw new AppError('Conversation changed. Cancel this edit and reopen it before saving.', 409);
      if (this.db.prepare("SELECT id FROM jobs WHERE conversation=? AND status='running'").get(id)) throw new AppError('Stop the running reply before editing messages.', 409);
      const message = this.db.prepare("SELECT * FROM messages WHERE conversation=? AND id=? AND role IN ('user','assistant')").get(id, messageId) as unknown as Message;
      if (!message) throw new AppError('Message not found in this conversation.', 404);
      if (message.content === content) return message;
      const revision = c.revision + 1, edited = new Date().toISOString();
      this.db.prepare('UPDATE messages SET content=?,revision=?,edited=? WHERE conversation=? AND id=?').run(content, revision, edited, id, messageId);
      this.db.prepare('UPDATE conversations SET revision=? WHERE id=?').run(revision, id);
      return { ...message, content, revision, edited };
    });
  }
  latestJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE conversation=? ORDER BY created DESC,rowid DESC LIMIT 1').get(id);
    return row ? this.parseJob(row) : null;
  }
  parseJob(row: any): Job { return { ...row, actions: JSON.parse(row.actions) }; }
  job(id: string): Job {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw new AppError('Job not found.', 404);
    return this.parseJob(row);
  }
  start(id: string, text: string, expected: number): Job {
    return this.transaction(() => {
      const c = this.conversation(id);
      if (c.revision !== expected) throw new AppError('Conversation changed. Refresh before sending.', 409);
      if (this.db.prepare("SELECT id FROM jobs WHERE conversation=? AND status='running'").get(id)) throw new AppError('This conversation already has a running job.', 409);
      const revision = c.revision + 1;
      if (c.title.startsWith('Untitled ')) this.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(text.replace(/\s+/g, ' ').slice(0, 55), id);
      this.db.prepare('UPDATE conversations SET revision=? WHERE id=?').run(revision, id);
      this.db.prepare("INSERT INTO messages(conversation,role,content,revision) VALUES(?,'user',?,?)").run(id, text, revision);
      const job: Job = { id: randomUUID(), conversation: id, status: 'running', text: '', error: '', actions: [], revision, created: new Date().toISOString() };
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)').run(job.id, id, job.status, '', '', '[]', revision, job.created);
      return job;
    });
  }
  saveJob(j: Job): void { this.db.prepare('UPDATE jobs SET status=?,text=?,error=?,actions=? WHERE id=?').run(j.status, j.text, j.error, JSON.stringify(j.actions), j.id); }
  finish(j: Job): void {
    this.transaction(() => {
      const c = this.conversation(j.conversation);
      if (c.revision !== j.revision) throw new AppError('Stale candidate rejected.', 409);
      if (j.status === 'complete') {
        this.db.prepare("INSERT INTO messages(conversation,role,content,revision) VALUES(?,'assistant',?,?)").run(c.id, j.text, c.revision + 1);
        this.db.prepare('UPDATE conversations SET revision=revision+1 WHERE id=?').run(c.id);
      }
      this.saveJob(j);
    });
  }
  project(id: string, path: string, trust: boolean): Conversation {
    const c = this.conversation(id);
    if (c.mode !== 'coding') throw new AppError('RP cannot use project tools.', 403);
    if (this.latestJob(id)?.status === 'running') throw new AppError('Stop the running job before changing project access.', 409);
    this.db.prepare('UPDATE conversations SET project=?,trusted=?,revision=revision+1 WHERE id=?').run(path, trust ? 1 : 0, id);
    return this.conversation(id);
  }
  setting(key: string): any { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) : null; }
  setSetting(key: string, value: unknown): void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  close(): void { this.db.close(); }
}
