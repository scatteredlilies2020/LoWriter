import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStory, importCard, importLore, storyContext, insertStoryDepth } from '../src/story-kit.ts';
import { blankStory } from '../src/story-types.ts';
import { fixture } from './helpers.ts';
import { memoryProvider } from './fixtures/memory-provider.ts';

const lore = { id: 'one', name: 'Harbor lore', keys: ['harbor'], content: 'The harbor closes at midnight.', enabled: true, always: false, priority: 100 };

test('additional instructions migrate once, allow custom entries, disable and remove without reviving source text', async t => {
  const { app } = await fixture(t), c = app.store.create('rp', 'Legacy setup');
  const legacy = { instructions: 'MAIN', characterNote: 'NOTE', postHistory: 'PHI', placements: { characterNote: { position: 'depth', role: 'assistant', depth: 7 } } };
  app.store.db.prepare('INSERT INTO story_setups VALUES(?,?)').run(c.id, JSON.stringify(legacy));
  const s = app.engine.stories.get(c.id);
  assert.deepEqual(s.additionalInstructions.map(e => e.content), ['MAIN', 'NOTE', 'PHI']);
  assert.equal(s.instructions, ''); assert.equal(s.characterNote, ''); assert.equal(s.postHistory, '');
  assert.deepEqual(validateStory(s), s); assert.deepEqual(app.engine.stories.get(c.id), s);
  s.additionalInstructions[1].enabled = false;
  s.additionalInstructions.push({ id: 'custom', name: 'Not sent as prompt', content: 'CUSTOM {{char}}', enabled: true, source: '', placement: { position: 'depth', role: 'user', depth: 1 } });
  s.additionalInstructions = s.additionalInstructions.filter(e => e.source !== 'postHistory');
  app.engine.stories.save(c.id, s, 0);
  const saved = app.engine.stories.get(c.id), p = storyContext(saved, '');
  assert.equal(saved.additionalInstructions.length, 3); assert.equal(p.after.length, 0);
  assert.deepEqual(p.atDepth, [{ depth: 1, message: { role: 'user', content: 'CUSTOM Narrator' } }]);
  assert.ok(!JSON.stringify(p).includes('Not sent as prompt')); assert.ok(!JSON.stringify(p).includes('NOTE'));
  assert.deepEqual(importCard(JSON.stringify({ format: 'lowriter.story', version: 1, setup: saved })).setup, saved);
  app.engine.stories.savePreset('Custom setup', saved); assert.deepEqual(app.engine.stories.preset(app.engine.stories.presets()[0].id), saved);
  assert.throws(() => validateStory({ additionalInstructions: Array(51).fill({}) }), /50/);
  assert.throws(() => validateStory({ additionalInstructions: [{ id: 'same' }, { id: 'same' }] }), /Duplicate/);
  assert.throws(() => validateStory({ additionalInstructions: [{ placement: { role: 'tool', position: 'before' } }] }), /role/);
  assert.throws(() => validateStory({ additionalInstructions: [{ placement: { role: 'system', position: 'depth', depth: -1 } }] }), /number/);
});
test('only descriptive fields merge; all other ST fields retain content and original source paths', () => {
  const source = { spec: 'chara_card_v3', spec_version: '3.0', extraRoot: { future: true }, data: { name: 'Cast', description: 'World description', personality: 'A varied cast', scenario: 'The harbor', mes_example: '<START>\n{{char}}: Example', system_prompt: 'Main {{original}} {{custom::macro}}', post_history_instructions: 'PHI {{lastMessage}}', first_mes: 'Start', creator_notes: 'Private notes', tags: ['tag'], assets: [{ uri: 'https://example.invalid/never-fetch' }], extensions: { depth_prompt: { prompt: 'Note {{char}}', depth: 2, role: 'assistant', custom: 'retained' }, unknown: { nested: 'kept here' } } } };
  const { setup } = importCard(JSON.stringify(source));
  assert.equal(setup.description, 'World description\n\nPersonality:\nA varied cast\n\nScenario:\nThe harbor');
  assert.equal((setup as any).scenario, undefined); assert.equal((setup as any).personality, undefined);
  assert.equal(setup.examples, source.data.mes_example); assert.equal(setup.additionalInstructions.find(e => e.source === 'instructions')!.content, source.data.system_prompt); assert.equal(setup.additionalInstructions.find(e => e.source === 'postHistory')!.content, source.data.post_history_instructions);
  assert.equal(setup.additionalInstructions.find(e => e.source === 'characterNote')!.content, 'Note {{char}}'); assert.deepEqual(setup.placements.characterNote, { position: 'depth', depth: 2, role: 'assistant' });
  assert.deepEqual(JSON.parse(setup.importedCard), source);
  assert.deepEqual(validateStory(setup), setup); // No repeated legacy merging on save/reload.
  const roundtrip = importCard(JSON.stringify({ format: 'lowriter.story', version: 1, setup })).setup;
  assert.deepEqual(roundtrip, setup);
  const prompt = storyContext(setup, ''); assert.equal(prompt.before[0].content, source.data.system_prompt); assert.equal(prompt.after[0].content, source.data.post_history_instructions);
  assert.ok(!JSON.stringify(prompt).includes('Private notes')); assert.ok(!JSON.stringify(prompt).includes('never-fetch'));
});

