import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { MediaStore, imageBytes } from '../src/media.ts';
import { saveConnection } from '../src/connections.ts';
import { generateImage, listVoices, speak } from '../src/provider-services.ts';
import { nativeRequest } from '../src/provider-native.ts';
import type { Connection, Dialect } from '../src/shared.ts';
import { fixture, temp } from './helpers.ts';
import { mediaProvider, png } from './fixtures/media-provider.ts';

const signal = () => new AbortController().signal;
const connection = (dialect: Dialect): Connection => ({ provider: 'custom', endpoint: 'https://example.com/v1', model: 'fixture-model', dialect, route: 'direct' });
test('reply variants preserve original, edits, media and selection across restart; stale/foreign/older swipes fail', async t => {
  const file = join(await temp(t), 'variants.sqlite'); let store = new Store(file), media = new MediaStore(store);
  const c = store.create('rp', 'Variants'), j = store.start(c.id, 'Scene', 0); j.text = 'First'; j.status = 'complete'; store.finish(j);
  const m = store.messages(c.id).at(-1)!, first = m.active_variant!;
  const a = media.add(m, 'image', imageBytes(png).bytes, 'image/png', 'First scene', 'fixture');
  const regen = store.start(c.id, '', store.conversation(c.id).revision, m.id); regen.text = 'Second'; regen.status = 'complete'; store.finish(regen);
  assert.equal(store.messages(c.id).length, 2); assert.equal(store.messages(c.id).at(-1)!.variants!.length, 2);
  assert.deepEqual(media.list(store.message(c.id, m.id)), []);
  store.editMessage(c.id, m.id, 'Second edited', store.conversation(c.id).revision);
  const second = store.message(c.id, m.id).active_variant!;
  store.swipe(c.id, m.id, first, store.conversation(c.id).revision);
  assert.equal(store.message(c.id, m.id).content, 'First'); assert.equal(media.list(store.message(c.id, m.id))[0].id, a.id);
  assert.throws(() => store.swipe(c.id, m.id, second, 0), /changed/);
  const foreign = store.create('rp', 'Other'); assert.throws(() => store.swipe(foreign.id, m.id, first, 0), /not found/);
  store.close(); store = new Store(file); media = new MediaStore(store);
  assert.equal(media.list(store.message(c.id, m.id))[0].id, a.id);
  store.swipe(c.id, m.id, second, store.conversation(c.id).revision); assert.equal(store.message(c.id, m.id).content, 'Second edited');
  store.start(c.id, 'Next', store.conversation(c.id).revision);
  assert.throws(() => store.latestAssistant(c.id, m.id), /latest reply/); store.close();
});

test('regeneration cancellation/failure retains the selected reply and never appends a user message', async t => {
  const { app, wait } = await fixture(t), c = app.store.create('rp', 'Cancel');
  await wait(app.engine.start(c.id, 'story', 0).id);
  const m = app.store.messages(c.id).at(-1)!;
  app.store.editMessage(c.id, app.store.messages(c.id)[0].id, '[slow]', app.store.conversation(c.id).revision);
  const job = app.engine.start(c.id, '', app.store.conversation(c.id).revision, m.id); await app.engine.cancel(job.id);
  assert.equal(app.store.job(job.id).status, 'cancelled');
  assert.equal(app.store.messages(c.id).length, 2); assert.equal(app.store.message(c.id, m.id).content, m.content);
  app.store.editMessage(c.id, app.store.messages(c.id)[0].id, '[http-error]', app.store.conversation(c.id).revision);
  const failed = await wait(app.engine.start(c.id, '', app.store.conversation(c.id).revision, m.id).id);
  assert.equal(failed.status, 'failed'); assert.equal(app.store.message(c.id, m.id).active_variant, m.active_variant);
});

