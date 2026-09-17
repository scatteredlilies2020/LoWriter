import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Conversation, Message, Job, Mode, Connection } from '../src/shared.ts';
import './style.css';
import { ConnectionForm } from './connections.tsx';
import { providers } from '../src/provider-catalog.ts';
import { Appearance, normalizeTypography } from './appearance.tsx';
import { MessageContent } from './message-content.tsx';
import { MessageMedia, VoiceLibrary, type MediaState } from './media.tsx';
import { ChatLibrary, StoryMemory } from './stories.tsx';
import { StorySetupPanel, PortraitStrip } from './story-setup.tsx';
import type { StorySetup } from '../src/story-types.ts';

interface State extends MediaState { conversations: Conversation[]; connection: Connection | null; connections: Connection[]; vault: { exists: boolean; unlocked: boolean; automatic: boolean; migrationRequired: boolean; protection: string }; capabilities: Record<string, unknown> }
interface Detail { conversation: Conversation; messages: Message[]; job: Job | null; mediaBusy: boolean; memory?: { enabled: boolean; updating: boolean; stale: boolean; error: string } }
async function api(path: string, input?: unknown): Promise<any> {
  const response = await fetch('/api' + path, { method: input === undefined ? 'GET' : 'POST', headers: { 'X-LoWriter': '1', 'Content-Type': 'application/json' }, credentials: 'same-origin', body: input === undefined ? undefined : JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || 'Request failed.'), { status: response.status });
  return value;
}
function saved(key: string, fallback: string): string { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function readableToolOutput(output: string): string {
  try { const value = JSON.parse(output); return typeof value.diff === 'string' ? value.diff : JSON.stringify(value, null, 2); }
  catch { return output || 'Working…'; }
}
function App() {
  const [state, setState] = useState<State | null>(null), [paired, setPaired] = useState(false), [pairing, setPairing] = useState('');
  const [loading, setLoading] = useState(true), [shutdown, setShutdown] = useState(false);
  const [selected, setSelected] = useState(saved('lowriter-chat', '')), [mode, setMode] = useState<Mode>('rp'), [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<'connections' | 'appearance' | 'project' | 'media' | 'chats' | 'memory' | 'story' | null>(null), [older, setOlder] = useState<number | null>(null);
  const [theme, setTheme] = useState(saved('lowriter-theme', 'system')), [font, setFont] = useState(Number(saved('lowriter-font', '17')));
  const [width, setWidth] = useState(Number(saved('lowriter-width', '760'))), [dialogue, setDialogue] = useState(saved('lowriter-dialogue', ''));
  const [typography, setTypography] = useState(() => { try { return normalizeTypography(JSON.parse(saved('lowriter-typography', '{}'))); } catch { return normalizeTypography(null); } });
  useEffect(() => { try { localStorage.setItem('lowriter-typography', JSON.stringify(typography)); } catch {} }, [typography]);
  const [authoredRole, setAuthoredRole] = useState('assistant'), [authoredSpeaker, setAuthoredSpeaker] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [project, setProject] = useState(''), [trust, setTrust] = useState(false), [notice, setNotice] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const [editingMessages, setEditingMessages] = useState<Set<number>>(new Set());
  const drafts = useRef(new Map<string, string>());
  const [setupDirty, setSetupDirty] = useState(false), [storySetup, setStorySetup] = useState<StorySetup | null>(null);
  useEffect(() => { let cancelled = false; setStorySetup(null); if (selected && detail?.conversation.mode === 'rp') api(`/conversations/${selected}/story`).then(v => { if (!cancelled) setStorySetup(v.setup); }).catch(() => {}); return () => { cancelled = true; }; }, [selected, detail?.conversation.revision]);
  function closePanel() { if (setupDirty && !confirm('Discard unsaved story setup changes?')) return; setPanel(null); setPassphrase(''); }
  function identity(message: Message) { const name = message.speaker || (message.role === 'user' ? storySetup?.personaName : storySetup?.name) || (message.role === 'user' ? 'You' : 'LoWriter'); return { name, portrait: storySetup?.portraits.find(p => p.name.toLowerCase() === name.toLowerCase()) }; }
  useEffect(() => { try { localStorage.setItem('lowriter-chat', selected); } catch {} }, [selected]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (text || editingMessages.size || [...drafts.current.values()].some(Boolean)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [text, editingMessages]);
  const currentView = useRef({ selected, older }); currentView.current = { selected, older };
  async function refresh() { const [core, media] = await Promise.all([api('/state'), api('/media-state')]); const next = { ...core, ...media }; setState(next); setPaired(true); return next as State; }
  async function act(fn: () => Promise<void>) { setError(''); setBusy(true); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  useEffect(() => { refresh().catch(e => { if (e.status !== 401) setError(e.message); }).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('lowriter-theme', theme); localStorage.setItem('lowriter-font', String(font)); localStorage.setItem('lowriter-width', String(width)); localStorage.setItem('lowriter-dialogue', dialogue); } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme, font, width, dialogue]);
  useEffect(() => {
    if (!selected || !paired || shutdown) { setDetail(null); return; }
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const d = await api('/conversations/' + selected + (older ? '?before=' + older : '')); if (!disposed) { setDetail(d); setMode(d.conversation.mode); } }
      catch (e: any) { if (!disposed) { setError(e.message); if (e.status === 404) setSelected(''); } }
      if (!disposed) timer = setTimeout(poll, 600);
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [selected, paired, older, shutdown]);
  useEffect(() => { if (!older) end.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [detail?.messages.length, detail?.job?.text, selected, older]);
  const running = detail?.job?.status === 'running';
  const working = running || !!detail?.mediaBusy;
  async function refreshMessages(conversation: string) {
    const updated = await api('/conversations/' + conversation + (older ? '?before=' + older : ''));
    if (currentView.current.selected === conversation && currentView.current.older === older) setDetail(updated);
    await refresh();
  }
  async function create(workspace: Mode = mode) {
    const c = await api('/conversations', { mode: workspace, title: workspace === 'rp' ? 'Untitled story' : 'Untitled chat' });
    setSelected(c.id); setDetail(null); setOlder(null); setDrawer(false); setNotice(''); await refresh(); return c;
  }
  function saveDraft(): boolean {
    if (busy) return false;
    if (editingMessages.size && !confirm('Discard unsaved message edits before switching chats? Your composer draft will stay in this tab.')) return false;
    drafts.current.set(selected || 'fresh-' + mode, text); setEditingMessages(new Set()); return true;
  }
  function choose(c: Conversation) {
    if (c.id === selected) { setDrawer(false); setPanel(null); return; }
    if (!saveDraft()) return;
    setSelected(c.id); setMode(c.mode); setDetail(null); setOlder(null); setText(drafts.current.get(c.id) || ''); setDrawer(false); setNotice(''); setPanel(null);
  }
  function switchMode(next: Mode) { if (!saveDraft()) return; setMode(next); setSelected(''); setDetail(null); setOlder(null); setText(drafts.current.get('fresh-' + next) || ''); setDrawer(false); setPanel(null); }
  async function send(event?: Event) {
    event?.preventDefault(); if (!text.trim() || working || busy || !state?.connection) return;
    await act(async () => {
      const c = selected ? (await api('/conversations/' + selected)).conversation : await create();
      const job = await api(`/conversations/${c.id}/send`, { text, revision: c.revision });
      drafts.current.delete(selected || 'fresh-' + mode); setText(''); setOlder(null); setDetail(await api('/conversations/' + c.id)); await refresh();
    });
  }
  function openPanel(next: typeof panel) {
    if (setupDirty && !confirm('Discard unsaved story setup changes?')) return;
    setError(''); setNotice(''); setPanel(next); setDrawer(false);
    if (next === 'connections') setPassphrase('');
    if (next === 'project') { setProject(detail?.conversation.project || ''); setTrust(false); }
  }
  const activeMessages = detail?.messages || [];
  const themeSwitch = <div class="theme-switch" role="group" aria-label="Color mode">{([['light', 'Light mode', '☀'], ['dark', 'Dark mode', '☾'], ['system', 'Follow system theme', '▣']] as const).map(([value, label, icon]) => <button type="button" key={value} aria-label={label} title={label} aria-pressed={theme === value} onClick={() => setTheme(value)}><span aria-hidden="true">{icon}</span></button>)}</div>;
  return <div class="app" style={{ '--message-font': typography.family === 'serif' ? "Georgia, 'Times New Roman', serif" : typography.family === 'mono' ? 'Consolas, monospace' : 'system-ui, sans-serif', '--message-leading': typography.lineHeight, '--paragraph-spacing': `${typography.paragraphSpacing}em`, '--letter-spacing': `${typography.letterSpacing}px`, '--reading-width': `${width}px`, '--reading-font': `${font}px`, ...(dialogue ? { '--dialogue': dialogue } : {}) }}>
    {loading || shutdown || !paired ? <main class="pair-screen"><section class="pair-card">
      <div class="brand"><span class="brand-mark">L<span>·</span></span><span>LoWriter</span></div>
      <p class="eyebrow">YOUR LOCAL WRITING & WORK SPACE</p><h1>{loading ? 'Opening your workspace…' : shutdown ? 'See you next time.' : 'Open LoWriter.'}</h1>
      {loading ? <p role="status">Connecting to your local workspace.</p> : shutdown ? <p role="status">LoWriter has stopped. Your saved work stays on this device. You can close this tab; use Start LoWriter to return.</p> : <>
      <p>Double-click <strong>Start LoWriter</strong> to open your workspace automatically. No pairing code is needed when you use the launcher.</p>
      <p class="hint">If the service was restarted, close this old tab and open LoWriter again. For the local demo, use Try LoWriter Demo.</p>
      <details><summary>Advanced: manual browser pairing</summary>
      <form onSubmit={e => { e.preventDefault(); void act(async () => { await api('/login', { token: pairing.trim() }); setPairing(''); await refresh(); }); }}>
        <label>Local pairing code<input type="password" autoComplete="off" value={pairing} onInput={e => setPairing(e.currentTarget.value)} placeholder="Paste the code from LoWriter’s terminal" required/></label>
        <button class="primary" disabled={busy}>Open my workspace <span>→</span></button>
      </form><p class="hint">Fallback only: <code>LoWriter.ps1 pair</code> or <code>npm run cli -- pair</code>. This local code is not a provider API key.</p></details></>}
      {error && <p role="alert" class="error">{error}</p>}<div class="pair-foot">LOCAL-FIRST <span>·</span> MILESTONE 1 PROTOTYPE</div>
    </section></main> : <>
      {drawer && <button class="scrim" aria-label="Close navigation" onClick={() => setDrawer(false)}/>}
      <aside class={'sidebar ' + (drawer ? 'open' : '')}>
        <div class="brand"><span class="brand-mark">L<span>·</span></span><span>LoWriter<small>A little room to think</small></span></div>
        <div class="workspace-switch" aria-label="Workspace"><button class={mode === 'rp' ? 'active' : ''} onClick={() => switchMode('rp')}>Writing</button><button class={mode === 'coding' ? 'active' : ''} onClick={() => switchMode('coding')}>Assistant</button></div>
        <button class="new-button" disabled={busy} onClick={() => { if (saveDraft()) void act(async () => { await create(); setText(''); }); }}>＋ <span>{mode === 'rp' ? 'New story' : 'New chat'}</span></button>
        <button class="quiet" onClick={() => openPanel('chats')}>Load chats</button>
        <div class="section-label">YOUR {mode === 'rp' ? 'STORIES' : 'CHATS'} <span>{state?.conversations.filter(c => c.mode === mode).length || 0}</span></div>
        <nav class="conversation-list">{state?.conversations.filter(c => c.mode === mode).map(c => <button key={c.id} class={'conversation-link ' + (selected === c.id ? 'selected' : '')} onClick={() => choose(c)}><span class="conversation-icon">{mode === 'rp' ? '◇' : '⌘'}</span><span>{c.title}<small>{new Date(c.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {c.mode === 'rp' ? 'Writing' : c.trusted ? 'Project tools' : 'Assistant'}</small></span></button>)}
          {!state?.conversations.some(c => c.mode === mode) && <p class="empty-nav">Your next {mode === 'rp' ? 'story' : 'chat'} starts here.</p>}
        </nav>
        <div class="sidebar-bottom"><button onClick={() => openPanel('connections')}>⇄ <span>Connections</span><i class={state?.connection ? 'dot connected' : 'dot'}/></button><button onClick={() => openPanel('appearance')}>◐ <span>Appearance</span></button><button disabled={busy} onClick={() => { if (confirm('Quit LoWriter and stop active jobs? Saved messages and completed edits remain.')) void act(async () => { await api('/shutdown', {}); setShutdown(true); setPanel(null); }); }}>⏻ <span>Quit LoWriter</span></button><div class="local-status"><i class="dot connected"/> Local service <span>v0.1</span></div></div>
      </aside>
      <main class="workspace">
        <header class="topbar"><button class="mobile-menu" aria-label="Open navigation" onClick={() => setDrawer(true)}>☰</button><div class="breadcrumb">{mode === 'rp' ? 'Writing room' : 'Assistant'}<span>/</span><strong>{detail?.conversation.title || 'A fresh page'}</strong></div><div class="top-actions">{themeSwitch}{mode === 'rp' && <button class="quiet" disabled={busy || working} onClick={() => { if (!selected) void act(async () => { await create('rp'); setPanel('story'); }); else openPanel('story'); }}>Story setup</button>}{mode === 'rp' && <button class="quiet" disabled={!detail} onClick={() => openPanel('memory')}>{detail?.memory?.updating ? 'Memory updating…' : detail?.memory?.error || detail?.memory?.stale ? 'Memory · check' : `Memory ${detail?.memory?.enabled ? 'on' : 'off'}`}</button>}<button class="quiet" onClick={() => openPanel('media')}>Images & voices</button>{mode === 'coding' && <button class="quiet" disabled={!selected} onClick={() => openPanel('project')}>{detail?.conversation.trusted ? '● Project trusted' : 'Choose project'}</button>}<button class="stop-button" onClick={() => void act(async () => { await api('/stop', {}); setNotice('All active jobs stopped. Completed edits remain available for review.'); })}>■ Stop all</button></div></header>
        <div class="connection-strip"><span class={'tag ' + (state?.connection?.demo ? 'demo' : '')}>{state?.connection?.demo ? 'LOCAL DEMO' : state?.connection ? (providers.find(p => p.id === state.connection?.provider)?.name || 'CUSTOM CONNECTION') : 'NO CONNECTION'}</span><span>{state?.connection?.model || 'Set up a provider to begin'}</span><button onClick={() => openPanel('connections')}>{state?.connection?.demo ? 'Connect a real model →' : 'Manage →'}</button></div>
        {error && <div class="banner error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {notice && <div class="banner" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
        {mode === 'rp' && <PortraitStrip setup={storySetup}/>}
        <section class="transcript" aria-label="Conversation">
          {!activeMessages.length && !detail?.job ? <div class="welcome"><div class="welcome-symbol">{mode === 'rp' ? '✦' : '⌘'}</div><p class="eyebrow">{mode === 'rp' ? 'MAKE SPACE FOR A STORY' : 'QUESTIONS, IDEAS & EVERYDAY HELP'}</p><h1>{mode === 'rp' ? <>Every world starts<br/>with a few words.</> : <>What’s on<br/>your mind?</>}</h1><p>{mode === 'rp' ? 'Set a scene, find a character’s voice, or follow a thought somewhere unexpected. The page is yours.' : 'Ask questions, explore ideas, draft something, or work on code. Just send a message — no project setup needed.'}</p>
            <div class="starter-grid">{(mode === 'rp' ? [['Set the scene', 'Start a story at a quiet station after the last train has left.'], ['Find a voice', 'Help me develop a character with a secret they are afraid to tell.']] : [['Explain something', 'Explain a complicated idea in plain language. Start by asking what I want to understand.'], ['Help me draft', 'Help me turn rough notes into a clear message. Ask me for the notes and who it is for.'], ['Work on code', 'Help me understand or improve some code. Ask me to paste it and describe what I want to do.'], ...(state?.connection?.demo ? [['Try the coding demo', 'Demo coding: inspect the project, update greeting.js, and check its syntax.']] : [])]).map(([title, prompt]) => <button onClick={() => setText(prompt)}><strong>{title}<span>↗</span></strong><small>{prompt}</small></button>)}</div>
            <p class="prototype-note">{mode === 'rp' ? 'Load a saved chat, import a story, or enable optional Continuity Memory inside a story. Use Story setup for optional scenario cards, personas, lorebooks and portraits.' : 'Project tools are optional: choose and explicitly trust a folder only when you want file access. No general shell, web browsing, or desktop control.'}</p>
          </div> : <div class="message-column">
            <div class="paging">{activeMessages.length === 40 && <button onClick={() => setOlder(activeMessages[0].id)}>← Older messages</button>}{older && <button onClick={() => setOlder(null)}>Back to latest →</button>}</div>
{activeMessages.map(message => <article key={message.id} class={'message ' + message.role}><div class="message-heading"><span class="avatar">{identity(message).portrait?.image ? <img src={identity(message).portrait!.image} alt=""/> : message.role === 'user' ? 'Y' : 'L'}</span><strong>{identity(message).name}</strong><span>{message.role === 'user' ? 'Your words' : 'Reply'}</span></div><MessageContent key={message.active_variant} onEditingChange={editing => setEditingMessages(previous => { const next = new Set(previous); if (editing) next.add(message.id); else next.delete(message.id); return next; })} text={message.content} revision={detail!.conversation.revision} edited={message.edited} editable={!working && !busy} onSave={async (text, revision) => { await api(`/conversations/${message.conversation}/messages/${message.id}/edit`, { text, revision }); await refreshMessages(message.conversation); }}/>{state && <MessageMedia key={`${message.id}:${message.active_variant}`} message={message} story={mode === 'rp'} assignedVoice={identity(message).portrait?.voice} revision={detail!.conversation.revision} latest={!older && message.id === activeMessages.at(-1)?.id} disabled={working || busy || editingMessages.size > 0} profiles={state.connections} mediaState={state} onChanged={() => refreshMessages(message.conversation)} onManage={() => openPanel('media')}/>}{mode === 'rp' && <button class="quiet" disabled={working || busy || editingMessages.size > 0} onClick={() => { if (!confirm('Create a separate story through this message, preserving the original? Setup, reply variants and media copy; memory starts off and rebuilds independently.')) return; const title = prompt('Name the new branch:', (detail?.conversation.title || 'Story') + ' · branch'); if (title === null) return; if (!saveDraft()) return; void act(async () => { const d = await api(`/conversations/${selected}`); const v = await api(`/conversations/${selected}/story-branch`, { through: message.id, title, revision: d.conversation.revision }); setSelected(v.conversation.id); setDetail(null); setOlder(null); setText(''); await refresh(); }); }}>Branch from here</button>}</article>)}
            {!older && detail?.job && <>
              {detail.job.notice && <p role="status" class="banner">{detail.job.notice}</p>}
              {detail.job.actions.length > 0 && <details class="action-panel" open><summary>Project activity <span>{detail.job.actions.length} actions</span></summary>{detail.job.actions.map((a, i) => <details class="action" key={i} open={a.tool === 'write_text' || a.status === 'failed'}><summary><span>{a.status === 'complete' ? '✓' : a.status === 'running' ? '◌' : '!'} {a.tool.replaceAll('_', ' ')}</span><small>{a.status}</small></summary><pre>{readableToolOutput(a.output)}</pre>{(() => { try { const parsed = JSON.parse(a.output); return parsed.checkpoint ? <button disabled={busy || running} onClick={() => { if (confirm('Restore this checkpoint? The file is changed only if it still matches the recorded edit.')) void act(async () => { await api(`/conversations/${selected}/restore`, { checkpoint: parsed.checkpoint }); setNotice('Checkpoint restored. The file is back to its saved state.'); }); }}>Restore this edit</button> : null; } catch { return null; } })()}</details>)}</details>}
              {detail.job.status !== 'complete' && <article class="message assistant candidate"><div class="message-heading"><span class="avatar">L</span><strong>LoWriter</strong><span class={running ? 'live' : ''}>{running ? 'Writing…' : `${detail.job.status} · uncommitted candidate`}</span></div><MessageContent key={detail.job.id} text={detail.job.text || (running ? 'Waiting for the provider…' : 'No reply was committed.')}/>{detail.job.error && <p class="job-error">{detail.job.error}</p>}</article>}
            </>}
          </div>}<div ref={end}/>
        </section>
<footer class="composer-area">{mode === 'rp' && <details class="authored-controls"><summary>Write directly into the story (no AI request)</summary><label>Message role<select value={authoredRole} onChange={e => setAuthoredRole(e.currentTarget.value)}><option value="assistant">Assistant / narrative</option><option value="user">User</option></select></label><label>Speaker name (optional)<input maxLength={100} value={authoredSpeaker} onInput={e => setAuthoredSpeaker(e.currentTarget.value)}/></label><button disabled={busy || working || !text.trim()} onClick={() => void act(async () => { const c = selected ? (await api(`/conversations/${selected}`)).conversation : await create(); await api(`/conversations/${c.id}/story-authored`, { text, role: authoredRole, speaker: authoredSpeaker, revision: c.revision }); drafts.current.delete(selected || 'fresh-' + mode); setText(''); setOlder(null); await refreshMessages(c.id); })}>Insert composer text without AI</button><p class="hint">Adds your text as written. Assistant narrative can then be continued or regenerated. The role affects what the model receives, not who you are allowed to write.</p></details>}<form class="composer" onSubmit={send}><label class="sr-only" for="message-input">{mode === 'rp' ? 'Message your writing partner' : 'Ask a question or describe a task'}</label><textarea id="message-input" disabled={busy} value={text} onInput={e => setText(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!e.repeat) void send(); } }} placeholder={mode === 'rp' ? 'Where shall we begin?' : 'Ask anything, work through an idea, or write code…'} rows={3} maxLength={16000}/><div class="composer-bottom"><span>{mode === 'rp' ? '◇ Writing' : detail?.conversation.trusted ? '⌘ Trusted project tools' : '◇ Assistant · project tools optional'}</span>{running ? <button class="stop-button" type="button" onClick={() => void act(async () => { await api(`/jobs/${detail!.job!.id}/cancel`, {}); })}>■ Stop reply</button> : <button class="primary send" disabled={busy || working || !text.trim() || !state?.connection}>Send <span>↑</span></button>}</div></form><div class="composer-hint"><span>Local history · {older ? 'Viewing an older page' : 'Bounded recent context'}</span><span>Enter to send · Shift + Enter for a new line</span></div></footer>
      </main>
      {panel && <div class="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { closePanel(); } }}><section class="modal" role="dialog" aria-modal="true" aria-label={panel === 'connections' ? 'Connections' : panel === 'appearance' ? 'Appearance' : panel === 'media' ? 'Images & voices' : panel === 'chats' ? 'Load chats' : panel === 'memory' ? 'Story memory' : panel === 'story' ? 'Story setup' : 'Project access'}><header><div><p class="eyebrow">YOUR WORKSPACE</p><h2>{panel === 'connections' ? 'Connections' : panel === 'appearance' ? 'Make yourself at home.' : panel === 'media' ? 'Images & voices' : panel === 'chats' ? 'Your chats' : panel === 'memory' ? 'Story memory' : panel === 'story' ? 'Story setup' : 'Local project access'}</h2></div><button aria-label="Close settings" onClick={() => { closePanel(); }}>×</button></header>
        {error && <p class="error" role="alert">{error}</p>}{notice && <p class="banner">{notice}</p>}
        {panel === 'connections' && <>
          <section class="vault-box"><div class="section-label">SAVED CREDENTIALS <span>{state?.vault.migrationRequired ? 'ONE-TIME MIGRATION' : 'AUTOMATIC'}</span></div>{state?.vault.migrationRequired ? <form onSubmit={e => { e.preventDefault(); void act(async () => { try { await api('/vault/migrate', { passphrase }); await refresh(); setNotice('Credentials migrated. No vault password is needed on future launches.'); } finally { setPassphrase(''); } }); }}><p>Your old keys are passphrase-encrypted. Enter the old passphrase once to preserve them and enable automatic access. It will not be saved.</p><label>Old vault passphrase<input type="password" value={passphrase} minLength={12} maxLength={512} autoComplete="off" onInput={e => setPassphrase(e.currentTarget.value)} required/></label><button class="primary" disabled={busy}>Migrate saved credentials</button></form> : <p class="hint">No vault password or unlocking. {state?.vault.protection}. Saved API keys / proxy passwords stay on this device and appear only as asterisks; their values are never sent back to the browser. Anyone using your unlocked account can use saved connections.</p>}</section>
          <ConnectionForm current={state?.connection || null} profiles={state?.connections || []} unlocked={!!state?.vault.unlocked} onSaved={refresh}/>
        </>}
        {panel === 'story' && selected && <StorySetupPanel key={selected} id={selected} voices={state?.voices || []} onChanged={() => refreshMessages(selected)} onDirty={setSetupDirty}/>}
        {panel === 'appearance' && <Appearance value={{ font, width, dialogue, ...typography }} onChange={v => { setFont(v.font); setWidth(v.width); setDialogue(v.dialogue); setTypography(normalizeTypography(v)); }}/>}
        {panel === 'media' && state && <VoiceLibrary profiles={state.connections} voices={state.voices} onSaved={refresh} onConnections={() => openPanel('connections')}/>}
        {panel === 'chats' && <ChatLibrary current={detail?.conversation || null} onLoad={choose} onChanged={async () => { if (selected) await refreshMessages(selected); else await refresh(); }}/>}
        {panel === 'memory' && detail?.conversation.mode === 'rp' && <StoryMemory key={selected} conversation={detail.conversation} connection={state?.connection || null} profiles={state?.connections || []} onConnections={() => openPanel('connections')} onChanged={() => refreshMessages(selected)}/>}
        {panel === 'project' && <><p>You do not need a project for everyday chat or discussing pasted code. Choosing a folder does not grant trust. Project text and file snippets may be sent to the configured provider when tools run.</p><form onSubmit={e => { e.preventDefault(); void act(async () => { await api(`/conversations/${selected}/project`, { path: project, trust }); setDetail(await api('/conversations/' + selected)); await refresh(); setPanel(null); }); }}><label>Absolute folder path<input value={project} onInput={e => { setProject(e.currentTarget.value); setTrust(false); }} placeholder="C:\Users\you\projects\my-project" required/></label><label class="check-label"><input type="checkbox" checked={trust} onChange={e => setTrust(e.currentTarget.checked)}/><span>I explicitly trust this project for reading, checkpointed text changes, JavaScript syntax checks, and JSON assertions.</span></label><p class="hint">This is not an OS sandbox. No general shell, project scripts, browser, desktop, publishing, or messaging tools. Trust is device-local and never shared with writing/RP. Selecting without the checkbox revokes existing trust.</p><button class="primary" disabled={busy || running}>{trust ? 'Grant project trust' : 'Select without trust'}</button></form></>}
      </section></div>}
    </>}
  </div>;
}
render(<App/>, document.getElementById('app')!);