test('prompt depth uses dialogue boundaries, stable ordering and clamps without counting attachments', () => {
  const s = validateStory({ description: 'Description', instructions: 'Main', postHistory: 'PHI', characterNote: 'Note', placements: { characterNote: { position: 'depth', role: 'assistant', depth: 1 }, description: { position: 'depth', role: 'user', depth: 400 } } });
  const p = storyContext(s, ''), raw = [{ role: 'user' as const, content: 'First' }, { role: 'user' as const, content: 'Attachment', images: [{ mime: 'image/png', data: 'AA==' }] }, { role: 'assistant' as const, content: 'Second' }];
  const sent = [...p.before, ...insertStoryDepth(raw, p.atDepth, [0, 2]), ...p.after];
  assert.deepEqual(sent.map(m => m.content), ['Main', 'Description', 'First', 'Attachment', 'Note', 'Second', 'PHI']);
  s.additionalInstructions.find(e => e.source === 'characterNote')!.placement.depth = 0; assert.equal(insertStoryDepth(raw, storyContext(s, '').atDepth, [0, 2]).at(-1)?.content, 'Note');
  assert.throws(() => validateStory({ placements: { instructions: { position: 'depth', role: 'tool', depth: 1 } } }), /role/);
  assert.throws(() => validateStory({ placements: { instructions: { position: 'depth', role: 'system', depth: -1 } } }), /number/);
  assert.throws(() => validateStory({ importedCard: 'not json' }), /JSON/);
});

