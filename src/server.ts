import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from './store.ts';
import { Vault } from './vault.ts';
import { Engine } from './engine.ts';
import { AppError, requireString } from './shared.ts';
import { validateConnection } from './provider.ts';
import { projectRoot } from './project-tools.ts';
import type { Connection } from './shared.ts';
import { BrowserLaunch } from './browser-launch.ts';
import { profiles, saveConnection, connectionKey } from './connections.ts';
import { listModels, listVoices, speak } from './provider-services.ts';

function matches(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
async function body(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('JSON Content-Type is required.', 415);
  let data = '', bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 100000) throw new AppError('Request too large.', 413); data += chunk; }
  try { const parsed = JSON.parse(data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
  catch { throw new AppError('Invalid JSON body.'); }
}
function json(res: ServerResponse, value: unknown, status = 200): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
export interface ServerOptions { dataDir: string; port?: number; staticDir?: string; demo?: Connection; credentialMode?: 'automatic' | 'legacy-test' }
export async function startServer(options: ServerOptions) {
  const dir = resolve(options.dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  }
  const lock = join(dir, 'coordinator.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
    let owner: any;
    try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); } catch { throw new AppError('Coordinator lock needs review. Do not start two owners of this data folder.', 409); }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new AppError('Invalid coordinator lock; manual review required.', 409);
    try { process.kill(owner.pid, 0); throw new AppError('A coordinator already owns this data folder.', 409); }
    catch (err: any) { if (err.code !== 'ESRCH') throw err; }
    // Only remove this app's stale lock after proving its owning process is gone.
    await unlink(join(lock, 'owner.json')); await rmdir(lock); await mkdir(lock, { mode: 0o700 });
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let store: Store;
  try { store = new Store(join(dir, 'lowriter.sqlite')); }
  catch (e) { await unlink(join(lock, 'owner.json')); await rmdir(lock); throw e; }
  const vault = new Vault(join(dir, 'vault.json')), engine = new Engine(store, vault);
  try { if (options.credentialMode !== 'legacy-test') await vault.initializeAutomatic(); }
  catch (e) { store.close(); await unlink(join(lock, 'owner.json')); await rmdir(lock); throw e; }
  if (options.demo && (!store.setting('connection') || store.setting('connection').demo)) store.setSetting('connection', { ...options.demo, demo: true });
  else if (store.setting('connection')?.demo) store.setSetting('connection', null);
  const token = randomBytes(32).toString('base64url');
  const staticDir = options.staticDir ?? resolve('dist');
  const browserLaunch = new BrowserLaunch();
  let closedResolve!: () => void, closing: Promise<void> | undefined;
  const closed = new Promise<void>(resolveClosed => { closedResolve = resolveClosed; });
  let origin = '', stopping = false, attempts: number[] = [], administrativeWrite = false;
  const providerRequests = new Map<AbortController, string>();
  const stopProviderRequests = () => { for (const controller of providerRequests.keys()) controller.abort(); };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (stopping) throw new AppError('Service is stopping.', 503);
      if (req.headers.host !== new URL(origin).host) throw new AppError('Host is not allowed.', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError('Origin is not allowed.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site request rejected.', 403);
      const path = new URL(req.url ?? '/', origin).pathname;
      const cookieName = 'lowriter_' + new URL(origin).port;
      if (path === '/launch' && req.method === 'GET') {
        browserLaunch.consume(req.headers);
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(303, { Location: '/' }); res.end(); return;
      }
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') throw new AppError('Method not allowed.', 405);
        const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
        const file = files[path]; if (!file) throw new AppError('Not found.', 404);
        let data: Buffer; try { data = await readFile(join(staticDir, file[0])); } catch { throw new AppError('GUI not built. Run the build command first.', 503); }
        res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' }); res.end(data); return;
      }
      if (req.headers['x-lowriter'] !== '1') throw new AppError('Local API header is required.', 403);
      if (path === '/api/login' && req.method === 'POST') {
        attempts = attempts.filter(t => t > Date.now() - 60000);
        if (attempts.length >= 6) throw new AppError('Too many pairing attempts. Wait one minute.', 429);
        const input = await body(req); attempts.push(Date.now());
        if (typeof input.token !== 'string' || !matches(input.token, token)) throw new AppError('Invalid pairing code.', 401);
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        attempts = []; json(res, { ok: true }); return;
      }
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
      if (!matches(bearer || cookie, token)) throw new AppError('Open LoWriter using its launcher to reconnect automatically.', 401);
      if (path === '/api/state' && req.method === 'GET') {
        json(res, { conversations: store.conversations(), connection: engine.connection(), connections: profiles(store), speechConnection: store.setting('speechConnection') || null, vault: { exists: await vault.exists(), unlocked: !!vault.key, automatic: vault.automatic, migrationRequired: vault.migrationRequired, protection: process.platform === 'win32' ? 'Windows account encryption' : 'App-private file permissions' }, capabilities: { platform: process.platform, runtime: process.version, rp: 'basic chat; memory/story/import pending', coding: 'trusted text tools and harmless checks', shell: false, browser: false, desktop: false, sync: false, termux: 'not device-validated' } }); return;
      }
      const parts = path.split('/').slice(2), id = parts[1];
      if (parts[0] === 'conversations' && id && req.method === 'GET') {
        const before = Number(new URL(req.url!, origin).searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        if (!Number.isSafeInteger(before) || before < 1) throw new AppError('Invalid history cursor.');
        const c = store.conversation(id), latest = store.latestJob(id);
        json(res, { conversation: c, messages: store.messages(id, before), job: latest ? engine.snapshot(latest.id) : null }); return;
      }
      if (parts[0] === 'jobs' && id && req.method === 'GET') { json(res, engine.snapshot(id)); return; }
      if (req.method !== 'POST') throw new AppError('Not found.', 404);
      const input = await body(req);
      if (path === '/api/launch') {
        // Browser cookies cannot arm a new launch; the private local client can.
        if (!matches(bearer, token)) throw new AppError('The local launcher is required.', 403);
        browserLaunch.arm(); json(res, { url: origin + '/launch' }); return;
      }
      if (path === '/api/shutdown') { json(res, { ok: true }); setImmediate(() => { void close(); }); return; }
      if (path === '/api/conversations') { json(res, store.create(input.mode, requireString(input.title, 'title', 100)), 201); return; }
      if (path === '/api/logout') { res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); json(res, { ok: true }); return; }
      if (path === '/api/stop') { stopProviderRequests(); await engine.stopAll(); json(res, { ok: true }); return; }
      if (parts[0] === 'jobs' && parts[2] === 'cancel') { await engine.cancel(id); json(res, { ok: true }); return; }
      if (parts[0] === 'conversations' && parts[2] === 'send') {
        if (administrativeWrite) throw new AppError('Settings update in progress.', 409);
        if (!Number.isSafeInteger(input.revision)) throw new AppError('Expected revision is required.');
        json(res, engine.start(id, input.text, input.revision), 202); return;
      }
      if (administrativeWrite) throw new AppError('Another settings/project update is in progress.', 409);
      if (parts[0] === 'conversations' && parts[2] === 'messages' && parts[4] === 'edit' && parts.length === 5) {
        const text = vault.redact(requireString(input.text, 'message', 64000), [token]);
        json(res, store.editMessage(id, Number(parts[3]), text, input.revision)); return;
      }
      if (['/api/models', '/api/voices', '/api/speech'].includes(path)) {
        if (providerRequests.size >= 3 || (path === '/api/speech' && [...providerRequests.values()].includes(path))) throw new AppError('Provider request already running. Stop it or wait.', 429);
          const connection = validateConnection({ ...input, model: path === '/api/speech' ? input.model : input.model || 'catalog' });
        const key = connectionKey(store, vault, connection, input), controller = new AbortController();
        providerRequests.set(controller, path);
        const abort = () => controller.abort(); res.once('close', abort);
        try {
          if (path === '/api/speech') {
            const audio = await speak(connection, key, input, controller.signal);
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="lowriter-speech.mp3"' }); res.end(audio);
          } else {
            const result = path === '/api/models' ? await listModels(connection, key, controller.signal) : await listVoices(connection, key, controller.signal);
            // Treat catalog text as untrusted; never return a credential echo.
            json(res, JSON.parse(JSON.stringify(result, (_k, v) => typeof v === 'string' ? vault.redact(v, [key]) : v)));
          }
        } finally { providerRequests.delete(controller); res.off('close', abort); }
        return;
      }
      administrativeWrite = true;
      try {
        if (parts[0] === 'conversations' && parts[2] === 'project') {
          if (typeof input.trust !== 'boolean') throw new AppError('Explicit trust selection is required.');
          const root = await projectRoot(requireString(input.path, 'project path', 2000));
          if (root === dir || dir.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) throw new AppError('Choose a project that does not contain LoWriter private storage.', 403);
          json(res, store.project(id, root, input.trust)); return;
        }
        if (parts[0] === 'conversations' && parts[2] === 'restore') {
          if (engine.active.size) throw new AppError('Stop running jobs before restoring a checkpoint.', 409);
          json(res, { output: vault.redact(await engine.tools.restore(store.conversation(id), requireString(input.checkpoint, 'checkpoint', 100))) }); return;
        }
        if (path === '/api/vault/migrate') { await vault.migrate(requireString(input.passphrase, 'passphrase', 512)); json(res, { ok: true }); return; }
        if (path === '/api/vault/unlock') { if (vault.automatic) throw new AppError('Saved credentials open automatically; use migration only for an old vault.', 409); await vault.unlock(requireString(input.passphrase, 'passphrase', 512)); json(res, { ok: true }); return; }
        if (path === '/api/vault/lock') {
          if (vault.automatic) throw new AppError('Credentials are managed automatically. Use Stop all to cancel jobs.', 409);
          stopProviderRequests(); await engine.stopAll(); if (vault.busy) throw new AppError('Vault operation in progress.', 409);
          vault.lock(); json(res, { ok: true }); return;
        }
        if (path === '/api/connection') {
          if (engine.active.size) throw new AppError('Stop running jobs before changing connections.', 409);
          json(res, await saveConnection(store, vault, input)); return;
        }
        throw new AppError('Not found.', 404);
      } finally { administrativeWrite = false; }
    } catch (e) { if (!res.headersSent) json(res, { error: e instanceof AppError ? vault.redact(e.message, [token]) : 'Operation failed. Raw diagnostic details withheld.' }, e instanceof AppError ? e.status : 500); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 50;
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(options.port ?? 4317, '127.0.0.1', yes); });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(join(dir, 'client.json'), JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 });
  } catch (e) { server.close(); store.close(); await unlink(join(lock, 'owner.json')); await rmdir(lock); throw e; }
  function close(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      stopProviderRequests(); await engine.stopAll(); vault.lock();
      await new Promise<void>(yes => { server.closeAllConnections(); server.close(() => yes()); });
      store.close(); await unlink(join(dir, 'client.json')).catch(() => {}); await unlink(join(lock, 'owner.json')); await rmdir(lock);
      closedResolve();
    })();
    return closing;
  }
  return { origin, token, store, vault, engine, close, closed };
}
