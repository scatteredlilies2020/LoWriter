// Synthetic API failures/version skew only; never opens personal data or providers.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server.ts';

const playwright = await import(pathToFileURL(process.env.LOWRITER_PLAYWRIGHT_MODULE || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
await mkdir('.test-data', { recursive: true });
await mkdir('artifacts', { recursive: true });
const dir = await mkdtemp(resolve('.test-data/setup-recovery-'));
let app, browser;
const errors = [], checks = [];
try {
  app = await startServer({ dataDir: dir, port: 0, credentialMode: 'legacy-test' });
  const c = app.store.create('rp', 'Recovery fixture');
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.LOWRITER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  const context = await browser.newContext();
  await context.request.post(app.origin + '/api/login', { headers: { 'X-LoWriter': '1' }, data: { token: app.token } });
  await context.addInitScript(id => localStorage.setItem('lowriter-chat', id), c.id);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  let responseMode = 'legacy', writes = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/story')) writes++; });
  await page.route('**/api/conversations/*/story', async route => {
    if (responseMode === 'offline') return route.fulfill({ status: 503, json: { error: 'Synthetic service unavailable.' } });
    const response = await route.fetch(), value = await response.json();
    if (responseMode === 'legacy') delete value.setup.additionalInstructions;
    if (responseMode === 'broken') value.setup.additionalInstructions = [null];
    await route.fulfill({ response, json: value });
  });
  const open = () => page.getByRole('button', { name: 'Story setup', exact: true }).click();
  const close = async () => {
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  };
  await page.goto(app.origin);
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/story')), open()]);
  // Give the fetched setup a chance to render, including the legacy crash.
  await page.waitForTimeout(300);
  assert.deepEqual(errors, [], 'An older service must not crash the browser application');
  await page.getByRole('alert').filter({ hasText: 'older version' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save story setup', exact: true }).count(), 0);
  assert.equal(writes, 0);
  await close();
  checks.push('Legacy service shows recovery guidance, cannot silently lose new instruction fields, and X closes');

  responseMode = 'offline';
  await open();
  await page.getByRole('alert').filter({ hasText: 'Synthetic service unavailable' }).waitFor();
  responseMode = 'current';
  await page.getByRole('button', { name: 'Retry loading story setup', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Retain my story.');
  await page.getByRole('button', { name: 'Add instruction', exact: true }).click();
  await page.getByLabel('Instruction 1 text', { exact: true }).fill('Retain my guidance.');
  await page.getByRole('button', { name: 'Save story setup', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Story setup saved.' }).waitFor();
  assert.equal(app.engine.stories.get(c.id).description, 'Retain my story.');
  assert.equal(app.engine.stories.get(c.id).additionalInstructions[0].content, 'Retain my guidance.');
  await close();
  checks.push('Failed load retries without refresh; editing, adding instructions, saving and closing work');

  responseMode = 'broken';
  await open();
  await page.getByRole('alert').filter({ hasText: 'could not display' }).waitFor();
  await close();
  responseMode = 'current';
  await open();
  assert.equal(await page.getByLabel('Description', { exact: true }).inputValue(), 'Retain my story.');
  await page.getByLabel('Description', { exact: true }).fill('Unsaved edit');
  page.once('dialog', d => d.dismiss());
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  assert.equal(await page.getByLabel('Description', { exact: true }).inputValue(), 'Unsaved edit');
  page.once('dialog', d => d.accept());
  await close();
  assert.equal(app.engine.stories.get(c.id).description, 'Retain my story.');
  checks.push('Unexpected panel render errors stay contained; X/reopen work and unsaved-close confirmation protects edits');
  assert.deepEqual(errors, []);
  const report = { checks, pageErrors: errors, personalDataTouched: false };
  await writeFile('artifacts/story-setup-recovery-ui-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await app?.close(); }
