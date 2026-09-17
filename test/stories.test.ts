import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Continuity, validateExtraction } from '../src/continuity.ts';
import { Chats, parseChat } from '../src/chats.ts';
import { saveConnection } from '../src/connections.ts';
import { fixture, temp } from './helpers.ts';
import { extraction, memoryProvider } from './fixtures/memory-provider.ts';

export const nativeChat = (count = 2) => JSON.stringify({ format: 'lowriter.chat', version: 1, title: 'Mara at the harbor', mode: 'rp', messages: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'Mara keeps a blue lantern at the harbor and watches the water.', speaker: i % 2 ? 'Narrator' : 'Mara' })) });
const settled = async (app: any, id: string) => { for (let n = 0; n < 500; n++) { if (!app.engine.memoryActive.has(id)) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Memory did not finish.'); };
async function setup(t: any, count = 3) {
  const f = await fixture(t), provider = await memoryProvider(); t.after(provider.close);
  await f.app.vault.unlock('test-story-passphrase');
  const saved = await f.request('/connection', { endpoint: provider.endpoint, model: 'fixture', dialect: 'chat-completions', route: 'direct', provider: 'custom', auth: 'none', key: '' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const imported = await f.request('/chats/import', { text: nativeChat(count), includeMemory: false }); assert.equal(imported.status, 201);
  return { ...f, provider, c: imported.data.conversation };
}

test('native and ST imports preserve speakers, active text and swipes without importing settings/trust', async t => {
  const store = new Store(join(await temp(t), 'chats.sqlite')), memory = new Continuity(store), chats = new Chats(store, memory); t.after(() => store.close());
  const text = [{ character_name: 'Mara', chat_metadata: { api_key: 'not-imported', project: 'C:/sensitive', trusted: true } }, { mes: 'Hello', name: 'Player', is_user: true }, { mes: '**Current edit**', name: 'Mara', is_user: false, swipes: ['Old', 'Second'], swipe_id: 1, extra: { image: 'https://example.invalid/private.png' } }].map(v => JSON.stringify(v)).join('\n');
  const result = chats.import(text, false), all = store.messages(result.conversation.id);
  assert.equal(all[1].speaker, 'Mara'); assert.equal(all[1].content, '**Current edit**'); assert.equal(all[1].variants?.length, 2);
  assert.equal(result.conversation.trusted, 0); assert.equal(result.conversation.project, null);
  const exported = chats.export(result.conversation.id, true);
  assert.equal(exported.messages[1].selected, 1); assert.deepEqual(exported.messages[1].variants, ['Old', '**Current edit**']);
  assert.ok(!JSON.stringify(exported).includes('not-imported')); assert.ok(!JSON.stringify(exported).includes('private.png'));
  const copy = chats.import(JSON.stringify(exported), true); assert.notEqual(copy.conversation.id, result.conversation.id);
  assert.equal(store.messages(copy.conversation.id)[1].speaker, 'Mara'); assert.equal(memory.status(copy.conversation.id).enabled, false);
  store.swipe(copy.conversation.id, store.messages(copy.conversation.id)[1].id, store.messages(copy.conversation.id)[1].variants![0].id, 0);
  assert.equal(store.messages(copy.conversation.id)[1].content, 'Old');
});

test('chat import is bounded, atomic, validates roles and rejects unsafe structures', async t => {
  const store = new Store(join(await temp(t), 'bad.sqlite')), chats = new Chats(store, new Continuity(store)); t.after(() => store.close());
  assert.throws(() => chats.import('bad', false), /Expected/);
  assert.throws(() => chats.import(nativeChat(), 'yes'), /Choose/);
  const unsafe = JSON.parse(nativeChat()); unsafe.messages[1].role = 'system'; assert.throws(() => chats.import(JSON.stringify(unsafe), false), /Only user/);
  assert.equal(store.conversations().length, 0);
  unsafe.messages[1].role = 'assistant'; unsafe.messages[0].content = 'a'.repeat(64001); assert.throws(() => chats.import(JSON.stringify(unsafe), false), /too long/);
  assert.throws(() => parseChat('{"format":"lowriter.chat","version":1,"__proto__":{}}'), /Unsafe/);
  assert.throws(() => parseChat('a'.repeat(8000001)), /8 MB/);
});

test('library searches all chats beyond the sidebar limit and renames with revision checks', async t => {
  const { app, request } = await fixture(t);
  for (let i = 0; i < 115; i++) app.store.create('rp', `Library ${i}`);
  assert.equal(app.store.conversations().length, 100);
  const first = await request('/chats'); assert.equal(first.data.conversations.length, 50); assert.equal(first.data.more, true);
  const last = await request('/chats?offset=100'); assert.equal(last.data.conversations.length, 15); assert.equal(last.data.more, false);
  const found = await request('/chats?query=Library%20114'); assert.equal(found.data.conversations.length, 1);
  const c = found.data.conversations[0]; assert.equal((await request(`/conversations/${c.id}/rename`, { title: 'Renamed story', revision: 0 })).status, 200);
  assert.equal((await request(`/conversations/${c.id}/rename`, { title: 'Old revision', revision: 0 })).status, 409);
  assert.equal((await request('/chats?offset=-1')).status, 400);
});

test('story memory is off by default, isolated, and cannot be enabled for coding', async t => {
  const { app, request, c, provider } = await setup(t);
  assert.equal((await request(`/conversations/${c.id}`)).data.memory.enabled, false); assert.equal(provider.calls.length, 0);
  assert.equal(app.engine.memory.context(c.id, app.store.messages(c.id)), null);
  const coding = app.store.create('coding', 'Tools');
  assert.equal((await request(`/conversations/${coding.id}/memory-toggle`, { enabled: true, revision: 0 })).status, 400);
  assert.equal((await request(`/conversations/${coding.id}`)).data.memory, null);
  assert.equal((await request(`/conversations/${coding.id}/memory`)).status, 400);
  const other = app.store.create('rp', 'Other'); assert.equal(app.engine.memory.status(other.id).hasMemory, false);
});

test('automatic memory uses the chosen text connection, validates and merges the real core, recalls and round-trips', async t => {
  const { app, request, c, provider } = await setup(t, 6);
  assert.equal((await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 })).status, 200);
  await settled(app, c.id);
  const status = app.engine.memoryStatus(c.id); assert.equal(status.error, '', JSON.stringify(status));
  assert.equal(status.hasMemory, true); assert.equal(status.processed, 5); assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].tools, undefined); assert.equal(provider.calls[0].model, 'fixture');
  const world = app.engine.memory.inspect(c.id).world; assert.ok(world.capsules.length); assert.ok(world.chronicle.length); assert.ok(world.facts.length);
  const context = app.engine.memory.context(c.id, app.store.messages(c.id).slice(-1)); assert.match(context!.content!, /blue lantern/); assert.equal(context!.role, 'user');
  const before = app.store.messages(c.id)[2].id; assert.equal(app.engine.memory.context(c.id, app.store.messages(c.id).slice(0, 2), before), null);
  const exported = await request(`/conversations/${c.id}/export?memory=1`); assert.ok(exported.data.continuityMemory);
  const roundtrip = await request('/chats/import', { text: JSON.stringify(exported.data), includeMemory: true });
  assert.equal(roundtrip.data.importedMemory, true, JSON.stringify(roundtrip.data.warnings));
  assert.equal(app.engine.memory.status(roundtrip.data.conversation.id).enabled, false);
  assert.equal(app.engine.memory.status(roundtrip.data.conversation.id).stale, false);
  assert.ok(app.engine.memory.inspect(roundtrip.data.conversation.id).world.chronicle.every((v: any) => v.chatKey === roundtrip.data.conversation.id));
  app.engine.memory.toggle(roundtrip.data.conversation.id, true, 0);
  const secondCopy = await request('/chats/import', { text: JSON.stringify((await request(`/conversations/${roundtrip.data.conversation.id}/export?memory=1`)).data), includeMemory: true });
  assert.equal(secondCopy.data.importedMemory, true, JSON.stringify(secondCopy.data.warnings));
  const off = await request(`/conversations/${c.id}/memory-toggle`, { enabled: false, revision: app.store.conversation(c.id).revision }); assert.equal(off.status, 200);
  assert.equal(app.engine.memory.context(c.id, []), null); assert.equal(app.engine.memory.status(c.id).hasMemory, true);
  assert.equal((await request(`/conversations/${c.id}/export?memory=1`)).data.continuityMemory, undefined);
});

