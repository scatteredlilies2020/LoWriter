import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startServer } from '../src/server.ts';
import { startMock } from '../src/mock.ts';
import { Vault } from '../src/vault.ts';
import { temp } from './helpers.ts';

test('normal API saves masked named presets and generates after restart without any unlock', async t => {
  const dataDir = await temp(t), mock = await startMock();
  let app = await startServer({ dataDir, port: 0 }); t.after(async () => { await app.close(); await mock.close(); });
  const req = async (path: string, data?: unknown) => { const r = await fetch(app.origin + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-LoWriter': '1', 'Content-Type': 'application/json', Authorization: `Bearer ${app.token}` }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: r.status, body: await r.json() as any }; };
  const c = { endpoint: mock.endpoint, provider: 'custom', dialect: 'chat-completions', model: 'fixture-one', route: 'auto', name: 'First model', apiKey: 'synthetic-auto-password', keyMode: 'keep' };
  const one = await req('/connection', c); assert.equal(one.status, 200); assert.ok(one.body.hasKey); assert.ok(!JSON.stringify(one.body).includes(c.apiKey));
  const two = await req('/connection', { ...c, apiKey: '', model: 'fixture-two', name: 'Second model' }); assert.equal(two.status, 200); assert.notEqual(one.body.profileId, two.body.profileId); assert.equal(one.body.credentialId, two.body.credentialId);
  await req('/connection', { ...c, apiKey: '', model: 'fixture-updated' });
  let state = (await req('/state')).body; assert.equal(state.connections.length, 2); assert.equal(state.connections[0].model, 'fixture-updated'); assert.equal(state.connections[1].model, 'fixture-two'); assert.ok(!JSON.stringify(state).includes(c.apiKey));
  assert.equal((await req('/vault/lock', {})).status, 409);
  const oldToken = app.token; await app.close(); app = await startServer({ dataDir, port: 0 }); assert.notEqual(app.token, oldToken);
  state = (await req('/state')).body; assert.ok(state.vault.automatic && state.vault.unlocked); assert.ok(!state.vault.migrationRequired); assert.equal(state.connections.length, 2);
  assert.equal(app.vault.get(one.body.credentialId), c.apiKey); assert.ok(!(await readFile(join(dataDir, 'vault.json'), 'utf8')).includes(c.apiKey));
  const conversation = (await req('/conversations', { mode: 'rp', title: 'Automatic credential fixture' })).body;
  const sent = await req(`/conversations/${conversation.id}/send`, { text: 'Hello fixture', revision: 0 }); assert.equal(sent.status, 202);
  for (let n = 0; n < 300 && app.engine.snapshot(sent.body.id).status === 'running'; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(app.engine.snapshot(sent.body.id).status, 'complete');
  await req('/connection', { ...c, apiKey: '', keyMode: 'clear' }); state = (await req('/state')).body; assert.ok(state.connections.every((p: any) => !p.hasKey));
});

test('legacy migration is explicit, protected by API auth, and persists automatically', async t => {
  const dataDir = await temp(t), file = join(dataDir, 'vault.json'), v = new Vault(file);
  await v.unlock('synthetic old vault passphrase'); await v.set('provider', 'synthetic-existing-password'); v.lock();
  const old = await readFile(file, 'utf8'); let app = await startServer({ dataDir, port: 0 }); t.after(() => app.close());
  assert.ok(app.vault.migrationRequired); assert.equal(app.vault.key, null);
  const request = async (passphrase: string, authorized = true) => fetch(app.origin + '/api/vault/migrate', { method: 'POST', headers: { 'X-LoWriter': '1', 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${app.token}` } : {}) }, body: JSON.stringify({ passphrase }) });
  assert.equal((await request('synthetic old vault passphrase', false)).status, 401);
  assert.equal((await request('wrong synthetic passphrase')).status, 403); assert.equal(await readFile(file, 'utf8'), old);
  const result = await request('synthetic old vault passphrase'); assert.equal(result.status, 200); assert.equal(app.vault.get('provider'), 'synthetic-existing-password'); assert.ok(!(await result.text()).includes('synthetic'));
  await app.close(); app = await startServer({ dataDir, port: 0 }); assert.equal(app.vault.get('provider'), 'synthetic-existing-password'); assert.ok(!app.vault.migrationRequired);
});
