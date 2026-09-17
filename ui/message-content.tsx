import { createElement, type ComponentChildren } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { Lexer, type Token, type Tokens } from 'marked';
import './message-content.css';

// Use Markdown tokens, never the parser's HTML output. Model/user HTML remains
// inert text and images never initiate background requests to remote servers.
function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
function plainText(value: string): string {
  if (!value.includes('&')) return value;
  // Escape literal tags first; this detached textarea only decodes entities.
  const decoder = document.createElement('textarea');
  decoder.innerHTML = value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return decoder.value;
}
function renderTokens(tokens: Token[], depth = 0): ComponentChildren {
  if (depth > 64) throw new Error('Markdown nesting limit');
  return tokens.map(token => {
    const children = () => renderTokens('tokens' in token ? token.tokens || [] : [], depth + 1);
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'paragraph': return <p>{children()}</p>;
      case 'heading': return createElement('h' + Math.min(6, Math.max(2, token.depth)), {}, children());
      case 'strong': return <strong>{children()}</strong>;
      case 'em': return <em>{children()}</em>;
      case 'del': return <del>{children()}</del>;
      case 'blockquote': return <blockquote>{children()}</blockquote>;
      case 'code': return <pre><code>{token.text}</code></pre>;
      case 'codespan': return <code>{token.text}</code>;
      case 'br': return <br/>;
      case 'hr': return <hr/>;
      case 'list': return createElement(token.ordered ? 'ol' : 'ul', token.ordered ? { start: token.start } : {}, token.items.map((item: Tokens.ListItem) => <li>{item.task && <span aria-label={item.checked ? 'Completed' : 'Not completed'}>{item.checked ? '☑ ' : '☐ '}</span>}{renderTokens(item.tokens || [], depth + 1)}</li>));
      case 'table': return <div class="message-table"><table><thead><tr>{token.header.map((cell: { tokens: Token[] }) => <th>{renderTokens(cell.tokens, depth + 1)}</th>)}</tr></thead><tbody>{token.rows.map((row: { tokens: Token[] }[]) => <tr>{row.map(cell => <td>{renderTokens(cell.tokens, depth + 1)}</td>)}</tr>)}</tbody></table></div>;
      case 'link': {
        const href = safeLink(plainText(token.href));
        return href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={href}>{children()}</a> : children();
      }
      case 'image': return <span class="message-image-note">[Image: {token.text || 'description unavailable'} — not loaded]</span>;
      case 'html': return token.raw;
      case 'text': return token.tokens ? children() : plainText(token.text);
      case 'escape': return token.text;
      default: return token.raw;
    }
  });
}
export function MessageContent({ text, revision = 0, editable = false, edited, onSave }: { text: string; revision?: number; editable?: boolean; edited?: string | null; onSave?: (text: string, revision: number) => Promise<void> }) {
  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [baseRevision, setBaseRevision] = useState(0);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  function format(before: string, after = before) {
    const field = input.current; if (!field) return;
    const start = field.selectionStart, end = field.selectionEnd;
    setDraft(draft.slice(0, start) + before + draft.slice(start, end) + after + draft.slice(end));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + before.length, end + before.length); });
  }
  function formatLines(prefix: string) {
    const field = input.current; if (!field) return;
    const start = field.selectionStart, end = field.selectionEnd;
    const lineStart = draft.slice(0, start).lastIndexOf('\n') + 1;
    const lastSelected = end > start && draft[end - 1] === '\n' ? end - 1 : end;
    const nextBreak = draft.indexOf('\n', lastSelected);
    const lineEnd = nextBreak < 0 ? draft.length : nextBreak;
    const block = draft.slice(lineStart, lineEnd).split('\n').map(line => prefix + line).join('\n');
    setDraft(draft.slice(0, lineStart) + block + draft.slice(lineEnd));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(lineStart, lineStart + block.length); });
  }
  const formatted = useMemo(() => {
    try { return { content: renderTokens(Lexer.lex(text, { gfm: true, breaks: true })), failed: false }; }
    catch { return { content: text, failed: true }; }
  }, [text]);
  return <div class="message-content">
    <div class="message-display-controls">{edited && <small title={edited}>Edited</small>}<button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? 'Show formatting' : 'Show raw text'}</button>{onSave && <button type="button" aria-pressed={editing} disabled={saving || (!editing && !editable)} onClick={() => { if (!editing) { setDraft(text); setBaseRevision(revision); setError(''); } setEditing(!editing); }}>{editing ? 'Cancel edit' : 'Edit message'}</button>}</div>
    {editing ? <form class="message-editor" onSubmit={async e => { e.preventDefault(); if (!editable || saving || !draft.trim() || !onSave) return; setSaving(true); setError(''); try { await onSave(draft, baseRevision); setEditing(false); } catch (error: any) { setError(error.message || 'Could not save. Your draft is still here.'); } finally { setSaving(false); } }}>
      <fieldset disabled={saving}><div class="format-toolbar" role="group" aria-label="Message formatting">{[['Bold', '**', '**'], ['Italic', '*', '*'], ['Strike', '~~', '~~'], ['Heading 1', '# ', ''], ['Heading 2', '## ', ''], ['Heading 3', '### ', ''], ['List', '- ', ''], ['Quote', '> ', ''], ['Code', '`', '`'], ['Code block', '```\n', '\n```']].map(([label, before, after]) => <button type="button" onClick={() => after === '' ? formatLines(before) : format(before, after)}>{label}</button>)}</div>
      <label>Edit message text<textarea ref={input} value={draft} onInput={e => setDraft(e.currentTarget.value)} rows={8} maxLength={64000}/></label>
      <p class="hint">Markdown is editable here. Saving changes future conversation context only; later replies and tool actions are not rerun. Enter adds a new line in this editor.</p>
      {error && <p role="alert" class="error">{error}</p>}<button class="primary" disabled={!editable || !draft.trim() || draft.length > 64000}>Save message</button></fieldset>
    </form> : <div class={'message-text' + (raw || formatted.failed ? ' raw-message' : ' formatted-message')}>{raw ? text : formatted.content}</div>}
  </div>;
}