test('manual corrections preserve source records, are revision checked, off gated and undoable', async t => {
  const { app, request, c } = await setup(t, 6), path = `/conversations/${c.id}`;
  await request(path + '/memory-toggle', { enabled: true, revision: 0 }); await settled(app, c.id);
  const inspected = app.engine.memory.inspect(c.id), record = inspected.world.facts[0], original = JSON.stringify(inspected.world);
  const input = { collection: 'facts', recordId: record.id, text: 'Manual correction: the lantern is green.', revision: app.store.conversation(c.id).revision, version: inspected.version };
  const corrected = await request(path + '/memory-correct', input); assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal(JSON.stringify(app.engine.memory.inspect(c.id).world), original);
  assert.match(app.engine.memory.context(c.id, app.store.messages(c.id).slice(-1))!.content!, /lantern is green/);
  assert.equal((await request(path + '/memory-correct', input)).status, 409);
  const next = app.engine.memory.inspect(c.id), override = next.overrides[0]; assert.equal(override.matches, true);
  assert.equal((await request(path + '/memory-undo-correction', { correction: override.id, revision: input.revision, version: next.version })).status, 200);
  assert.ok(!app.engine.memory.context(c.id, [])!.content!.includes('lantern is green'));
  assert.equal(JSON.stringify(app.engine.memory.inspect(c.id).world), original);
  assert.equal((await request(path + '/memory-correct', { ...input, version: app.engine.memory.inspect(c.id).version })).status, 200);
  await request(path + '/memory-toggle', { enabled: false, revision: app.store.conversation(c.id).revision });
  assert.equal(app.engine.memory.context(c.id, []), null);
});