test('imported Main Prompt, PHI and adjustable Character Note reach the wire and survive continuation', async t => {
  const { app, request, wait } = await fixture(t), provider = await memoryProvider(); t.after(provider.close);
  await app.vault.unlock('synthetic-placement-passphrase');
  await request('/connection', { endpoint: provider.endpoint, model: 'fixture', dialect: 'chat-completions', route: 'direct', provider: 'custom', auth: 'none', key: '', messageProcessing: 'separate' });
  const c = app.store.create('rp', 'Cast'), source = { name: 'Cast', description: 'Description only', system_prompt: 'MAIN_MARKER', post_history_instructions: 'PHI_MARKER', first_mes: 'Opening', extensions: { depth_prompt: { prompt: 'NOTE_MARKER', role: 'assistant', depth: 1 } } };
  const setup = importCard(JSON.stringify(source)).setup; app.engine.stories.save(c.id, setup, 0); app.engine.stories.greeting(c.id, 0, 1);
  const result = await request(`/conversations/${c.id}/send`, { text: 'USER_MARKER', revision: 2 }); assert.equal((await wait(result.data.id)).status, 'complete');
  const wire = JSON.stringify(provider.calls[0].messages); assert.ok(wire.indexOf('MAIN_MARKER') < wire.indexOf('Opening')); assert.ok(wire.indexOf('NOTE_MARKER') < wire.indexOf('USER_MARKER')); assert.ok(wire.indexOf('PHI_MARKER') > wire.indexOf('USER_MARKER'));
  assert.ok(!app.store.messages(c.id).at(-1)!.content.startsWith('PHI_MARKER'));
  const reply = app.store.messages(c.id).at(-1)!;
  const continued = await request(`/conversations/${c.id}/messages/${reply.id}/continue`, { revision: app.store.conversation(c.id).revision }); assert.equal((await wait(continued.data.id)).status, 'complete');
  const next = provider.calls[1].messages; assert.equal(next.at(-1).content, reply.content); assert.ok(JSON.stringify(next).includes('NOTE_MARKER')); assert.ok(JSON.stringify(next).includes('PHI_MARKER'));
});
test('scenario validation is bounded and strips permissions; portraits cannot fetch URLs or execute SVG', () => {
  const s = validateStory({ name: 'An entire cast', trusted: true, endpoint: 'secret', lore: [lore] });
  assert.equal(s.contextMessages, 40); assert.equal((s as any).trusted, undefined); assert.equal((s as any).endpoint, undefined);
  assert.throws(() => validateStory({ contextMessages: 10000 }), /number/);
  assert.throws(() => validateStory({ lore: [lore, lore] }), /Duplicate/);
  assert.throws(() => validateStory({ portraits: [{ image: 'https://example.invalid/a.png' }] }), /local/);
  assert.throws(() => validateStory({ portraits: [{ image: 'data:image/svg+xml;base64,PHN2Zz4=' }] }), /local/);
  assert.throws(() => validateStory({ name: 'n'.repeat(101) }), /text/);
});
test('card and lore import preserve supported fields without executing macros or extensions', () => {
  const imported = importCard(JSON.stringify({ spec: 'chara_card_v2', data: { name: 'World', description: 'Many people', first_mes: 'Hi {{user}}', system_prompt: 'My own writing style', post_history_instructions: 'Stay quiet', alternate_greetings: ['Hello'], character_book: { entries: [{ keys: ['harbor'], content: 'A place', constant: true, enabled: true }] }, extensions: { scripts: 'never execute' } } }));
  assert.equal(imported.setup.additionalInstructions.find(e => e.source === 'instructions')!.content, 'My own writing style'); assert.equal(imported.setup.lore[0].always, true); assert.deepEqual(imported.setup.greetings, ['Hi {{user}}', 'Hello']);
  assert.equal(JSON.parse(imported.setup.importedCard).data.extensions.scripts, 'never execute'); assert.ok(!JSON.stringify(storyContext(imported.setup, '')).includes('never execute')); assert.ok(imported.warnings.length);
  const native = importCard(JSON.stringify({ format: 'lowriter.story', version: 1, setup: { portraits: [{ name: 'Mara', voice: 'private-profile' }] } })); assert.equal(native.setup.portraits[0].voice, '');
  const st = importLore({ entries: { 0: { key: ['harbor'], keysecondary: ['night'], selective: true, content: 'Lore', disable: true, order: 20 } } }); assert.equal(st.lore[0].enabled, false); assert.deepEqual(st.lore[0].secondaryKeys, ['night']);
  assert.throws(() => importCard('{}'), /Expected/);
});
test('PNG card metadata is decoded locally with bounded chunk lengths', () => {
  const chunk = (type: string, content: Buffer) => { const b = Buffer.alloc(content.length + 12); b.writeUInt32BE(content.length); b.write(type, 4); content.copy(b, 8); return b; };
  const text = Buffer.from('chara\0' + Buffer.from(JSON.stringify({ name: 'World', description: 'A cast' })).toString('base64'));
  const b = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('tEXt', text), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(importCard(undefined, b.toString('base64')).setup.name, 'World');
  b.writeUInt32BE(999999, 8); assert.throws(() => importCard(undefined, b.toString('base64')), /Malformed/);
});
test('story prompt uses literal matching, budget and explicit user templates without forced modes', () => {
  const s = validateStory({ name: 'World', personaName: 'Mara', description: '{{user}} in {{char}}', prefill: 'The ', lore: [lore, { ...lore, id: 'two', name: 'Always', always: true, priority: 200 }, { ...lore, id: 'three', name: 'Disabled', enabled: false }] });
  const p = storyContext(s, 'HARBOR at night'); assert.deepEqual(p.activeLore, ['Always', 'Harbor lore']); assert.match(p.before[0].content!, /Mara in World/); assert.equal(p.after.at(-1)?.role, 'assistant');
  s.loreBudget = 0; assert.equal(storyContext(s, 'harbor').activeLore.length, 0); assert.equal(storyContext(s, 'harbor').omittedLore.length, 2);
  s.loreBudget = 12000; s.lore[0].secondaryKeys = ['storm']; assert.ok(!storyContext(s, 'harbor').activeLore.includes('Harbor lore'));
  assert.deepEqual(storyContext(blankStory(), ''), { before: [], after: [], atDepth: [], activeLore: [], omittedLore: [] });
});
test('setup saves with revision checks, undo history, isolated presets and coding denial', async t => {
  const { app, request } = await fixture(t), c = app.store.create('rp', 'World'), coding = app.store.create('coding', 'Work');
  const path = `/conversations/${c.id}`;
  assert.equal((await request(`/conversations/${coding.id}/story`)).status, 400);
  assert.equal((await request(path + '/story-save', { setup: { name: 'Whole cast' }, revision: 0 })).status, 200);
  assert.equal((await request(path + '/story-save', { setup: { name: 'Stale overwrite' }, revision: 0 })).status, 409);
  let v = (await request(path + '/story')).data; assert.equal(v.setup.name, 'Whole cast'); assert.equal(v.versions.length, 1);
  assert.equal((await request(path + '/story-preset-save', { name: 'World preset', setup: v.setup })).status, 200);
  v = (await request(path + '/story')).data; assert.equal(v.presets.length, 1);
  assert.equal((await request(path + '/story-preset-load', { preset: v.presets[0].id })).data.name, 'Whole cast');
  assert.equal((await request(path + '/story-restore', { version: v.versions[0].id, revision: 1 })).status, 200);
  assert.equal(app.engine.stories.get(c.id).name, ''); assert.equal(app.engine.stories.versions(c.id).length, 2);
});
test('greetings, continuation and branching preserve original variants and never add a synthetic user message', async t => {
  const { app, request, wait } = await fixture(t), c = app.store.create('rp', 'World');
  app.engine.stories.save(c.id, { name: 'World', personaName: 'Mara', greetings: ['Hello {{user}}. '] }, 0);
  assert.equal((await request(`/conversations/${c.id}/story-greeting`, { index: 0, revision: 1 })).status, 200);
  const original = app.store.messages(c.id)[0]; assert.equal(original.content, 'Hello Mara. ');
  assert.equal((await request(`/conversations/${c.id}/story-greeting`, { index: 0, revision: 2 })).status, 400);
  const started = await request(`/conversations/${c.id}/messages/${original.id}/continue`, { revision: 2 }); assert.equal(started.status, 202);
  const done = await wait(started.data.id); assert.equal(done.status, 'complete', done.error);
  const next = app.store.messages(c.id); assert.equal(next.length, 1); assert.equal(next[0].id, original.id); assert.ok(next[0].content.startsWith(original.content)); assert.equal(next[0].variants!.length, 2);
  app.store.swipe(c.id, original.id, original.variants![0].id, app.store.conversation(c.id).revision); assert.equal(app.store.message(c.id, original.id).content, original.content);
  const branch = await request(`/conversations/${c.id}/story-branch`, { revision: app.store.conversation(c.id).revision, through: original.id, title: 'Alternative' }); assert.equal(branch.status, 201);
  const id = branch.data.conversation.id; assert.notEqual(id, c.id); assert.equal(app.engine.stories.get(id).name, 'World'); assert.equal(app.store.messages(id)[0].variants!.length, 2); assert.equal(app.engine.memory.row(id).enabled, 0);
});
test('story reference and prefill reach the selected provider; continuation uses the actual last reply', async t => {
  const { app, request, wait } = await fixture(t), provider = await memoryProvider(); t.after(provider.close);
  await app.vault.unlock('synthetic-story-kit-passphrase');
  await request('/connection', { endpoint: provider.endpoint, model: 'fixture', dialect: 'chat-completions', route: 'direct', provider: 'custom', auth: 'none', key: '' });
  const c = app.store.create('rp', 'World'); app.engine.stories.save(c.id, { description: 'Whole world and cast', personaName: 'Mara', prefill: 'Opening: ', lore: [lore] }, 0);
  const send = await request(`/conversations/${c.id}/send`, { text: 'Visit the harbor.', revision: 1 }); assert.equal((await wait(send.data.id)).status, 'complete');
  const outbound = provider.calls[0].messages; assert.match(JSON.stringify(outbound), /Whole world and cast/); assert.match(JSON.stringify(outbound), /closes at midnight/); assert.equal(outbound.at(-1).role, 'assistant'); assert.equal(outbound.at(-1).content, 'Opening: ');
  const reply = app.store.messages(c.id).at(-1)!; assert.ok(reply.content.startsWith('Opening: '));
  const more = await request(`/conversations/${c.id}/messages/${reply.id}/continue`, { revision: app.store.conversation(c.id).revision }); assert.equal((await wait(more.data.id)).status, 'complete');
  assert.equal(provider.calls[1].messages.at(-1).content, reply.content); assert.equal(app.store.messages(c.id).length, 2);
  const coding = app.store.create('coding', 'Work'); const work = await request(`/conversations/${coding.id}/send`, { text: 'Hello', revision: 0 }); await wait(work.data.id); assert.ok(!JSON.stringify(provider.calls.at(-1)).includes('Whole world and cast'));
});
test('branches copy selected local media and independent variants without changing the source', async t => {
  const { app } = await fixture(t), c = app.store.create('rp', 'World');
  app.engine.stories.save(c.id, { greetings: ['Hi.'] }, 0); app.engine.stories.greeting(c.id, 0, 1);
  const m = app.store.messages(c.id)[0]; const a = app.engine.media.add(m, 'image', Buffer.from([137,80,78,71,13,10,26,10]), 'image/png', 'test', 'test');
  const revision = app.store.conversation(c.id).revision;
  const copy = app.engine.stories.branch(c.id, m.id, revision, 'Copy'), cm = app.store.messages(copy.id)[0], assets = app.engine.media.list(cm);
  assert.equal(assets.length, 1); assert.notEqual(assets[0].id, a.id); assert.notEqual(assets[0].variant, a.variant); assert.equal(assets[0].selected, 1);
  assert.equal(app.engine.media.list(m).length, 1); assert.equal(app.store.conversation(c.id).revision, revision);
});
