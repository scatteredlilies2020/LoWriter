import { createHash } from 'node:crypto';
import { AppError, isSpeech, isImage } from './shared.ts';
import type { Connection } from './shared.ts';
import type { Store } from './store.ts';
import type { Vault } from './vault.ts';
import { validateConnection } from './provider.ts';

// Never reuse credentials based on a browser-supplied ID, name, or provider alone.
export function credentialId(c: Connection): string {
  return 'connection-' + createHash('sha256').update(JSON.stringify([c.provider || 'custom', c.endpoint, c.dialect, c.auth || 'auto'])).digest('hex');
}
export function profiles(store: Store): Connection[] { return store.setting('connections') || []; }
export function connectionKey(store: Store, vault: Vault, c: Connection, input: any): string {
  const key = input.apiKey ?? '';
  if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key)) throw new AppError('API key / proxy password must be at most 4096 characters, without line breaks.');
  if (input.keyMode !== undefined && !['keep', 'replace', 'clear'].includes(input.keyMode)) throw new AppError('Invalid key action.');
  // Automatic device storage is ready at startup; legacy encrypted data needs migration.
  const saved = vault.get(credentialId(c));
  if (input.keyMode === 'clear' || c.auth === 'none') return '';
  if (key) return key;
  if (input.keyMode !== 'keep') return '';
  const old = store.setting('connection');
  if (old && !old.demo && !old.credentialId && credentialId(validateConnection(old)) === credentialId(c)) return vault.get('provider');
  return saved;
}
export async function saveConnection(store: Store, vault: Vault, input: any): Promise<Connection> {
  const c = validateConnection(input), id = credentialId(c), key = connectionKey(store, vault, c, input);
  const profileId = 'preset-' + createHash('sha256').update(JSON.stringify([id, c.name || ''])).digest('hex');
  const previous = profiles(store), index = previous.findIndex(p => p.profileId === profileId || (!p.profileId && p.credentialId === id && (p.name || '') === (c.name || '')));
  if (index < 0 && previous.length >= 100) throw new AppError('Connection profile limit reached (100).');
  const profile = { ...c, credentialId: id, profileId, hasKey: !!key };
  await vault.set(id, key);
  const next = previous.map(p => p.credentialId === id ? { ...p, hasKey: !!key } : p); if (index < 0) next.push(profile); else next[index] = profile;
  store.setSetting('connections', next);
  if (isSpeech(c.dialect)) store.setSetting('speechConnection', profile);
  else if (isImage(c.dialect)) store.setSetting('imageConnection', profile);
  else { store.setSetting('connection', profile); store.setSetting('hasKey', !!key); }
  return profile;
}
