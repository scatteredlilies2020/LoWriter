import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { startServer } from '../src/server.ts';
import { temp } from './helpers.ts';

test('actual process death: stale lock recovery, interrupted stream and no automatic replay', async t => {
  const dir = join(await temp(t), 'private');
  const child = spawn(process.execPath, ['test/crash-worker.ts'], { env: { ...process.env, LOWRITER_DATA_DIR: dir }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Crash worker exited before ready.'); }), new Promise<never>((_, no) => { const timer = setTimeout(() => no(new Error('Crash worker timeout.')), 10000); timer.unref(); })]);
  const ids = message[0] as { conversation: string; job: string };
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const app = await startServer({ dataDir: dir, port: 0 }); t.after(() => app.close());
  assert.equal(app.store.job(ids.job).status, 'interrupted'); assert.ok(app.store.job(ids.job).text.length > 0); assert.equal(app.store.messages(ids.conversation).length, 1); assert.equal(app.engine.active.size, 0); assert.equal(app.engine.connection(), null);
});
