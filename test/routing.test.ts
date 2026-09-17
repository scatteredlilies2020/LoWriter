import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { connect } from 'node:net';
import { createServer as httpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { validateConnection, streamReply } from '../src/provider.ts';
import { routePolicy, networkKind } from '../src/route-policy.ts';
import { routedFetch, socksAvailable, detectTor } from '../src/transport.ts';
import { listModels, listVoices, speak } from '../src/provider-services.ts';

const signal = () => AbortSignal.timeout(5000);
const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const reply = event({ content: 'Routed fixture' }) + event({}, 'stop') + 'data: [DONE]\n\n';

test('SOCKS5H aliases SOCKS5 with private hostname routing and existing credential guards', () => {
  assert.deepEqual(routePolicy('http://fixture.onion/v1', 'auto', 'socks5h://127.0.0.1:9150'), { route: 'tor', proxyUrl: 'socks5://127.0.0.1:9150' });
  assert.equal(validateConnection({ endpoint: 'https://fixture.invalid/v1', dialect: 'chat-completions', model: 'test', route: 'proxy', proxyUrl: 'socks5h://127.0.0.1:9050' }).proxyUrl, 'socks5://127.0.0.1:9050');
  assert.throws(() => routePolicy('http://fixture.onion/v1', 'auto', 'socks5h://user:password@127.0.0.1:9050'), /credentials/);
  assert.throws(() => routePolicy('http://fixture.i2p/v1', 'auto', 'socks5h://127.0.0.1:9050'), /HTTP/);
});
test('automatic Tor detection tries daemon then browser port and never substitutes a direct route', async () => {
  const ports: number[] = [];
  assert.equal(await detectTor(signal(), async p => { ports.push(p); return p === 9150; }), 'socks5://127.0.0.1:9150');
  assert.deepEqual(ports, [9050, 9150]);
  await assert.rejects(detectTor(signal(), async () => false), /Nothing was sent directly/);
  const controller = new AbortController(); controller.abort(); let probes = 0;
  await assert.rejects(detectTor(controller.signal, async () => { probes++; return true; })); assert.equal(probes, 0);
});
async function listen(t: TestContext, server: any) {
  const sockets = new Set<any>(); server.on('connection', (s: any) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(r)); });
  return (server.address() as { port: number }).port;
}
test('automatic route policy covers regular, onion, I2P and trailing dots; incompatible routes fail closed', () => {
  assert.equal(routePolicy('https://example.com/v1').route, 'direct');
  assert.equal(routePolicy('http://private.onion/v1').route, 'tor');
  assert.deepEqual(routePolicy('http://private.i2p/v1'), { route: 'i2p', proxyUrl: 'http://127.0.0.1:4444' });
  assert.equal(routePolicy('https://private.i2p/v1').proxyUrl, 'http://127.0.0.1:4445');
  assert.equal(networkKind(new URL('http://PRIVATE.ONION./v1')), 'tor');
  assert.equal(routePolicy('https://example.com', 'tor').route, 'tor');
  for (const route of ['direct', 'i2p', 'proxy'] as const) assert.throws(() => routePolicy('http://private.onion', route, 'http://127.0.0.1:4444'), /fallback/);
  assert.throws(() => routePolicy('https://example.com', 'i2p'), /outproxy/);
  for (const proxy of ['socks5://remote.example:9050', 'http://127.0.0.1:9050', 'socks5://secret:password@127.0.0.1:9050']) assert.throws(() => routePolicy('http://private.onion', 'auto', proxy));
  assert.throws(() => routePolicy('https://example.com', 'proxy'), /Enter/);
  assert.throws(() => routePolicy('https://example.com', 'direct', 'http://127.0.0.1:8080'));
  assert.equal(validateConnection({ endpoint: 'http://private.onion/v1', model: 'test' }).route, 'auto');
});
test('I2P HTTP proxy receives private hostname, chat, catalogs and speech; no destination DNS or redirects', async t => {
  const seen: { url: string; auth: string | undefined }[] = [];
  const port = await listen(t, httpServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization }); req.resume();
    if (req.url?.includes('/redirect')) { res.writeHead(307, { Location: 'http://127.0.0.1:9/forbidden' }); res.end(); }
    else if (req.url?.includes('/text-to-speech/')) { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from('synthetic MP3 fixture')); }
    else if (req.url?.endsWith('/voices')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ voices: [{ voice_id: 'testvoice', name: 'Fixture' }] })); }
    else if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); }
    else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(reply); }
  }));
  const c = validateConnection({ endpoint: 'http://unresolvable-fixture.i2p/v1', model: 'test', proxyUrl: `http://127.0.0.1:${port}` });
  assert.equal((await streamReply(c, 'synthetic-key', [], false, signal(), () => {})).text, 'Routed fixture');
  assert.deepEqual((await listModels(c, 'synthetic-key', signal())).models, [{ id: 'fixture-model', name: 'fixture-model' }]);
  const speech = validateConnection({ ...c, dialect: 'speech', auth: 'bearer' });
  assert.equal((await listVoices(speech, 'synthetic-key', signal())).voices[0].id, 'testvoice');
  assert.equal(new TextDecoder().decode(await speak(speech, 'synthetic-key', { voice: 'testvoice', text: 'fixture' }, signal())), 'synthetic MP3 fixture');
  await assert.rejects(routedFetch(c)(c.endpoint + '/redirect', { signal: signal() }), /fallback/);
  assert.equal(seen.length, 5); assert.ok(seen.every(r => r.url.startsWith('http://unresolvable-fixture.i2p/v1/')));
  assert.ok(seen.slice(0, 4).every(r => r.auth === 'Bearer synthetic-key'));
});
test('SOCKS5 sends onion hostname to router, supports fragmented handshake and local-only availability probe', async t => {
  const names: string[] = []; let requests = 0;
  const port = await listen(t, tcpServer(socket => {
    let stage = 0, buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 3) {
        const size = 2 + buffer[1]; if (buffer.length < size) return;
        assert.equal(buffer[0], 5); buffer = buffer.subarray(size); stage = 1;
        socket.write(Buffer.from([5])); setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.from([0])); }, 5);
      }
      if (stage === 1 && buffer.length >= 5) {
        assert.equal(buffer[3], 3, 'SOCKS must send domain name, not resolve target locally');
        const size = 7 + buffer[4]; if (buffer.length < size) return;
        names.push(buffer.subarray(5, 5 + buffer[4]).toString()); buffer = buffer.subarray(size); stage = 2;
        socket.write(Buffer.from([5, 0, 0, 1])); setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.from([127, 0, 0, 1, 0, 80])); }, 5);
      }
      if (stage === 2 && buffer.includes('\r\n\r\n')) {
        requests++; stage = 3;
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`);
      }
    });
  }));
  assert.equal(await socksAvailable(port, signal()), true); assert.deepEqual(names, [], 'probe must not send target or credentials');
  const c = validateConnection({ endpoint: 'http://synthetic.onion/v1', model: 'test', route: 'auto', proxyUrl: `socks5://127.0.0.1:${port}` });
  assert.equal((await streamReply(c, 'synthetic-key', [], false, signal(), () => {})).text, 'Routed fixture');
  assert.deepEqual(names, ['synthetic.onion']); assert.equal(requests, 1);
});
test('failed proxy cannot fall back to reachable direct destination; redirects and cross-origin requests blocked', async t => {
  let directHits = 0;
  const port = await listen(t, httpServer((req, res) => { directHits++; req.resume(); res.end('direct leak'); }));
  const dead = tcpServer(); await new Promise<void>(r => dead.listen(0, '127.0.0.1', r)); const deadPort = (dead.address() as { port: number }).port; await new Promise<void>(r => dead.close(() => r()));
  const c = validateConnection({ endpoint: `http://127.0.0.1:${port}/v1`, model: 'test', route: 'proxy', proxyUrl: `http://127.0.0.1:${deadPort}` });
  await assert.rejects(routedFetch(c)(c.endpoint + '/models', { signal: signal() }), /No direct fallback/);
  await assert.rejects(routedFetch(c)('http://127.0.0.1:9/v1/models'), /Cross-origin/);
  assert.equal(directHits, 0);
});
test('direct route ignores ambient proxy configuration and cancellation closes in-flight route', async t => {
  let closed!: () => void; const ended = new Promise<void>(r => { closed = r; }); let received!: () => void; const began = new Promise<void>(r => { received = r; });
  const port = await listen(t, httpServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); req.socket.once('close', closed); received(); }));
  const old = process.env.HTTP_PROXY; process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  try {
    const c = validateConnection({ endpoint: `http://127.0.0.1:${port}/v1`, model: 'test' }), controller = new AbortController();
    const response = await routedFetch(c)(c.endpoint + '/models', { signal: controller.signal }); await began; const reading = response.text(); controller.abort();
    await assert.rejects(reading); await Promise.race([ended, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Socket did not close')), 2000); timer.unref(); })]);
  } finally { if (old === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = old; }
});
test('HTTPS proxy uses CONNECT and rejects an untrusted destination certificate before sending API credentials', async t => {
  let targetHits = 0, tunnels = 0;
  const targetPort = await listen(t, httpsServer({ key: await readFile('test/fixtures/untrusted-test-key.pem'), cert: await readFile('test/fixtures/untrusted-test-cert.pem') }, (req, res) => { targetHits++; req.resume(); res.end('must not arrive'); }));
  const proxy = httpServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels++; assert.equal(req.url, `synthetic.invalid:${targetPort}`); assert.equal(req.headers.authorization, undefined);
    const upstream = connect(targetPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(t, proxy);
  const c = validateConnection({ endpoint: `https://synthetic.invalid:${targetPort}/v1`, model: 'test', route: 'proxy', proxyUrl: `http://127.0.0.1:${proxyPort}` });
  await assert.rejects(routedFetch(c)(c.endpoint + '/models', { headers: { Authorization: 'Bearer synthetic-key' }, signal: signal() }), /No direct fallback/);
  assert.equal(tunnels, 1); assert.equal(targetHits, 0);
});