test('changed source invalidates memory; mismatched snapshots leave imported chat intact and memory off', async t => {
  const { app, request, c } = await setup(t, 4);
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 }); await settled(app, c.id);
  const exported = (await request(`/conversations/${c.id}/export?memory=1`)).data;
  assert.ok(exported.continuityMemory);
  exported.messages[0].content = 'Mara never owned a lantern.';
  const imported = await request('/chats/import', { text: JSON.stringify(exported), includeMemory: true });
  assert.equal(imported.status, 201); assert.equal(imported.data.importedMemory, false); assert.ok(imported.data.warnings.some((v: string) => /fingerprints/.test(v)));
  assert.equal(app.store.messages(imported.data.conversation.id).length, 4);
  app.store.editMessage(c.id, app.store.messages(c.id)[0].id, 'Changed source', app.store.conversation(c.id).revision);
  assert.equal(app.engine.memory.status(c.id).stale, true); assert.equal(app.engine.memory.context(c.id, []), null);
  assert.equal((await request(`/conversations/${c.id}/export?memory=1`)).status, 400);
});

test('switching off cancels in-flight memory and next story reply does not update it', async t => {
  const { app, request, c, provider, wait } = await setup(t);
  provider.control.slow = true;
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 });
  for (let n = 0; n < 100 && !provider.calls.length; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(app.engine.memoryActive.has(c.id), true);
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: false, revision: app.store.conversation(c.id).revision }); await settled(app, c.id);
  assert.equal(app.engine.memory.status(c.id).hasMemory, false);
  const job = app.engine.start(c.id, 'Continue.', app.store.conversation(c.id).revision); assert.equal((await wait(job.id)).status, 'complete');
  assert.equal(provider.calls.length, 2); assert.equal(app.engine.memoryActive.size, 0);
});

