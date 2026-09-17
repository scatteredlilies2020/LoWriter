import { startServer } from './server.ts';
import { startMock } from './mock.ts';
import { dataDir } from './paths.ts';
import { fileURLToPath } from 'node:url';

let demo: Awaited<ReturnType<typeof startMock>> | undefined;
try {
  if (process.argv.includes('--demo')) demo = await startMock();
  const port = Number(process.env.LOWRITER_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
  const app = await startServer({ dataDir: dataDir(), port, staticDir: fileURLToPath(new URL('../dist', import.meta.url)), demo: demo ? { endpoint: demo.endpoint, model: 'lowriter-demo', route: 'direct', dialect: 'chat-completions' } : undefined });
  console.log(`LoWriter ${app.engine.connection()?.demo ? 'LOCAL DEMO' : 'service'} ready at ${app.origin}\nUse the LoWriter launcher to open the GUI automatically. The CLI needs no browser.\nCtrl+C or Quit LoWriter closes the service safely.`);
  void app.closed.then(() => demo?.close());
  let stopping = false;
  const close = async () => { if (stopping) return; stopping = true; await app.close(); await demo?.close(); process.exitCode = 0; };
  process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
} catch (e) {
  await demo?.close();
  console.error(e instanceof Error && !e.message.includes('://') ? e.message : 'LoWriter startup failed.'); process.exitCode = 1;
}
