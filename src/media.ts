import { createHash, randomUUID } from 'node:crypto';
import { AppError, requireString } from './shared.ts';
import type { MediaAsset, Message, VoiceProfile } from './shared.ts';
import { Store } from './store.ts';

export const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function imageBytes(base64: unknown): { bytes: Uint8Array; mime: string } {
  if (typeof base64 !== 'string' || base64.length > 11000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new AppError('Expected bounded base64 image data, not an image URL.', 502);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '') || bytes.length > 8000000) throw new AppError('Invalid or oversized image.', 502);
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : '';
  if (!mime) throw new AppError('Only PNG, JPEG and WebP image data are accepted; SVG/HTML and remote image URLs are not loaded.', 502);
  return { bytes, mime };
}
const columns = 'id,message,variant,kind,mime,prompt,label,selected,use_in_chat,source_hash,created';
export class MediaStore {
  store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS media_assets(id TEXT PRIMARY KEY, message INTEGER NOT NULL REFERENCES messages(id), variant INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, prompt TEXT NOT NULL, label TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0, use_in_chat INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS media_message ON media_assets(message,variant);
      CREATE UNIQUE INDEX IF NOT EXISTS selected_image ON media_assets(message,variant) WHERE kind='image' AND selected=1;`);
  }
  list(m: Message): MediaAsset[] {
    return (this.store.db.prepare(`SELECT ${columns} FROM media_assets WHERE message=? AND variant=? ORDER BY created,rowid`).all(m.id, m.active_variant || 0) as unknown as MediaAsset[]).map(a => ({ ...a, stale: a.source_hash !== textHash(m.content) }));
  }
  asset(id: string): MediaAsset & { data: Uint8Array } {
    const row = this.store.db.prepare(`SELECT ${columns},data FROM media_assets WHERE id=?`).get(id);
    if (!row) throw new AppError('Media not found.', 404);
    return row as unknown as MediaAsset & { data: Uint8Array };
  }
  room(m: Message, incomingBytes = 0) {
    if (Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE message=? AND variant=?').get(m.id, m.active_variant || 0)!.n) >= 50) throw new AppError('Media limit reached for this reply variant (50).');
    if (Number(this.store.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS n FROM media_assets').get()!.n) + incomingBytes >= 500000000) throw new AppError('Local media storage limit reached (500 MB).');
  }
  add(m: Message, kind: 'image' | 'audio', data: Uint8Array, mime: string, prompt: string, label: string, fingerprint = '', use = true): MediaAsset {
    return this.store.transaction(() => {
      this.room(m, data.length);
      const id = randomUUID(), variant = m.active_variant || 0;
      if (kind === 'image') this.store.db.prepare("UPDATE media_assets SET selected=0 WHERE message=? AND variant=? AND kind='image'").run(m.id, variant);
      this.store.db.prepare('INSERT INTO media_assets(id,message,variant,kind,mime,data,prompt,label,selected,use_in_chat,source_hash,fingerprint,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, m.id, variant, kind, mime, data, prompt, label, kind === 'image' ? 1 : 0, kind === 'image' && use ? 1 : 0, textHash(m.content), fingerprint, new Date().toISOString());
      this.store.db.prepare('UPDATE conversations SET revision=revision+1 WHERE id=?').run(m.conversation);
      const { data: _data, ...asset } = this.asset(id); return asset;
    });
  }
  select(m: Message, assetId: string, use: boolean, revision: number) {
    this.store.transaction(() => {
      this.store.writable(m.conversation, revision);
      const asset = this.asset(assetId);
      if (asset.message !== m.id || asset.variant !== (m.active_variant || 0) || asset.kind !== 'image') throw new AppError('Image does not belong to this message variant.', 404);
      if (typeof use !== 'boolean') throw new AppError('Explicit chat image selection required.');
      this.store.db.prepare("UPDATE media_assets SET selected=0 WHERE message=? AND variant=? AND kind='image'").run(m.id, m.active_variant || 0);
      this.store.db.prepare('UPDATE media_assets SET selected=1,use_in_chat=? WHERE id=?').run(use ? 1 : 0, asset.id);
      this.store.db.prepare('UPDATE conversations SET revision=revision+1 WHERE id=?').run(m.conversation);
    });
  }
  cached(m: Message, fingerprint: string): MediaAsset | undefined {
    return this.list(m).find(a => a.kind === 'audio' && this.store.db.prepare('SELECT id FROM media_assets WHERE id=? AND fingerprint=?').get(a.id, fingerprint));
  }
  voices(): VoiceProfile[] { return this.store.setting('voices') || []; }
  saveVoice(input: any): VoiceProfile {
    const name = requireString(input.name, 'voice name', 80), connection = requireString(input.connection, 'saved speech connection', 100), voice = requireString(input.voice, 'voice ID', 200);
    const profile = (this.store.setting('connections') || []).find((c: any) => c.profileId === connection && ['speech', 'speech-openai'].includes(c.dialect));
    if (!profile || !/^[a-zA-Z0-9_-]+$/.test(voice)) throw new AppError('Choose a saved speech connection and valid voice ID.');
    const speed = input.speed ?? 1;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.7 || speed > 1.2) throw new AppError('Voice speed must be between 0.7 and 1.2.');
    const all = this.voices(), existing = all.find(v => v.connection === connection && v.name === name);
    if (!existing && all.length >= 100) throw new AppError('Voice preset limit reached (100).');
    const v = { id: existing?.id || randomUUID(), name, connection, voice, speed };
    this.store.setSetting('voices', [...all.filter(p => p.id !== v.id), v]); return v;
  }
}
