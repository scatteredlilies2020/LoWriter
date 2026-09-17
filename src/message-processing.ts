import { AppError } from './shared.ts';
import type { MessagePart, MessageProcessing, ProviderMessage } from './shared.ts';

export function messageParts(m: ProviderMessage): MessagePart[] {
  return m.parts || [...(m.content !== null && m.content !== '' ? [{ type: 'text' as const, text: m.content }] : []), ...(m.images || []).map(i => ({ type: 'image' as const, ...i }))];
}
const structured = (m: ProviderMessage) => ['native', 'tool_calls', 'tool_call_id', 'reasoning_content', 'reasoning_details'].some(k => Object.hasOwn(m, k));
const dialogue = (m: ProviderMessage) => ['user', 'assistant'].includes(m.role) && !structured(m);
const plain = (m: ProviderMessage) => ['system', 'developer', 'user', 'assistant'].includes(m.role) && !structured(m);
function join(a: ProviderMessage, b: ProviderMessage): ProviderMessage {
  const content = [a.content, b.content].filter(v => v !== null && v !== '').join('\n\n');
  const parts = [...messageParts(a)];
  for (const [index, part] of messageParts(b).entries()) {
    const last = parts.at(-1);
    if (part.type === 'text' && last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + (index === 0 ? '\n\n' : '') + part.text };
    else parts.push(part.type === 'text' && index === 0 && parts.length ? { ...part, text: '\n\n' + part.text } : part);
  }
  return { role: a.role, content, ...(parts.some(p => p.type === 'image') ? { parts } : {}) };
}
export function prefillStart(messages: ProviderMessage[]): number {
  let start = messages.length;
  while (start && messages[start - 1].role === 'assistant' && dialogue(messages[start - 1])) start--;
  return start;
}
export function processMessages(messages: ProviderMessage[], mode: MessageProcessing = 'merge', tools = false, userPrefill = false): ProviderMessage[] {
  const copy = structuredClone(messages), tail = prefillStart(copy);
  if (userPrefill) for (let i = tail; i < copy.length; i++) copy[i].role = 'user';
  // Never flatten tool calls, results or signed/encrypted provider continuation data.
  const effective = mode === 'single' && (tools || copy.some(m => structured(m) || m.role === 'tool')) ? 'merge' : mode;
  const result: ProviderMessage[] = [];
  for (let i = 0; i < copy.length; i++) {
    let m = copy[i];
    // Single-user dialogue still retains the trailing assistant block as a prefill.
    // System/developer boundaries stay separate and are never promoted/demoted.
    if (effective === 'single' && dialogue(m) && (userPrefill || i < tail)) m = { ...m, role: 'user' };
    const last = result.at(-1);
    if (effective !== 'separate' && last && last.role === m.role && plain(last) && plain(m)) result[result.length - 1] = join(last, m);
    else result.push(m);
  }
  return result;
}

export class PrefillRejected extends AppError {
  constructor() { super('Provider rejected assistant prefill.', 502); }
}
// Match explicit format rejection, never content refusals, generic 400s, billing,
// timeout, rate-limit or safety errors. Do not return raw provider diagnostics.
export function rejectsPrefill(message: string): boolean {
  const text = message.toLowerCase().replace(/[\r\n]+/g, ' ').slice(0, 2000);
  if (/\b(?:content_filter|content policy|safety|refusal|refused|moderation|billing|quota|rate.limit|api.key|authentication|unauthori[sz]ed|permission)\b/.test(text)) return false;
  return /(?:does not support|do not support|cannot accept|not support)[^.]{0,100}(?:assistant.{0,20})?prefill/.test(text)
    || /prefill(?:ing)?[^.]{0,100}(?:not supported|unsupported|not allowed|is disabled|is not permitted)/.test(text)
    || /(?:requests? |messages? )?ending (?:with|in) (?:an? )?(?:assistant|model) (?:turn|message)[^.]{0,80}(?:not supported|not allowed|unsupported)/.test(text)
    || /(?:last|final) (?:message|turn|role)[^.]{0,60}(?:must|should|has to) (?:be|have)[^.]{0,25}["'`]?user\b/.test(text)
    || /(?:must not|cannot|can't|may not) end (?:with|on|in) (?:an? )?(?:assistant|model) (?:message|turn)/.test(text);
}
function errorMessage(value: any, depth = 0): string {
  if (depth > 6) return '';
  if (typeof value === 'string') { try { return errorMessage(JSON.parse(value), depth + 1); } catch { return value; } }
  if (!value || typeof value !== 'object') return '';
  if (value.error !== undefined) return errorMessage(value.error, depth + 1);
  if (typeof value.message === 'string') return value.message;
  if (value.metadata?.raw !== undefined) return errorMessage(value.metadata.raw, depth + 1);
  return '';
}
export async function checkPrefillRejection(response: Response, signal: AbortSignal): Promise<boolean> {
  if (![400, 422].includes(response.status) || !response.body) return false;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0, expired = false;
  const stop = () => { expired = true; void reader.cancel().catch(() => {}); };
  const timer = setTimeout(stop, 3000); signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) return false;
    while (!expired) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 16384) return false; chunks.push(value);
    }
    if (expired) return false;
    const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const raw = new TextDecoder().decode(data);
    return rejectsPrefill(errorMessage(raw));
  } catch { return false; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
