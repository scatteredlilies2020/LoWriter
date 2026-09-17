import { AppError } from './shared.ts';
import type { Mode } from './shared.ts';
import type { Store } from './store.ts';
import { boundedJson, Continuity } from './continuity.ts';

type ChatMessage = { role: 'user' | 'assistant'; content: string; speaker: string; variants: string[]; selected: number };
const obj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
function text(v: any, name: string, max = 64000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(`Invalid ${name}.`);
  return v;
}
export function parseChat(raw: unknown): { title: string; mode: Mode; messages: ChatMessage[]; snapshot?: any; warnings: string[] } {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8000000) throw new AppError('Choose a chat file under 8 MB.', 413);
  raw = raw.replace(/^\uFEFF/, '');
  let value: any, st = false;
  try { value = JSON.parse(raw as string); }
  catch {
    const lines = (raw as string).split(/\r?\n/).filter(s => s.trim());
    if (lines.length > 10001) throw new AppError('Chat limit: 10,000 messages.');
    try { value = lines.map(s => JSON.parse(s)); st = true; }
    catch { throw new AppError('Expected LoWriter JSON or SillyTavern JSONL.'); }
  }
  if (!st && obj(value) && Object.hasOwn(value, 'mes')) { value = [value]; st = true; }
  boundedJson(value, 8000000);
  if (!st && (!obj(value) || value.format !== 'lowriter.chat' || value.version !== 1)) throw new AppError('Expected a LoWriter chat export (version 1) or SillyTavern JSONL.');
  const header = st && obj(value[0]) && !Object.hasOwn(value[0], 'mes') ? value.shift() : {};
  const rows = st ? value : value.messages;
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new AppError('Import needs 1–10,000 messages.');
  const warnings = new Set<string>();
  if (st) warnings.add('Only chat text, speaker names, reply swipes and optional Continuity memory are imported. Cards, lorebooks, extension settings and media are not imported.');
  const messages: ChatMessage[] = [];
  for (const row of rows) {
    if (!obj(row)) throw new AppError('Invalid chat message.');
    if (st && row.is_system === true) { warnings.add('System messages were skipped; embedded memory may no longer match.'); continue; }
    const role = st ? (row.is_user === true ? 'user' : row.is_user === false ? 'assistant' : '') : row.role;
    if (!['user', 'assistant'].includes(role)) throw new AppError('Only user and assistant messages can be imported.');
    const speaker = st ? row.name : row.speaker;
    if (speaker !== undefined && (typeof speaker !== 'string' || speaker.length > 100)) throw new AppError('Invalid speaker name.');
    let content = st ? row.mes : row.content;
    if (st && typeof content === 'string' && !content.trim()) { warnings.add('Empty messages were skipped; embedded memory may no longer match.'); continue; }
    content = text(content, 'message text');
    const variants: string[] = [];
    const swipes = st ? row.swipes : row.variants;
    if (swipes !== undefined && (!Array.isArray(swipes) || swipes.length > 50)) throw new AppError('Reply swipe limit: 50.');
    if (role === 'assistant' && swipes?.length) for (const swipe of swipes) variants.push(text(swipe, 'reply swipe'));
    let selected = st ? row.swipe_id : row.selected;
    if (selected !== undefined && (!Number.isSafeInteger(selected) || selected < 0 || selected >= Math.max(1, variants.length))) throw new AppError('Invalid selected reply swipe.');
    selected ??= Math.max(0, variants.indexOf(content));
    if (variants.length) {
      // ST mes is the actual current text, including edits that swipes may not contain.
      variants[selected] = content;
    } else if (role === 'assistant') variants.push(content);
    if (row.media?.length || row.extra?.image || row.extra?.media) warnings.add('Images and audio were not copied. Text chat export does not bundle media.');
    messages.push({ role, content, speaker: speaker || '', variants, selected });
  }
  if (!messages.length) throw new AppError('No usable chat messages found.');
  const mode: Mode = st ? 'rp' : value.mode;
  if (!['rp', 'coding'].includes(mode)) throw new AppError('Invalid chat mode.');
  const title = st ? String(header.character_name || messages.find(m => m.role === 'assistant')?.speaker || 'Imported story').slice(0, 100) : text(value.title, 'chat title', 100);
  return { title, mode, messages, snapshot: st ? header.chat_metadata?.continuityMemory : value.continuityMemory, warnings: [...warnings] };
}

export class Chats {
  store: Store; memory: Continuity;
  constructor(store: Store, memory: Continuity) { this.store = store; this.memory = memory; }
  import(raw: unknown, includeMemory: unknown, title?: unknown, redact = (v: string) => v): any {
    if (typeof includeMemory !== 'boolean') throw new AppError('Choose whether to import embedded memory.');
    const parsed = parseChat(raw);
    return this.store.transaction(() => {
      const c = this.store.create(parsed.mode, redact(title ? text(title, 'chat title', 100) : parsed.title));
      for (const m of parsed.messages) {
        const id = Number(this.store.db.prepare('INSERT INTO messages(conversation,role,content,revision,speaker) VALUES(?,?,?,0,?)').run(c.id, m.role, redact(m.content), redact(m.speaker)).lastInsertRowid);
        m.variants.forEach((v, i) => {
          const variant = Number(this.store.db.prepare('INSERT INTO message_variants(message,content) VALUES(?,?)').run(id, redact(v)).lastInsertRowid);
          if (i === m.selected) this.store.db.prepare('UPDATE messages SET active_variant=? WHERE id=?').run(variant, id);
        });
      }
      let importedMemory = false;
      if (includeMemory && parsed.snapshot) {
        try { this.memory.importSnapshot(c.id, JSON.parse(redact(JSON.stringify(parsed.snapshot)))); importedMemory = true; }
        catch (e) { parsed.warnings.push(e instanceof AppError ? e.message : 'Embedded memory could not be validated. Chat text was still imported.'); }
      } else if (parsed.snapshot) parsed.warnings.push('Embedded memory was left out.');
      return { conversation: c, messages: parsed.messages.length, importedMemory, warnings: parsed.warnings };
    });
  }
  export(id: string, includeMemory: boolean): any {
    const c = this.store.conversation(id);
    const messages = this.store.allMessages(id).map(m => {
      const variants = this.store.db.prepare('SELECT id,content FROM message_variants WHERE message=? ORDER BY id').all(m.id);
      return { role: m.role, content: m.content, speaker: m.speaker || '', variants: variants.map(v => v.content), selected: Math.max(0, variants.findIndex(v => v.id === m.active_variant)) };
    });
    const result = { format: 'lowriter.chat', version: 1, title: c.title, mode: c.mode, messages, continuityMemory: this.memory.portable(id, includeMemory) };
    boundedJson(result, 8000000);
    return result;
  }
}
