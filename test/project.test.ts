import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ProjectTools, hash, safePath, projectRoot } from '../src/project-tools.ts';
import { temp } from './helpers.ts';

async function setup(t: any) { const root = await temp(t), project = join(root, 'odd project [test] ü'); await mkdir(project); const store = new Store(join(root, 'db.sqlite')); t.after(() => store.close()); let c = store.create('coding', 'Task'); c = store.project(c.id, await projectRoot(project), true); return { root, project, store, c, tools: new ProjectTools(store), signal: new AbortController().signal }; }
test('chosen but untrusted project cannot read/write/run tools', async t => { const { tools, c, signal } = await setup(t); c.trusted = 0; await assert.rejects(tools.execute(c, 'list_files', { path: '.' }, signal), /trust/); });
test('read, compare-and-swap edit, diff and restore preserve user work', async t => {
  const { tools, c, project, signal } = await setup(t); await writeFile(join(project, 'hello.js'), 'const n = 1;\n');
  const read = JSON.parse(await tools.execute(c, 'read_text', { path: 'hello.js' }, signal));
  const edited = JSON.parse(await tools.execute(c, 'write_text', { path: 'hello.js', expectedHash: read.sha256, content: 'const n = 2;\n' }, signal));
  assert.match(edited.diff, /-const n = 1/); assert.match(edited.diff, /\+const n = 2/);
  await assert.rejects(tools.execute(c, 'write_text', { path: 'hello.js', expectedHash: read.sha256, content: 'bad' }, signal), /changed/);
  await tools.restore(c, edited.checkpoint); assert.equal(await readFile(join(project, 'hello.js'), 'utf8'), 'const n = 1;\n');
});
test('restore refuses to overwrite later external edits', async t => {
  const { tools, c, project, signal } = await setup(t); const edited = JSON.parse(await tools.execute(c, 'write_text', { path: 'new.txt', expectedHash: 'new', content: 'original' }, signal));
  await writeFile(join(project, 'new.txt'), 'user work'); await assert.rejects(tools.restore(c, edited.checkpoint), /changed/); assert.equal(await readFile(join(project, 'new.txt'), 'utf8'), 'user work');
});
test('new file checkpoint can remove only its unchanged created file', async t => { const { tools, c, project, signal } = await setup(t); const edit = JSON.parse(await tools.execute(c, 'write_text', { path: 'new.txt', expectedHash: 'new', content: 'hello' }, signal)); await tools.restore(c, edit.checkpoint); await assert.rejects(readFile(join(project, 'new.txt')), { code: 'ENOENT' }); });
test('checkpoints cannot be replayed in a different project', async t => { const { tools, c, root, signal } = await setup(t); const edit = JSON.parse(await tools.execute(c, 'write_text', { path: 'same.txt', expectedHash: 'new', content: 'same' }, signal)); const other = join(root, 'other'); await mkdir(other); await writeFile(join(other, 'same.txt'), 'same'); c.project = await projectRoot(other); await assert.rejects(tools.restore(c, edit.checkpoint), /different project/); assert.equal(await readFile(join(other, 'same.txt'), 'utf8'), 'same'); });
test('Windows normalized credential aliases are blocked', async t => { const { c } = await setup(t); for (const path of ['.env.', '.env ']) await assert.rejects(safePath(c.project!, path, true)); });
test('path traversal, absolute paths, ADS and sensitive paths are blocked', async t => {
  const { c } = await setup(t);
  for (const path of ['../outside.txt', '..\\outside.txt', 'C:\\outside.txt', '/etc/passwd', 'normal.txt:secret', '.env', '.git/config', '.ssh/id_rsa', 'credentials.json', 'vault.json', 'node_modules/x']) await assert.rejects(safePath(c.project!, path, true));
});
test('junction/symlink traversal is rejected', async t => {
  const { c, root, project } = await setup(t); const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'private');
  await symlink(outside, join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(safePath(c.project!, 'escape/private.txt'), /Symlinks/);
});
test('JavaScript syntax check handles Unicode/spaces without executing code', async t => {
  const { tools, c, project, signal } = await setup(t); await writeFile(join(project, 'check ü.js'), 'throw new Error("MUST NOT RUN");\n');
  const result = JSON.parse(await tools.execute(c, 'check_javascript', { path: 'check ü.js' }, signal)); assert.equal(result.exitCode, 0); assert.equal(result.output, 'Syntax check passed.');
  await writeFile(join(project, 'bad.js'), 'const = nope'); const bad = JSON.parse(await tools.execute(c, 'check_javascript', { path: 'bad.js' }, signal)); assert.notEqual(bad.exitCode, 0);
});
test('declarative JSON tests report pass and fail honestly', async t => { const { tools, c, project, signal } = await setup(t); await writeFile(join(project, 'config.json'), '{"greeting":"Hello"}'); assert.equal(JSON.parse(await tools.execute(c, 'check_json', { path: 'config.json', field: 'greeting', expected: 'Hello' }, signal)).passed, true); assert.equal(JSON.parse(await tools.execute(c, 'check_json', { path: 'config.json', field: 'greeting', expected: 'Wrong' }, signal)).passed, false); });
test('unknown tools and cancelled writes fail closed', async t => {
  const { tools, c, project, signal } = await setup(t); await assert.rejects(tools.execute(c, 'shell', { path: '.' }, signal), /not supported/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(tools.execute(c, 'write_text', { path: 'no.txt', expectedHash: 'new', content: 'no' }, abort.signal)); await assert.rejects(readFile(join(project, 'no.txt')));
});
test('binary and oversized files do not enter model context', async t => { const { tools, c, project, signal } = await setup(t); await writeFile(join(project, 'binary.dat'), Buffer.from([0, 1, 2])); await writeFile(join(project, 'large.txt'), 'a'.repeat(65000)); await assert.rejects(tools.execute(c, 'read_text', { path: 'binary.dat' }, signal), /Binary/); await assert.rejects(tools.execute(c, 'read_text', { path: 'large.txt' }, signal), /64 KB/); });
