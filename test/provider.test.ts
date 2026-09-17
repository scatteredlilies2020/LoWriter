import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateConnection, streamReply } from '../src/provider.ts';
import { fixture } from './helpers.ts';

const base = { endpoint: 'https://example.com/v1', model: 'exact-model', dialect: 'chat-completions', route: 'direct' };
test('connection validator rejects insecure, credential-bearing, private and unimplemented routes', () => {
  for (const endpoint of ['http://example.com/v1', 'https://name:pass@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'https://hidden.onion/v1', 'https://hidden.i2p/v1', 'file:///etc/passwd']) assert.throws(() => validateConnection({ ...base, endpoint }));
  assert.throws(() => validateConnection({ ...base, route: 'unsupported' }), /fallback/); assert.throws(() => validateConnection({ ...base, dialect: 'unknown-protocol' }), /dialect/);
});
async function rawProvider(t: any, text: string, status = 200, headers: Record<string, string> = {}) {
  let hits = 0;
  const server = createServer((req, res) => { hits++; req.resume(); res.writeHead(status, { 'Content-Type': 'text/event-stream', ...headers }); res.end(text); });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  t.after(() => new Promise<void>(yes => { server.closeAllConnections(); server.close(() => yes()); }));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { connection: validateConnection({ ...base, endpoint }), hits: () => hits };
}
const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
test('provider follows no redirects and makes no automatic retry', async t => { const p = await rawProvider(t, '', 307, { Location: 'http://127.0.0.1:9/steal' }); await assert.rejects(streamReply(p.connection, 'synthetic-test-key', [], false, new AbortController().signal, () => {})); assert.equal(p.hits(), 1); });
test('provider rejects unsolicited RP tool calls', async t => { const p = await rawProvider(t, event({ tool_calls: [{ index: 0, id: 'call', function: { name: 'write_text', arguments: '{}' } }] }) + event({}, 'tool_calls') + 'data: [DONE]\n\n'); await assert.rejects(streamReply(p.connection, '', [], false, new AbortController().signal, () => {}), /Unexpected/); });
test('provider rejects truncated length finish, empty replies and wrong envelopes', async t => {
  for (const raw of [event({ content: 'cut' }, 'length') + 'data: [DONE]\n\n', event({}, 'stop') + 'data: [DONE]\n\n', 'data: {"other":true}\n\n']) { const p = await rawProvider(t, raw); await assert.rejects(streamReply(p.connection, '', [], false, new AbortController().signal, () => {})); }
});
test('provider accepts CRLF framing and rejects excessive output', async t => {
  const p = await rawProvider(t, (event({ content: 'Hello' }) + event({}, 'stop') + 'data: [DONE]\n\n').replaceAll('\n', '\r\n')); assert.equal((await streamReply(p.connection, '', [], false, new AbortController().signal, () => {})).text, 'Hello');
  const big = await rawProvider(t, event({ content: 'x'.repeat(64001) })); await assert.rejects(streamReply(big.connection, '', [], false, new AbortController().signal, () => {}), /64 KB/);
});
test('known key echoes are redacted from job snapshots and SQLite history', async t => {
  const { app, request, wait } = await fixture(t), secret = 'synthetic-private-key-abcdefgh';
  const p = await rawProvider(t, event({ content: 'Echo: ' + secret.slice(0, 15) }) + event({ content: secret.slice(15) }) + event({}, 'stop') + 'data: [DONE]\n\n');
  await app.vault.unlock('synthetic long passphrase'); await app.vault.set('provider', secret); app.store.setSetting('connection', p.connection);
  const c = app.store.create('rp', 'Redaction'); const j = app.engine.start(c.id, 'Redact echo', 0); const done = await wait(j.id); assert.equal(done.status, 'complete'); assert.ok(!done.text.includes(secret)); assert.match(done.text, /REDACTED/); assert.ok(!JSON.stringify(app.store.messages(c.id)).includes(secret));
});
