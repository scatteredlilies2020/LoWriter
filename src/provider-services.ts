import { AppError, requireString } from './shared.ts';
import type { Connection } from './shared.ts';
import { preset } from './provider-catalog.ts';
import { boundedBody, requestHeaders } from './provider-native.ts';
import { routedFetch } from './transport.ts';

async function getJson(c: Connection, key: string, url: string, signal: AbortSignal, transport: typeof fetch): Promise<any> {
  const response = await transport(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { ...requestHeaders(c, key), Accept: 'application/json' } });
  const data = await boundedBody(response, 4000000);
  try { return JSON.parse(new TextDecoder().decode(data)); } catch { throw new AppError('Provider returned invalid JSON; raw data withheld.', 502); }
}
const safeId = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && s.length <= 200 && !/[\x00-\x1f]/.test(s);
export async function listModels(c: Connection, key: string, signal: AbortSignal, transport: typeof fetch = routedFetch(c)) {
  const p = preset(c.provider || 'custom');
  if (p.discovery === false) return { models: (p.models || []).map(id => ({ id, name: id })), source: 'documentation', partial: false, note: 'Documentation suggestions only. Enter an exact model ID from your account; this service has no integrated model-list endpoint.' };
  // Aggregators return a compatible catalog even when a selected model uses native generation.
  const google = c.dialect === 'gemini' && c.provider !== 'opencode';
  const anthropic = c.dialect === 'anthropic' && !['opencode', 'aws-mantle'].includes(c.provider || '');
  const endpoint = c.provider === 'aws-mantle' ? c.endpoint.replace('/anthropic/v1', '/v1') : c.endpoint;
  const catalogConnection = ['opencode', 'aws-mantle'].includes(c.provider || '') ? { ...c, dialect: 'chat-completions' as const } : c;
  const data = await getJson(catalogConnection, key, endpoint + '/models' + (google ? '?pageSize=1000' : anthropic ? '?limit=100' : ''), signal, transport);
  let raw: any[] = google ? data.models : c.dialect === 'speech' ? data : data.data;
  if (!Array.isArray(raw)) throw new AppError('Provider model catalog has an unsupported format.', 502);
  if (google) raw = raw.filter(m => m?.supportedGenerationMethods?.includes('generateContent'));
  if (c.dialect === 'speech') raw = raw.filter(m => m?.can_do_text_to_speech);
  const models = raw.slice(0, 2000).map(m => ({ id: google ? m?.name?.replace(/^models\//, '') : c.dialect === 'speech' ? m?.model_id : m?.id, name: m?.displayName || m?.display_name || m?.name || m?.id || m?.model_id })).filter(m => safeId(m.id)).map(m => ({ id: m.id as string, name: typeof m.name === 'string' ? m.name.slice(0, 200) : m.id as string }));
  return { models, source: 'provider', partial: !!data.nextPageToken || !!data.has_more || raw.length > 2000, note: 'Catalog only—not proof of billing, account access, or tool support. You can always enter a model ID manually.' };
}
export async function listVoices(c: Connection, key: string, signal: AbortSignal, transport: typeof fetch = routedFetch(c)) {
  if (c.dialect !== 'speech') throw new AppError('Choose a speech connection.');
  // Official catalog is v2; legacy /voices remains available to custom v1-compatible proxies.
  const data = await getJson(c, key, c.provider === 'elevenlabs' ? c.endpoint.replace(/\/v1$/, '/v2') + '/voices?page_size=100' : c.endpoint + '/voices', signal, transport);
  if (!Array.isArray(data.voices)) throw new AppError('Unsupported voice catalog.', 502);
  return { voices: data.voices.slice(0, 1000).filter((v: any) => safeId(v?.voice_id)).map((v: any) => ({ id: v.voice_id, name: typeof v.name === 'string' ? v.name.slice(0, 200) : v.voice_id })), partial: data.voices.length > 1000 || !!data.has_more };
}
export async function speak(c: Connection, key: string, input: any, signal: AbortSignal, transport: typeof fetch = routedFetch(c)): Promise<Uint8Array> {
  if (c.dialect !== 'speech') throw new AppError('Choose a speech connection.');
  const voice = requireString(input.voice, 'voice ID', 200), text = requireString(input.text, 'speech text', 5000);
  if (!/^[a-zA-Z0-9_-]+$/.test(voice)) throw new AppError('Invalid voice ID.');
  const response = await transport(`${c.endpoint}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), headers: { ...requestHeaders(c, key), Accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: c.model }) });
  if (response.ok && !response.headers.get('content-type')?.includes('audio/mpeg')) { await response.body?.cancel(); throw new AppError('Provider did not return MP3 audio.', 502); }
  const audio = await boundedBody(response, 8000000);
  if (!audio.length) throw new AppError('Provider returned empty audio.', 502);
  return audio;
}
