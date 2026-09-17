import { spawn } from 'node:child_process';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { AppError } from './shared.ts';

// Secrets travel only over pipes, never PowerShell arguments or diagnostic output.
async function dpapi(data: Buffer, decrypt: boolean): Promise<Buffer> {
  const command = `Add-Type -AssemblyName System.Security; try { $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)); [Array]::Clear($b,0,$b.Length); [Array]::Clear($r,0,$r.Length) } catch { exit 1 }`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', failed = false;
    const fail = () => { failed = true; reject(new AppError('Windows could not open saved credentials for this account. No credentials were replaced.', 503)); };
    const timer = setTimeout(() => { child.kill(); fail(); }, 15000);
    child.on('error', () => { clearTimeout(timer); fail(); }); child.stdin.on('error', fail);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) { child.kill(); fail(); } });
    child.on('close', code => { clearTimeout(timer); if (failed) return; if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) { fail(); return; } resolve(Buffer.from(output, 'base64')); });
    child.stdin.end(data.toString('base64'));
  });
}
export interface WrappedKey { kind: 'windows-dpapi' | 'private-file'; data?: string }
export async function wrapKey(key: Buffer, file: string): Promise<WrappedKey> {
  if (process.platform === 'win32') return { kind: 'windows-dpapi', data: (await dpapi(key, false)).toString('base64') };
  // Termux/POSIX fallback: relies on app-private directory and 0600 file permissions,
  // not a hardware/OS keychain. Never pretend it resists a compromised local account.
  await writeFile(file + '.device-key', key, { mode: 0o600, flag: 'wx' });
  return { kind: 'private-file' };
}
export async function unwrapKey(wrapped: WrappedKey, file: string): Promise<Buffer> {
  let key: Buffer;
  if (wrapped.kind === 'windows-dpapi' && process.platform === 'win32' && typeof wrapped.data === 'string' && wrapped.data.length < 32768) key = await dpapi(Buffer.from(wrapped.data, 'base64'), true);
  else if (wrapped.kind === 'private-file' && process.platform !== 'win32') {
    const stat = await lstat(file + '.device-key');
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new AppError('Saved credential key file must be owned by this account with private permissions.', 503);
    key = await readFile(file + '.device-key');
  } else throw new AppError('Saved credentials belong to another platform. Migrate them on the original device.', 503);
  if (key.length !== 32) { key.fill(0); throw new AppError('Invalid saved credential key.', 503); }
  return key;
}
