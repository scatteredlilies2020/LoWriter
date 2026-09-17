import { useEffect, useRef, useState } from 'preact/hooks';
import { isImage, isSpeech } from '../src/shared.ts';
import type { AuthMode, Connection, Dialect, Route, MessageProcessing } from '../src/shared.ts';
import { providers, resolvePreset, awsRegions } from '../src/provider-catalog.ts';
import './connections.css';
import { networkKind } from '../src/route-policy.ts';

export const categories: { id: Dialect; name: string }[] = [
  { id: 'chat-completions', name: 'OpenAI-compatible chat' }, { id: 'responses', name: 'OpenAI Responses' },
  { id: 'anthropic', name: 'Claude / Anthropic Messages' }, { id: 'gemini', name: 'Gemini native' }, { id: 'speech', name: 'Speech / ElevenLabs-compatible' },
  { id: 'speech-openai', name: 'Speech / OpenAI-compatible' }, { id: 'images', name: 'Images / OpenAI-compatible' }, { id: 'gemini-images', name: 'Images / Gemini native' },
];
export function ConnectionForm({ current, profiles, unlocked, onSaved }: { current: Connection | null; profiles: Connection[]; unlocked: boolean; onSaved: () => Promise<unknown> }) {
  const initial = current && !current.demo ? current : null;
  const [provider, setProvider] = useState(initial?.provider || (initial ? 'custom' : 'openai'));
  const [category, setCategory] = useState<Dialect | 'all'>(initial?.provider === 'custom' ? initial.dialect : 'all');
  const [endpoint, setEndpoint] = useState(initial?.endpoint || ''), [model, setModel] = useState(initial?.model || '');
  const [variant, setVariant] = useState(initial?.variant || ''), [region, setRegion] = useState(initial?.region || 'us-east-1');
  const [auth, setAuth] = useState<AuthMode>(initial?.auth || 'auto'), [name, setName] = useState(initial?.name || '');
  const [route, setRoute] = useState<Route>(initial?.route || 'auto'), [proxyUrl, setProxyUrl] = useState(initial?.proxyUrl || '');
  const [messageProcessing, setMessageProcessing] = useState<MessageProcessing>(initial?.messageProcessing || 'merge');
  const [key, setKey] = useState(''), [clearKey, setClearKey] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [voice, setVoice] = useState(''), [voices, setVoices] = useState<{ id: string; name: string }[]>([]), [speech, setSpeech] = useState(''), [audio, setAudio] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio); }, [audio]);
  const p = providers.find(p => p.id === provider)!;
  const resolved = provider === 'custom' ? { endpoint, dialect: category === 'all' ? 'chat-completions' as Dialect : category } : resolvePreset(provider, variant, region, model);
  const saved = profiles.find(c => c.provider === provider && c.endpoint === resolved.endpoint && c.dialect === resolved.dialect && (c.auth || 'auto') === auth);
  const hasKey = saved?.hasKey || (!initial?.credentialId && initial?.endpoint === resolved.endpoint && initial?.dialect === resolved.dialect && initial?.hasKey);
  const draft = () => ({ provider, ...resolved, variant, region, model, auth, name, route, proxyUrl, messageProcessing, apiKey: key, keyMode: clearKey ? 'clear' : 'keep' });
  function reset() { setKey(''); setClearKey(false); setModels([]); setVoices([]); setVoice(''); setAudio(''); setError(''); setNotice(''); }
  function defaults() {
    setMessageProcessing('merge');
    reset(); setModel(''); setVariant(''); setRegion('us-east-1'); setAuth('auto'); setName(''); setRoute('auto'); setProxyUrl(''); setSpeech('');
    if (provider === 'custom') setEndpoint('');
    setNotice('This provider/category draft was reset. Saved presets and passwords were not deleted or changed. Save to apply changes.');
  }
  function restore(c: Connection, all = false) {
    setMessageProcessing(c.messageProcessing || 'merge');
    setRoute(c.route || 'auto'); setProxyUrl(c.proxyUrl || '');
    reset(); setProvider(c.provider || 'custom'); setCategory(c.provider && c.provider !== 'custom' ? 'all' : c.dialect); setEndpoint(c.endpoint); setModel(c.model); setVariant(c.variant || ''); setRegion(c.region || 'us-east-1'); setAuth(c.auth || 'auto'); setName(c.name || '');
  }
  function choose(id: string, filter = category) {
    setMessageProcessing('merge');
    setRoute('auto'); setProxyUrl('');
    const old = profiles.findLast(c => c.provider === id && (filter === 'all' || c.dialect === filter));
    if (old) { restore(old, filter === 'all'); return; }
    reset(); setProvider(id); setCategory(id === 'custom' && filter === 'all' ? 'chat-completions' : filter); setEndpoint(''); setModel(''); setVariant(''); setRegion('us-east-1'); setAuth('auto'); setName('');
  }
  async function run(fn: (signal: AbortSignal) => Promise<void>) {
    setError(''); setNotice(''); setBusy(true); const controller = new AbortController(); request.current = controller;
    try { await fn(controller.signal); } catch (e: any) { setError(controller.signal.aborted ? 'Request stopped; it was not retried.' : e.message || 'Request failed.'); }
    finally { setBusy(false); request.current = null; }
  }
  async function post(path: string, input: unknown, signal: AbortSignal, binary = false) {
    const r = await fetch('/api/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LoWriter': '1' }, body: JSON.stringify(input), signal });
    if (binary && r.ok) return r.blob();
    const value = await r.json(); if (!r.ok) throw new Error(value.error || 'Request failed.'); return value;
  }
  return <section class="connection-form">
    <p>Choose a built-in provider—its address is automatic—or use a custom proxy in any API category. Writing and coding share the active text connection. Image and speech connections are saved separately.</p>
    {profiles.length > 0 && <label>Saved connections<select aria-label="Saved connections" value="" disabled={busy} onChange={e => { const c = profiles.find(c => (c.profileId || c.credentialId) === e.currentTarget.value); if (c) restore(c, true); }}><option value="">Choose a saved profile…</option>{profiles.map(c => <option value={c.profileId || c.credentialId}>{c.name || providers.find(p => p.id === c.provider)?.name || 'Custom'} · {c.model} · {new URL(c.endpoint).host}</option>)}</select></label>}
    <form onSubmit={e => { e.preventDefault(); void run(async signal => { try { await post('connection', draft(), signal); await onSaved(); setNotice(isSpeech(resolved.dialect) ? 'Speech connection saved; writing connection unchanged.' : isImage(resolved.dialect) ? 'Image connection saved; writing connection unchanged.' : 'Connection saved and selected. Send a message to test your account/model.'); } finally { setKey(''); } }); }}>
      <fieldset disabled={busy}>
        <label>API category<select aria-label="API category" value={category} onChange={e => { const next = e.currentTarget.value as Dialect | 'all'; setCategory(next); choose(next === 'all' ? 'openai' : 'custom', next); }}><option value="all">All built-in providers</option>{categories.map(c => <option value={c.id}>{c.name}</option>)}</select></label>
        <label>Provider<select aria-label="Provider" value={provider} onChange={e => choose(e.currentTarget.value)}>{providers.filter(p => category === 'all' || p.id === 'custom' || p.dialect === category || (p.id === 'opencode' && !isSpeech(category) && !isImage(category)) || (p.id === 'aws-mantle' && category === 'anthropic')).map(p => <option value={p.id}>{p.id === 'custom' ? 'Custom / my proxy' : p.name}</option>)}</select></label>
        {p.variants && <label>Provider region / plan<select aria-label="Provider region / plan" value={variant || p.variants[0].id} onChange={e => { setVariant(e.currentTarget.value); reset(); }}>{p.variants.map(v => <option value={v.id}>{v.name}</option>)}</select></label>}
        {p.regional && <label>AWS region<select aria-label="AWS region" value={region} onChange={e => { setRegion(e.currentTarget.value); reset(); }}>{awsRegions.map(r => <option>{r}</option>)}</select></label>}
        {p.note && <p class="hint">{p.note}</p>}
        <label key="connection-name">Connection name <small>Optional, e.g. My Claude proxy</small><input value={name} onInput={e => setName(e.currentTarget.value)} maxLength={80}/></label>
        {provider === 'custom' ? <label key="custom-endpoint">API base URL<input type="url" value={endpoint} placeholder="https://my-proxy.example/v1" onInput={e => { setEndpoint(e.currentTarget.value); setKey(''); setModels([]); setVoices([]); setAudio(''); }} required/></label> : <div key="preset-endpoint" class="endpoint-preview"><span>Automatic API base · {categories.find(c => c.id === resolved.dialect)?.name}</span><code>{resolved.endpoint}</code><button type="button" onClick={() => { reset(); setProvider('custom'); setCategory(resolved.dialect); setEndpoint(resolved.endpoint); setAuth('auto'); setName(''); }}>Use a custom proxy for this category</button></div>}
        <label key="api-key">API key / proxy password <small>{hasKey && !clearKey ? 'Saved for this endpoint. Type to replace; leave unchanged to keep.' : 'Saved automatically on this device. No separate vault password.'}</small><input type="password" autoComplete="off" value={key} placeholder={hasKey && !clearKey ? '********' : ''} onInput={e => { setKey(e.currentTarget.value); setClearKey(false); }} maxLength={4096} disabled={auth === 'none'}/></label>
        {hasKey && <label class="check-label"><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.currentTarget.checked); setKey(''); }}/><span>Remove the saved key for this endpoint when saving</span></label>}
        {provider === 'custom' && <><label>Proxy authentication<select aria-label="Proxy authentication" value={auth} onChange={e => { setAuth(e.currentTarget.value as AuthMode); setKey(''); }}><option value="auto">Automatic for this API category</option><option value="bearer">Bearer token / proxy password</option><option value="x-api-key">x-api-key (Claude)</option><option value="x-goog-api-key">x-goog-api-key (Gemini)</option><option value="xi-api-key">xi-api-key (ElevenLabs)</option><option value="none">None (keyless endpoint)</option></select></label><p class="hint">Use the proxy’s API base including its prefix, not the final /messages or /chat/completions path. Credentials are not copied from a built-in provider. Only use a proxy you trust with your prompts and credentials.</p></>}
        <details class="network-options" open={route !== 'auto' || !!proxyUrl}><summary>Advanced network settings (optional)</summary><label>Network route<select aria-label="Network route" value={route} onChange={e => { setRoute(e.currentTarget.value as Route); setProxyUrl(''); }}><option value="auto">Automatic · regular / .onion / .i2p</option><option value="direct">Regular / direct</option><option value="tor">Tor · including regular websites</option><option value="i2p">I2P · .i2p addresses only</option><option value="proxy">Custom HTTP(S) / SOCKS5 network proxy</option></select></label>
        {route !== 'direct' && <label>Network proxy URL<input aria-label="Network proxy URL" type="url" value={proxyUrl} onInput={e => setProxyUrl(e.currentTarget.value)} placeholder={route === 'i2p' ? 'http://127.0.0.1:4444' : 'socks5h://127.0.0.1:9050'} required={route === 'proxy'}/><small>Only for a nonstandard router or explicit proxy. SOCKS5 / SOCKS5H both resolve destination names remotely. No router credentials in this URL.</small></label>}
        <button type="button" onClick={() => { setRoute('auto'); setProxyUrl(''); setNotice('Network draft reset to automatic. Saved presets unchanged until saving.'); }}>Reset network defaults</button></details>
        <p class="hint" role="status">{(() => { let kind = 'regular'; try { kind = networkKind(new URL(resolved.endpoint)); } catch {} return route === 'auto' ? `Automatic route: ${kind === 'regular' ? 'regular / direct' : kind.toUpperCase()}.` : `Selected route: ${route}.`; })()} Tor checks local ports 9050 / 9150. I2P uses local 4444 (HTTP) or 4445 (HTTPS). A router must already be running; unavailable private routes never fall back to direct.</p>
        <p class="hint">Put your regular, .onion or .i2p API address in API base URL; routing is automatic. Use the API-key field for your API proxy password. Router settings are separate and usually need no changes.</p>
        <button type="button" disabled={!unlocked} onClick={() => void run(async signal => { const result = await post('models', draft(), signal); setModels(result.models); setNotice((result.partial ? 'Partial catalog. ' : '') + result.note); })}>{p.discovery === false ? 'Show model suggestions' : 'Load models'}</button>
        {(models.length > 0 || !!p.models?.length) && <label>Model picker<select aria-label="Model picker" value={model} onChange={e => setModel(e.currentTarget.value)}><option value="">Select a model or type an ID below…</option>{(models.length ? models : p.models!.map(id => ({ id, name: id }))).map(m => <option value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}</select></label>}
        <label>Exact model ID<input value={model} onInput={e => setModel(e.currentTarget.value)} required maxLength={200} placeholder="Load models or enter your custom model ID"/></label>
        {!isSpeech(resolved.dialect) && !isImage(resolved.dialect) && <details><summary>Message post-processing</summary><label>Message format<select aria-label="Message format" value={messageProcessing} onChange={e => setMessageProcessing(e.currentTarget.value as MessageProcessing)}><option value="merge">Merge consecutive roles (default)</option><option value="single">Single user message</option><option value="separate">Separate messages</option></select></label><button type="button" onClick={() => setMessageProcessing('merge')}>Reset message format</button><p class="hint">Changes the outgoing request only, never your saved messages. Single user combines dialogue while retaining system instructions and a trailing assistant prefill separately. Tool-enabled requests keep their structured roles. Native APIs still use their required system/tool envelopes.</p><p class="hint">Trailing assistant messages are sent as prefills. If the provider explicitly rejects that format (HTTP 400/422), retry once with that trailing block as user text, using the same model and route. No fallback for refusals, authentication, quota, timeouts, partial streams or unrelated errors. Prefill behavior depends on the model.</p></details>}
        <p class="hint">Selecting a provider sends nothing. Load models contacts only the selected endpoint. Catalog entries do not guarantee account access or tool support. Requests keep the selected route; no redirects. Only an explicit prefill-format rejection can trigger one compatibility retry.</p>
        <button class="primary" disabled={!unlocked}>{isSpeech(resolved.dialect) ? 'Save speech connection' : isImage(resolved.dialect) ? 'Save image connection' : 'Save connection'}</button>
        <button type="button" onClick={defaults}>Reset this API category to defaults</button><p class="hint">Give each preset a different connection name to save multiple models or routes for the same endpoint. The same name and endpoint update that preset. Passwords are shared only by presets with the exact same endpoint, protocol and authentication type. Reset affects this draft, not saved presets or passwords.</p>
      </fieldset>
    </form>
    {isSpeech(resolved.dialect) && <section class="speech-box"><h3>Text to speech</h3><button type="button" disabled={busy} onClick={() => { setVoice(''); setVoices([]); setSpeech(''); setAudio(''); setNotice('Speech inputs reset. Saved connection unchanged.'); }}>Reset speech inputs</button><p class="hint">ElevenLabs or OpenAI-compatible speech—not chat, transcription, or voice cloning. Use Images & voices to save a voice for message read-aloud. Generate is an explicit, potentially billable request using the fields above.</p><button disabled={busy || !unlocked} onClick={() => void run(async signal => { const r = await post('voices', draft(), signal); setVoices(r.voices); setNotice(r.partial ? 'Partial voice catalog; you can enter a voice ID.' : 'Voice catalog loaded.'); })}>Load voices</button>{voices.length > 0 && <label>Voice picker<select aria-label="Voice picker" value={voice} disabled={busy} onChange={e => setVoice(e.currentTarget.value)}><option value="">Select a voice…</option>{voices.map(v => <option value={v.id}>{v.name}</option>)}</select></label>}<label>Voice ID<input value={voice} disabled={busy} onInput={e => setVoice(e.currentTarget.value)} maxLength={200}/></label><label>Speech text<textarea value={speech} disabled={busy} onInput={e => setSpeech(e.currentTarget.value)} maxLength={5000} rows={3}/></label><button disabled={busy || !unlocked || !model || !voice || !speech.trim()} onClick={() => void run(async signal => { setAudio(''); const blob = await post('speech', { ...draft(), voice, text: speech }, signal, true); setAudio(URL.createObjectURL(blob)); setNotice('Audio generated. Play or download it below.'); })}>Generate speech (uses credits)</button>{audio && <div><audio controls src={audio}/><a href={audio} download="lowriter-speech.mp3">Download MP3</a></div>}</section>}
    {busy && <button type="button" onClick={() => request.current?.abort()}>Stop request</button>}
    {error && <p role="alert" class="error">{error}</p>}{notice && <p role="status" class="banner">{notice}</p>}
  </section>;
}
