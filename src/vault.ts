import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { AppError } from './shared.ts';
import { wrapKey, unwrapKey } from './device-key.ts';
import type { WrappedKey } from './device-key.ts';
const derive = (pass: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));

export class Vault {
  file: string; key: Buffer | null = null; salt: Buffer | null = null; values: Record<string, string> = {}; busy = false;
  constructor(file: string) { this.file = file; }
  automatic = false; migrationRequired = false; wrapped: WrappedKey | null = null;
  async initializeAutomatic(): Promise<void> {
    this.automatic = true;
    try {
      if (!await this.exists()) {
        this.key = randomBytes(32); this.salt = randomBytes(16); this.wrapped = await wrapKey(this.key, this.file); await this.persist(); return;
      }
      const envelope = JSON.parse(await readFile(this.file, 'utf8'));
      if (envelope.version === 1) { this.migrationRequired = true; return; }
      if (envelope.version !== 2 || !envelope.wrapped) throw new Error('version');
      this.wrapped = envelope.wrapped; this.key = await unwrapKey(envelope.wrapped, this.file); this.salt = Buffer.from(envelope.salt, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(Buffer.from('LoWriter local vault v2')); cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const clear = Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]);
      try { const values = JSON.parse(clear.toString('utf8')); if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(v => typeof v !== 'string')) throw new Error('values'); this.values = values; } finally { clear.fill(0); }
    } catch { this.lock(); throw new AppError('Saved credentials could not be opened on this device. Existing files were not reset.', 503); }
  }
  async migrate(pass: string): Promise<void> {
    if (!this.automatic || !this.migrationRequired) throw new AppError('No legacy credentials need migration.', 409);
    await this.unlock(pass);
    this.busy = true;
    try { this.wrapped = await wrapKey(this.key!, this.file); await this.persist(); this.migrationRequired = false; }
    catch { this.wrapped = null; this.lock(); throw new AppError('Migration could not finish. Original credentials remain passphrase-protected.', 503); }
    finally { this.busy = false; }
  }
  async exists(): Promise<boolean> { try { await readFile(this.file); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
  async unlock(pass: string): Promise<void> {
    if (this.busy) throw new AppError('Vault operation in progress.', 409);
    if (this.key) throw new AppError('Vault is already unlocked.', 409);
    if (pass.length < 12 || pass.length > 512) throw new AppError('Use a passphrase of 12–512 characters.');
    this.busy = true;
    let derived: Buffer | undefined;
    try {
      if (await this.exists()) {
        const envelope = JSON.parse(await readFile(this.file, 'utf8'));
        if (envelope.version !== 1) throw new Error('version');
        const salt = Buffer.from(envelope.salt, 'base64');
        derived = await derive(pass, salt);
        const cipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(envelope.iv, 'base64'));
        cipher.setAAD(Buffer.from('LoWriter local vault v1'));
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const clear = Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]);
        let values: Record<string, string>;
        try { values = JSON.parse(clear.toString('utf8')); } finally { clear.fill(0); }
        this.lock(); this.key = derived; derived = undefined; this.salt = salt; this.values = values;
      } else {
        this.salt = randomBytes(16); derived = await derive(pass, this.salt);
        this.key = derived; derived = undefined; this.values = {}; await this.persist();
      }
    } catch { derived?.fill(0); this.lock(); throw new AppError('Vault could not be unlocked. Check the passphrase and vault file.', 403); }
    finally { this.busy = false; }
  }
  async persist(): Promise<void> {
    if (!this.key || !this.salt) throw new AppError('Unlock the vault first.', 423);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.wrapped ? 'LoWriter local vault v2' : 'LoWriter local vault v1'));
    const clear = Buffer.from(JSON.stringify(this.values));
    let data: Buffer;
    try { data = Buffer.concat([cipher.update(clear), cipher.final()]); } finally { clear.fill(0); }
    const envelope = { version: this.wrapped ? 2 : 1, ...(this.wrapped ? { wrapped: this.wrapped } : {}), salt: this.salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    await writeFile(this.file + '.tmp', JSON.stringify(envelope), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
  async set(name: string, value: string): Promise<void> {
    if (!this.key) throw new AppError('Unlock the vault first.', 423);
    if (this.busy) throw new AppError('Vault operation in progress.', 409);
    this.busy = true;
    const previous = this.values[name];
    try { this.values[name] = value; await this.persist(); }
    catch (e) { if (previous === undefined) delete this.values[name]; else this.values[name] = previous; throw e; }
    finally { this.busy = false; }
  }
  get(name: string): string { if (!this.key) throw new AppError('Unlock the vault in Connections first.', 423); return this.values[name] || ''; }
  lock(): void { this.key?.fill(0); this.key = null; this.values = {}; this.salt = null; }
  redact(text: string, extra: string[] = []): string {
    for (const secret of [...Object.values(this.values), ...extra]) if (secret) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  }
}
