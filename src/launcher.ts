import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDir } from './paths.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export interface Client { origin: string; token: string; pid: number }
export interface LaunchOptions { dataDir: string; demo?: boolean; port?: number; open?: (url: string) => Promise<void> }

async function clientFile(dir: string): Promise<Client | undefined> {
  let raw: string;
  try { raw = await readFile(join(dir, 'client.json'), 'utf8'); }
  catch (e: any) { if (e.code === 'ENOENT') return; throw new Error('Cannot read local LoWriter startup state.'); }
  try {
    const c = JSON.parse(raw), url = new URL(c.origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== c.origin || !/^[\w-]{43}$/.test(c.token) || !Number.isInteger(c.pid) || c.pid < 1) throw new Error();
    return c;
  } catch { throw new Error('Invalid local LoWriter startup state. No other application was opened.'); }
}

async function localRequest(client: Client, path: string, post = false): Promise<Response> {
  return fetch(client.origin + '/api' + path, {
    method: post ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(1500),
    headers: { 'X-LoWriter': '1', Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' },
    body: post ? '{}' : undefined,
  });
}
async function running(dir: string): Promise<Client | undefined> {
  const client = await clientFile(dir); if (!client) return;
  let response: Response;
  try { response = await localRequest(client, '/state'); } catch { return; }
  await response.body?.cancel();
  if (response.ok) return client;
  if (response.status === 503) return;
  throw new Error('The existing local service could not be authenticated. Close its LoWriter terminal, then reopen LoWriter.');
}

// Bind a console to this exact authenticated instance, never to a replacement
// which happens to reuse its port or private directory.
export async function coordinatorState(dir: string, client: Client): Promise<'running' | 'stopped' | 'crashed'> {
  const current = await clientFile(dir);
  if (!current || current.pid !== client.pid || current.token !== client.token || current.origin !== client.origin) return 'stopped';
  try { process.kill(client.pid, 0); return 'running'; } catch { return 'crashed'; }
}

export async function coordinatorPresent(dir: string, client: Client): Promise<boolean> {
  return await coordinatorState(dir, client) === 'running';
}

export async function stopCoordinator(dir: string, client: Client): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!await coordinatorPresent(dir, client)) return;
    try {
      const response = await localRequest(client, '/shutdown', true);
      await response.body?.cancel();
      if (response.ok || response.status === 503) return;
    } catch { /* Retry a temporary local transport failure, not another process. */ }
    await new Promise(yes => setTimeout(yes, 300));
  }
  throw new Error('LoWriter could not shut down cleanly. Use Quit LoWriter again.');
}

export async function ensureCoordinator(options: LaunchOptions): Promise<Client> {
  const dir = resolve(options.dataDir), existing = await running(dir);
  if (existing) return existing;
  const port = options.port ?? Number(process.env.LOWRITER_PORT ?? (options.demo ? 4318 : 4317));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
  // Spawn only our entry point, without a shell, credentials, or a visible console.
  const child = spawn(process.execPath, [join(root, 'src/main.ts'), ...(options.demo ? ['--demo'] : [])], {
    cwd: root, env: { ...process.env, LOWRITER_DATA_DIR: dir, LOWRITER_PORT: String(port) },
    windowsHide: true, detached: true, stdio: 'ignore',
  });
  let failedToStart = false;
  child.once('error', () => { failedToStart = true; });
  child.once('exit', () => { failedToStart = true; }); child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failedToStart) throw new Error('LoWriter stopped during startup. Its port may be occupied. Run LoWriter.ps1 service for a visible diagnostic.');
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
    const ready = await running(dir); if (ready) return ready;
  }
  throw new Error('LoWriter did not become ready. Its port may be occupied. Run LoWriter.ps1 service for a visible diagnostic; no existing application was stopped.');
}

export function browserCommand(url: string, platform: string = process.platform, termux = !!process.env.PREFIX?.includes('com.termux')): [string, string[]] {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/launch' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid local launch address.');
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'android' || termux) return ['termux-open-url', [url]];
  return [platform === 'darwin' ? 'open' : 'xdg-open', [url]];
}
export async function openBrowser(url: string): Promise<void> {
  const [command, args] = browserCommand(url);
  try { await promisify(execFile)(command, args, { windowsHide: true, timeout: 15000 }); }
  catch { throw new Error('LoWriter is running, but the browser did not open. Check your default browser and open LoWriter again.'); }
}
export async function launch(options: LaunchOptions): Promise<{ origin: string; pid: number }> {
  const client = await ensureCoordinator(options);
  return openCoordinator(client, options.open);
}

export async function openCoordinator(client: Client, open: (url: string) => Promise<void> = openBrowser): Promise<{ origin: string; pid: number }> {
  const response = await localRequest(client, '/launch', true);
  if (response.status === 404) throw new Error('An older LoWriter service is running. Close its old terminal once, then open LoWriter again.');
  if (!response.ok) throw new Error('Could not prepare the local workspace. Open LoWriter again.');
  const value = await response.json() as { url?: string };
  if (value.url !== client.origin + '/launch') throw new Error('Invalid local launch response.');
  await open(value.url);
  return { origin: client.origin, pid: client.pid };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const demo = process.argv.includes('--demo');
    const options = { dataDir: demo && !process.env.LOWRITER_DATA_DIR ? join(root, '.demo-data') : dataDir(), demo };
    if (demo) {
      const project = join(root, '.demo-project'); await mkdir(project, { recursive: true });
      try { await copyFile(join(root, 'examples/demo-project/greeting.js'), join(project, 'greeting.js'), constants.COPYFILE_EXCL); }
      catch (e: any) { if (e.code !== 'EEXIST') throw new Error('Could not prepare the disposable demo project.'); }
      console.log(`Local demo project: ${project}`);
    }
    const { consoleSession } = await import('./console-session.ts');
    await consoleSession(options, process.argv.includes('--no-browser'));
  } catch (e) { console.error(e instanceof Error ? e.message : 'LoWriter could not open.'); process.exitCode = 1; }
}
