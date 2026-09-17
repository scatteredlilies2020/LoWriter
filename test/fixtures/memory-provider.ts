import { createServer } from 'node:http';
import { extractionSchema } from '../../src/continuity-core.ts';
function empty(schema: any): any {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, empty(s)]));
  if (schema.type === 'array') return [];
  return schema.enum?.[0] ?? (schema.type === 'integer' ? schema.minimum || 1 : '');
}
export function extraction(): any {
  const result = empty(extractionSchema);
  result.scene = { location: 'Harbor', time: '', participants: ['Mara'], activity: 'Watching the water', mood: 'Quiet' };
  Object.assign(result.sceneCapsule, { title: 'The harbor lantern', location: 'Harbor', participants: ['Mara'], opening: 'Mara keeps a blue lantern at the harbor.', beats: ['Mara watches the water.'], closing: 'The blue lantern stays with Mara.', importance: 4 });
  result.facts = [{ targetId: '', subject: 'Mara', predicate: 'keeps', value: 'a blue lantern at the harbor', category: 'possession', importance: 4, persistence: 'persistent' }];
  result.chronicleEntry = 'Mara keeps a blue lantern at the harbor and watches the water.';
  return result;
}
export async function memoryProvider() {
  const calls: any[] = [];
  const authorizations: (string | undefined)[] = [];
  const control = { slow: false, invalid: false, replyDelay: 0 };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw); calls.push(body); authorizations.push(req.headers.authorization);
    const isMemory = body.messages[0]?.content.includes('Return exactly one complete JSON object');
    if (control.slow && isMemory) { const timer = setTimeout(() => res.end(), 20000); res.on('close', () => clearTimeout(timer)); return; }
    if (!isMemory && control.replyDelay) await new Promise(r => setTimeout(r, control.replyDelay));
    const content = isMemory ? control.invalid ? 'not JSON' : JSON.stringify(extraction()) : 'Mara watches the harbor water.';
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { calls, authorizations, control, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}