async function setup(t: any) {
  const f = await fixture(t), p = await mediaProvider(); t.after(p.close);
  await f.app.vault.unlock('synthetic media test passphrase');
  const save = (dialect: Dialect) => saveConnection(f.app.store, f.app.vault, { ...connection(dialect), endpoint: p.endpoint, apiKey: 'synthetic-' + dialect, keyMode: 'replace', name: dialect });
  const chat = await save('chat-completions'), image = await save('images'), speech = await save('speech-openai');
  assert.equal(f.app.store.setting('connection').profileId, chat.profileId);
  const voice = f.app.engine.media.saveVoice({ connection: speech.profileId, name: 'Narrator', voice: 'alloy', speed: 1 });
  const c = f.app.store.create('rp', 'Media'); await f.wait(f.app.engine.start(c.id, 'Start', 0).id);
  const m = f.app.store.messages(c.id).at(-1)!;
  const action = (action: string, data: any = {}) => f.request(`/conversations/${c.id}/messages/${m.id}/${action}`, { revision: f.app.store.conversation(c.id).revision, ...data });
  return { ...f, p, c, m, image, speech, voice, action };
}

test('image variants are authenticated, scoped and only the selected enabled image enters chat; regeneration excludes target', async t => {
  const { app, request, wait, p, c, m, image, action } = await setup(t);
  const one = await action('generate-image', { connection: image.profileId, prompt: 'one', useInChat: true }); assert.equal(one.status, 200);
  const two = await action('generate-image', { connection: image.profileId, prompt: 'two', useInChat: true }); assert.equal(two.status, 200);
  const assets = app.engine.media.list(m); assert.equal(assets.length, 2); assert.equal(assets.filter(a => a.selected).length, 1);
  const url = app.origin + '/api/media/' + one.data.asset.id;
  assert.equal((await fetch(url)).status, 401);
  const loaded = await fetch(url, { headers: { Authorization: 'Bearer ' + app.token } }); assert.equal(loaded.status, 200); assert.equal(loaded.headers.get('content-type'), 'image/png'); await loaded.arrayBuffer();
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + app.token, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await action('select-image', { asset: one.data.asset.id, useInChat: true })).status, 200);
  await wait(app.engine.start(c.id, '', app.store.conversation(c.id).revision, m.id).id);
  assert.ok(!JSON.stringify(p.calls.at(-1)!.body).includes('image_url'), 'Regeneration excludes the old reply and its image');
  const first = app.store.messages(c.id).at(-1)!.variants![0].id;
  await action('swipe', { variant: first });
  await wait(app.engine.start(c.id, 'Describe the selected picture', app.store.conversation(c.id).revision).id);
  const parts = p.calls.at(-1)!.body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
  assert.equal(parts.filter((p: any) => p.type === 'image_url').length, 1);
  assert.equal(parts.find((p: any) => p.type === 'image_url').image_url.url, 'data:image/png;base64,' + Buffer.from(app.engine.media.asset(one.data.asset.id).data).toString('base64'));
  assert.equal((await action('regenerate')).status, 409, 'Older messages cannot regenerate after a later exchange');
  assert.equal((await action('select-image', { asset: one.data.asset.id, useInChat: false })).status, 200);
  await wait(app.engine.start(c.id, 'No picture this time', app.store.conversation(c.id).revision).id);
  assert.ok(!JSON.stringify(p.calls.at(-1)!.body).includes('image_url'));
  const foreign = app.store.create('rp', 'Foreign');
  assert.equal((await request(`/conversations/${foreign.id}/messages/${m.id}/select-image`, { revision: 0, asset: one.data.asset.id, useInChat: true })).status, 404);
  assert.ok(p.calls.filter(c => c.url.includes('/images/')).every(c => c.auth === 'Bearer synthetic-images'));
});

test('speech uses saved voice endpoint, caches exact audio and retains marked old-text recordings', async t => {
  const { app, p, c, m, voice, action } = await setup(t);
  const first = await action('narrate', { voicePreset: voice.id }); assert.equal(first.status, 200); assert.equal(first.data.cached, false);
  const second = await action('narrate', { voicePreset: voice.id }); assert.equal(second.data.cached, true); assert.equal(first.data.asset.id, second.data.asset.id);
  assert.equal(p.calls.filter(c => c.url.includes('/audio/speech')).length, 1);
  assert.equal(p.calls.at(-1)!.auth, 'Bearer synthetic-speech-openai');
  app.store.editMessage(c.id, m.id, 'Edited scene', app.store.conversation(c.id).revision);
  assert.equal(app.engine.media.list(app.store.message(c.id, m.id))[0].stale, true);
  assert.equal((await action('narrate', { voicePreset: voice.id })).data.cached, false);
  app.engine.media.saveVoice({ ...voice, speed: 1.1 });
  assert.equal((await action('narrate', { voicePreset: voice.id })).data.cached, false);
  assert.equal(p.calls.filter(c => c.url.includes('/audio/speech')).length, 3);
  assert.throws(() => app.engine.media.saveVoice({ ...voice, voice: '../bad' }), /valid voice/);
  assert.throws(() => app.engine.media.saveVoice({ ...voice, speed: 3 }), /speed/);
});

