import { AppError } from './shared.ts';
import type { Connection, ProviderMessage, ToolCall } from './shared.ts';
import { toolDefinitions } from './project-tools.ts';
import { preset, resolvePreset } from './provider-catalog.ts';
import { nativeReply, requestHeaders } from './provider-native.ts';
import { networkKind, routePolicy } from './route-policy.ts';
import { routedFetch } from './transport.ts';

export function validateConnection(value: any): Connection {
  if (!value) throw new AppError('Invalid connection.');
  const provider = value.provider ?? 'custom'; preset(provider);
  const resolved = provider === 'custom' ? { endpoint: value.endpoint, dialect: value.dialect ?? 'chat-completions' } : resolvePreset(provider, value.variant, value.region, value.model);
  if (!['chat-completions', 'responses', 'anthropic', 'gemini', 'speech'].includes(resolved.dialect)) throw new AppError('Unsupported API dialect.');
  const auth = provider === 'custom' ? value.auth ?? 'auto' : 'auto';
  if (!['auto', 'bearer', 'x-api-key', 'x-goog-api-key', 'xi-api-key', 'none'].includes(auth)) throw new AppError('Unsupported authentication mode.');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 80)) throw new AppError('Connection name must be at most 80 characters.');
  let url: URL;
  try { url = new URL(resolved.endpoint); } catch { throw new AppError('Invalid endpoint URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new AppError('Endpoint cannot include credentials, query parameters, or fragments.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || networkKind(url) !== 'regular'))) throw new AppError('Use HTTPS, or HTTP only for loopback / routed private-network endpoints.');
  const route = value.route ?? 'auto'; routePolicy(url.href, route, value.proxyUrl);
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) throw new AppError('Enter an exact model ID.');
  return { ...resolved, endpoint: url.href.replace(/\/$/, ''), model: value.model.trim(), dialect: resolved.dialect, route, ...(value.proxyUrl ? { proxyUrl: routePolicy(url.href, route, value.proxyUrl).proxyUrl } : {}), provider, auth, ...(value.name?.trim() ? { name: value.name.trim() } : {}) };
}
export interface ProviderResult { text: string; calls: ToolCall[]; usage: unknown; native?: any[]; reasoning_content?: string; reasoning_details?: any[]; responseId?: string }
export async function streamReply(connection: Connection, key: string, messages: ProviderMessage[], enableTools: boolean, signal: AbortSignal, onText: (text: string) => void, transport?: typeof fetch): Promise<ProviderResult> {
  const checked = validateConnection(connection);
  transport ??= routedFetch(checked);
  if (checked.dialect === 'speech') throw new AppError('ElevenLabs is a speech connection, not a chat model.');
  if (checked.dialect !== 'chat-completions') return nativeReply(checked, key, messages, enableTools, signal, onText, transport);
  const response = await transport(`${checked.endpoint}/chat/completions`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    headers: requestHeaders(checked, key),
    body: JSON.stringify({ model: checked.model, messages: messages.map(({ native, ...m }) => m), stream: true, ...(enableTools ? { tools: toolDefinitions, tool_choice: 'auto' } : {}) })
  });
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`Provider HTTP ${response.status}. Response body withheld to protect credentials.`, 502); }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) { await response.body?.cancel(); throw new AppError('Provider did not return an SSE stream.', 502); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', reasoning_content = '', bytes = 0, done = false, finished = '', usage: unknown = null;
  const calls = new Map<number, ToolCall>();
  const reasoning_details: any[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1000000) throw new AppError('Provider stream exceeded the 1 MB safety limit.', 502);
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { done = true; break; }
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { throw new AppError('Malformed provider SSE JSON.', 502); }
        if (!parsed || parsed.error || !Array.isArray(parsed.choices)) throw new AppError('Malformed provider response envelope.', 502);
        if (parsed.usage) usage = parsed.usage;
        if (!parsed.choices.length) continue;
        const choice = parsed.choices[0];
        if (!choice || (choice.index !== undefined && choice.index !== 0) || !choice.delta || typeof choice.delta !== 'object') throw new AppError('Malformed provider choice.', 502);
        if (choice.finish_reason) finished = choice.finish_reason;
        const delta = choice.delta;
        // Aggregator-native signed/encrypted blocks must survive the in-flight tool round unchanged.
        if (delta.reasoning_details !== undefined && delta.reasoning_details !== null) {
          if (!Array.isArray(delta.reasoning_details) || delta.reasoning_details.some((r: any) => !r || typeof r !== 'object' || Array.isArray(r))) throw new AppError('Malformed reasoning details.', 502);
          reasoning_details.push(...delta.reasoning_details);
        }
        if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
          if (typeof delta.reasoning_content !== 'string') throw new AppError('Malformed reasoning content.', 502);
          reasoning_content += delta.reasoning_content;
        }
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== 'string') throw new AppError('Provider content must be text.', 502);
          text += delta.content;
          if (text.length > 64000) throw new AppError('Candidate exceeded the 64 KB limit.', 502);
          onText(text);
        }
        if (delta.tool_calls !== undefined) {
          if (!enableTools || !Array.isArray(delta.tool_calls)) throw new AppError('Unexpected provider tool call.', 502);
          for (const part of delta.tool_calls) {
            if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 6) throw new AppError('Invalid tool call index.', 502);
            const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
            for (const v of [part.id, part.function?.name, part.function?.arguments]) if (v !== undefined && typeof v !== 'string') throw new AppError('Malformed tool call fields.', 502);
            if (part.id) call.id += part.id;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
            if (call.function.arguments.length > 18000 || call.id.length > 200 || call.function.name.length > 100) throw new AppError('Tool call too large.', 502);
            calls.set(part.index, call);
          }
        }
      }
      if (done) break;
    }
    if (!done || !['stop', 'tool_calls'].includes(finished)) throw new AppError('Provider stream ended without a complete, usable finish.', 502);
    if ((calls.size > 0) !== (finished === 'tool_calls')) throw new AppError('Provider finish/tool mismatch.', 502);
    if (!text.trim() && !calls.size) throw new AppError('Provider returned an empty reply.', 502);
    const result = [...calls.values()];
    if (new Set(result.map(c => c.id)).size !== result.length || result.some(c => !c.id || !c.function.name || !c.function.arguments)) throw new AppError('Incomplete or duplicate tool calls.', 502);
    return { text, calls: result, usage, ...(reasoning_content ? { reasoning_content } : {}), ...(reasoning_details.length ? { reasoning_details } : {}) };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
