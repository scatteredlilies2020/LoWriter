import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';
import { temp } from './helpers.ts';

test('device credentials reopen automatically without plaintext keys or a passphrase', async t => {
  const file = join(await temp(t), 'vault.json'), v = new Vault(file);
  await v.initializeAutomatic(); assert.ok(v.key); await v.set('provider', 'synthetic-device-secret');
  const raw = await readFile(file, 'utf8'); assert.ok(!raw.includes('synthetic-device-secret')); assert.ok(!raw.includes(v.key!.toString('base64'))); assert.equal(JSON.parse(raw).version, 2);
  v.lock(); const reopened = new Vault(file); await reopened.initializeAutomatic(); assert.equal(reopened.get('provider'), 'synthetic-device-secret'); reopened.lock();
  const data = JSON.parse(raw), bytes = Buffer.from(data.data, 'base64'); bytes[0] ^= 1; data.data = bytes.toString('base64'); await writeFile(file, JSON.stringify(data));
  const bad = new Vault(file); await assert.rejects(bad.initializeAutomatic(), /could not/); assert.equal(bad.key, null); assert.equal(await readFile(file, 'utf8'), JSON.stringify(data));
});
test('legacy vault migrates once without losing keys; wrong password leaves the old file intact', async t => {
  const file = join(await temp(t), 'vault.json'), old = new Vault(file); await old.unlock('synthetic legacy passphrase'); await old.set('provider', 'synthetic-preserved-key'); old.lock();
  const raw = await readFile(file, 'utf8'), v = new Vault(file); await v.initializeAutomatic(); assert.ok(v.migrationRequired); assert.equal(v.key, null);
  await assert.rejects(v.migrate('incorrect synthetic passphrase'), /could not/); assert.equal(await readFile(file, 'utf8'), raw);
  await v.migrate('synthetic legacy passphrase'); assert.equal(v.migrationRequired, false); assert.equal(v.get('provider'), 'synthetic-preserved-key'); v.lock();
  const next = new Vault(file); await next.initializeAutomatic(); assert.equal(next.get('provider'), 'synthetic-preserved-key'); assert.ok(!next.migrationRequired); next.lock();
});
test('failed automatic persistence fails closed', async t => {
  const v = new Vault(join(await temp(t), 'vault.json')); v.persist = async () => { throw new Error('Synthetic persistence failure'); };
  await assert.rejects(v.initializeAutomatic(), /could not/); assert.equal(v.key, null); assert.deepEqual(v.values, {});
});

