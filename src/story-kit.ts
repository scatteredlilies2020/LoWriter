import { randomUUID } from 'node:crypto';
import { AppError } from './shared.ts';
import type { ProviderMessage } from './shared.ts';
import { Store } from './store.ts';
import { blankStory } from './story-types.ts';
import type { StorySetup, LoreEntry, PromptField, PromptPlacement, AdditionalInstruction } from './story-types.ts';
import { imageBytes } from './media.ts';

function str(v: unknown, max = 32000): string { if (v === undefined) return ''; if (typeof v !== 'string' || v.length > max) throw new AppError(`Expected text up to ${max} characters.`); return v; }
function list(v: any, max: number): any[] { if (v === undefined) return []; if (!Array.isArray(v) || v.length > max) throw new AppError(`Expected a list of at most ${max} entries.`); return v; }
function num(v: any, fallback: number, min: number, max: number): number { if (v === undefined) return fallback; if (!Number.isSafeInteger(v) || v < min || v > max) throw new AppError(`Expected a number from ${min} to ${max}.`); return v; }
function flag(v: any, fallback: boolean): boolean { if (v === undefined) return fallback; if (typeof v !== 'boolean') throw new AppError('Expected an on/off value.'); return v; }
export function validateStory(v: any): StorySetup {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('Expected story setup.');
  const s = blankStory();
  for (const k of ['name', 'description', 'examples', 'instructions', 'postHistory', 'characterNote', 'prefill', 'personaName', 'persona', 'authorNotes'] as const) s[k] = str(v[k], ['name', 'personaName'].includes(k) ? 100 : k === 'prefill' ? 8000 : k === 'description' ? 96000 : 32000);
  // Migrate only descriptive fields. Examples and prompt fields retain their own slots.
  s.description = [s.description, v.personality ? 'Personality:\n' + str(v.personality) : '', v.scenario ? 'Scenario:\n' + str(v.scenario) : ''].filter(Boolean).join('\n\n');
  if (s.description.length > 96000) throw new AppError('Description exceeds 96000 characters.');
  if (v.placements !== undefined && (!v.placements || typeof v.placements !== 'object' || Array.isArray(v.placements))) throw new AppError('Invalid prompt placements.');
  for (const k of Object.keys(s.placements) as PromptField[]) {
    const p = v.placements?.[k]; if (p === undefined) continue;
    if (!p || !['before', 'after', 'depth'].includes(p.position) || !['system', 'user', 'assistant'].includes(p.role)) throw new AppError('Invalid prompt placement or role.');
    s.placements[k] = { position: p.position, role: p.role, depth: num(p.depth, s.placements[k].depth, 0, 400) };
  }
  s.additionalInstructions = list(v.additionalInstructions, 50).map((e): AdditionalInstruction => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new AppError('Invalid additional instruction.');
    const p = e.placement ?? { position: 'before', role: 'system', depth: 0 };
    if (!p || !['before', 'after', 'depth'].includes(p.position) || !['system', 'user', 'assistant'].includes(p.role)) throw new AppError('Invalid instruction placement or role.');
    if (e.source !== undefined && !['', 'instructions', 'postHistory', 'characterNote'].includes(e.source)) throw new AppError('Invalid instruction source.');
    return { id: str(e.id, 100) || randomUUID(), name: str(e.name, 100), content: str(e.content), enabled: flag(e.enabled, true), source: e.source || '', placement: { position: p.position, role: p.role, depth: num(p.depth, 0, 0, 400) } };
  });
  // Legacy setup/card slots migrate once into editable entries; clear old text to avoid duplicate injection.
  for (const key of ['instructions', 'characterNote', 'postHistory'] as const) {
    if (s[key]) s.additionalInstructions.push({ id: 'legacy-' + key, name: '', content: s[key], enabled: true, source: key, placement: { ...s.placements[key] } });
    s[key] = '';
  }
  if (s.additionalInstructions.length > 50) throw new AppError('Expected a list of at most 50 additional instructions.');
  s.importedCard = str(v.importedCard, 4000000);
  if (s.importedCard) { const source = readJson(s.importedCard); if (!source || typeof source !== 'object' || Array.isArray(source)) throw new AppError('Expected retained card JSON object.'); }
  s.greetings = list(v.greetings, 50).map(x => str(x, 16000));
  s.lore = list(v.lore, 500).map((e): LoreEntry => {
    if (!e || typeof e !== 'object') throw new AppError('Invalid lore entry.');
    return { id: str(e.id, 100) || randomUUID(), name: str(e.name, 100), keys: list(e.keys, 100).map(x => str(x, 200).trim()).filter(Boolean), secondaryKeys: list(e.secondaryKeys, 100).map(x => str(x, 200).trim()).filter(Boolean), content: str(e.content), enabled: flag(e.enabled, true), always: flag(e.always, false), matchAll: flag(e.matchAll, false), caseSensitive: flag(e.caseSensitive, false), priority: num(e.priority, 100, -10000, 10000) };
  });
  s.portraits = list(v.portraits, 24).map(p => {
    if (!p || typeof p !== 'object') throw new AppError('Invalid portrait.');
    const image = str(p.image, 800000);
    if (image) { const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image); if (!match || imageBytes(match[2]).mime !== match[1]) throw new AppError('Use a local PNG, JPEG or WebP portrait under 600 KB.'); }
    if (p.motion !== undefined && !['none', 'breathe', 'bounce', 'sway'].includes(p.motion)) throw new AppError('Invalid portrait motion.');
    return { id: str(p.id, 100) || randomUUID(), name: str(p.name, 100), image, voice: str(p.voice, 100), motion: p.motion || 'none' };
  });
  for (const entries of [s.lore, s.portraits, s.additionalInstructions]) if (new Set(entries.map(e => e.id)).size !== entries.length) throw new AppError('Duplicate entry IDs.');
  s.showPortraits = flag(v.showPortraits, false);
  s.contextMessages = num(v.contextMessages, 40, 4, 400); s.contextChars = num(v.contextChars, 48000, 8000, 240000); s.loreBudget = num(v.loreBudget, 12000, 0, 64000);
  if (Buffer.byteLength(JSON.stringify(s)) > 6000000) throw new AppError('Story setup exceeds 6 MB.');
  return s;
}
function readJson(text: unknown): any { try { return JSON.parse(str(text, 8000000).replace(/^\uFEFF/, '')); } catch (e) { if (e instanceof AppError) throw e; throw new AppError('Invalid JSON file.'); } }
export function importLore(v: any): { lore: LoreEntry[]; warnings: string[] } {
  const entries = v?.entries;
  if (!entries || typeof entries !== 'object') throw new AppError('Expected a lorebook with entries.');
  const warnings = ['Lore uses literal keyword matching, optional secondary keywords, always-on entries and priority. Regex, recursive scanning, probability, tokenizers, insertion depth and extension scripts are not executed.'];
  const lore = Object.values(entries).map((e: any) => {
    if (!e || typeof e !== 'object') throw new AppError('Invalid lore entry.');
    return { name: e.name || e.comment || '', keys: e.keys || e.key || [], secondaryKeys: (e.selective ?? e.extensions?.selective) ? e.secondary_keys || e.keysecondary || [] : [], content: e.content, enabled: e.enabled ?? !e.disable, always: e.constant ?? false, matchAll: e.matchAll ?? false, caseSensitive: e.case_sensitive ?? e.caseSensitive ?? false, priority: e.insertion_order ?? e.order ?? 100 };
  });
  return { lore: validateStory({ lore }).lore, warnings };
}
export function importCard(raw: unknown, png?: unknown): { setup: StorySetup; warnings: string[] } {
  let v: any;
  if (png !== undefined) {
    const bytes = Buffer.from(imageBytes(png).bytes);
    if (bytes[0] !== 137) throw new AppError('Character cards must be PNG or JSON.');
    let value = '', v3 = '', end = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) throw new AppError('Malformed PNG card.');
      if (type === 'tEXt') { const chunk = bytes.subarray(offset + 8, offset + 8 + length), zero = chunk.indexOf(0), key = chunk.toString('ascii', 0, Math.max(0, zero)); if (key === 'chara') value = chunk.toString('ascii', zero + 1); if (key === 'ccv3') v3 = chunk.toString('ascii', zero + 1); }
      offset += length + 12; if (type === 'IEND') { end = true; break; }
    }
    if (!end || !(v3 || value)) throw new AppError('No chara/ccv3 text metadata found in this PNG.');
    v = readJson(Buffer.from(v3 || value, 'base64').toString('utf8'));
  } else v = readJson(raw);
  if (v?.format === 'lowriter.story' && v.version === 1) { const setup = validateStory(v.setup); setup.portraits.forEach(p => p.voice = ''); return { setup, warnings: ['Local voice assignments are not transferred. Review this setup before saving.'] }; }
  const d = v?.data || v;
  if (!d || typeof d.name !== 'string' || !['description', 'scenario', 'first_mes'].some(k => typeof d[k] === 'string')) throw new AppError('Expected a character/scenario card (V1, V2 or V3 JSON/PNG).');
  const lore = d.character_book ? importLore(d.character_book) : { lore: [], warnings: [] };
  const depth = d.extensions?.depth_prompt;
  const placements = { ...blankStory().placements, ...d.extensions?.lowriter_prompt_placements };
  if (depth) placements.characterNote = { position: 'depth', role: depth.role ?? 'system', depth: depth.depth ?? 4 };
  const setup = validateStory({ name: d.name, description: d.description, personality: d.personality, scenario: d.scenario, examples: d.mes_example, instructions: d.system_prompt, postHistory: d.post_history_instructions, characterNote: depth?.prompt, placements, importedCard: JSON.stringify(v), greetings: [d.first_mes, ...list(d.alternate_greetings, 49)].filter(Boolean), lore: lore.lore });
  return { setup, warnings: ['Imported into a draft. Only personality and scenario were merged into Description. Example dialogue stays separate; card prompt fields become Additional instructions with their original placements. All original fields, including unknown extensions, remain in Retained card fields and native exports. Only {{user}} and {{char}} substitutions run; other macros remain literal. Unsupported extension behavior, tools, remote assets and scripts do not run. PNG metadata is read locally; upload a portrait separately.', ...lore.warnings] };
}
export interface StoryContext { before: ProviderMessage[]; after: ProviderMessage[]; atDepth: { depth: number; message: ProviderMessage }[]; activeLore: string[]; omittedLore: string[] }
export function storyContext(s: StorySetup, recent: string): StoryContext {
  const sub = (t: string) => t.replace(/\{\{(user|char)\}\}/gi, (_, k) => k.toLowerCase() === 'user' ? s.personaName || 'User' : s.name || 'Narrator');
  const result: StoryContext = { before: [], after: [], atDepth: [], activeLore: [], omittedLore: [] };
  const inject = (p: PromptPlacement, text: string) => { if (!text) return; const message: ProviderMessage = { role: p.role, content: sub(text) }; if (p.position === 'depth') result.atDepth.push({ depth: p.depth, message }); else result[p.position].push(message); };
  const add = (key: PromptField, text: string) => inject(s.placements[key], text);
  for (const e of s.additionalInstructions.filter(e => e.enabled && e.source === 'instructions')) inject(e.placement, e.content);
  add('description', [s.name ? 'Card: ' + s.name : '', s.description].filter(Boolean).join('\n\n'));
  add('examples', s.examples ? 'Example dialogue (reference, not past events):\n' + s.examples : '');
  add('persona', [s.personaName, s.persona].filter(Boolean).join('\n'));
  add('authorNotes', s.authorNotes);
  let budget = 0; const activeLore: string[] = [], omittedLore: string[] = [];
  for (const e of s.lore.filter(e => e.enabled).toSorted((a, b) => b.priority - a.priority)) {
    const hay = e.caseSensitive ? recent : recent.toLowerCase(), has = (k: string) => hay.includes(e.caseSensitive ? sub(k) : sub(k).toLowerCase());
    if (!e.always && (!e.keys.length || !(e.matchAll ? e.keys.every(has) : e.keys.some(has)) || (e.secondaryKeys.length && !e.secondaryKeys.some(has)))) continue;
    const text = `Lore: ${e.name}\n${sub(e.content)}`;
    if (budget + text.length > s.loreBudget) { omittedLore.push(e.name || e.id); continue; }
    budget += text.length; activeLore.push(e.name || e.id); add('lore', text);
  }
  for (const e of s.additionalInstructions.filter(e => e.enabled && e.source !== 'instructions')) inject(e.placement, e.content);
  if (s.prefill) result.after.push({ role: 'assistant', content: sub(s.prefill) });
  return { ...result, activeLore, omittedLore };
}
// Depth counts retained dialogue messages, not injected prompts or image attachments.
export function insertStoryDepth(context: ProviderMessage[], injections: StoryContext['atDepth'], dialogueOffsets: number[]): ProviderMessage[] {
  const slots = new Map<number, ProviderMessage[]>();
  for (const { depth, message } of injections) { const index = depth === 0 ? context.length : dialogueOffsets[Math.max(0, dialogueOffsets.length - depth)] ?? 0; slots.set(index, [...(slots.get(index) || []), message]); }
  return Array.from({ length: context.length + 1 }, (_, i) => [...(slots.get(i) || []), ...(i < context.length ? [context[i]] : [])]).flat();
}
export class StoryKit {
  store: Store;
  constructor(store: Store) { this.store = store; store.db.exec(`CREATE TABLE IF NOT EXISTS story_setups(conversation TEXT PRIMARY KEY REFERENCES conversations(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS story_versions(id INTEGER PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS story_presets(id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);`); }
  get(id: string): StorySetup { if (this.store.conversation(id).mode !== 'rp') throw new AppError('Story setup belongs to Writing only.'); const r = this.store.db.prepare('SELECT data FROM story_setups WHERE conversation=?').get(id); return r ? validateStory(JSON.parse(String(r.data))) : blankStory(); }
  save(id: string, data: unknown, revision: number): StorySetup {
    const setup = validateStory(data); this.get(id);
    return this.store.transaction(() => { this.store.writable(id, revision); const old = this.get(id); this.store.db.prepare('INSERT INTO story_versions(conversation,data,created) VALUES(?,?,?)').run(id, JSON.stringify(old), new Date().toISOString()); this.store.db.prepare('DELETE FROM story_versions WHERE conversation=? AND id NOT IN (SELECT id FROM story_versions WHERE conversation=? ORDER BY id DESC LIMIT 20)').run(id, id); this.store.db.prepare('INSERT INTO story_setups VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(setup)); this.store.db.prepare('UPDATE conversations SET revision=revision+1 WHERE id=?').run(id); return setup; });
  }
  versions(id: string): any[] { this.get(id); return this.store.db.prepare('SELECT id,created FROM story_versions WHERE conversation=? ORDER BY id DESC').all(id); }
  restore(id: string, version: number, revision: number): StorySetup { const row = this.store.db.prepare('SELECT data FROM story_versions WHERE conversation=? AND id=?').get(id, version); if (!row) throw new AppError('Saved setup version not found.', 404); return this.save(id, JSON.parse(String(row.data)), revision); }
  presets(): any[] { return this.store.db.prepare('SELECT id,name FROM story_presets ORDER BY name').all(); }
  preset(id: string): StorySetup { const row = this.store.db.prepare('SELECT data FROM story_presets WHERE id=?').get(id); if (!row) throw new AppError('Preset not found.', 404); return validateStory(JSON.parse(String(row.data))); }
  savePreset(name: unknown, data: unknown): void { const n = str(name, 100).trim(); if (!n) throw new AppError('Name this preset.'); if (this.presets().length >= 50) throw new AppError('Preset limit: 50. Delete an unused preset first.'); this.store.db.prepare('INSERT INTO story_presets VALUES(?,?,?)').run(randomUUID(), n, JSON.stringify(validateStory(data))); }
  greeting(id: string, index: number, revision: number): void {
    const s = this.get(id); if (!Number.isSafeInteger(index) || !s.greetings[index]?.trim()) throw new AppError('Choose a greeting.');
    this.store.transaction(() => { this.store.writable(id, revision); if (this.store.messages(id).length) throw new AppError('Greetings can only start an empty story.'); const content = s.greetings[index].replace(/\{\{(user|char)\}\}/gi, (_, k) => k.toLowerCase() === 'user' ? s.personaName || 'User' : s.name || 'Narrator'); const m = Number(this.store.db.prepare("INSERT INTO messages(conversation,role,content,revision,speaker) VALUES(?,'assistant',?,?,?)").run(id, content, revision + 1, s.name).lastInsertRowid); this.store.ensureVariant(this.store.message(id, m)); this.store.db.prepare('UPDATE conversations SET revision=revision+1 WHERE id=?').run(id); });
  }
  authored(id: string, role: unknown, content: unknown, speaker: unknown, revision: number): void {
    this.get(id); if (role !== 'user' && role !== 'assistant') throw new AppError('Choose user or assistant narrative.');
    const text = str(content, 64000); if (!text.trim()) throw new AppError('Write a message first.');
    const name = str(speaker, 100);
    this.store.transaction(() => { this.store.writable(id, revision); const m = Number(this.store.db.prepare('INSERT INTO messages(conversation,role,content,revision,speaker) VALUES(?,?,?,?,?)').run(id, role, text, revision + 1, name).lastInsertRowid); if (role === 'assistant') this.store.ensureVariant(this.store.message(id, m)); this.store.db.prepare('UPDATE conversations SET revision=revision+1 WHERE id=?').run(id); });
  }
  branch(id: string, through: number, revision: number, title: unknown): any {
    const setup = this.get(id); this.store.message(id, through);
    return this.store.transaction(() => {
      this.store.writable(id, revision);
      const copyBytes = Number(this.store.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS n FROM media_assets WHERE message IN (SELECT id FROM messages WHERE conversation=? AND id<=?)').get(id, through)!.n);
      const totalBytes = Number(this.store.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS n FROM media_assets').get()!.n);
      if (totalBytes + copyBytes >= 500000000) throw new AppError('Branch would exceed the 500 MB local media limit.');
      const c = this.store.create('rp', str(title, 100).trim() || (this.store.conversation(id).title.slice(0, 80) + ' · branch'));
      for (const m of this.store.allMessages(id).filter(m => m.id <= through)) {
        const newId = Number(this.store.db.prepare('INSERT INTO messages(conversation,role,content,revision,speaker,edited) VALUES(?,?,?,0,?,?)').run(c.id, m.role, m.content, m.speaker || '', m.edited || null).lastInsertRowid);
        const variants = new Map<number, number>([[0, 0]]);
        for (const v of this.store.db.prepare('SELECT * FROM message_variants WHERE message=? ORDER BY id').all(m.id)) {
          const variant = Number(this.store.db.prepare('INSERT INTO message_variants(message,content,edited) VALUES(?,?,?)').run(newId, v.content!, v.edited!).lastInsertRowid); variants.set(Number(v.id), variant);
        }
        this.store.db.prepare('UPDATE messages SET active_variant=? WHERE id=?').run(variants.get(m.active_variant || 0) || 0, newId);
        for (const a of this.store.db.prepare('SELECT * FROM media_assets WHERE message=?').all(m.id)) {
          this.store.db.prepare('INSERT INTO media_assets(id,message,variant,kind,mime,data,prompt,label,selected,use_in_chat,source_hash,fingerprint,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), newId, variants.get(Number(a.variant)) || 0, a.kind!, a.mime!, a.data!, a.prompt!, a.label!, a.selected!, a.use_in_chat!, a.source_hash!, a.fingerprint!, a.created!);
        }
      }
      this.store.db.prepare('INSERT INTO story_setups VALUES(?,?)').run(c.id, JSON.stringify(setup));
      return c;
    });
  }
}
