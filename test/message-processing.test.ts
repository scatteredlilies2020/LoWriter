import test from 'node:test';
import assert from 'node:assert/strict';
import { processMessages, messageParts, prefillStart, rejectsPrefill, checkPrefillRejection } from '../src/message-processing.ts';
import { validateConnection, streamReply } from '../src/provider.ts';
import { nativeRequest } from '../src/provider-native.ts';
import { saveConnection } from '../src/connections.ts';
import { fixture } from './helpers.ts';
import type { Connection, ProviderMessage, MessageProcessing, Dialect } from '../src/shared.ts';

const c = (dialect: Dialect = 'chat-completions'): Connection => ({ endpoint: 'https://fixture.invalid/v1', provider: 'custom', dialect, model: 'fixture', route: 'direct', auth: 'bearer' });
const m = (role: string, content: string): ProviderMessage => ({ role, content });
const source = () => [m('system', 'System one'), m('system', 'System two'), m('user', 'First'), m('user', 'Second'), m('assistant', 'Earlier answer'), m('user', 'Continue this'), m('assistant', 'Opening'), m('assistant', 'unfinished ' )];
const wire = (events: any[]) => events.map(v => 'data: ' + JSON.stringify(v) + '\n\n').join('');
function success(dialect: Dialect) {
  let text: string;
  if (dialect === 'anthropic') text = wire([{ type: 'message_start', message: { role: 'assistant' } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'continued' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
  else if (dialect === 'gemini') text = wire([{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'continued' }] }, finishReason: 'STOP' }] }]);
  else if (dialect === 'responses') text = wire([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'continued' }] }] } }]);
  else text = wire([{ choices: [{ index: 0, delta: { content: 'continued' }, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('default merges only adjacent like roles, retains all trailing assistant text and leaves inputs unchanged', () => {
  assert.equal(validateConnection(c()).messageProcessing, 'merge');
  assert.throws(() => validateConnection({ ...c(), messageProcessing: 'bogus' }), /post-processing/);
  const input = source(), before = structuredClone(input), out = processMessages(input);
  assert.deepEqual(out.map(v => v.role), ['system', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(out[0].content, 'System one\n\nSystem two'); assert.equal(out[1].content, 'First\n\nSecond');
  assert.equal(out.at(-1)!.content, 'Opening\n\nunfinished '); assert.deepEqual(input, before);
  assert.equal(prefillStart(out), out.length - 1);
});

test('single-user merges dialogue, keeps system authority and trailing prefill, separate preserves boundaries', () => {
  const input = source();
  const single = processMessages(input, 'single');
  assert.deepEqual(single.map(v => v.role), ['system', 'user', 'assistant']);
  assert.equal(single[1].content, 'First\n\nSecond\n\nEarlier answer\n\nContinue this');
  assert.equal(single[2].content, 'Opening\n\nunfinished ');
  assert.deepEqual(processMessages(input, 'separate'), input);
  const fallback = processMessages(input, 'merge', false, true);
  assert.deepEqual(fallback.map(v => v.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(fallback[2].content, 'Earlier answer'); assert.equal(fallback.at(-1)!.content, 'Continue this\n\nOpening\n\nunfinished ');
  assert.deepEqual(processMessages(input, 'single', false, true).map(v => v.role), ['system', 'user']);
  assert.equal(processMessages([m('user', 'A'), m('system', 'B'), m('assistant', 'C'), m('user', 'D')], 'single').length, 3);
});

test('tool protocol and signed native reasoning are not flattened, merged or reclassified', () => {
  const input: ProviderMessage[] = [m('system', 'Rules'), m('user', 'Read'), { role: 'assistant', content: '', native: [{ type: 'thinking', signature: 'signed' }], tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_text', arguments: '{}' } }] }, { role: 'tool', content: 'Result', tool_call_id: 't1' }, { role: 'assistant', content: 'Visible', reasoning_details: [{ signature: 'sig' }] }];
  const before = structuredClone(input);
  assert.deepEqual(processMessages(input, 'single', true, true), before);
  assert.equal(prefillStart(input), input.length);
  assert.deepEqual(processMessages(input, 'single', false), before);
  assert.deepEqual(processMessages([m('user', 'A'), m('assistant', 'B'), m('user', 'C')], 'single', true).map(v => v.role), ['user', 'assistant', 'user']);
});

test('merged multimodal content retains text/image order across all native request formats', () => {
  const input = [m('system', 'Rules'), { ...m('user', 'Before image'), images: [{ mime: 'image/png', data: 'AA==' }] }, m('user', 'After image')];
  const out = processMessages(input);
  assert.deepEqual(messageParts(out[1]).map(p => p.type === 'text' ? p.text : 'IMAGE'), ['Before image', 'IMAGE', '\n\nAfter image']);
  assert.equal(nativeRequest(c('anthropic'), out, false).body.messages[0].content[1].type, 'image');
  assert.ok(nativeRequest(c('gemini'), out, false).body.contents[0].parts[1].inlineData);
  assert.equal(nativeRequest(c('responses'), out, false).body.input[1].content[1].type, 'input_image');
  for (const dialect of ['anthropic', 'gemini'] as Dialect[]) {
    const body = nativeRequest({ ...c(dialect), messageProcessing: 'separate' }, input, false).body;
    assert.equal((body.messages || body.contents).length, 2);
  }
});

test('explicit prefill rejection triggers exactly one same-destination retry across protocols and formats', async () => {
  for (const dialect of ['chat-completions', 'responses', 'anthropic', 'gemini'] as Dialect[]) for (const mode of ['merge', 'single', 'separate'] as MessageProcessing[]) {
    const calls: any[] = [], input = source(), before = structuredClone(input), controller = new AbortController();
    const fetcher = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      if (calls.length === 1) return new Response(JSON.stringify({ error: { message: 'This model does not support assistant message prefill.' } }), { status: 400 });
      return success(dialect);
    }) as typeof fetch;
    const result = await streamReply({ ...c(dialect), messageProcessing: mode }, 'synthetic-key', input, false, controller.signal, () => {}, fetcher);
    assert.equal(result.text, 'continued'); assert.equal(result.prefillFallback, true); assert.equal(calls.length, 2);
    assert.equal(calls[0].url, calls[1].url); assert.deepEqual(calls[0].headers, calls[1].headers); assert.equal(calls[1].body.model || c().model, c().model);
    const turns = (body: any) => body.messages || body.contents || body.input;
    assert.equal(turns(calls[0].body).at(-1).role, dialect === 'gemini' ? 'model' : 'assistant');
    assert.equal(turns(calls[1].body).at(-1).role, 'user'); assert.deepEqual(input, before);
  }
});

test('unsupported-prefill classifier is narrow and error bodies are bounded and never exposed', async () => {
  for (const text of ['This model does not support assistant message prefill.', 'Requests ending with a model turn are not supported', 'The last message must be a user message', 'Assistant prefill is not supported with this model']) assert.equal(rejectsPrefill(text), true, text);
  for (const text of ['Billing unavailable', 'Content policy refusal', 'Invalid max_tokens', 'Assistant prefill must not end with trailing whitespace', 'The conversation must end with an assistant message']) assert.equal(rejectsPrefill(text), false, text);
  const signal = new AbortController().signal;
  assert.equal(await checkPrefillRejection(new Response(JSON.stringify({ error: { message: 'Invalid temperature', prompt: 'prefill is not supported' } }), { status: 400 }), signal), false);
  assert.equal(await checkPrefillRejection(new Response('prefill is not supported' + 'x'.repeat(17000), { status: 400 }), signal), false);
  assert.equal(await checkPrefillRejection(new Response(JSON.stringify({ error: { metadata: { raw: JSON.stringify({ error: { message: 'Prefill is not supported' } }) } } }), { status: 422 }), signal), true);
});

test('unrelated errors, refusals, rate limits, timeouts, partial SSE and failed fallback are not replayed', async () => {
  for (const status of [400, 401, 403, 408, 429, 500]) {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(JSON.stringify({ error: { message: status === 400 ? 'Invalid temperature; synthetic-secret' : 'This model does not support assistant prefill; synthetic-secret' } }), { status }); }) as typeof fetch;
    await assert.rejects(streamReply(c(), '', source(), false, new AbortController().signal, () => {}, fetcher), e => !String(e).includes('synthetic-secret'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(streamReply(c(), '', source(), false, new AbortController().signal, () => {}, (async () => { calls++; throw new Error('network timeout'); }) as typeof fetch)); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(streamReply(c(), '', source(), false, new AbortController().signal, () => {}, (async () => { calls++; return new Response(wire([{ choices: [{ index: 0, delta: { content: 'Partial' } }] }, { error: { message: 'Prefill is not supported' } }]), { headers: { 'Content-Type': 'text/event-stream' } }); }) as typeof fetch)); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(streamReply(c(), '', source(), false, new AbortController().signal, () => {}, (async () => { calls++; return new Response('Prefill is not supported', { status: 400 }); }) as typeof fetch)); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(streamReply(c(), '', [m('user', 'No prefill')], false, new AbortController().signal, () => {}, (async () => { calls++; return new Response('Prefill is not supported', { status: 400 }); }) as typeof fetch)); assert.equal(calls, 1);
});

test('cancellation while reading rejection prevents compatibility retry', async () => {
  const controller = new AbortController(); let calls = 0;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('Prefill is not supported')); } });
  const task = streamReply(c(), '', source(), false, controller.signal, () => {}, (async () => { calls++; return new Response(body, { status: 400 }); }) as typeof fetch);
  controller.abort(); await assert.rejects(task); assert.equal(calls, 1);
});

test('message format persists per saved profile without changing credential scope', async t => {
  const { app } = await fixture(t); await app.vault.unlock('synthetic-postprocessing-passphrase');
  const first = await saveConnection(app.store, app.vault, { ...c(), name: 'One', messageProcessing: 'single', apiKey: 'synthetic-key' });
  const second = await saveConnection(app.store, app.vault, { ...c(), name: 'Two', messageProcessing: 'separate', keyMode: 'keep' });
  assert.equal(first.credentialId, second.credentialId); assert.notEqual(first.profileId, second.profileId);
  assert.deepEqual(app.store.setting('connections').map((p: Connection) => p.messageProcessing), ['single', 'separate']);
  assert.equal(app.engine.connection()!.messageProcessing, 'separate');
});