test('SQLite transactional lifecycle persists across close/reopen', async t => {
  const dir = await temp(t), path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const c = store.create('rp', 'Story');
  const j = store.start(c.id, 'Hello', 0); j.text = 'World'; j.status = 'complete'; store.finish(j);
  assert.equal(store.conversation(c.id).revision, 2); store.close(); store = new Store(path);
  assert.deepEqual(store.messages(c.id).map(m => m.content), ['Hello', 'World']); store.close();
});
test('concurrent and stale sends cannot append duplicate history', async t => {
  const store = new Store(join(await temp(t), 'test.sqlite')); t.after(() => store.close());
  const c = store.create('coding', 'Task'); store.start(c.id, 'First', 0);
  assert.throws(() => store.start(c.id, 'Duplicate', 0), /changed/);
  assert.throws(() => store.start(c.id, 'Concurrent', 1), /running/);
  assert.equal(store.messages(c.id).length, 1);
});
test('restart preserves partial candidate as interrupted and never commits it', async t => {
  const file = join(await temp(t), 'test.sqlite'); let store = new Store(file);
  const c = store.create('rp', 'Story'), j = store.start(c.id, 'Hello', 0); j.text = 'Partial'; store.saveJob(j); store.close();
  store = new Store(file); assert.equal(store.job(j.id).status, 'interrupted'); assert.equal(store.job(j.id).text, 'Partial'); assert.equal(store.messages(c.id).length, 1); store.close();
});
test('stale finish rejected with no assistant append', async t => {
  const store = new Store(join(await temp(t), 'test.sqlite')); t.after(() => store.close());
  const c = store.create('rp', 'Story'), j = store.start(c.id, 'Hello', 0); j.revision = 0; j.status = 'complete';
  assert.throws(() => store.finish(j), /Stale/); assert.equal(store.messages(c.id).length, 1);
});
test('history stays paged at 40/80 even with 10,000 records', async t => {
  const store = new Store(join(await temp(t), 'test.sqlite')); t.after(() => store.close()); const c = store.create('rp', 'Scale');
  store.transaction(() => { const insert = store.db.prepare('INSERT INTO messages(conversation,role,content,revision) VALUES(?,?,?,?)'); for (let n = 0; n < 10000; n++) insert.run(c.id, 'user', `Message ${n}`, n); });
  const page = store.messages(c.id); assert.equal(page.length, 40); assert.equal(page.at(-1)?.content, 'Message 9999');
  assert.equal(store.messages(c.id, page[0].id).at(-1)?.content, 'Message 9959'); assert.equal(store.messages(c.id, Number.MAX_SAFE_INTEGER, 10000).length, 80);
});
test('RP cannot inherit project authority', async t => {
  const store = new Store(join(await temp(t), 'test.sqlite')); t.after(() => store.close()); const c = store.create('rp', 'RP'); assert.throws(() => store.project(c.id, '/tmp', true), /RP/);
});
test('vault encrypts at rest, locks, rejects wrong passphrase and reopens', async t => {
  const file = join(await temp(t), 'vault.json'), vault = new Vault(file), secret = 'synthetic-test-secret-123456';
  await vault.unlock('a synthetic long passphrase'); await vault.set('provider', secret);
  const raw = await readFile(file, 'utf8'); assert.ok(!raw.includes(secret)); assert.ok(!raw.includes('a synthetic long passphrase'));
  vault.lock(); assert.throws(() => vault.get('provider'), /Unlock/);
  await assert.rejects(vault.unlock('incorrect long passphrase'), /could not/); assert.equal(vault.key, null);
  await vault.unlock('a synthetic long passphrase'); assert.equal(vault.get('provider'), secret); vault.lock();
});
test('vault tampering fails authentication', async t => {
  const file = join(await temp(t), 'vault.json'), vault = new Vault(file); await vault.unlock('synthetic test passphrase'); await vault.set('provider', 'test-key-123456'); vault.lock();
  const data = JSON.parse(await readFile(file, 'utf8')); const bytes = Buffer.from(data.data, 'base64'); bytes[0] ^= 1; data.data = bytes.toString('base64'); await writeFile(file, JSON.stringify(data));
  await assert.rejects(vault.unlock('synthetic test passphrase'), /could not/); assert.equal(vault.key, null);
});
test('vault redacts exact values and common credential patterns', async t => {
  const vault = new Vault(join(await temp(t), 'vault.json')); await vault.unlock('synthetic passphrase only'); await vault.set('provider', 'demo-secret-abcdefgh');
  const cleaned = vault.redact('demo-secret-abcdefgh Bearer abcdefg sk-test12345678'); assert.ok(!cleaned.includes('abcdefgh')); assert.ok(!cleaned.includes('abcdefg')); assert.ok(!cleaned.includes('sk-test')); vault.lock();
});
test('vault refuses short passphrases and locked writes', async t => {
  const vault = new Vault(join(await temp(t), 'vault.json')); await assert.rejects(vault.unlock('short'), /12/); await assert.rejects(vault.set('provider', 'key'), /Unlock/);
});
test('failed initial vault persistence leaves no usable in-memory key', async t => {
  const vault = new Vault(join(await temp(t), 'vault.json'));
  vault.persist = async () => { throw new Error('Synthetic disk failure'); };
  await assert.rejects(vault.unlock('synthetic passphrase only'), /could not/);
  assert.equal(vault.key, null); assert.deepEqual(vault.values, {});
  assert.throws(() => vault.get('provider'), /Unlock/);
});
