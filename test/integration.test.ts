import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { fixture, temp } from './helpers.ts';
import { startServer } from '../src/server.ts';

test('API requires authentication, custom header, correct host and origin', async t => {
  const { app, request } = await fixture(t);
  assert.equal((await fetch(app.origin + '/api/state')).status, 403);
  assert.equal((await fetch(app.origin + '/api/state', { headers: { 'X-LoWriter': '1' } })).status, 401);
  assert.equal((await request('/state', undefined, { Origin: 'https://evil.example' })).status, 403);
  const hostStatus = await new Promise<number>(resolveStatus => {
    const req = httpRequest(app.origin + '/api/state', { headers: { Host: 'evil.example', 'X-LoWriter': '1', Authorization: `Bearer ${app.token}` } }, res => { res.resume(); resolveStatus(res.statusCode!); }); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const good = await request('/state'); assert.equal(good.status, 200); assert.ok(!JSON.stringify(good.data).includes(app.token));
});
test('pairing sets HttpOnly SameSite cookie and rejects CSRF login', async t => {
  const { app, request } = await fixture(t);
  const pair = await request('/login', { token: app.token }); assert.equal(pair.status, 200);
  const cookie = pair.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await request('/login', { token: app.token }, { Origin: 'https://evil.example' })).status, 403);
  const res = await fetch(app.origin + '/api/state', { headers: { 'X-LoWriter': '1', Cookie: cookie.split(';')[0], Origin: app.origin } }); assert.equal(res.status, 200);
});
test('login is rate limited without revealing the local token', async t => {
  const { request } = await fixture(t); for (let i = 0; i < 6; i++) assert.equal((await request('/login', { token: 'bad' })).status, 401); assert.equal((await request('/login', { token: 'bad' })).status, 429);
});
test('streamed mock reply is visible before completion and persisted', async t => {
  const { request, wait, app } = await fixture(t); const c = (await request('/conversations', { mode: 'rp', title: 'Story' })).data;
  const j = (await request(`/conversations/${c.id}/send`, { text: 'Start a story', revision: 0 })).data;
  await new Promise(resolve => setTimeout(resolve, 120)); const live = app.engine.snapshot(j.id); assert.equal(live.status, 'running'); assert.ok(live.text.length > 0);
  assert.equal((await wait(j.id)).status, 'complete'); const detail = (await request(`/conversations/${c.id}`)).data; assert.equal(detail.messages.length, 2); assert.match(detail.messages[1].content, /last train/);
});
test('GUI/API and CLI resume same conversation without opening browser', async t => {
  const { request, wait, app, dir } = await fixture(t); const c = (await request('/conversations', { mode: 'coding', title: 'Shared' })).data;
  const j = (await request(`/conversations/${c.id}/send`, { text: 'Hello from GUI', revision: 0 })).data; await wait(j.id);
  const run = promisify(execFile), env = { ...process.env, LOWRITER_DATA_DIR: join(dir, 'private') };
  const show = await run(process.execPath, ['src/cli.ts', 'show', c.id], { cwd: resolve('.'), env, windowsHide: true }); assert.match(show.stdout, /Hello from GUI/);
  const send = await run(process.execPath, ['src/cli.ts', 'send', c.id, 'Hello from CLI'], { cwd: resolve('.'), env, windowsHide: true }); assert.match(send.stdout, /complete/);
  const detail = (await request(`/conversations/${c.id}`)).data; assert.equal(detail.messages.length, 4); assert.equal(detail.messages[2].content, 'Hello from CLI'); assert.ok(!send.stdout.includes(app.token));
});
test('overlapping GUI and CLI-style sends cannot produce conflicting writes', async t => {
  const { request, wait } = await fixture(t); const c = (await request('/conversations', { mode: 'rp', title: 'Race' })).data;
  const attempts = await Promise.all([request(`/conversations/${c.id}/send`, { text: 'one', revision: 0 }), request(`/conversations/${c.id}/send`, { text: 'two', revision: 0 })]);
  assert.deepEqual(attempts.map(a => a.status).sort(), [202, 409]); await wait(attempts.find(a => a.status === 202)!.data.id); assert.equal((await request(`/conversations/${c.id}`)).data.messages.length, 2);
});
test('cancellation retains partial reply, never commits, and permits explicit follow-up', async t => {
  const { request, wait } = await fixture(t); const c = (await request('/conversations', { mode: 'rp', title: 'Cancel' })).data;
  const j = (await request(`/conversations/${c.id}/send`, { text: '[slow]', revision: 0 })).data; await new Promise(resolve => setTimeout(resolve, 140));
  await request(`/jobs/${j.id}/cancel`, {}); const cancelled = await wait(j.id); assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.text.length > 0);
  const d = (await request(`/conversations/${c.id}`)).data; assert.equal(d.messages.length, 1);
  const next = (await request(`/conversations/${c.id}/send`, { text: 'Try again explicitly', revision: 1 })).data; assert.equal((await wait(next.id)).status, 'complete');
});
for (const marker of ['[malformed]', '[incomplete]', '[http-error]']) test(`provider failure ${marker} never fabricates a reply or leaks error body`, async t => {
  const { request, wait } = await fixture(t); const c = (await request('/conversations', { mode: 'rp', title: marker })).data;
  const j = (await request(`/conversations/${c.id}/send`, { text: marker, revision: 0 })).data; const done = await wait(j.id); assert.equal(done.status, 'failed'); assert.ok(!done.error.includes('Secret error body')); assert.equal((await request(`/conversations/${c.id}`)).data.messages.length, 1);
});
test('end-to-end coding inspects, edits, checks, shows diff and restores', async t => {
  const { request, wait, dir } = await fixture(t), project = join(dir, 'demo project'); await mkdir(project); await writeFile(join(project, 'greeting.js'), 'export const greeting = "Before";\n');
  const c = (await request('/conversations', { mode: 'coding', title: 'Coding' })).data;
  let p = await request(`/conversations/${c.id}/project`, { path: project, trust: false }); assert.equal(p.data.trusted, 0);
  p = await request(`/conversations/${c.id}/project`, { path: project, trust: true }); assert.equal(p.status, 200);
  const j = (await request(`/conversations/${c.id}/send`, { text: 'demo coding', revision: p.data.revision })).data, done = await wait(j.id);
  assert.equal(done.status, 'complete'); assert.deepEqual(done.actions.map((a: any) => a.tool), ['list_files', 'read_text', 'write_text', 'check_javascript']);
  assert.equal(JSON.parse(done.actions[3].output).exitCode, 0); const edit = JSON.parse(done.actions[2].output); assert.match(edit.diff, /Before/); assert.match(await readFile(join(project, 'greeting.js'), 'utf8'), /Hello from LoWriter/);
  assert.equal((await request(`/conversations/${c.id}/restore`, { checkpoint: edit.checkpoint })).status, 200); assert.match(await readFile(join(project, 'greeting.js'), 'utf8'), /Before/);
});
test('RP has no tool authority even when requested by a prompt', async t => {
  const { request, wait, dir } = await fixture(t); const c = (await request('/conversations', { mode: 'rp', title: 'RP' })).data;
  assert.equal((await request(`/conversations/${c.id}/project`, { path: dir, trust: true })).status, 403);
  const j = (await request(`/conversations/${c.id}/send`, { text: 'demo coding', revision: 0 })).data; assert.equal((await wait(j.id)).actions.length, 0);
});
test('stop-all cancels both bounded foreground jobs', async t => {
  const { request, wait } = await fixture(t); const ids = [];
  for (let i = 0; i < 2; i++) { const c = (await request('/conversations', { mode: 'rp', title: 'Stop' })).data; ids.push((await request(`/conversations/${c.id}/send`, { text: '[slow]', revision: 0 })).data.id); }
  const third = (await request('/conversations', { mode: 'rp', title: 'Bound' })).data; assert.equal((await request(`/conversations/${third.id}/send`, { text: '[slow]', revision: 0 })).status, 429);
  await request('/stop', {}); for (const id of ids) assert.equal((await wait(id)).status, 'cancelled');
});
test('vault config never returns key, requires unlock, and private routes fail closed', async t => {
  const { request, app, dir, mock } = await fixture(t);
  const cfg = { endpoint: mock.endpoint, model: 'fixture', dialect: 'chat-completions', route: 'direct', apiKey: 'synthetic-key-12345678' };
  assert.equal((await request('/connection', cfg)).status, 423);
  assert.equal((await request('/vault/unlock', { passphrase: 'synthetic test passphrase' })).status, 200);
  const save = await request('/connection', cfg); assert.equal(save.status, 200); assert.ok(!JSON.stringify(save.data).includes(cfg.apiKey));
  assert.equal((await request('/connection', { ...cfg, route: 'unimplemented' })).status, 400); assert.equal(app.engine.connection()?.route, 'direct');
  assert.ok(!(await readFile(join(dir, 'private', 'vault.json'), 'utf8')).includes(cfg.apiKey));
  await request('/vault/lock', {}); const c = (await request('/conversations', { mode: 'rp', title: 'Locked' })).data; assert.equal((await request(`/conversations/${c.id}/send`, { text: 'no', revision: 0 })).status, 423);
});
test('second coordinator cannot open an already-owned database', async t => { const { dir } = await fixture(t); await assert.rejects(startServer({ dataDir: join(dir, 'private'), port: 0 }), /already owns/); });
test('restart rotates local auth and preserves history, without unlocked credentials', async t => {
  const root = await temp(t); let app = await startServer({ credentialMode: 'legacy-test', dataDir: join(root, 'private'), port: 0 }); const token = app.token;
  const c = app.store.create('rp', 'Retained'); const j = app.store.start(c.id, 'Hello', 0); j.text = 'World'; j.status = 'complete'; app.store.finish(j);
  await app.vault.unlock('synthetic passphrase only'); await app.vault.set('provider', 'synthetic-test-key'); await app.close();
  app = await startServer({ credentialMode: 'legacy-test', dataDir: join(root, 'private'), port: 0 }); assert.notEqual(app.token, token); assert.equal(app.vault.key, null); assert.equal(app.store.messages(c.id).length, 2); await app.close();
});