test('bad extraction cannot overwrite memory or stall chat; no automatic retry', async t => {
  const { app, request, c, provider, wait } = await setup(t);
  provider.control.invalid = true;
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 }); await settled(app, c.id);
  assert.match(app.engine.memoryStatus(c.id).error, /invalid JSON/); assert.equal(provider.calls.length, 1);
  assert.equal(app.engine.memory.status(c.id).hasMemory, false);
  const job = app.engine.start(c.id, 'Continue.', app.store.conversation(c.id).revision); assert.equal((await wait(job.id)).status, 'complete'); await settled(app, c.id);
  assert.equal(provider.calls.length, 3);
  assert.throws(() => validateExtraction({ scene: {} }), /Missing/);
  assert.doesNotThrow(() => validateExtraction(extraction()));
});

test('memory automatic catch-up is bounded and successful replies continue it', async t => {
  const { app, request, c, provider, wait } = await setup(t, 30);
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 }); await settled(app, c.id);
  assert.equal(app.engine.memoryStatus(c.id).error, ''); assert.equal(provider.calls.length, 3); assert.equal(app.engine.memory.status(c.id).processed, 24);
  const job = app.engine.start(c.id, 'Mara watches the water.', app.store.conversation(c.id).revision); assert.equal((await wait(job.id)).status, 'complete'); await settled(app, c.id);
  assert.equal(app.engine.memoryStatus(c.id).error, ''); assert.equal(app.engine.memory.status(c.id).pendingMessages, 0);
  assert.equal(provider.calls.length, 5);
});

test('memory review IDs, transcript guards, saved state and off preference survive database reopen', async t => {
  const path = join(await temp(t), 'persistent.sqlite'), provider = await memoryProvider(); t.after(provider.close);
  let store = new Store(path); t.after(() => store.close());
  let memory = new Continuity(store);
  const { conversation: c } = new Chats(store, memory).import(nativeChat(4), false);
  memory.toggle(c.id, true, 0);
  const connection = { endpoint: provider.endpoint, model: 'fixture', dialect: 'chat-completions' as const, route: 'direct' as const, auth: 'none' as const };
  store.setSetting('connections', [{ ...connection, profileId: 'persistent-memory-ai' }]);
  memory.selectProfile(c.id, 'persistent-memory-ai', 0);
  await memory.build(c.id, 0, connection, '', new AbortController().signal, v => v);
  const review = memory.inspect(c.id).review;
  assert.throws(() => memory.review(c.id, 0, true, review.result, 'wrong-review-id'), /review has changed/);
  assert.throws(() => memory.review(c.id, 0, false, undefined, 'wrong-review-id'), /review has changed/);
  store.close(); store = new Store(path); memory = new Continuity(store);
  assert.equal(memory.inspect(c.id).review.id, review.id);
  assert.equal(memory.status(c.id).enabled, true);
  assert.equal(memory.status(c.id).profile, 'persistent-memory-ai');
  memory.review(c.id, 0, true, review.result, review.id);
  memory.toggle(c.id, false, 0);
  store.close(); store = new Store(path); memory = new Continuity(store);
  assert.equal(memory.status(c.id).enabled, false); assert.equal(memory.status(c.id).hasMemory, true);
  assert.equal(memory.status(c.id).stale, false); assert.equal(memory.context(c.id, []), null);
  assert.equal(memory.status(c.id).profile, 'persistent-memory-ai');
  memory.toggle(c.id, true, 0);
  store.editMessage(c.id, store.messages(c.id)[0].id, 'Mara now carries a green lantern.', 0);
  await memory.build(c.id, 1, connection, '', new AbortController().signal, v => v);
  const pending = memory.inspect(c.id).review;
  store.editMessage(c.id, store.messages(c.id)[0].id, 'Mara carries no lantern.', 1);
  assert.throws(() => memory.review(c.id, 2, true, pending.result, pending.id), /Chat changed since extraction/);
  assert.equal(memory.status(c.id).stale, true);
});

