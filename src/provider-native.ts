import { AppError } from './shared.ts';
import type { Connection, ProviderMessage, ToolCall } from './shared.ts';
import type { ProviderResult } from './provider.ts';
import { toolDefinitions } from './project-tools.ts';
import { messageParts } from './message-processing.ts';

const fail = (message = 'Malformed or incomplete native provider stream.'): never => { throw new AppError(message, 502); };
export function requestHeaders(c: Connection, key: string): Record<string, string> {
  if (/[\r\n]/.test(key)) throw new AppError('Invalid API key.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (c.dialect === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (c.provider === 'custom' && c.auth && c.auth !== 'auto') {
    if (key && c.auth !== 'none') headers[c.auth === 'bearer' ? 'Authorization' : c.auth] = c.auth === 'bearer' ? `Bearer ${key}` : key;
    return headers;
  }
  if (c.dialect === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (key) headers['x-api-key'] = key; }
  else if (['gemini', 'gemini-images'].includes(c.dialect) && c.provider !== 'opencode') { if (key) headers['x-goog-api-key'] = key; }
  else if (c.dialect === 'speech') { if (key) headers['xi-api-key'] = key; }
  else if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}
export function nativeRequest(c: Connection, messages: ProviderMessage[], tools: boolean): { url: string; body: any } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const rest = messages.filter(m => m.role !== 'system');
  if (c.dialect === 'responses') {
    const input = messages.flatMap((m): any[] => {
      if (m.native) return m.native;
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }];
      return [{ role: m.role, content: m.images?.length || m.parts ? messageParts(m).map(p => p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` }) : m.content || '' }, ...(m.tool_calls ?? []).map(t => ({ type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments }))];
    });
    return { url: c.endpoint + '/responses', body: { model: c.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'], ...(tools ? { tools: toolDefinitions.map(t => ({ type: 'function', ...t.function, strict: false })), tool_choice: 'auto' } : {}) } };
  }
  if (c.dialect === 'anthropic') {
    const converted: any[] = [];
    for (const m of rest) {
      const role = m.role === 'tool' ? 'user' : m.role;
      const content = m.native ?? (m.role === 'tool' ? [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '' }] : [
        ...messageParts(m).map(p => p.type === 'text' ? p : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }), ...(m.tool_calls ?? []).map(t => ({ type: 'tool_use', id: t.id, name: t.function.name, input: JSON.parse(t.function.arguments) })),
      ]);
      if (c.messageProcessing !== 'separate' && converted.at(-1)?.role === role) converted.at(-1).content.push(...content); else converted.push({ role, content });
    }
    return { url: c.endpoint + '/messages', body: { model: c.model, system, messages: converted, max_tokens: 8192, stream: true, ...(tools ? { tools: toolDefinitions.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}) } };
  }
  if (c.dialect === 'gemini') {
    const names = new Map(messages.flatMap(m => (m.tool_calls ?? []).map(t => [t.id, t.function.name] as const)));
    const contents: any[] = [];
    for (const m of rest) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts = m.native ?? (m.role === 'tool' ? [{ functionResponse: { name: names.get(m.tool_call_id!) || fail('Unknown Gemini tool result.'), response: { result: m.content }, ...(m.tool_call_id?.startsWith('gemini-local-') ? {} : { id: m.tool_call_id }) } }] : [
        ...messageParts(m).map(p => p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.data } }), ...(m.tool_calls ?? []).map(t => ({ functionCall: { name: t.function.name, args: JSON.parse(t.function.arguments) } })),
      ]);
      if (c.messageProcessing !== 'separate' && contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts); else contents.push({ role, parts });
    }
    return { url: `${c.endpoint}/models/${encodeURIComponent(c.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`, body: { systemInstruction: { parts: [{ text: system }] }, contents, ...(tools ? { tools: [{ functionDeclarations: toolDefinitions.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }] } : {}) } };
  }
  return fail('Unsupported native protocol.');
}
export async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`Provider HTTP ${response.status}. Response body withheld to protect credentials.`, 502); }
  if (!response.body) return fail('Provider returned no body.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) return fail('Provider response exceeded its safety limit.'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0; for (const c of chunks) { data.set(c, offset); offset += c.length; } return data;
}
export async function* sse(response: Response, signal: AbortSignal): AsyncGenerator<any> {
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`Provider HTTP ${response.status}. Response body withheld to protect credentials.`, 502); }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); return fail('Provider did not return an SSE stream.'); }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 1000000) return fail('Provider stream exceeded the 1 MB safety limit.');
      buffer += decoder.decode(chunk.value, { stream: true }); buffer = buffer.replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        let value: any; try { value = JSON.parse(data); } catch { return fail('Malformed provider SSE JSON.'); }
        if (!value || typeof value !== 'object' || value.error || value.type === 'error') return fail('Provider reported a stream error; raw details withheld.');
        yield value;
      }
    }
    if (buffer.trim()) return fail();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function checkedCalls(calls: ToolCall[], enabled: boolean): void {
  if (calls.length && !enabled) fail('Unexpected provider tool call.');
  if (calls.length > 6 || new Set(calls.map(c => c.id)).size !== calls.length) fail('Invalid/duplicate tool calls.');
  for (const c of calls) {
    if (typeof c.id !== 'string' || !c.id || c.id.length > 200 || typeof c.function.name !== 'string' || !c.function.name || c.function.name.length > 100 || typeof c.function.arguments !== 'string' || c.function.arguments.length > 18000) fail('Malformed tool call.');
    try { const v = JSON.parse(c.function.arguments); if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); } catch { fail('Malformed tool arguments.'); }
  }
}
export async function nativeReply(c: Connection, key: string, messages: ProviderMessage[], tools: boolean, signal: AbortSignal, onText: (text: string) => void, transport: typeof fetch): Promise<ProviderResult> {
  const req = nativeRequest(c, messages, tools);
  const response = await transport(req.url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), headers: requestHeaders(c, key), body: JSON.stringify(req.body) });
  let text = '', complete = false, finish = '', usage: unknown = null, responseId: string | undefined, started = false;
  let native: any[] = []; const calls: ToolCall[] = [], blocks = new Map<number, any>(), partial = new Map<number, string>(), stopped = new Set<number>();
  const add = (value: unknown) => { if (typeof value !== 'string') fail(); text += value; if (text.length > 64000) fail('Candidate exceeded the 64 KB limit.'); onText(text); };
  for await (const e of sse(response, signal)) {
    if (complete) fail('Unexpected data after provider completion.');
    if (c.dialect === 'responses') {
      if (e.type === 'response.output_text.delta') add(e.delta);
      else if (['response.failed', 'response.incomplete'].includes(e.type)) fail('Provider response was not complete.');
      else if (e.type === 'response.completed') {
        if (e.response?.status !== 'completed' || !Array.isArray(e.response.output)) fail();
        native = e.response.output; responseId = e.response.id; usage = e.response.usage; complete = true;
        let finalText = '';
        for (const item of native) {
          if (item.type === 'function_call') calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
          else if (item.type === 'message') { if (!Array.isArray(item.content)) fail(); for (const part of item.content) { if (part.type === 'output_text') { if (typeof part.text !== 'string') fail(); finalText += part.text; } else if (part.type === 'refusal') fail('Provider declined the request.'); } }
          else if (item.type !== 'reasoning') fail('Unexpected native output/tool type.');
        }
        if (text && text !== finalText) fail('Provider final text disagreed with its stream.');
        if (!text) add(finalText);
      }
    } else if (c.dialect === 'anthropic') {
      if (e.type === 'message_start') { if (started || e.message?.role !== 'assistant') fail(); started = true; responseId = e.message.id; usage = e.message.usage; }
      else if (e.type === 'content_block_start') {
        if (!started || !Number.isSafeInteger(e.index) || e.index < 0 || e.index > 63 || blocks.has(e.index) || !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(e.content_block?.type)) fail();
        const block = structuredClone(e.content_block); blocks.set(e.index, block);
        if (block.type === 'text') add(block.text);
      } else if (e.type === 'content_block_delta') {
        const b = blocks.get(e.index); if (!b || stopped.has(e.index)) fail(); const d = e.delta;
        if (d?.type === 'text_delta' && b.type === 'text') { add(d.text); b.text += d.text; }
        else if (d?.type === 'input_json_delta' && b.type === 'tool_use' && typeof d.partial_json === 'string') { const p = (partial.get(e.index) || '') + d.partial_json; if (p.length > 18000) fail('Tool call too large.'); partial.set(e.index, p); }
        else if (d?.type === 'thinking_delta' && b.type === 'thinking' && typeof d.thinking === 'string') b.thinking = (b.thinking || '') + d.thinking;
        else if (d?.type === 'signature_delta' && b.type === 'thinking' && typeof d.signature === 'string') b.signature = (b.signature || '') + d.signature;
        else fail();
      } else if (e.type === 'content_block_stop') {
        const b = blocks.get(e.index); if (!b || stopped.has(e.index)) fail(); stopped.add(e.index);
        if (b.type === 'tool_use' && partial.get(e.index)) { try { b.input = JSON.parse(partial.get(e.index)!); } catch { fail('Malformed tool arguments.'); } }
      } else if (e.type === 'message_delta') { if (e.delta?.stop_reason) finish = e.delta.stop_reason; if (e.usage) usage = { ...(usage as object), ...e.usage }; }
      else if (e.type === 'message_stop') {
        if (!started || blocks.size !== stopped.size || !['end_turn', 'stop_sequence', 'tool_use'].includes(finish)) fail();
        native = [...blocks].sort(([a], [b]) => a - b).map(([, b]) => b);
        for (const b of native) if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } });
        if ((calls.length > 0) !== (finish === 'tool_use')) fail(); complete = true;
      }
    } else if (c.dialect === 'gemini') {
      if (e.promptFeedback?.blockReason) fail('Gemini blocked this request.');
      if (e.usageMetadata) usage = e.usageMetadata;
      if (!Array.isArray(e.candidates) || !e.candidates.length) { if (e.usageMetadata) continue; fail(); }
      if (finish) fail('Unexpected Gemini content after completion.');
      if (e.candidates.length !== 1) fail(); const candidate = e.candidates[0];
      if (candidate.index !== undefined && candidate.index !== 0) fail();
      for (const p of candidate.content?.parts ?? []) {
        native.push(p);
        if (p.text !== undefined && !p.thought) add(p.text);
        else if (p.functionCall) { const f = p.functionCall; calls.push({ id: f.id || `gemini-local-${calls.length}`, type: 'function', function: { name: f.name, arguments: JSON.stringify(f.args) } }); }
        else if (!p.thought && !p.thoughtSignature) fail('Unexpected Gemini content type.');
      }
      if (candidate.finishReason) { if (candidate.finishReason !== 'STOP') fail('Gemini did not finish normally.'); finish = 'STOP'; }
      if (e.responseId) responseId = e.responseId;
    }
  }
  if (c.dialect === 'gemini') complete = finish === 'STOP';
  if (!complete) fail(); checkedCalls(calls, tools);
  if (!text.trim() && !calls.length) fail('Provider returned an empty reply.');
  return { text, calls, usage, native, responseId };
}
