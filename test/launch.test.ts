import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { BrowserLaunch } from '../src/browser-launch.ts';
import { launch, ensureCoordinator, browserCommand } from '../src/launcher.ts';
import { fixture, temp } from './helpers.ts';

const navigation = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const lowerNavigation = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
test('browser launch expires, is single use, and refuses web/subresource requests', () => {
  let now = 100; const gate = new BrowserLaunch(() => now);
  assert.throws(() => gate.consume(lowerNavigation), /expired/);
  gate.arm();
  for (const headers of [{}, { ...lowerNavigation, 'sec-fetch-site': 'cross-site' }, { ...lowerNavigation, 'sec-fetch-mode': 'cors' }, { ...lowerNavigation, 'sec-fetch-dest': 'iframe' }, { ...lowerNavigation, referer: 'https://evil.example/' }]) assert.throws(() => gate.consume(headers), /launcher/);
  gate.consume(lowerNavigation); assert.throws(() => gate.consume(lowerNavigation), /expired/);
  gate.arm(); now += 30000; assert.throws(() => gate.consume(lowerNavigation), /expired/);
});
test('automatic browser sign-in requires an authenticated launcher and keeps secrets off URLs', async t => {
  const { app, request } = await fixture(t);
  assert.equal((await fetch(app.origin + '/launch', { headers: navigation, redirect: 'manual' })).status, 403);
  assert.equal((await fetch(app.origin + '/api/launch', { method: 'POST', headers: { 'X-LoWriter': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const armed = await request('/launch', {}); assert.equal(armed.status, 200);
  assert.equal(armed.data.url, app.origin + '/launch'); assert.ok(!JSON.stringify(armed.data).includes(app.token));
  const bad = await fetch(armed.data.url, { headers: { ...navigation, 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' }); assert.equal(bad.status, 403);
  // node fetch overwrites Sec-Fetch-Mode; use node:http for exact navigation metadata.
  const { request: httpRequest } = await import('node:http');
  const entered = await new Promise<{ status: number; cookie: string; location: string | undefined }>((yes, no) => {
    const req = httpRequest(armed.data.url, { headers: navigation }, res => { res.resume(); yes({ status: res.statusCode!, cookie: res.headers['set-cookie']![0], location: res.headers.location }); }); req.on('error', no); req.end();
  });
  assert.equal(entered.status, 303); assert.equal(entered.location, '/'); assert.match(entered.cookie, /HttpOnly; SameSite=Strict/);
  const cookie = entered.cookie.split(';')[0];
  assert.equal((await fetch(app.origin + '/api/state', { headers: { 'X-LoWriter': '1', Cookie: cookie } })).status, 200);
  const cookieArm = await fetch(app.origin + '/api/launch', { method: 'POST', headers: { 'X-LoWriter': '1', Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(cookieArm.status, 403);
});
test('launcher reuses an existing coordinator, authenticates it and passes only a clean URL to opener', async t => {
  const { app, dir } = await fixture(t); let opened = '';
  const first = await launch({ dataDir: join(dir, 'private'), open: async url => { opened = url; } });
  const second = await launch({ dataDir: join(dir, 'private'), open: async () => {} });
  assert.deepEqual(first, second); assert.equal(first.pid, process.pid); assert.equal(opened, app.origin + '/launch');
  assert.ok(!JSON.stringify(first).includes(app.token));
});
test('normal and demo services use distinct cookies so one cannot sign the other out', async t => {
  const a = await fixture(t), b = await fixture(t);
  const loginA = await a.request('/login', { token: a.app.token }), loginB = await b.request('/login', { token: b.app.token });
  const cookieA = loginA.headers.get('set-cookie')!.split(';')[0], cookieB = loginB.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual(cookieA.split('=')[0], cookieB.split('=')[0]);
  for (const app of [a.app, b.app]) assert.equal((await fetch(app.origin + '/api/state', { headers: { 'X-LoWriter': '1', Cookie: cookieA + '; ' + cookieB } })).status, 200);
});
test('browser opener uses shell-free platform dispatch and rejects remote or credential-bearing URLs', () => {
  const url = 'http://127.0.0.1:4317/launch';
  assert.deepEqual(browserCommand(url, 'win32', false), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'android', false), ['termux-open-url', [url]]);
  assert.deepEqual(browserCommand(url, 'linux', true), ['termux-open-url', [url]]);
  for (const invalid of ['https://evil.example/launch', url + '?token=bad', url + '#bad', 'http://secret@127.0.0.1:4317/launch', 'file:///launch']) assert.throws(() => browserCommand(invalid));
});
test('invalid client metadata cannot redirect launcher authentication to another host', async t => {
  const dir = await temp(t); await writeFile(join(dir, 'client.json'), JSON.stringify({ origin: 'https://evil.example', token: 'a'.repeat(43), pid: 1 }));
  await assert.rejects(ensureCoordinator({ dataDir: dir }), /Invalid local/);
});
test('shutdown is authenticated, stops jobs and removes only its own service state', async t => {
  const { app, request, dir } = await fixture(t);
  assert.equal((await fetch(app.origin + '/api/shutdown', { method: 'POST', headers: { 'X-LoWriter': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const c = (await request('/conversations', { mode: 'rp', title: 'Quit test' })).data;
  await request(`/conversations/${c.id}/send`, { text: '[slow]', revision: 0 });
  assert.equal((await request('/shutdown', {})).status, 200); await app.closed;
  await assert.rejects(readFile(join(dir, 'private/client.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, 'private/coordinator.lock/owner.json')), { code: 'ENOENT' });
});
test('real detached startup, repeat launch and graceful quit require no browser or pairing input', { timeout: 40000 }, async t => {
  const dir = join(await temp(t), 'private');
  const listener = createServer(); await new Promise<void>(yes => listener.listen(0, '127.0.0.1', yes));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(yes => listener.close(() => yes()));
  let client: Awaited<ReturnType<typeof ensureCoordinator>> | undefined;
  t.after(async () => {
    if (!client) return;
    await fetch(client.origin + '/api/shutdown', { method: 'POST', headers: { 'X-LoWriter': '1', Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    for (let i = 0; i < 100; i++) { try { await readFile(join(dir, 'client.json')); } catch { return; } await new Promise(yes => setTimeout(yes, 50)); }
    throw new Error('Owned test service did not shut down.');
  });
  client = await ensureCoordinator({ dataDir: dir, demo: true, port });
  assert.notEqual(client.pid, process.pid);
  const again = await ensureCoordinator({ dataDir: dir, demo: true, port }); assert.equal(again.pid, client.pid);
  const opened = await launch({ dataDir: dir, open: async url => { assert.equal(url, client!.origin + '/launch'); } }); assert.equal(opened.pid, client.pid);
});
