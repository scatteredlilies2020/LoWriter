import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { TestContext } from 'node:test';
import { startServer } from '../src/server.ts';
import { startMock } from '../src/mock.ts';

export async function temp(t: TestContext): Promise<string> {
  const root = resolve('.test-data'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'case-'));
  // Synthetic fixtures stay in the ignored test-only root for failure diagnosis.
  return dir;
}
export async function fixture(t: TestContext) {
  const dir = await temp(t), mock = await startMock();
  const app = await startServer({ credentialMode: 'legacy-test', dataDir: join(dir, 'private'), port: 0, demo: { endpoint: mock.endpoint, model: 'test', dialect: 'chat-completions', route: 'direct' } });
  t.after(async () => { await app.close(); await mock.close(); });
  const request = async (path: string, value?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(app.origin + '/api' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'X-LoWriter': '1', Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json', ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: res.status, headers: res.headers, data: await res.json() as any };
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 500; i++) { const job = app.engine.snapshot(id); if (job.status !== 'running') return job; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Job did not finish.');
  };
  return { app, dir, mock, request, wait };
}
