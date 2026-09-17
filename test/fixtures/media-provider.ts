// Local, deterministic provider fixture. Never contacts a real API.
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
function fixturePng() {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(480, 0); header.writeUInt32BE(280, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(280 * (480 * 3 + 1));
  for (let y = 0; y < 280; y++) for (let x = 0; x < 480; x++) {
    const n = y * 1441 + 1 + x * 3, sun = Math.hypot(x - 350, y - 80) < 30;
    const color = sun ? [238,177,93] : y > 170 ? [35,70 + Math.floor(y / 10),85] : [65 + Math.floor(y / 3),78 + Math.floor(y / 4),115];
    pixels.set(color, n);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
export const png = fixturePng();
export async function mediaProvider() {
  const calls: { url: string; body: any; auth: string }[] = [];
  let image = 0, reply = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw || '{}'); calls.push({ url: req.url!, body, auth: String(req.headers.authorization || req.headers['xi-api-key'] || '') });
    if (body.prompt === 'slow') { const timer = setTimeout(() => res.end('{}'), 20000); res.on('close', () => clearTimeout(timer)); return; }
    if (body.prompt === 'fail') { res.writeHead(500).end('private fixture diagnostic'); return; }
    if (req.url === '/v1/images/generations') {
      // Distinct bytes for assertions, harmless trailing bytes after PNG IEND.
      const data = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from(String(++image))]);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: data.toString('base64') }] })); return;
    }
    if (req.url === '/v1/audio/speech' || req.url?.startsWith('/v1/text-to-speech/')) { res.setHeader('Content-Type', 'audio/mpeg'); res.end('ID3 synthetic audio fixture'); return; }
    if (req.url === '/v1/voices') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ voices: [{ voice_id: 'fixture_voice', name: 'Fixture narrator' }] })); return; }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: `Scene ${++reply}: **A lantern** beside the quiet lake.` }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { calls, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}
