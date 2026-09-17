import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { ensureCoordinator, coordinatorPresent, stopCoordinator, type Client } from '../src/launcher.ts';
import { fixture, temp } from './helpers.ts';

const delay = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  assert.fail(message);
}
async function freePort() {
  const listener = createServer();
  await new Promise<void>(yes => listener.listen(0, '127.0.0.1', yes));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(yes => listener.close(() => yes()));
  return port;
}
async function session(t: TestContext, suppliedDir?: string, suppliedPort?: number) {
  const dir = suppliedDir ?? join(await temp(t), 'private'), port = suppliedPort ?? await freePort();
  const owner = spawn(process.execPath, [resolve('src/launcher.ts'), '--demo', '--no-browser'], {
    cwd: resolve('.'), env: { ...process.env, LOWRITER_DATA_DIR: dir, LOWRITER_PORT: String(port) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  owner.stdout.on('data', data => { output += data.toString(); });
  owner.stderr.on('data', data => { output += data.toString(); });
  const exited = new Promise<number | null>((yes, no) => { owner.once('exit', yes); owner.once('error', no); });
  t.after(async () => {
    let client: Client | undefined;
    try { client = JSON.parse(await readFile(join(dir, 'client.json'), 'utf8')); } catch { /* Not started or already stopped. */ }
    if (client) {
      await stopCoordinator(dir, client);
      await until(async () => !await coordinatorPresent(dir, client!), 'Test service must finish shutdown.');
    }
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    await exited;
  });
  return { owner, exited, dir, port, output: () => output, ready: async () => {
    await until(async () => {
      assert.equal(owner.exitCode, null, 'Launcher exited before readiness: ' + output);
      return output.includes('Keep this window open.');
    }, 'Launcher must report readiness.');
    return JSON.parse(await readFile(join(dir, 'client.json'), 'utf8')) as Client;
  } };
}

test('console stays open; authenticated Quit stops the service and exits its launcher', { timeout: 40000 }, async t => {
  const run = await session(t), client = await run.ready();
  await delay(1100);
  assert.equal(run.owner.exitCode, null);
  assert.equal(await coordinatorPresent(run.dir, client), true);
  assert.ok(!run.output().includes(client.token));
  await stopCoordinator(run.dir, client);
  assert.equal(await run.exited, 0);
  await until(async () => !processAlive(client.pid), 'Quit must end the actual service process.');
  await assert.rejects(readFile(join(run.dir, 'client.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(run.dir, 'coordinator.lock/owner.json')), { code: 'ENOENT' });
});

test('forcibly terminating the console owner closes its service and allows reopening', { timeout: 40000 }, async t => {
  const run = await session(t), client = await run.ready();
  // On Windows this is TerminateProcess, not a catchable JS signal: like the
  // foreground process being forcibly torn down when its console is closed.
  run.owner.kill('SIGKILL'); await run.exited;
  await until(async () => !await coordinatorPresent(run.dir, client), 'Closing console owner must stop service.');
  await until(async () => !processAlive(client.pid), 'Closing console owner must end the actual service process.');
  await assert.rejects(readFile(join(run.dir, 'coordinator.lock/owner.json')), { code: 'ENOENT' });
  const reopened = await session(t, run.dir, run.port), next = await reopened.ready();
  assert.notEqual(next.token, client.token);
  await stopCoordinator(reopened.dir, next);
  assert.equal(await reopened.exited, 0);
});

test('opening an existing background instance gives the new console control of that same instance', { timeout: 40000 }, async t => {
  const dir = join(await temp(t), 'private'), port = await freePort();
  const existing = await ensureCoordinator({ dataDir: dir, port, demo: true });
  t.after(() => stopCoordinator(dir, existing));
  const run = await session(t, dir, port), client = await run.ready();
  assert.equal(client.pid, existing.pid);
  run.owner.kill('SIGKILL'); await run.exited;
  await until(async () => !await coordinatorPresent(dir, existing), 'Reused service must also stop with its console.');
});

test('startup failure is reported promptly instead of silently closing successfully', { timeout: 30000 }, async t => {
  const blocker = createServer();
  await new Promise<void>(yes => blocker.listen(0, '127.0.0.1', yes));
  t.after(() => new Promise<void>(yes => blocker.close(() => yes())));
  const run = await session(t, join(await temp(t), 'private'), (blocker.address() as { port: number }).port);
  assert.equal(await run.exited, 1);
  assert.match(run.output(), /stopped during startup/);
  assert.ok(!run.output().includes('Keep this window open.'));
});

test('an unexpected service exit is reported as an error, not a successful quit', { timeout: 40000 }, async t => {
  const run = await session(t), client = await run.ready();
  process.kill(client.pid, 'SIGKILL');
  assert.equal(await run.exited, 1);
  assert.match(run.output(), /service stopped unexpectedly/);
});

test('an old console cannot shut down replacement instance metadata', async t => {
  const { app, dir } = await fixture(t), privateDir = join(dir, 'private');
  const original = JSON.parse(await readFile(join(privateDir, 'client.json'), 'utf8')) as Client;
  const replaced = { ...original, token: 'z'.repeat(43) };
  await writeFile(join(privateDir, 'client.json'), JSON.stringify(replaced));
  await stopCoordinator(privateDir, original);
  assert.equal((await fetch(app.origin + '/api/state', { headers: { 'X-LoWriter': '1', Authorization: `Bearer ${original.token}` } })).status, 200);
  await writeFile(join(privateDir, 'client.json'), JSON.stringify(original));
});
