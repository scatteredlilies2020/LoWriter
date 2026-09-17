import { useState } from 'preact/hooks';

export type Typography = { family: 'serif' | 'sans' | 'mono'; lineHeight: number; paragraphSpacing: number; letterSpacing: number };
export const typographyDefaults: Typography = { family: 'serif', lineHeight: 1.9, paragraphSpacing: 1, letterSpacing: 0 };
export function normalizeTypography(value: Partial<Typography> | null): Typography {
  const bounded = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return { family: value && ['serif', 'sans', 'mono'].includes(value.family || '') ? value.family! : 'serif', lineHeight: bounded(value?.lineHeight, 1.2, 2.6, 1.9), paragraphSpacing: bounded(value?.paragraphSpacing, 0, 2.5, 1), letterSpacing: bounded(value?.letterSpacing, -0.5, 2, 0) };
}
type Settings = { font: number; width: number; dialogue: string } & Typography;
type Preset = Settings & { name: string };
export const appearanceDefaults: Settings = { font: 17, width: 760, dialogue: '', ...typographyDefaults };
function storedPresets(): Preset[] {
  try { const data = JSON.parse(localStorage.getItem('lowriter-appearance-presets') || '[]'); return Array.isArray(data) ? data.filter(p => p && typeof p.name === 'string' && p.name.length <= 80 && Number.isInteger(p.font) && p.font >= 14 && p.font <= 24 && Number.isInteger(p.width) && p.width >= 540 && p.width <= 980 && (p.dialogue === '' || /^#[0-9a-f]{6}$/i.test(p.dialogue))).slice(0, 30).map(p => ({ ...p, ...normalizeTypography(p) })) : []; } catch { return []; }
}
export function Appearance({ value, onChange }: { value: Settings; onChange: (value: Settings) => void }) {
  const [presets, setPresets] = useState(storedPresets), [name, setName] = useState(''), [notice, setNotice] = useState('');
  function persist(next: Preset[]) { try { localStorage.setItem('lowriter-appearance-presets', JSON.stringify(next)); setPresets(next); return true; } catch { setNotice('This browser could not save presets. Existing presets were not changed.'); return false; } }
  return <>
    <p>A quiet interface, adjusted to your reading rhythm. Settings and named presets stay on this browser. Light/dark mode stays separate in the toolbar.</p>
    <label>Appearance presets<select aria-label="Appearance presets" value="" onChange={e => { const p = presets.find(p => p.name === e.currentTarget.value); if (p) { onChange({ font: p.font, width: p.width, dialogue: p.dialogue, ...normalizeTypography(p) }); setName(p.name); setNotice('Appearance preset loaded.'); } }}><option value="">Choose a saved preset…</option>{presets.map(p => <option key={p.name}>{p.name}</option>)}</select></label>
    <label>Appearance preset name<input value={name} onInput={e => setName(e.currentTarget.value)} maxLength={80} placeholder="My reading setup"/></label>
    <div class="settings-actions"><button disabled={!name.trim()} onClick={() => { const trimmed = name.trim(), next = presets.filter(p => p.name !== trimmed); if (next.length >= 30) { setNotice('Preset limit reached (30). Choose an existing name to update it.'); return; } if (persist([...next, { ...value, name: trimmed }])) setNotice('Appearance preset saved.'); }}>Save appearance preset</button><button disabled={!presets.some(p => p.name === name.trim())} onClick={() => { if (persist(presets.filter(p => p.name !== name.trim()))) setNotice('Named preset removed. Current appearance unchanged.'); }}>Delete appearance preset</button></div>
    <label>Text size <span>{value.font}px</span><input type="range" min="14" max="24" value={value.font} onInput={e => onChange({ ...value, font: Number(e.currentTarget.value) })}/></label><button onClick={() => onChange({ ...value, font: appearanceDefaults.font })}>Reset text size</button>
    <label>Reading width <span>{value.width}px</span><input type="range" min="540" max="980" step="20" value={value.width} onInput={e => onChange({ ...value, width: Number(e.currentTarget.value) })}/></label><button onClick={() => onChange({ ...value, width: appearanceDefaults.width })}>Reset reading width</button>
    <label>Message font<select aria-label="Message font" value={value.family} onChange={e => onChange({ ...value, family: e.currentTarget.value as Typography['family'] })}><option value="serif">Serif · book style</option><option value="sans">Sans serif · clean</option><option value="mono">Monospace · fixed width</option></select></label><button onClick={() => onChange({ ...value, family: typographyDefaults.family })}>Reset message font</button>
    <label>Line spacing <span>{value.lineHeight.toFixed(1)}</span><input type="range" min="1.2" max="2.6" step="0.1" value={value.lineHeight} onInput={e => onChange({ ...value, lineHeight: Number(e.currentTarget.value) })}/></label><button onClick={() => onChange({ ...value, lineHeight: typographyDefaults.lineHeight })}>Reset line spacing</button>
    <label>Paragraph spacing <span>{value.paragraphSpacing.toFixed(1)} em</span><input type="range" min="0" max="2.5" step="0.1" value={value.paragraphSpacing} onInput={e => onChange({ ...value, paragraphSpacing: Number(e.currentTarget.value) })}/></label><button onClick={() => onChange({ ...value, paragraphSpacing: typographyDefaults.paragraphSpacing })}>Reset paragraph spacing</button>
    <label>Letter spacing <span>{value.letterSpacing.toFixed(1)} px</span><input type="range" min="-0.5" max="2" step="0.1" value={value.letterSpacing} onInput={e => onChange({ ...value, letterSpacing: Number(e.currentTarget.value) })}/></label><button onClick={() => onChange({ ...value, letterSpacing: typographyDefaults.letterSpacing })}>Reset letter spacing</button>
    <label>Your dialogue color<input type="color" value={value.dialogue || '#ad5913'} onInput={e => onChange({ ...value, dialogue: e.currentTarget.value })}/></label><button onClick={() => onChange({ ...value, dialogue: '' })}>Reset dialogue color</button>
    <div class="settings-actions"><button onClick={() => { onChange({ ...appearanceDefaults }); setNotice('Appearance reset. Saved presets, theme and connections are unchanged.'); }}>Reset appearance to defaults</button></div>
    {notice && <p role="status">{notice}</p>}<div class="appearance-sample">“There is always another way to tell the story.”</div>
    <h3>Prototype capabilities</h3><p class="hint">Memory, story direction, imports, cloud/key sync, browser automation, desktop control, and advanced media remain later milestones; basic text-to-speech is in Connections. Android/Termux has not been tested on a real device.</p>
  </>;
}
