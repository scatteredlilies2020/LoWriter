import { createServer } from 'node:http';
import { hash } from './project-tools.ts';

// Deterministic, intentionally limited demo. No credentials or internet access.
export async function startMock(port = 0) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const part of req) { raw += part; if (raw.length > 250000) { res.writeHead(413).end(); return; } }
    let body: any; try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    const lastUser = body.messages?.findLast((m: any) => m.role === 'user')?.content ?? '';
    if (lastUser.includes('[http-error]')) { res.writeHead(401).end('Secret error body must not be reflected.'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (lastUser.includes('[malformed]')) { res.end('data: not-json\n\n'); return; }
    if (lastUser.includes('[incomplete]')) { event({ content: 'An unfinished candidate' }); res.end(); return; }
    const toolResults = body.messages.slice(body.messages.findLastIndex((m: any) => m.role === 'user') + 1).filter((m: any) => m.role === 'tool');
    if (lastUser.toLowerCase().includes('demo coding') && body.tools?.length && toolResults.length < 4) {
      const n = toolResults.length;
      let name = 'list_files', args: any = { path: '.' };
      if (n === 1) { name = 'read_text'; args = { path: 'greeting.js' }; }
      if (n === 2) {
        name = 'write_text';
        let previous: any; try { previous = JSON.parse(toolResults[1].content); } catch { previous = {}; }
        args = { path: 'greeting.js', expectedHash: previous.sha256 ?? 'missing', content: 'export const greeting = "Hello from LoWriter";\n' };
      }
      if (n === 3) { name = 'check_javascript'; args = { path: 'greeting.js' }; }
      event({ tool_calls: [{ index: 0, id: `demo-call-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      event({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    const codingSuccess = toolResults.length === 4 && (() => { try { return JSON.parse(toolResults[3].content).exitCode === 0; } catch { return false; } })();
    const text = lastUser.includes('[slow]') ? 'This deliberately slow demo can be stopped without committing its partial reply. '.repeat(10)
      : toolResults.length ? codingSuccess ? 'Demo complete: inspected the project, read greeting.js, saved a checkpoint and diff, changed the greeting, and passed node --check. This proves syntax only, not runtime behavior.' : 'The demo coding task encountered a tool failure. Review the action output; I cannot claim the change or test passed.'
      : `This is a local demo, not a live AI model.\n\n${lastUser.toLowerCase().includes('story') ? 'The last train had left an hour ago, but a warm light still glowed in the station window. On the bench lay a letter addressed to you.\n\nWhat would you like to happen next?' : 'Your message is saved here, and this reply is arriving as a real SSE stream. Open Connections to configure a compatible provider, or switch to Coding to try a controlled project task.'}`;
    for (const part of text.match(/.{1,12}|\n/g) ?? []) {
      if (res.destroyed) return;
      event({ content: part });
      await new Promise(resolve => setTimeout(resolve, lastUser.includes('[slow]') ? 100 : 12));
    }
    event({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
