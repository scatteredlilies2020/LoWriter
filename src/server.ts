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
import { listModels, listVoices, speak, generateImage } from './provider-services.ts';
import { textHash } from './media.ts';
import { Chats } from './chats.ts';
import { importCard, importLore, storyContext } from './story-kit.ts';

function matches(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
async function body(req: IncomingMessage, max = 100000): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('JSON Content-Type is required.', 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw new AppError('Request too large.', 413); chunks.push(chunk); }
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
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
  const chats = new Chats(store, engine.memory);
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
  const mediaReservations = new Set<string>(), pendingMedia = new Set<Promise<void>>();
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
      const mediaRead = req.method === 'GET' && /^\/api\/media\/[a-f0-9-]{36}$/.test(path);
      if (!mediaRead && req.headers['x-lowriter'] !== '1') throw new AppError('Local API header is required.', 403);
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
      if (mediaRead) {
        const a = engine.media.asset(path.split('/').at(-1)!);
        res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': a.data.length, 'Content-Disposition': `inline; filename="lowriter-${a.kind}.${a.mime === 'image/jpeg' ? 'jpg' : a.mime === 'audio/mpeg' ? 'mp3' : a.mime.split('/')[1]}"` }); res.end(a.data); return;
      }
      if (path === '/api/media-state' && req.method === 'GET') { json(res, { imageConnection: store.setting('imageConnection'), speechConnection: store.setting('speechConnection'), voices: engine.media.voices() }); return; }
      if (path === '/api/state' && req.method === 'GET') {
json(res, { conversations: store.conversations(), connection: engine.connection(), connections: profiles(store), speechConnection: store.setting('speechConnection') || null, vault: { exists: await vault.exists(), unlocked: !!vault.key, automatic: vault.automatic, migrationRequired: vault.migrationRequired, protection: process.platform === 'win32' ? 'Windows account encryption' : 'App-private file permissions' }, capabilities: { platform: process.platform, runtime: process.version, rp: 'story cards, keyword lore, branches, continuation and optional Continuity core; partial ST behavior compatibility', coding: 'general-purpose chat and optional trusted project tools; no general shell, browser or desktop control', shell: false, browser: false, desktop: false, sync: false, termux: 'not device-validated' } }); return;
      }
      const parts = path.split('/').slice(2), id = parts[1];
      if (path === '/api/chats' && req.method === 'GET') {
        const query = new URL(req.url!, origin).searchParams;
        json(res, store.library(query.get('query') || '', Number(query.get('offset') || 0))); return;
      }
      if (parts[0] === 'conversations' && id && parts.length === 3 && req.method === 'GET') {
        if (parts[2] === 'memory-source') { if (store.conversation(id).mode !== 'rp') throw new AppError('Story sources only.'); const q = new URL(req.url!, origin).searchParams, from = Number(q.get('from')), to = Number(q.get('to')); if (!q.has('from') || !q.has('to') || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > 19) throw new AppError('Choose a source range of up to 20 messages.'); json(res, { messages: store.allMessages(id).slice(from, to + 1).map((m, i) => ({ index: from + i, role: m.role, speaker: m.speaker, content: m.content })) }); return; }
        if (parts[2] === 'story') { json(res, { setup: engine.stories.get(id), versions: engine.stories.versions(id), presets: engine.stories.presets(), revision: store.conversation(id).revision }); return; }
        if (parts[2] === 'export') { json(res, chats.export(id, new URL(req.url!, origin).searchParams.get('memory') === '1')); return; }
        if (parts[2] === 'memory') {
          if (store.conversation(id).mode !== 'rp') throw new AppError('Memory is available for stories only.');
          json(res, { ...engine.memory.inspect(id), ...engine.memoryStatus(id) }); return;
        }
      }
      if (parts[0] === 'conversations' && id && parts.length === 2 && req.method === 'GET') {
        const before = Number(new URL(req.url!, origin).searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        if (!Number.isSafeInteger(before) || before < 1) throw new AppError('Invalid history cursor.');
        const c = store.conversation(id), latest = store.latestJob(id);
        json(res, { conversation: c, messages: store.messages(id, before).map(m => ({ ...m, media: engine.media.list(m) })), job: latest ? engine.snapshot(latest.id) : null, mediaBusy: mediaReservations.has(id), memory: c.mode === 'rp' ? engine.memoryStatus(id) : null }); return;
      }
      if (parts[0] === 'jobs' && id && req.method === 'GET') { json(res, engine.snapshot(id)); return; }
      if (req.method !== 'POST') throw new AppError('Not found.', 404);
      const input = await body(req, path === '/api/chats/import' || parts[2]?.startsWith('story') ? 16000000 : parts[2] === 'memory-review' ? 2000000 : 100000);
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
      if (parts[0] === 'conversations' && parts[2] === 'memory-toggle') {
        // Turning off cancels background memory immediately; no media reservation needed.
        engine.memory.toggle(id, input.enabled, input.revision);
        if (input.enabled === false) { engine.cancelMemory(id); engine.memoryErrors.delete(id); }
        if (input.enabled) engine.startMemory(id);
        json(res, engine.memoryStatus(id)); return;
      }
      if (parts[0] === 'conversations' && parts[2] === 'memory-profile') {
        if (administrativeWrite) throw new AppError('Settings update in progress.', 409);
        engine.memory.selectProfile(id, input.profile, input.revision);
        const previous = engine.memoryActive.get(id);
        previous?.controller.abort();
        if (previous) await previous.finished;
        engine.memoryErrors.delete(id);
        engine.startMemory(id);
        json(res, engine.memoryStatus(id)); return;
      }
      if (parts[0] === 'conversations' && mediaReservations.has(id)) throw new AppError('Media is generating for this conversation. Wait or use Stop all.', 409);
      if (parts[0] === 'conversations' && parts[2] === 'send') {
        if (administrativeWrite) throw new AppError('Settings update in progress.', 409);
        if (!Number.isSafeInteger(input.revision)) throw new AppError('Expected revision is required.');
        json(res, engine.start(id, input.text, input.revision), 202); return;
      }
      if (administrativeWrite) throw new AppError('Another settings/project update is in progress.', 409);
      if (parts[0] === 'conversations' && parts[2]?.startsWith('story')) {
        engine.stories.get(id);
        const clean = (v: any) => JSON.parse(vault.redact(JSON.stringify(v), [token]));
        if (parts[2] === 'story-save') { engine.cancelMemory(id); json(res, engine.stories.save(id, clean(input.setup), input.revision)); return; }
        if (parts[2] === 'story-authored') { engine.stories.authored(id, input.role, vault.redact(requireString(input.text, 'message', 64000), [token]), vault.redact(typeof input.speaker === 'string' ? input.speaker : '', [token]), input.revision); engine.cancelMemory(id); json(res, { ok: true }); return; }
        if (parts[2] === 'story-import') { json(res, clean(input.kind === 'lore' ? importLore(JSON.parse(requireString(input.text, 'lorebook JSON', 8000000))) : importCard(input.text, input.png))); return; }
        if (parts[2] === 'story-preview') { const s = engine.stories.get(id), recent = store.contextMessages(id, Number.MAX_SAFE_INTEGER, s.contextMessages); let chars = 0; const included = []; for (const m of recent.toReversed()) { if (chars + m.content.length > s.contextChars) break; chars += m.content.length; included.unshift(m); } json(res, storyContext(s, included.map(m => m.content).join('\n'))); return; }
        if (parts[2] === 'story-restore') { engine.cancelMemory(id); json(res, engine.stories.restore(id, input.version, input.revision)); return; }
        if (parts[2] === 'story-greeting') { engine.stories.greeting(id, input.index, input.revision); json(res, { ok: true }); return; }
        if (parts[2] === 'story-preset-save') { engine.stories.savePreset(vault.redact(requireString(input.name, 'preset name', 100), [token]), clean(input.setup)); json(res, { ok: true }); return; }
        if (parts[2] === 'story-preset-load') { json(res, engine.stories.preset(requireString(input.preset, 'preset ID', 100))); return; }
        if (parts[2] === 'story-preset-delete') { engine.stories.store.db.prepare('DELETE FROM story_presets WHERE id=?').run(requireString(input.preset, 'preset ID', 100)); json(res, { ok: true }); return; }
        if (parts[2] === 'story-branch') { json(res, { conversation: engine.stories.branch(id, input.through, input.revision, input.title) }, 201); return; }
      }
      if (path === '/api/chats/import') { json(res, chats.import(input.text, input.includeMemory, input.title, v => vault.redact(v, [token])), 201); return; }
      if (parts[0] === 'conversations' && parts[2] === 'rename') { store.rename(id, vault.redact(requireString(input.title, 'title', 100), [token]), input.revision); json(res, { ok: true }); return; }
      if (parts[0] === 'conversations' && parts[2] === 'memory-update') {
        store.writable(id, input.revision);
        if (store.conversation(id).mode !== 'rp' || !engine.memory.row(id).enabled) throw new AppError('Turn on story memory first.');
        engine.startMemory(id); json(res, engine.memoryStatus(id), 202); return;
      }
      if (parts[0] === 'conversations' && parts[2] === 'memory-review') {
        if (engine.memoryActive.has(id)) throw new AppError('Memory is updating. Use Stop all first.', 409);
        const result = input.result === undefined ? undefined : JSON.parse(vault.redact(JSON.stringify(input.result), [token]));
        engine.memory.review(id, input.revision, input.accept, result, input.reviewId); json(res, engine.memoryStatus(id)); return;
      }
      if (parts[0] === 'conversations' && ['memory-correct', 'memory-undo-correction'].includes(parts[2])) {
        if (engine.memoryActive.has(id)) throw new AppError('Memory is updating. Stop updates first.', 409);
        if (parts[2] === 'memory-correct') engine.memory.correct(id, input.collection, input.recordId, vault.redact(requireString(input.text, 'correction', 4000), [token]), input.revision, input.version);
        else engine.memory.undoCorrection(id, input.correction, input.revision, input.version);
        json(res, engine.memory.inspect(id)); return;
      }
      if (path === '/api/voice-presets') { json(res, engine.media.saveVoice({ ...input, name: vault.redact(requireString(input.name, 'voice name', 80), [token]) })); return; }
      if (parts[0] === 'conversations' && parts[2] === 'messages' && parts.length === 5) {
        const messageId = Number(parts[3]), action = parts[4];
        if (action === 'continue') { if (!Number.isSafeInteger(input.revision)) throw new AppError('Expected revision is required.'); json(res, engine.start(id, '', input.revision, messageId, true), 202); return; }
        if (action === 'regenerate') {
          if (!Number.isSafeInteger(input.revision)) throw new AppError('Expected revision is required.');
          json(res, engine.start(id, '', input.revision, messageId), 202); return;
        }
        if (action === 'swipe') { store.swipe(id, messageId, input.variant, input.revision); json(res, { ok: true }); return; }
        if (action === 'select-image') { engine.media.select(store.message(id, messageId), requireString(input.asset, 'image ID', 100), input.useInChat, input.revision); json(res, { ok: true }); return; }
        if (['generate-image', 'narrate'].includes(action)) {
          store.writable(id, input.revision);
          let m = store.message(id, messageId);
          // Existing databases acquire a stable variant before any media is attached.
          if (m.role === 'assistant' && !m.active_variant) { store.ensureVariant(m); m = store.message(id, messageId); }
          const voice = action === 'narrate' ? engine.media.voices().find(v => v.id === input.voicePreset) : undefined;
          if (action === 'narrate' && !voice) throw new AppError('Add or select a saved voice preset first.');
          const selectedProfile = action === 'narrate' ? voice!.connection : input.connection;
          const profile = profiles(store).find(p => p.profileId === selectedProfile);
          if (!profile) throw new AppError('Choose a saved media connection.');
          const connection = validateConnection(profile), key = vault.get(profile.credentialId!);
          const prompt = action === 'generate-image' ? vault.redact(requireString(input.prompt, 'image prompt', 8000), [key, token]) : m.content;
          if (action === 'generate-image' && typeof input.useInChat !== 'boolean') throw new AppError('Choose whether to use the generated image in chat.');
          if (action === 'narrate' && prompt.length > 5000) throw new AppError('Read-aloud supports messages up to 5,000 characters. Shorten the message or use the speech panel for an excerpt.');
          const fingerprint = textHash(JSON.stringify([connection, profile.credentialId, prompt, voice?.voice, voice?.speed]));
          const cached = action === 'narrate' ? engine.media.cached(m, fingerprint) : undefined;
          if (cached) { json(res, { asset: cached, cached: true }); return; }
          engine.media.room(m);
          if (providerRequests.size >= 3) throw new AppError('Provider request limit reached. Wait or use Stop all.', 429);
          const controller = new AbortController(); providerRequests.set(controller, action); mediaReservations.add(id);
          let done!: () => void; const pending = new Promise<void>(r => { done = r; }); pendingMedia.add(pending);
          const abort = () => controller.abort(); res.once('close', abort);
          try {
            const generated = action === 'generate-image' ? await generateImage(connection, key, { ...input, prompt }, controller.signal) : { bytes: await speak(connection, key, { voice: voice!.voice, speed: voice!.speed, text: prompt }, controller.signal), mime: 'audio/mpeg' };
            controller.signal.throwIfAborted();
            const label = action === 'narrate' ? voice!.name : connection.name || connection.model;
            const asset = engine.media.add(m, action === 'narrate' ? 'audio' : 'image', generated.bytes, generated.mime, prompt, label, fingerprint, input.useInChat);
            json(res, { asset, cached: false });
          } finally { res.off('close', abort); providerRequests.delete(controller); mediaReservations.delete(id); done(); pendingMedia.delete(pending); }
          return;
        }
      }
      if (parts[0] === 'conversations' && parts[2] === 'messages' && parts[4] === 'edit' && parts.length === 5) {
        engine.cancelMemory(id);
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
          if (engine.active.size || mediaReservations.size || engine.memoryActive.size) throw new AppError('Stop running jobs before changing connections.', 409);
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
      stopProviderRequests(); await engine.stopAll(); await Promise.allSettled([...pendingMedia]); vault.lock();
      await new Promise<void>(yes => { server.closeAllConnections(); server.close(() => yes()); });
      store.close(); await unlink(join(dir, 'client.json')).catch(() => {}); await unlink(join(lock, 'owner.json')); await rmdir(lock);
      closedResolve();
    })();
    return closing;
  }
  return { origin, token, store, vault, engine, close, closed };
}
