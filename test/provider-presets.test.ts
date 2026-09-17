import test from 'node:test';
import assert from 'node:assert/strict';
import { providers, resolvePreset } from '../src/provider-catalog.ts';
import { validateConnection, streamReply } from '../src/provider.ts';
import { nativeRequest, requestHeaders } from '../src/provider-native.ts';
import { listModels, listVoices, speak } from '../src/provider-services.ts';
import { credentialId, connectionKey, saveConnection } from '../src/connections.ts';
import { fixture } from './helpers.ts';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sig = () => new AbortController().signal;
const custom = (dialect: string) => validateConnection({ endpoint: 'https://fixture.invalid/v1', model: 'test-model', dialect });
const wire = (events: any[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
function transport(body: unknown, type = 'application/json', status = 200) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetcher = (async (url: any, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
  }) as typeof fetch;
  return { fetcher, calls };
}
const responseText = (text = 'Hello') => [
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: { id: 'resp-test', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } },
];
const anthropic = (blocks: any[], finish = 'end_turn') => [
  { type: 'message_start', message: { id: 'msg-test', role: 'assistant' } },
  ...blocks.flatMap((b, index) => [{ type: 'content_block_start', index, content_block: b }, { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: finish } }, { type: 'message_stop' },
];

test('all 16 requested provider presets resolve automatically; regional plans and dynamic protocols', () => {
  assert.equal(providers.filter(p => p.id !== 'custom').length, 16);
  for (const p of providers.filter(p => p.id !== 'custom')) {
    const c = validateConnection({ provider: p.id, model: 'fixture-model', endpoint: 'https://malicious.invalid', auth: 'none' });
    assert.ok(c.endpoint.startsWith('https://')); assert.ok(!c.endpoint.includes('malicious')); assert.equal(c.auth, 'auto'); assert.equal(c.route, 'auto');
    for (const v of p.variants || []) assert.equal(resolvePreset(p.id, v.id).endpoint, v.endpoint);
  }
  assert.equal(resolvePreset('opencode', '', '', 'claude-fixture').dialect, 'anthropic');
  assert.equal(resolvePreset('opencode', '', '', 'gemini-fixture').dialect, 'gemini');
  assert.equal(resolvePreset('opencode', '', '', 'gpt-fixture').dialect, 'responses');
  assert.match(resolvePreset('aws-mantle', '', 'eu-west-1', 'anthropic.claude-fixture').endpoint, /eu-west-1.*anthropic\/v1$/);
  assert.throws(() => resolvePreset('aws-claude', '', 'malicious.invalid'));
  assert.throws(() => resolvePreset('dashscope', 'unknown'));
});
test('each of five API categories accepts custom proxies and explicit authentication', () => {
  for (const dialect of ['chat-completions', 'responses', 'anthropic', 'gemini', 'speech']) {
    const c = validateConnection({ ...custom(dialect), auth: 'bearer', name: 'My proxy' });
    assert.equal(c.dialect, dialect); assert.equal(c.endpoint, 'https://fixture.invalid/v1');
    assert.equal(requestHeaders(c, 'synthetic-key').Authorization, 'Bearer synthetic-key');
    assert.equal(requestHeaders({ ...c, auth: 'none' }, 'synthetic-key').Authorization, undefined);
  }
  assert.equal(requestHeaders(custom('anthropic'), 'synthetic-key')['x-api-key'], 'synthetic-key');
  assert.equal(requestHeaders(custom('gemini'), 'synthetic-key')['x-goog-api-key'], 'synthetic-key');
  assert.equal(requestHeaders(custom('speech'), 'synthetic-key')['xi-api-key'], 'synthetic-key');
  assert.throws(() => requestHeaders(custom('responses'), 'key\r\ninjected'));
});
test('Responses streams native text and preserves encrypted reasoning and function calls in tool continuation', async () => {
  const native = [{ type: 'reasoning', id: 'rs1', encrypted_content: 'synthetic-encrypted-fixture', summary: [] }, { type: 'function_call', call_id: 'call1', name: 'read_text', arguments: '{"path":"a.txt"}' }];
  const f = transport(wire([{ type: 'response.completed', response: { status: 'completed', output: native } }]), 'text/event-stream');
  const c = custom('responses'), result = await streamReply(c, 'synthetic-key', [], true, sig(), () => {}, f.fetcher);
  assert.equal(result.calls[0].id, 'call1'); assert.deepEqual(result.native, native);
  const next = nativeRequest(c, [{ role: 'assistant', content: '', native: result.native, tool_calls: result.calls }, { role: 'tool', content: 'file content', tool_call_id: 'call1' }], true);
  assert.deepEqual(next.body.input.slice(0, 2), native); assert.equal(next.body.input[2].call_id, 'call1');
  assert.equal(next.body.store, false); assert.ok(next.body.tools.every((t: any) => t.type === 'function' && t.strict === false));
  const text = transport(wire(responseText()), 'text/event-stream'), seen: string[] = [];
  assert.equal((await streamReply(c, '', [], false, sig(), s => seen.push(s), text.fetcher)).text, 'Hello'); assert.deepEqual(seen, ['Hello']);
});
test('Anthropic streams signed thinking and tool JSON without exposing thinking as public text', async () => {
  const events = [
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private synthetic thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-fixture' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool1', name: 'read_text', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
    { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ];
  const f = transport(wire(events), 'text/event-stream'), c = custom('anthropic');
  const r = await streamReply(c, '', [], true, sig(), () => {}, f.fetcher); assert.equal(r.text, ''); assert.equal(r.native![0].signature, 'signed-fixture');
  assert.equal(r.calls[0].function.arguments, '{"path":"a.txt"}');
  const next = nativeRequest(c, [{ role: 'system', content: 'system' }, { role: 'assistant', content: '', native: r.native }, { role: 'tool', content: 'file', tool_call_id: 'tool1' }], true);
  assert.deepEqual(next.body.messages[0].content, r.native); assert.equal(next.body.messages[1].content[0].tool_use_id, 'tool1'); assert.equal(next.body.system, 'system');
  const text = transport(wire(anthropic([{ type: 'text', text: 'Hello' }])), 'text/event-stream');
  assert.equal((await streamReply(c, '', [], false, sig(), () => {}, text.fetcher)).text, 'Hello');
});
test('Gemini preserves thought signatures and native tool IDs; local IDs never sent as provider IDs', async () => {
  for (const id of [undefined, 'native-call-id']) {
    const parts = [{ text: 'private thought', thought: true }, { functionCall: { name: 'read_text', args: { path: 'a.txt' }, ...(id ? { id } : {}) }, thoughtSignature: 'synthetic-signature' }];
    const f = transport(wire([{ candidates: [{ index: 0, content: { parts }, finishReason: 'STOP' }] }, { usageMetadata: { totalTokenCount: 10 } }]), 'text/event-stream'), c = custom('gemini');
    const r = await streamReply(c, '', [], true, sig(), () => {}, f.fetcher); assert.equal(r.text, ''); assert.deepEqual(r.native, parts);
    const next = nativeRequest(c, [{ role: 'assistant', content: '', native: r.native, tool_calls: r.calls }, { role: 'tool', content: 'file', tool_call_id: r.calls[0].id }], true);
    assert.deepEqual(next.body.contents[0].parts, parts); assert.equal(next.body.contents[1].parts[0].functionResponse.id, id);
    assert.match(next.url, /models\/test-model:streamGenerateContent\?alt=sse$/);
  }
  const f = transport(wire([{ candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }] }]), 'text/event-stream');
  assert.equal((await streamReply(custom('gemini'), '', [], false, sig(), () => {}, f.fetcher)).text, 'Hello');
});
test('native protocols reject truncation, RP tools, duplicate calls, stream errors and excessive output', async () => {
  const cases: [string, any[]][] = [
    ['responses', responseText().slice(0, 1)], ['responses', [{ type: 'response.incomplete' }]],
    ['responses', [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'read_text', arguments: '{}' }] } }]],
    ['responses', responseText('x'.repeat(64001))], ['responses', [{ type: 'error', error: { secret: 'withheld' } }]],
    ['responses', [{ type: 'response.completed', response: { status: 'completed', output: [1, 2].map(() => ({ type: 'function_call', call_id: 'same', name: 'read_text', arguments: '{}' })) } }]],
    ['anthropic', anthropic([{ type: 'text', text: 'cut' }], 'max_tokens')],
    ['anthropic', anthropic([{ type: 'tool_use', id: 'c', name: 'read_text', input: {} }], 'tool_use')],
    ['gemini', [{ candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] }]],
    ['gemini', [{ candidates: [{ content: { parts: [{ functionCall: { name: 'read_text', args: {} } }] }, finishReason: 'STOP' }] }]],
  ];
  for (const [dialect, events] of cases) { const f = transport(wire(events), 'text/event-stream'); await assert.rejects(streamReply(custom(dialect), '', [], false, sig(), () => {}, f.fetcher)); }
  for (const dialect of ['responses', 'anthropic', 'gemini']) {
    const f = transport('secret raw error', 'application/json', 403); await assert.rejects(streamReply(custom(dialect), '', [], false, sig(), () => {}, f.fetcher), /HTTP 403.*withheld/); assert.equal(f.calls.length, 1);
  }
});
test('catalogs use native paths/auth, filter usable types, identify partial catalogs and do not generate', async () => {
  const google = transport({ models: [{ name: 'models/text', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'more' });
  const r = await listModels(custom('gemini'), 'synthetic-key', sig(), google.fetcher); assert.equal(r.models.length, 1); assert.equal(r.models[0].id, 'text'); assert.equal(r.partial, true); assert.match(google.calls[0].url, /models\?pageSize=1000$/);
  const aws = validateConnection({ provider: 'aws-mantle', model: 'anthropic.claude-fixture' }), f = transport({ data: [{ id: 'test' }], has_more: true });
  await listModels(aws, 'synthetic-key', sig(), f.fetcher); assert.match(f.calls[0].url, /api.aws\/v1\/models$/); assert.equal((f.calls[0].init.headers as any).Authorization, 'Bearer synthetic-key');
  const never = transport({}); const suggestion = await listModels(validateConnection({ provider: 'glm', model: 'test' }), '', sig(), never.fetcher); assert.equal(never.calls.length, 0); assert.equal(suggestion.source, 'documentation');
  const speech = transport([{ model_id: 'tts', can_do_text_to_speech: true }, { model_id: 'other', can_do_text_to_speech: false }]); assert.equal((await listModels(custom('speech'), '', sig(), speech.fetcher)).models.length, 1);
  const voices = transport({ voices: [{ voice_id: 'fixture', name: 'Voice' }], has_more: true });
  await listVoices(validateConnection({ provider: 'elevenlabs', model: 'test' }), 'synthetic-key', sig(), voices.fetcher); assert.match(voices.calls[0].url, /\/v2\/voices\?page_size=100$/);
});
test('speech sends only explicit bounded text/model/voice and rejects wrong content or oversized input', async () => {
  const c = custom('speech'), f = transport('synthetic-mp3-bytes', 'audio/mpeg');
  assert.equal(new TextDecoder().decode(await speak(c, 'synthetic-key', { voice: 'voice1', text: 'fixture text' }, sig(), f.fetcher)), 'synthetic-mp3-bytes');
  assert.deepEqual(f.calls[0].body, { text: 'fixture text', model_id: 'test-model' }); assert.match(f.calls[0].url, /text-to-speech\/voice1\?output_format=mp3_44100_128$/);
  await assert.rejects(speak(c, '', { voice: '../bad', text: 'text' }, sig(), f.fetcher));
  await assert.rejects(speak(c, '', { voice: 'v', text: 'x'.repeat(5001) }, sig(), f.fetcher)); assert.equal(f.calls.length, 1);
  const bad = transport('not-audio'); await assert.rejects(speak(c, '', { voice: 'v', text: 'text' }, sig(), bad.fetcher), /MP3/);
});
test('saved keys are scoped to destination/category/auth; profiles and speech remain independent', async t => {
  const { app, request } = await fixture(t); await app.vault.unlock('synthetic fixture passphrase');
  const a = await saveConnection(app.store, app.vault, { ...custom('anthropic'), apiKey: 'synthetic-key-A', keyMode: 'keep' });
  const b = await saveConnection(app.store, app.vault, { ...custom('anthropic'), endpoint: 'https://other.invalid/v1', keyMode: 'keep', credentialId: a.credentialId });
  assert.equal(b.hasKey, false); assert.notEqual(a.credentialId, b.credentialId);
  assert.equal(connectionKey(app.store, app.vault, a, { keyMode: 'keep' }), 'synthetic-key-A');
  assert.equal(connectionKey(app.store, app.vault, { ...a, dialect: 'gemini' }, { keyMode: 'keep' }), '');
  assert.equal(connectionKey(app.store, app.vault, { ...a, auth: 'bearer' }, { keyMode: 'keep' }), '');
  assert.equal(credentialId({ ...a, route: 'tor', model: 'different' }), a.credentialId);
  await saveConnection(app.store, app.vault, { ...a, keyMode: 'keep' });
  const speech = await saveConnection(app.store, app.vault, { ...custom('speech'), apiKey: 'synthetic-key-voice', keyMode: 'keep' });
  assert.equal(app.store.setting('connection').credentialId, a.credentialId); assert.equal(app.store.setting('speechConnection').credentialId, speech.credentialId);
  const state = JSON.stringify((await request('/state')).data); assert.ok(!state.includes('synthetic-key'));
  await saveConnection(app.store, app.vault, { ...a, keyMode: 'clear' }); assert.equal(connectionKey(app.store, app.vault, a, { keyMode: 'keep' }), '');
});
test('legacy provider credential migrates only to its exact destination and vault lock gates all configuration', async t => {
  const { app } = await fixture(t); await app.vault.unlock('synthetic fixture passphrase');
  const c = custom('chat-completions'); app.store.setSetting('connection', c); await app.vault.set('provider', 'synthetic-legacy-key');
  assert.equal(connectionKey(app.store, app.vault, c, { keyMode: 'keep' }), 'synthetic-legacy-key');
  assert.equal(connectionKey(app.store, app.vault, { ...c, endpoint: 'https://other.invalid' }, { keyMode: 'keep' }), '');
  const saved = await saveConnection(app.store, app.vault, { ...c, keyMode: 'keep' }); assert.equal(app.vault.get(saved.credentialId!), 'synthetic-legacy-key');
  app.vault.lock(); await assert.rejects(saveConnection(app.store, app.vault, { ...c, auth: 'none', keyMode: 'keep' }), /unlock/i);
});
test('all native protocols complete a real trusted-file tool round through the coordinator without persisting reasoning', async t => {
  const { app, dir, wait } = await fixture(t); await app.vault.unlock('synthetic fixture passphrase');
  const project = join(dir, 'native-project'); await mkdir(project); await writeFile(join(project, 'a.txt'), 'Native fixture file');
  for (const dialect of ['responses', 'anthropic', 'gemini']) {
    const requests: any[] = [];
    const tool = dialect === 'responses' ? [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'private-native-fixture', summary: [] }, { type: 'function_call', call_id: 'c1', name: 'read_text', arguments: '{"path":"a.txt"}' }] } }]
      : dialect === 'anthropic' ? anthropic([{ type: 'thinking', thinking: 'private-native-fixture', signature: 'synthetic-signature' }, { type: 'tool_use', id: 'c1', name: 'read_text', input: { path: 'a.txt' } }], 'tool_use')
      : [{ candidates: [{ content: { parts: [{ functionCall: { name: 'read_text', args: { path: 'a.txt' } }, thoughtSignature: 'private-native-fixture' }] }, finishReason: 'STOP' }] }];
    const final = dialect === 'responses' ? responseText() : dialect === 'anthropic' ? anthropic([{ type: 'text', text: 'Hello' }]) : [{ candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }] }];
    const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(wire(requests.length === 1 ? tool : final)); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      await saveConnection(app.store, app.vault, { ...custom(dialect), endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, keyMode: 'keep' });
      const c = app.store.create('coding', dialect); app.store.project(c.id, project, true);
      const job = await wait(app.engine.start(c.id, 'Read a.txt', 1).id);
      assert.equal(job.status, 'complete', `${dialect}: ${job.error || job.text}`); assert.equal(job.actions.length, 1); assert.equal(requests.length, 2);
      assert.match(JSON.stringify(requests[1]), /private-native-fixture/); assert.match(JSON.stringify(requests[1]), /Native fixture file/);
      assert.ok(!JSON.stringify(app.store.messages(c.id)).includes('private-native-fixture')); assert.ok(!JSON.stringify(job).includes('private-native-fixture'));
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }
});
test('chat-compatible signed reasoning and reasoning_content survive the next tool request without entering public text', async () => {
  const details = [{ type: 'reasoning.text', text: 'private fixture', index: 0 }, { type: 'reasoning.encrypted', data: 'signed-fixture', index: 1 }];
  const events = [{ choices: [{ index: 0, delta: { reasoning_details: details, reasoning_content: 'private thought', tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_text', arguments: '{}' } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }];
  const f = transport(wire(events) + 'data: [DONE]\n\n', 'text/event-stream'), c = custom('chat-completions');
  const r = await streamReply(c, '', [], true, sig(), () => {}, f.fetcher); assert.equal(r.text, ''); assert.deepEqual(r.reasoning_details, details);
  const next = transport(wire([{ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n', 'text/event-stream');
  await streamReply(c, '', [{ role: 'assistant', content: '', tool_calls: r.calls, reasoning_details: r.reasoning_details, reasoning_content: r.reasoning_content }], true, sig(), () => {}, next.fetcher);
  assert.deepEqual(next.calls[0].body.messages[0].reasoning_details, details); assert.equal(next.calls[0].body.messages[0].reasoning_content, 'private thought');
});
test('catalog API requires vault access, redacts typed key echoes, and speech requires a model before any paid request', async t => {
  const { app, request } = await fixture(t); let hits = 0;
  const server = createServer((req, res) => { hits++; req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture', name: req.headers.authorization }] })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const input = { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, provider: 'custom', apiKey: 'synthetic-catalog-key', keyMode: 'keep' };
  assert.equal((await request('/models', input)).status, 423); assert.equal(hits, 0);
  await app.vault.unlock('synthetic fixture passphrase');
  const result = await request('/models', input); assert.equal(result.status, 200); assert.equal(hits, 1); assert.ok(!JSON.stringify(result.data).includes(input.apiKey));
  assert.equal((await request('/speech', { ...input, dialect: 'speech', text: 'fixture', voice: 'voice1' })).status, 400); assert.equal(hits, 1);
  const profile = await saveConnection(app.store, app.vault, { ...input, model: 'fixture', apiKey: 'short', auth: 'bearer' });
  assert.equal(app.vault.get(profile.credentialId!), 'short');
});
