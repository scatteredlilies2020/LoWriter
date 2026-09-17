import { useEffect, useRef, useState } from 'preact/hooks';
import type { Connection, Conversation } from '../src/shared.ts';
import { isImage, isSpeech } from '../src/shared.ts';
import './stories.css';

async function api(path: string, input?: unknown): Promise<any> {
  const response = await fetch('/api' + path, { method: input === undefined ? 'GET' : 'POST', headers: { 'X-LoWriter': '1', 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed.'); return value;
}
export function ChatLibrary({ current, onLoad, onChanged }: { current: Conversation | null; onLoad: (c: Conversation) => void; onChanged: () => Promise<void> }) {
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [rows, setRows] = useState<Conversation[]>([]), [more, setMore] = useState(false);
  const [file, setFile] = useState<File | null>(null), [include, setInclude] = useState(false), [exportMemory, setExportMemory] = useState(false);
  const [title, setTitle] = useState(current?.title || ''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [imported, setImported] = useState<Conversation | null>(null), [version, setVersion] = useState(0);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => { api(`/chats?query=${encodeURIComponent(query)}&offset=${offset}`).then(v => { if (!disposed) { setRows(v.conversations); setMore(v.more); } }).catch(e => { if (!disposed) setError(e.message); }); }, 150);
    return () => { disposed = true; clearTimeout(timer); };
  }, [query, offset, version]);
  async function act(fn: () => Promise<void>) { setError(''); setNotice(''); setBusy(true); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  return <div class="story-panel">
    <p>Open a saved chat or bring a story here. Import creates a new copy; it never overwrites an existing chat.</p>
    {error && <p role="alert" class="error">{error}</p>}{notice && <p role="status" class="banner">{notice}</p>}
    {imported && <button class="primary" onClick={() => onLoad(imported)}>Open imported story →</button>}
    <label>Search saved chats<input type="search" maxLength={100} value={query} onInput={e => { setQuery(e.currentTarget.value); setOffset(0); }}/></label>
    <div class="story-library">{rows.map(c => <button key={c.id} disabled={busy} onClick={() => onLoad(c)}><strong>{c.title}</strong><small>{c.mode === 'rp' ? 'Story' : 'Assistant'} · {new Date(c.created).toLocaleDateString()}{current?.id === c.id ? ' · Open now' : ''}</small></button>)}{!rows.length && <p>No matching saved chats.</p>}</div>
    <div class="story-actions"><button disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous chats</button><button disabled={!more || busy} onClick={() => setOffset(offset + 50)}>More chats</button></div>
    <details open><summary>Import a chat</summary>
      <label>Chat file (.json or .jsonl)<input type="file" accept=".json,.jsonl,application/json" onChange={e => { setFile(e.currentTarget.files?.[0] || null); setImported(null); }}/></label>
      <label class="check-label"><input type="checkbox" checked={include} onChange={e => setInclude(e.currentTarget.checked)}/><span>Also import embedded Continuity memory, if it matches this chat. It will stay off until I enable it.</span></label>
      <p class="hint">LoWriter JSON and SillyTavern JSONL: text, speaker names and reply swipes. Images, audio, cards, lorebooks, credentials and project permissions are not copied.</p>
      <button class="primary" disabled={!file || busy} onClick={() => void act(async () => {
        if (!file || file.size > 8000000) throw new Error('Choose a chat file under 8 MB.');
        const v = await api('/chats/import', { text: await file.text(), includeMemory: include });
        await onChanged(); setVersion(n => n + 1); setImported(v.conversation);
        setNotice(`Loaded ${v.messages} messages into a new chat. ${v.importedMemory ? 'Matching memory imported, switched off. ' : ''}${v.warnings.join(' ')}`);
      })}>{busy ? 'Working…' : 'Import chat'}</button>
    </details>
    {current && <details><summary>Current chat: rename / export</summary>
      <label>Chat name<input maxLength={100} value={title} onInput={e => setTitle(e.currentTarget.value)}/></label>
      <button disabled={busy || !title.trim()} onClick={() => void act(async () => { await api(`/conversations/${current.id}/rename`, { title, revision: current.revision }); await onChanged(); setVersion(n => n + 1); setNotice('Chat renamed.'); })}>Save name</button>
      {current.mode === 'rp' && <label class="check-label"><input type="checkbox" checked={exportMemory} onChange={e => setExportMemory(e.currentTarget.checked)}/><span>Include enabled, matching Continuity memory</span></label>}
      <p class="hint">Exports contain private chat text and reply swipes, not images/audio or settings. Memory is omitted when switched off. Save downloads somewhere private.</p>
      <button disabled={busy} onClick={() => void act(async () => {
        const value = await api(`/conversations/${current.id}/export?memory=${exportMemory ? '1' : '0'}`);
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'lowriter-chat.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('Chat export downloaded.');
      })}>Export chat</button>
    </details>}
  </div>;
}

export function StoryMemory({ conversation, connection, profiles, onConnections, onChanged }: { conversation: Conversation; connection: Connection | null; profiles: Connection[]; onConnections: () => void; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [reviewText, setReviewText] = useState(''), reviewId = useRef('');
  const path = `/conversations/${conversation.id}`;
  const textProfiles = profiles.filter(c => c.profileId && !c.demo && !isImage(c.dialect) && !isSpeech(c.dialect));
  const selectedAI = state?.profile ? textProfiles.find(c => c.profileId === state.profile) : connection;
  const read = async () => {
    const value = await api(path + '/memory'); setState(value);
    if ((value.review?.id || '') !== reviewId.current) { reviewId.current = value.review?.id || ''; setReviewText(value.review ? JSON.stringify(value.review.result, null, 2) : ''); }
  };
  useEffect(() => { let disposed = false, timer: ReturnType<typeof setTimeout>; const poll = async () => { try { if (!disposed) await read(); } catch (e: any) { if (!disposed) setError(e.message); } if (!disposed) timer = setTimeout(poll, 1200); }; void poll(); return () => { disposed = true; clearTimeout(timer); }; }, [conversation.id]);
  async function act(fn: (revision: number) => Promise<void>) {
    setBusy(true); setError('');
    try { const d = await api(path); await fn(d.conversation.revision); await read(); await onChanged(); } catch (e: any) { setError(e.message); await read().catch(() => {}); } finally { setBusy(false); }
  }
  return <div class="story-panel">
    <label class="check-label memory-switch"><input type="checkbox" role="switch" aria-label="Continuity Memory" checked={!!state?.enabled} disabled={busy || !state} onChange={e => { const enabled = e.currentTarget.checked; setState({ ...state, enabled }); void act(async revision => { await api(path + '/memory-toggle', { enabled, revision }); }); }}/><span><strong>Continuity Memory {state?.enabled ? 'on' : 'off'}</strong><small>Only for this story. Off by default.</small></span></label>
    <label>AI for memory functions<select aria-label="AI for memory functions" value={state?.profile || ''} disabled={busy || !state} onChange={e => { const profile = e.currentTarget.value; setState({ ...state, profile }); void act(async revision => { await api(path + '/memory-profile', { profile, revision }); }); }}>
      <option value="">Same AI as chat{connection ? ` · ${connection.name || connection.provider || 'Custom'} · ${connection.model}` : ''}</option>
      {state?.profile && !textProfiles.some(c => c.profileId === state.profile) && <option value={state.profile}>Unavailable saved AI — choose another</option>}
      {textProfiles.map(c => <option key={c.profileId} value={c.profileId}>{c.name || c.provider || 'Custom'} · {c.model}</option>)}
    </select></label>
    <div class="story-actions"><button disabled={busy} onClick={onConnections}>Manage AI connections</button><button disabled={busy || !state?.profile} onClick={() => void act(async revision => { await api(path + '/memory-profile', { profile: '', revision }); })}>Reset to chat AI</button></div>
    <p>When on, memory updates automatically after replies and is recalled in later messages. Memory extraction and reconciliation use {selectedAI ? `${selectedAI.name || selectedAI.provider || 'Custom'} · ${selectedAI.model}` : 'the selected AI (currently unavailable)'}. These additional model requests can cost credits. Turning off stops memory updates and recall without deleting saved memory.</p>
    <p class="hint">Choose any saved text connection, including custom/proxy models, without changing your story’s chat AI. The chosen connection’s saved credentials and regular / Tor / I2P route are reused. Recall itself runs locally. A reply already generating keeps the context it was sent.</p>
    {error && <p role="alert" class="error">{error}</p>}{state?.error && <p role="alert" class="error">{state.error} Chatting can continue without new memory.</p>}
    {state && <>
      <p role="status" class="banner">{state.updating ? 'Updating story memory in the background…' : state.enabled ? state.stale ? 'Source text changed. Old memory is not being used.' : state.hasMemory ? 'Story memory ready.' : 'Memory will build as you chat.' : 'Memory is off. Saved memory is not sent to the model.'} {state.processed} / {state.eligible} stable messages processed.</p>
      <p class="hint">The newest reply stays provisional for regeneration/swiping. Older imports catch up in batches of up to 24 messages per update. Memory can be imperfect; source edits invalidate old memory and trigger rebuilding after your next reply.</p>
      <div class="story-actions"><button disabled={busy || !state.enabled || state.updating || state.hasReview || !state.pendingMessages} onClick={() => void act(async revision => { await api(path + '/memory-update', { revision }); })}>{state.stale ? 'Rebuild from this chat' : 'Update / catch up now'}</button>{state.updating && <button onClick={() => void act(async () => { await api('/stop', {}); })}>Stop updates and replies</button>}</div>
      {state.review && <details open><summary>Update needs review</summary><p>The last update was not applied. Review or discard it before continuing updates.</p><label>Memory update JSON<textarea class="memory-json" value={reviewText} onInput={e => setReviewText(e.currentTarget.value)}/></label><div class="story-actions"><button disabled={busy || !state.enabled || state.updating} onClick={() => void act(async revision => { let result; try { result = JSON.parse(reviewText); } catch { throw new Error('Review must be valid JSON.'); } await api(path + '/memory-review', { revision, accept: true, reviewId: state.review.id, result }); })}>Save reviewed memory</button><button disabled={busy || state.updating} onClick={() => void act(async revision => { await api(path + '/memory-review', { revision, accept: false, reviewId: state.review.id }); })}>Discard update</button></div></details>}
      {state.world && <MemoryBrowser world={state.world} id={conversation.id} stale={state.stale} version={state.version} disabled={busy || state.updating} onCorrect={async (collection, recordId, text, version) => { const d = await api(path); await api(path + '/memory-correct', { collection, recordId, text, version, revision: d.conversation.revision }); await read(); }}/>}
      {!!state.overrides?.length && <details><summary>Manual memory corrections</summary><p class="hint">Local recall overlays, not edits to source records. Used only while memory is on and the referenced record still matches. Corrections are not included in portable chat exports or branches yet.</p>{state.overrides.map((v: any) => <section class="story-entry"><strong>{v.collection} · {v.active ? v.matches ? 'Active' : 'Record changed — not applied' : 'Undone'}</strong><p>{v.text}</p>{!!v.active && <button disabled={busy || state.updating} onClick={() => { if (confirm('Undo this manual correction? Original extracted records were never changed.')) void act(async revision => { await api(path + '/memory-undo-correction', { correction: v.id, revision, version: state.version }); }); }}>Undo correction #{v.id}</button>}</section>)}</details>}
      {state.world && <details><summary>Inspect saved memory JSON</summary><p class="hint">Stored locally, isolated from other stories. Imported memory is untrusted story reference, never project/tool permission.</p><pre class="memory-json">{JSON.stringify(state.world, null, 2)}</pre></details>}
      <p class="hint">Powered by the host-independent Continuity Memory core. LoWriter has its own optional cards and lorebooks in Story setup, not SillyTavern’s host schedulers or embeddings.</p>
    </>}
  </div>;
}

function MemoryValue({ value, depth = 0 }: { value: any; depth?: number }): any {
  if (value === null || value === undefined) return <span>—</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (depth > 5) return <span>{JSON.stringify(value)}</span>;
  if (Array.isArray(value)) return value.length ? <ul>{value.slice(0, 100).map(v => <li><MemoryValue value={v} depth={depth + 1}/></li>)}</ul> : <span>None recorded</span>;
  return <dl class="memory-fields">{Object.entries(value).filter(([k]) => !['id', 'fingerprint'].includes(k)).map(([k, v]) => <><dt>{k.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt><dd><MemoryValue value={v} depth={depth + 1}/></dd></>)}</dl>;
}
function MemoryBrowser({ world, id, stale, version, disabled, onCorrect }: { world: any; id: string; stale: boolean; version: number; disabled: boolean; onCorrect: (collection: string, recordId: string, text: string, version: number) => Promise<void> }) {
  const [query, setQuery] = useState(''), [category, setCategory] = useState('entities'), [limit, setLimit] = useState(25), [source, setSource] = useState<any>(null), [error, setError] = useState('');
  const [edit, setEdit] = useState<any>(null), [saving, setSaving] = useState(false);
  const categories = ['entities', 'relationships', 'facts', 'states', 'events', 'threads', 'backgrounds', 'capsules', 'chronicle', 'arcs', 'eras', 'corrections'];
  const rows = (world[category] || []).filter((r: any) => JSON.stringify(r).toLowerCase().includes(query.toLowerCase()));
  function sources(v: any): { from: number; to: number }[] { if (!v || typeof v !== 'object') return []; if (v.chatKey === id && Number.isSafeInteger(v.from) && Number.isSafeInteger(v.to)) return [{ from: v.from, to: Math.min(v.to, v.from + 19) }]; return Object.values(v).flatMap(sources); }
  return <details open><summary>Story memory tracker</summary><p class="hint">Recorded claims, not guaranteed truth. Characters can emerge from the writing; no portrait or card is required. Use Story setup → Author notes for explicit corrections without editing source history.</p>
    {stale && <p class="error">These records are stale and are not being recalled. Sources below show current chat text, which may differ from the extraction.</p>}
    <label>Search story memory<input type="search" value={query} onInput={e => { setQuery(e.currentTarget.value); setLimit(25); }}/></label>
    <label>Memory category<select value={category} onChange={e => { setCategory(e.currentTarget.value); setLimit(25); }}>{categories.map(k => <option value={k}>{k[0].toUpperCase() + k.slice(1)} ({world[k]?.length || 0})</option>)}</select></label>
    <p>{rows.length} matching records.</p>
    {rows.slice(0, limit).map((r: any, i: number) => <details class="memory-record" key={r.id || i}><summary>{r.name || r.title || r.subject || r.label || r.summary || `Record ${i + 1}`}</summary><MemoryValue value={r}/>{[...new Map(sources(r).map(s => [`${s.from}:${s.to}`, s])).values()].slice(0, 20).map(s => <button onClick={() => { setError(''); api(`/conversations/${id}/memory-source?from=${s.from}&to=${s.to}`).then(setSource).catch(e => setError(e.message)); }}>Read source messages {s.from + 1}–{s.to + 1}</button>)}<button disabled={disabled || saving || stale || typeof r.id !== 'string'} onClick={() => setEdit({ collection: category, recordId: r.id, original: r, version, text: '' })}>Correct this memory</button></details>)}
    {edit && <section class="story-entry" aria-label="Review memory correction"><h3>Review correction</h3><p>Original record (kept unchanged):</p><MemoryValue value={edit.original}/><label>Your correction<textarea maxLength={4000} value={edit.text} onInput={e => setEdit({ ...edit, text: e.currentTarget.value })}/></label><p class="hint">This explicit correction takes precedence during recall; it does not rewrite the chat or extraction. It stops applying if this record changes. You can undo it.</p><button disabled={disabled || saving || stale || !edit.text.trim()} onClick={() => { setSaving(true); setError(''); onCorrect(edit.collection, edit.recordId, edit.text, edit.version).then(() => setEdit(null)).catch(e => setError(e.message)).finally(() => setSaving(false)); }}>Save reviewed correction</button><button disabled={saving} onClick={() => setEdit(null)}>Cancel correction</button></section>}
    {rows.length > limit && <button onClick={() => setLimit(limit + 25)}>More memory records</button>}
    {error && <p class="error" role="alert">{error}</p>}{source && <section class="story-entry" aria-label="Memory source text"><button onClick={() => setSource(null)}>Close source text</button>{source.messages.map((m: any) => <div><strong>Message {m.index + 1} · {m.speaker || m.role}</strong><pre class="memory-json">{m.content}</pre></div>)}</section>}
  </details>;
}