test('actual reply requests recall older story memory only when enabled, never in another story', async t => {
  const { app, request, c, provider, wait } = await setup(t, 48);
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 }); await settled(app, c.id);
  const start = provider.calls.length;
  let job = app.engine.start(c.id, 'What does Mara carry?', app.store.conversation(c.id).revision);
  assert.equal((await wait(job.id)).status, 'complete'); await settled(app, c.id);
  assert.ok(provider.calls[start].messages.some((m: any) => m.role === 'user' && /BEGIN OPTIONAL CONTINUITY REFERENCE[\s\S]*blue lantern/.test(m.content)));
  const other = app.store.create('rp', 'A different story'), otherStart = provider.calls.length;
  job = app.engine.start(other.id, 'An unrelated forest.', 0); assert.equal((await wait(job.id)).status, 'complete');
  assert.ok(!JSON.stringify(provider.calls[otherStart]).includes('blue lantern'));
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: false, revision: app.store.conversation(c.id).revision });
  const offStart = provider.calls.length;
  job = app.engine.start(c.id, 'Continue.', app.store.conversation(c.id).revision); assert.equal((await wait(job.id)).status, 'complete');
  assert.ok(!JSON.stringify(provider.calls[offStart]).includes('BEGIN OPTIONAL CONTINUITY REFERENCE'));
  assert.equal(provider.calls.length, offStart + 1);
});

test('turning memory off during a reply preserves that reply and prevents its background update', async t => {
  const { app, request, c, provider, wait } = await setup(t);
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 }); await settled(app, c.id);
  provider.control.replyDelay = 250;
  const start = provider.calls.length, job = app.engine.start(c.id, 'Continue.', app.store.conversation(c.id).revision);
  assert.equal(app.engine.snapshot(job.id).status, 'running');
  const revision = app.store.conversation(c.id).revision;
  assert.equal((await request(`/conversations/${c.id}/memory-toggle`, { enabled: false, revision })).status, 200);
  assert.equal(app.store.conversation(c.id).revision, revision);
  assert.equal((await wait(job.id)).status, 'complete'); await settled(app, c.id);
  assert.equal(provider.calls.length, start + 1); assert.equal(app.engine.memory.status(c.id).enabled, false);
});

test('portable import strips host metadata and rejects foreign provenance while keeping chat text', async t => {
  const { app, request, c } = await setup(t, 4);
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 }); await settled(app, c.id);
  const exported = (await request(`/conversations/${c.id}/export?memory=1`)).data;
  const source = exported.continuityMemory.world.sources[c.id];
  source.settings = { secret: 'host-only-marker' }; exported.continuityMemory.world.continuation = { trusted: true };
  const imported = await request('/chats/import', { text: JSON.stringify(exported), includeMemory: true });
  assert.equal(imported.data.importedMemory, true);
  const world = app.engine.memory.inspect(imported.data.conversation.id).world;
  assert.equal(world.continuation, undefined); assert.ok(!JSON.stringify(world).includes('host-only-marker'));
  exported.continuityMemory.world.facts[0].source = { chatKey: 'foreign-chat', from: 0, to: 0 };
  const bad = await request('/chats/import', { text: JSON.stringify(exported), includeMemory: true });
  assert.equal(bad.status, 201); assert.equal(bad.data.importedMemory, false);
  assert.equal(app.store.allMessages(bad.data.conversation.id).length, 4);
});

