import { useEffect, useErrorBoundary, useState } from 'preact/hooks';
import { blankStory } from '../src/story-types.ts';
import type { StorySetup, LoreEntry, StoryPortrait, PromptField, PromptPlacement, AdditionalInstruction } from '../src/story-types.ts';
import type { VoiceProfile } from '../src/shared.ts';
import './stories.css';

async function api(path: string, value?: unknown): Promise<any> {
  try {
    const r = await fetch('/api' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'X-LoWriter': '1', 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value), signal: value === undefined ? AbortSignal.timeout(15000) : undefined });
    const v = await r.json(); if (!r.ok) throw new Error(v.error || 'Request failed.'); return v;
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new Error('The local service did not respond. Check that LoWriter is running, then retry.');
    throw e;
  }
}
type StorySetupProps = { id: string; voices: VoiceProfile[]; onChanged: () => Promise<void>; onDirty: (dirty: boolean) => void };
export function StorySetupPanel(props: StorySetupProps) {
  // Keep a bad setup response from breaking the surrounding modal and its X button.
  const [error, retry] = useErrorBoundary();
  if (error) return <div class="story-panel"><p class="error" role="alert">Story setup could not display this data. Your saved story has not been replaced. Close this panel and reopen LoWriter if it was recently updated.</p><button onClick={retry}>Retry loading story setup</button></div>;
  return <StorySetupForm {...props}/>;
}
function StorySetupForm({ id, voices, onChanged, onDirty }: StorySetupProps) {
  const [s, setS] = useState<StorySetup>(blankStory), [revision, setRevision] = useState(-1), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [presets, setPresets] = useState<any[]>([]), [versions, setVersions] = useState<any[]>([]), [preset, setPreset] = useState(''), [presetName, setPresetName] = useState(''), [preview, setPreview] = useState<any>(null), [includeImages, setIncludeImages] = useState(false);
  const path = `/conversations/${id}`;
  async function read() {
    const v = await api(path + '/story');
    // Never default this field to []: an older service would silently discard new instructions on save.
    if (v.setup && !Object.hasOwn(v.setup, 'additionalInstructions')) throw new Error('The local service is still running an older version of LoWriter. Finish any active generation, quit LoWriter, open Start LoWriter.cmd again, then refresh this page. Your saved stories are unchanged.');
    if (!Array.isArray(v.setup?.additionalInstructions) || !Number.isSafeInteger(v.revision) || v.revision < 0 || !Array.isArray(v.presets) || !Array.isArray(v.versions)) throw new Error('The local service returned incomplete story setup data. No draft was replaced. Retry loading, or reopen LoWriter.');
    setS(v.setup); setRevision(v.revision); setPresets(v.presets); setVersions(v.versions); setDirty(false);
  }
  useEffect(() => { void act(read); }, [id]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]);
  useEffect(() => { const guard = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
  function change(p: Partial<StorySetup>) { setS({ ...s, ...p }); setDirty(true); setPreview(null); }
  async function act(fn: () => Promise<void>) { setError(''); setNotice(''); setBusy(true); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  async function save() { await api(path + '/story-save', { setup: s, revision }); await read(); await onChanged(); setNotice('Story setup saved. Future replies use these settings; past writing is unchanged.'); }
  function reset(keys: (keyof StorySetup)[]) { const d = blankStory(); change(Object.fromEntries(keys.map(k => [k, d[k]]))); }
  function field(key: keyof StorySetup, label: string, max = 32000) { return <label>{label}<textarea rows={key === 'name' || key === 'personaName' ? 1 : 4} maxLength={max} value={s[key] as string} onInput={e => change({ [key]: e.currentTarget.value })}/></label>; }
  function placement(key: PromptField, label: string) {
    const p = s.placements[key], update = (patch: Partial<PromptPlacement>) => change({ placements: { ...s.placements, [key]: { ...p, ...patch } } });
    return <details class="prompt-placement"><summary>{label} placement · {p.role} · {p.position === 'depth' ? `depth ${p.depth}` : p.position + ' history'}</summary>
      <label>{label} role<select aria-label={label + ' role'} value={p.role} onChange={e => update({ role: e.currentTarget.value as PromptPlacement['role'] })}><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select></label>
      <label>{label} position<select aria-label={label + ' position'} value={p.position} onChange={e => update({ position: e.currentTarget.value as PromptPlacement['position'] })}><option value="before">Before history</option><option value="depth">At message depth</option><option value="after">After history</option></select></label>
      {p.position === 'depth' && <label>{label} depth<input type="number" min={0} max={400} value={p.depth} onInput={e => update({ depth: Number(e.currentTarget.value) })}/></label>}
      <button onClick={() => change({ placements: { ...s.placements, [key]: blankStory().placements[key] } })}>Reset {label} placement</button>
    </details>;
  }
  async function importFile(file: File | undefined, kind: 'card' | 'lore') {
    if (!file) return; if (dirty && !confirm(kind === 'card' ? 'Replace this unsaved setup draft with the imported card?' : 'Append imported lore to this draft?')) return;
    await act(async () => { if (file.size > 8000000) throw new Error('Import limit: 8 MB.'); let value;
      if (file.name.toLowerCase().endsWith('.png') && kind === 'card') { const bytes = new Uint8Array(await file.arrayBuffer()); let b = ''; for (let i = 0; i < bytes.length; i += 16384) b += String.fromCharCode(...bytes.subarray(i, i + 16384)); value = await api(path + '/story-import', { kind, png: btoa(b) }); }
      else value = await api(path + '/story-import', { kind, text: await file.text() });
      change(kind === 'lore' ? { lore: [...s.lore, ...value.lore] } : value.setup); setNotice(value.warnings.join(' '));
    });
  }
  function loreUpdate(id: string, patch: Partial<LoreEntry>) { change({ lore: s.lore.map(e => e.id === id ? { ...e, ...patch } : e) }); }
  function portraitUpdate(id: string, patch: Partial<StoryPortrait>) { change({ portraits: s.portraits.map(e => e.id === id ? { ...e, ...patch } : e) }); }
  function instructionUpdate(id: string, patch: Partial<AdditionalInstruction>) { change({ additionalInstructions: s.additionalInstructions.map(e => e.id === id ? { ...e, ...patch } : e) }); }
  if (revision < 0) return <div class="story-panel">
    {error ? <><p class="error" role="alert">{error}</p><button disabled={busy} onClick={() => void act(read)}>Retry loading story setup</button></> : <p role="status">Loading story setup…</p>}
  </div>;
  return <div class="story-panel story-setup">
    <p>One card can hold an entire world and cast. Everything below is optional. No group turns, automatic character agents, or mandatory writing modes.</p>
    {error && <p class="error" role="alert">{error}</p>}{notice && <p class="banner" role="status">{notice}</p>}
    <div class="story-actions setup-save"><button class="primary" disabled={busy || revision < 0 || !dirty} onClick={() => void act(save)}>Save story setup</button><span>{dirty ? 'Unsaved changes' : 'Saved locally'}</span></div>
    <fieldset disabled={busy || revision < 0}>
    <details open><summary>Card & prompts</summary>
      <label>Import character card (JSON / PNG)<input type="file" accept=".json,.png" onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void importFile(f, 'card'); }}/></label>
      {field('name', 'Card name', 100)}{field('description', 'Description', 96000)}{placement('description', 'Description')}
      <p class="hint">Personality and scenario are included here on import, not separate boxes. Other fields are not merged into Description.</p>
      <details open><summary>Additional instructions ({s.additionalInstructions.length})</summary>
        <p class="hint">Add as many separate instructions as you need (up to 50). Name them however you like; names are labels, not extra prompt text. Imported card instructions go here with their original roles, positions and depths. Nothing is required.</p>
        {s.additionalInstructions.map((entry, i) => { const label = `Instruction ${i + 1}`, p = entry.placement; return <details class="story-entry" key={entry.id} open>
          <summary>{entry.name || label}{!entry.enabled && ' · off'}</summary>
          <label>{label} name<input maxLength={100} value={entry.name} placeholder="Optional name" onInput={e => instructionUpdate(entry.id, { name: e.currentTarget.value })}/></label>
          <label>{label} text<textarea rows={4} maxLength={32000} value={entry.content} onInput={e => instructionUpdate(entry.id, { content: e.currentTarget.value })}/></label>
          <label class="check-label"><input type="checkbox" aria-label={label + ' enabled'} checked={entry.enabled} onChange={e => instructionUpdate(entry.id, { enabled: e.currentTarget.checked })}/>Enabled</label>
          <label>{label} role<select aria-label={label + ' role'} value={p.role} onChange={e => instructionUpdate(entry.id, { placement: { ...p, role: e.currentTarget.value as PromptPlacement['role'] } })}><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select></label>
          <label>{label} position<select aria-label={label + ' position'} value={p.position} onChange={e => instructionUpdate(entry.id, { placement: { ...p, position: e.currentTarget.value as PromptPlacement['position'] } })}><option value="before">Before history</option><option value="depth">At message depth</option><option value="after">After history</option></select></label>
          {p.position === 'depth' && <label>{label} depth<input type="number" min={0} max={400} value={p.depth} onInput={e => instructionUpdate(entry.id, { placement: { ...p, depth: Number(e.currentTarget.value) } })}/></label>}
          {entry.source && <p class="hint">Imported source: <code>{({ instructions: 'system_prompt', postHistory: 'post_history_instructions', characterNote: 'extensions.depth_prompt' })[entry.source]}</code>. Original source fields remain in Retained card fields.</p>}
          <button onClick={() => instructionUpdate(entry.id, { placement: entry.source ? { ...s.placements[entry.source] } : { position: 'before', role: 'system', depth: 0 } })}>Reset {label} placement</button>
          <button onClick={() => change({ additionalInstructions: s.additionalInstructions.filter(e => e.id !== entry.id) })}>Remove {label}</button>
        </details>; })}
        <button disabled={s.additionalInstructions.length >= 50} onClick={() => change({ additionalInstructions: [...s.additionalInstructions, { id: crypto.randomUUID(), name: '', content: '', enabled: true, source: '', placement: { position: 'before', role: 'system', depth: 0 } }] })}>Add instruction</button>
        <button onClick={() => { if (confirm('Clear additional instructions in this draft? Save to apply. Retained source JSON stays unchanged.')) reset(['additionalInstructions']); }}>Reset additional instructions draft</button>
      </details>
      <details><summary>Example dialogue</summary>{field('examples', 'Example dialogue (not past events)')}{placement('examples', 'Example dialogue')}</details>
      <details><summary>Assistant prefill</summary>{field('prefill', 'Assistant prefill (optional)', 8000)}<p class="hint">Prefill begins the reply; Continue uses the existing reply instead.</p></details>
      <p class="hint">Depth counts retained chat messages backwards: 0 after the latest, 1 before it. Larger depths clamp to the beginning of available history. Guidance goes before the final continuation/prefill. Provider role merging happens afterwards; native APIs that collect system prompts at the top cannot preserve in-history system positions. Only {'{{user}}'} and {'{{char}}'} expand; unsupported macros remain exactly in their original prompt field as literal text. No hidden style preset is applied.</p>
      <button onClick={() => reset(['name', 'description', 'examples', 'instructions', 'postHistory', 'characterNote', 'additionalInstructions', 'prefill', 'placements'])}>Reset card draft</button>
      {s.importedCard && <details><summary>Retained card fields (including unsupported fields)</summary>
        <p class="hint">Complete original card JSON, including creator notes, tags, extension settings, assets and unknown fields, at their original paths. This is retained in setup saves, presets and native exports, not executed or automatically sent as an extra prompt. Editing additional instructions above does not change this original copy. To change the imported source, edit here and explicitly reapply it. Reapplying replaces the card fields and lore draft, but keeps your persona, portraits and local context settings.</p>
        {field('importedCard', 'Retained card JSON', 4000000)}
        <button onClick={() => { if (confirm('Reapply this retained JSON to the card fields and lore in your draft?')) void act(async () => { const v = await api(path + '/story-import', { kind: 'card', text: s.importedCard }); const n = v.setup; change({ name: n.name, description: n.description, examples: n.examples, instructions: n.instructions, postHistory: n.postHistory, characterNote: n.characterNote, additionalInstructions: n.additionalInstructions, placements: n.placements, greetings: n.greetings, lore: n.lore, importedCard: n.importedCard }); setNotice(v.warnings.join(' ')); }); }}>Reapply retained card edits</button>
      </details>}
    </details>
    <details><summary>Persona & author notes</summary>{field('personaName', 'Your persona name', 100)}{field('persona', 'Your persona description')}{placement('persona', 'Persona')}{field('authorNotes', 'Author notes / explicit corrections')}{placement('authorNotes', 'Author notes')}
      <p class="hint">Your notes are sent as explicit story reference even when automatic memory is off. They do not rewrite the stored memory engine. Use them to clarify canon, uncertainty, relationships or who knows what.</p><button onClick={() => reset(['personaName', 'persona', 'authorNotes'])}>Reset persona & notes draft</button>
    </details>
    <details><summary>Opening messages</summary><p class="hint">Choose a greeting only for an empty story. Save first; no paid generation is needed.</p>
      {s.greetings.map((g, i) => <div class="story-entry" key={i}><label>Opening {i + 1}<textarea value={g} maxLength={16000} onInput={e => change({ greetings: s.greetings.map((v, n) => n === i ? e.currentTarget.value : v) })}/></label><button disabled={dirty || !g.trim()} onClick={() => void act(async () => { const d = await api(path); await api(path + '/story-greeting', { index: i, revision: d.conversation.revision }); await read(); await onChanged(); setNotice('Opening added to this empty story.'); })}>Use opening {i + 1}</button><button onClick={() => change({ greetings: s.greetings.filter((_, n) => n !== i) })}>Remove opening {i + 1}</button></div>)}
      <button disabled={s.greetings.length >= 50} onClick={() => change({ greetings: [...s.greetings, ''] })}>Add opening</button><button onClick={() => reset(['greetings'])}>Reset openings draft</button>
    </details>
    <details><summary>Lorebooks / world references ({s.lore.length})</summary>
      {placement('lore', 'Lore')}
      <p class="hint">User-owned reference, separate from learned Continuity memory. Higher priority is included first. Keywords scan the recent raw chat, not other lore entries. No regex or scripts run.</p>
      <label>Import lorebook JSON<input type="file" accept=".json" onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void importFile(f, 'lore'); }}/></label>
      {s.lore.map((l, i) => <details class="story-entry" key={l.id}><summary>{l.name || `Lore ${i + 1}`} {!l.enabled && '· off'}</summary>
        <label>Lore name<input value={l.name} maxLength={100} onInput={e => loreUpdate(l.id, { name: e.currentTarget.value })}/></label>
        <label>Keywords (comma separated)<input value={l.keys.join(',')} onInput={e => loreUpdate(l.id, { keys: e.currentTarget.value.split(',') })}/></label>
        <label>Secondary keywords (at least one, if supplied)<input value={l.secondaryKeys.join(',')} onInput={e => loreUpdate(l.id, { secondaryKeys: e.currentTarget.value.split(',').filter(Boolean) })}/></label>
        <label>Lore content<textarea value={l.content} maxLength={32000} onInput={e => loreUpdate(l.id, { content: e.currentTarget.value })}/></label>
        {(['enabled', 'always', 'matchAll', 'caseSensitive'] as const).map((key, n) => <label class="check-label"><input type="checkbox" checked={l[key]} onChange={e => loreUpdate(l.id, { [key]: e.currentTarget.checked })}/>{['Enabled', 'Always include', 'Require all primary keywords', 'Case sensitive'][n]}</label>)}
        <label>Priority<input type="number" min={-10000} max={10000} value={l.priority} onInput={e => loreUpdate(l.id, { priority: Number(e.currentTarget.value) })}/></label><button onClick={() => change({ lore: s.lore.filter(e => e.id !== l.id) })}>Remove lore entry</button>
      </details>)}
      <button disabled={s.lore.length >= 500} onClick={() => change({ lore: [...s.lore, { id: crypto.randomUUID(), name: '', keys: [], secondaryKeys: [], content: '', enabled: true, always: false, matchAll: false, caseSensitive: false, priority: 100 }] })}>Add lore entry</button><button onClick={() => reset(['lore', 'loreBudget'])}>Reset lore draft</button>
    </details>
    <details><summary>Optional portraits & voices</summary><p class="hint">Visual identities, not independent AI participants. Use the persona name for your portrait. Assign saved voices for whole-message narration; automatic dialogue splitting is not enabled. Portraits are display-only, not sent to the chat provider.</p>
      <label class="check-label"><input type="checkbox" checked={s.showPortraits} onChange={e => change({ showPortraits: e.currentTarget.checked })}/>Show portrait strip</label>
      {s.portraits.map(p => <details class="story-entry" key={p.id}><summary>{p.name || 'New portrait'}</summary>
        <label>Portrait / speaker name<input value={p.name} maxLength={100} onInput={e => portraitUpdate(p.id, { name: e.currentTarget.value })}/></label>
        <label>Local portrait image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void act(async () => { if (f.size > 8000000) throw new Error('Choose a portrait under 8 MB.'); const bitmap = await createImageBitmap(f); try { const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); portraitUpdate(p.id, { image: canvas.toDataURL('image/webp', .85) }); } finally { bitmap.close(); } }); }}/></label>
        {p.image && <img class="portrait-preview" src={p.image} alt={p.name || 'Portrait preview'}/>}
        <label>Idle motion<select value={p.motion} onChange={e => portraitUpdate(p.id, { motion: e.currentTarget.value as StoryPortrait['motion'] })}><option value="none">None</option><option value="breathe">Subtle breathing</option><option value="bounce">Idle bounce</option><option value="sway">Gentle sway</option></select></label>
        <label>Assigned voice<select value={p.voice} onChange={e => portraitUpdate(p.id, { voice: e.currentTarget.value })}><option value="">No assigned voice</option>{p.voice && !voices.some(v => v.id === p.voice) && <option value={p.voice}>Unavailable voice</option>}{voices.map(v => <option value={v.id}>{v.name}</option>)}</select></label>
        <button onClick={() => change({ portraits: s.portraits.filter(e => e.id !== p.id) })}>Remove portrait</button>
      </details>)}
      <button disabled={s.portraits.length >= 24} onClick={() => change({ portraits: [...s.portraits, { id: crypto.randomUUID(), name: '', image: '', voice: '', motion: 'none' }] })}>Add portrait</button><button onClick={() => reset(['portraits', 'showPortraits'])}>Reset portraits draft</button>
      <p class="hint">Your device’s reduced-motion preference disables animation automatically.</p>
    </details>
    <details><summary>Context budget & prompt inspection</summary>
      {([['contextMessages', 'Recent message limit', 4, 400], ['contextChars', 'Recent text character budget', 8000, 240000], ['loreBudget', 'Lore character budget', 0, 64000]] as const).map(([k, label, min, max]) => <label>{label}<input type="number" min={min} max={max} value={s[k]} onInput={e => change({ [k]: Number(e.currentTarget.value) })}/></label>)}
      <p class="hint">Character budgets are not exact model tokens. Larger context can cost more or exceed your model’s limit. Automatic memory does not guarantee complete coverage.</p>
      <button onClick={() => reset(['contextMessages', 'contextChars', 'loreBudget'])}>Reset context draft</button><button disabled={dirty} onClick={() => void act(async () => { setPreview(await api(path + '/story-preview', {})); })}>Inspect saved story prompt</button>
      {preview && <><p>Active lore: {preview.activeLore.join(', ') || 'None'}. Omitted by budget: {preview.omittedLore.join(', ') || 'None'}.</p><pre class="memory-json">{JSON.stringify(preview, null, 2)}</pre><p class="hint">Story additions only; raw chat, automatic memory and provider role processing are assembled separately.</p></>}
    </details>
    <details><summary>Presets, export & setup history</summary>
      <label>New preset name<input value={presetName} maxLength={100} onInput={e => setPresetName(e.currentTarget.value)}/></label><button disabled={!presetName.trim()} onClick={() => void act(async () => { await api(path + '/story-preset-save', { name: presetName, setup: s }); const v = await api(path + '/story'); setPresets(v.presets); setNotice('New local preset saved from this draft.'); })}>Save new preset</button>
      <label>Saved story preset<select value={preset} onChange={e => setPreset(e.currentTarget.value)}><option value="">Choose…</option>{presets.map(p => <option value={p.id}>{p.name}</option>)}</select></label>
      <button disabled={!preset} onClick={() => { if (!dirty || confirm('Replace this unsaved draft with the preset?')) void act(async () => { change(await api(path + '/story-preset-load', { preset })); setNotice('Preset loaded into draft. Review and save to apply.'); }); }}>Load preset into draft</button><button disabled={!preset} onClick={() => { if (confirm('Delete this saved preset? Current story is unchanged.')) void act(async () => { await api(path + '/story-preset-delete', { preset }); setPresets((await api(path + '/story')).presets); setPreset(''); }); }}>Delete preset</button>
      <label class="check-label"><input type="checkbox" checked={includeImages} onChange={e => setIncludeImages(e.currentTarget.checked)}/>Include portrait images in setup export</label>
      <p class="hint">Exports include private card text, retained original card fields, persona and author notes. Review imported metadata for private information before sharing. No LoWriter provider settings or local voice assignments. Chat/media exports are separate.</p><button onClick={() => { const setup = { ...s, portraits: s.portraits.map(p => ({ ...p, voice: '', image: includeImages ? p.image : '' })) }; const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'lowriter.story', version: 1, setup }, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'story-setup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export setup draft</button>
      <p>Previous setup versions (last 20; restoring also saves the current version):</p>{versions.map(v => <button disabled={dirty} onClick={() => { if (confirm('Restore this saved setup version? Past chat stays unchanged.')) void act(async () => { await api(path + '/story-restore', { version: v.id, revision }); await read(); await onChanged(); }); }}>{new Date(v.created).toLocaleString()} · Restore #{v.id}</button>)}
      <button onClick={() => { if (confirm('Clear every setup category in this draft? Nothing changes until you save.')) change(blankStory()); }}>Reset all setup draft</button>
      <button onClick={() => { if (!dirty || confirm('Discard unsaved setup changes and reload?')) void act(read); }}>Discard draft / reload</button>
    </details>
    </fieldset>
  </div>;
}
export function PortraitStrip({ setup }: { setup: StorySetup | null }) { return setup?.showPortraits && setup.portraits.some(p => p.image) ? <section class="portrait-strip" aria-label="Story portraits">{setup.portraits.filter(p => p.image).map(p => <figure key={p.id}><img class={'idle-' + p.motion} src={p.image} alt={p.name || 'Story portrait'}/><figcaption>{p.name}</figcaption></figure>)}</section> : null; }
