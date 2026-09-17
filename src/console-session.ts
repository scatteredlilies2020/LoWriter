import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Client, LaunchOptions } from './launcher.ts';

const delay = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));

// The foreground process owns an IPC pipe. This small, console-independent
// supervisor survives Windows closing the whole console and sees pipe EOF even
// when Windows forcibly terminates Node without delivering a JavaScript signal.
// No credentials go through process arguments, environment additions, or IPC.
export async function consoleSession(options: LaunchOptions, noBrowser = false): Promise<void> {
  console.log('Starting LoWriter…');
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), ...(options.demo ? ['--demo'] : []), ...(noBrowser ? ['--no-browser'] : [])], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, LOWRITER_DATA_DIR: options.dataDir, ...(options.port !== undefined ? { LOWRITER_PORT: String(options.port) } : {}) },
    detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  worker.stdout!.on('data', chunk => process.stdout.write(chunk));
  worker.stderr!.on('data', chunk => process.stderr.write(chunk));
  const stop = () => { if (worker.connected) worker.disconnect(); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;
  for (const signal of signals) process.on(signal, stop);
  try {
    await new Promise<void>((yes, no) => {
      worker.once('error', () => no(new Error('Could not start the LoWriter console session.')));
      worker.once('exit', code => code === 0 ? yes() : no(new Error('LoWriter closed unexpectedly. See the message above.')));
    });
  } finally {
    for (const signal of signals) process.off(signal, stop);
    stop();
  }
}

async function supervise(): Promise<void> {
  if (!process.send) throw new Error('Open LoWriter using its launcher.');
  let disconnected = !process.connected;
  process.on('disconnect', () => { disconnected = true; });
  const { ensureCoordinator, openCoordinator, coordinatorPresent, coordinatorState, stopCoordinator } = await import('./launcher.ts');
  // The console may vanish while startup is still in progress. Complete startup
  // before shutting down so that it cannot leave a late-starting orphan behind.
  const options = { dataDir: process.env.LOWRITER_DATA_DIR!, demo: process.argv.includes('--demo') };
  let client: Client | undefined;
  try {
    client = await ensureCoordinator(options);
    if (!disconnected) {
      if (!process.argv.includes('--no-browser')) {
        try { await openCoordinator(client); }
        catch (e) { console.error(e instanceof Error ? e.message : 'Could not open the browser.'); }
      }
      console.log(`LoWriter is running at ${client.origin}.\nKeep this window open. Close it or press Ctrl+C to quit LoWriter.\nQuit LoWriter in the app also stops this window. Closing only the browser tab does not stop LoWriter.`);
    }
    while (!disconnected && await coordinatorPresent(options.dataDir, client)) await delay(300);
    if (!disconnected && await coordinatorState(options.dataDir, client) === 'crashed') {
      throw new Error('The LoWriter service stopped unexpectedly. Open LoWriter again to restart it.');
    }
  } finally {
    if (client) {
      await stopCoordinator(options.dataDir, client);
      // Let the service finish cancelling jobs and flushing storage before the
      // console exits. Use metadata/process identity, not flaky health timeouts.
      while (await coordinatorPresent(options.dataDir, client)) await delay(100);
    }
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // stdout can disappear with the console; that must not interrupt cleanup.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  try { await supervise(); }
  catch (e) {
    console.error(e instanceof Error ? e.message : 'LoWriter session failed.');
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  }
}
