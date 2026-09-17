import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { memoryProvider } from './fixtures/memory-provider.ts';

test('Assistant answers ordinary chat without a project and keeps existing coding history', async t => {
  const { app, request, wait } = await fixture(t), provider = await memoryProvider(); t.after(provider.close);
  await app.vault.unlock('synthetic-assistant-passphrase');
  await request('/connection', { endpoint: provider.endpoint, model: 'fixture', dialect: 'chat-completions', route: 'direct', provider: 'custom', auth: 'none', key: '' });
  const story = app.store.create('rp', 'Separate story');
  app.engine.stories.save(story.id, { description: 'PRIVATE_STORY_MARKER' }, 0);
  const c = app.store.create('coding', 'Existing coding chat');
  for (const question of ['Explain why the sky is blue.', 'Help draft a polite thank-you message.']) {
    const job = await request(`/conversations/${c.id}/send`, { text: question, revision: app.store.conversation(c.id).revision });
    const done = await wait(job.data.id); assert.equal(done.status, 'complete', done.error); assert.equal(done.actions.length, 0);
    const wire = provider.calls.at(-1); assert.ok(!wire.tools?.length);
    assert.match(wire.messages[0].content, /general-purpose AI assistant/); assert.match(wire.messages[0].content, /No project-file tools/);
    assert.ok(!JSON.stringify(wire).includes('PRIVATE_STORY_MARKER'));
    assert.ok(JSON.stringify(wire).includes(question));
  }
  assert.equal(app.store.conversation(c.id).title, 'Existing coding chat');
  assert.equal(app.store.messages(c.id).length, 4); assert.equal(app.store.conversation(c.id).trusted, 0);
  assert.ok(JSON.stringify(provider.calls.at(-1)).includes('Explain why the sky is blue.'));
});
