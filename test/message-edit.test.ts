import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { fixture, temp } from './helpers.ts';

test('message edits preserve IDs, roles, later replies and jobs; revisions survive restart', async t => {
  const file = join(await temp(t), 'edit.sqlite'); let store = new Store(file);
  const c = store.create('rp', 'Edit test'), job = store.start(c.id, 'Original user', 0);
  job.text = 'Original assistant'; job.status = 'complete'; store.finish(job);
  const [user, assistant] = store.messages(c.id);
  const edited = store.editMessage(c.id, user.id, '**Edited** user', 2);
  assert.equal(edited.role, 'user'); assert.equal(edited.id, user.id); assert.ok(edited.edited);
  assert.equal(store.messages(c.id)[1].content, assistant.content);
  assert.equal(store.job(job.id).text, 'Original assistant');
  assert.throws(() => store.editMessage(c.id, assistant.id, 'Stale', 2), /changed/);
  assert.equal(store.conversation(c.id).revision, 3);
  store.editMessage(c.id, assistant.id, '*Edited* assistant', 3);
  const before = store.conversation(c.id).revision;
  store.editMessage(c.id, assistant.id, '*Edited* assistant', before);
  assert.equal(store.conversation(c.id).revision, before);
  store.close(); store = new Store(file); t.after(() => store.close());
  assert.deepEqual(store.messages(c.id).map(m => m.content), ['**Edited** user', '*Edited* assistant']);
  const next = store.start(c.id, 'Continue', 4);
  assert.equal(next.revision, 5);
  assert.equal(store.messages(c.id).length, 3);
  assert.throws(() => store.editMessage(c.id, user.id, 'During job', 5), /running/);
  assert.equal(store.messages(c.id)[0].content, '**Edited** user');
});

test('edit API enforces auth, exact conversation ownership, bounds, active-job and stale-revision guards', async t => {
  const { app, request, wait } = await fixture(t);
  const c = app.store.create('rp', 'API edit'), other = app.store.create('rp', 'Other');
  const job = (await request(`/conversations/${c.id}/send`, { text: '[slow]', revision: 0 })).data;
  const user = app.store.messages(c.id)[0], path = `/conversations/${c.id}/messages/${user.id}/edit`;
  assert.equal((await request(path, { text: 'Early', revision: 1 })).status, 409);
  await request(`/jobs/${job.id}/cancel`, {}); await wait(job.id);
  assert.equal((await request(path, { text: 'Unauthorized', revision: 1 }, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await request(`/conversations/${other.id}/messages/${user.id}/edit`, { text: 'Wrong conversation', revision: 0 })).status, 404);
  for (const value of [{ text: '', revision: 1 }, { text: 'x'.repeat(64001), revision: 1 }, { text: 'Valid', revision: '1' }]) assert.equal((await request(path, value)).status, 400);
  await app.vault.unlock('synthetic edit test passphrase'); await app.vault.set('test', 'synthetic-edit-secret');
  const response = await request(path, { text: 'Never store synthetic-edit-secret', revision: 1 });
  assert.equal(response.status, 200); assert.ok(!response.data.content.includes('synthetic-edit-secret'));
  assert.equal(app.store.messages(c.id).length, 1); assert.equal(app.engine.active.size, 0);
  assert.equal((await request(path, { text: 'Stale overwrite', revision: 1 })).status, 409);
});