test('story memory AI is independently selected with its own model and scoped key, resets and never silently falls back', async t => {
  const { app, request, c, provider, wait } = await setup(t, 4), alternate = await memoryProvider(); t.after(alternate.close);
  const chatAI = app.engine.connection()!;
  const memoryAI = await saveConnection(app.store, app.vault, { endpoint: alternate.endpoint, model: 'memory-model', name: 'Memory specialist', provider: 'custom', dialect: 'chat-completions', route: 'direct', auth: 'bearer', apiKey: 'synthetic-memory-key-only', keyMode: 'replace' });
  app.store.setSetting('connection', chatAI);
  assert.equal((await request(`/conversations/${c.id}/memory-profile`, { profile: memoryAI.profileId, revision: 0 })).status, 200);
  assert.equal(alternate.calls.length, 0); assert.equal(provider.calls.length, 0);
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 }); await settled(app, c.id);
  assert.equal(alternate.calls.length, 1); assert.equal(provider.calls.length, 0);
  assert.equal(alternate.calls[0].model, 'memory-model'); assert.equal(alternate.authorizations[0], 'Bearer synthetic-memory-key-only');
  assert.equal(app.engine.connection()!.profileId, chatAI.profileId);
  const other = app.store.create('rp', 'Independent'); assert.equal(app.engine.memory.status(other.id).profile, '');
  const exported = (await request(`/conversations/${c.id}/export?memory=1`)).data;
  assert.ok(!JSON.stringify(exported).includes(memoryAI.profileId!)); assert.ok(!JSON.stringify(exported).includes('synthetic-memory-key-only'));
  const copy = await request('/chats/import', { text: JSON.stringify(exported), includeMemory: true });
  assert.equal(app.engine.memory.status(copy.data.conversation.id).profile, '');
  let job = app.engine.start(c.id, 'Continue.', app.store.conversation(c.id).revision); assert.equal((await wait(job.id)).status, 'complete'); await settled(app, c.id);
  assert.equal(provider.calls.length, 1); assert.equal(provider.authorizations[0], undefined); assert.equal(alternate.calls.length, 2);
  await request(`/conversations/${c.id}/memory-profile`, { profile: '', revision: app.store.conversation(c.id).revision });
  job = app.engine.start(c.id, 'Continue.', app.store.conversation(c.id).revision); assert.equal((await wait(job.id)).status, 'complete'); await settled(app, c.id);
  assert.equal(provider.calls.length, 3); assert.equal(alternate.calls.length, 2);
  await request(`/conversations/${c.id}/memory-profile`, { profile: memoryAI.profileId, revision: app.store.conversation(c.id).revision });
  app.store.setSetting('connections', [chatAI]);
  job = app.engine.start(c.id, 'Continue.', app.store.conversation(c.id).revision); assert.equal((await wait(job.id)).status, 'complete'); await settled(app, c.id);
  assert.match(app.engine.memoryStatus(c.id).error, /unavailable.*no fallback/);
  assert.equal(provider.calls.length, 4); assert.equal(alternate.calls.length, 2);
});

test('memory AI switching aborts the old extraction and rejects media, stale, unknown and coding selections', async t => {
  const { app, request, c, provider } = await setup(t), alternate = await memoryProvider(); t.after(alternate.close);
  const chatAI = app.engine.connection()!;
  const memoryAI = await saveConnection(app.store, app.vault, { endpoint: alternate.endpoint, model: 'other-model', provider: 'custom', dialect: 'chat-completions', route: 'direct', auth: 'none', keyMode: 'clear' });
  app.store.setSetting('connection', chatAI);
  app.store.setSetting('connections', [...app.store.setting('connections'), { ...memoryAI, profileId: 'not-text', dialect: 'images' }]);
  const select = (id: string, profile: unknown, revision = 0) => request(`/conversations/${id}/memory-profile`, { profile, revision });
  assert.equal((await select(c.id, 'not-text')).status, 400); assert.equal((await select(c.id, 'missing')).status, 400);
  assert.equal((await select(c.id, null)).status, 400); assert.equal((await select(c.id, memoryAI.profileId, 99)).status, 409);
  assert.equal((await select(app.store.create('coding', 'No story memory').id, memoryAI.profileId)).status, 400);
  provider.control.slow = true;
  await request(`/conversations/${c.id}/memory-toggle`, { enabled: true, revision: 0 });
  for (let i = 0; i < 100 && !provider.calls.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(app.engine.memoryActive.has(c.id), true);
  assert.equal((await select(c.id, memoryAI.profileId)).status, 200); await settled(app, c.id);
  assert.equal(app.engine.memoryStatus(c.id).error, ''); assert.equal(app.engine.memory.status(c.id).hasMemory, true);
  assert.equal(provider.calls.length, 1); assert.equal(alternate.calls.length, 1); assert.equal(alternate.calls[0].model, 'other-model');
  assert.equal(app.store.conversation(c.id).revision, 0);
});