test('failed/cancelled media keeps old selection, blocks conflicting writes and releases reservation', async t => {
  const { app, p, c, m, image, action, request } = await setup(t);
  const one = await action('generate-image', { connection: image.profileId, prompt: 'one', useInChat: true });
  assert.equal((await action('generate-image', { connection: image.profileId, prompt: 'fail', useInChat: true })).status, 502);
  const slow = action('generate-image', { connection: image.profileId, prompt: 'slow', useInChat: true });
  for (let n = 0; !p.calls.some(c => c.body.prompt === 'slow') && n < 100; n++) await new Promise(r => setTimeout(r, 10));
  assert.ok(p.calls.some(c => c.body.prompt === 'slow'));
  assert.equal((await action('edit', { text: 'Cannot race' })).status, 409);
  assert.equal((await request(`/conversations/${c.id}/send`, { text: 'Cannot race', revision: app.store.conversation(c.id).revision })).status, 409);
  await request('/stop', {}); await slow;
  assert.equal((await request('/conversations/' + c.id)).data.mediaBusy, false);
  const list = app.engine.media.list(app.store.message(c.id, m.id)); assert.equal(list.length, 1); assert.equal(list[0].id, one.data.asset.id); assert.equal(list[0].selected, 1);
});

test('image adapters and native vision payloads are bounded, explicit and never fetch returned image URLs', async () => {
  const calls: any[] = []; const transport = (async (url: any, init: any) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return Response.json({ data: [{ b64_json: png }] }); }) as typeof fetch;
  await generateImage({ ...connection('images'), model: 'gpt-image-2.5-flare' }, 'synthetic', { prompt: 'scene' }, signal(), transport);
  assert.equal(calls[0].body.response_format, undefined); assert.equal(calls[0].body.n, 1); assert.equal(calls[0].redirect, 'error');
  const gemini = (async (_url: any, init: any) => { assert.deepEqual(JSON.parse(init.body).generationConfig.responseModalities, ['TEXT','IMAGE']); assert.equal(init.headers['x-goog-api-key'], 'synthetic'); return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }); }) as typeof fetch;
  assert.equal((await generateImage(connection('gemini-images'), 'synthetic', { prompt: 'scene' }, signal(), gemini)).mime, 'image/png');
  for (const result of [{ data: [{ url: 'https://never-fetch.example/image' }] }, { data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }]) {
    let count = 0; await assert.rejects(generateImage(connection('images'), '', { prompt: 'scene' }, signal(), (async () => { count++; return Response.json(result); }) as typeof fetch)); assert.equal(count, 1);
  }
  assert.throws(() => imageBytes('a'.repeat(11000001)), /bounded/);
  const messages = [{ role: 'user' as const, content: 'Look', images: [{ mime: 'image/png', data: png }] }];
  const responses = nativeRequest(connection('responses'), messages, false).body;
  assert.equal(responses.input[0].content[1].image_url, 'data:image/png;base64,' + png);
  assert.equal(nativeRequest(connection('anthropic'), messages, false).body.messages[0].content[1].source.data, png);
  assert.equal(nativeRequest(connection('gemini'), messages, false).body.contents[0].parts[1].inlineData.data, png);
  let contacted = false; const offline = (async () => { contacted = true; throw Error(); }) as typeof fetch;
  assert.ok((await listVoices(connection('speech-openai'), '', signal(), offline)).voices.some((v: { id: string }) => v.id === 'alloy')); assert.equal(contacted, false);
  await assert.rejects(speak(connection('speech-openai'), '', { voice: 'alloy', text: 'test', speed: 2 }, signal(), offline), /speed/); assert.equal(contacted, false);
});
