import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { callModel } from './model-client.mjs';
import { createEventParser } from './stream-events.mjs';

const llm = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic-secret' };
const encode = (value) => new TextEncoder().encode(value);
const event = (value, newline = '\n') => `event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
const complete = (text = '{}') => ({ type: 'response.completed', response: { status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } });
const streamed = (data) => new Response(data, { headers: { 'content-type': 'text/event-stream' } });
const run = (fetchImpl, options = {}) => callModel({ llm, messages: [], fetchImpl, ...options });
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.message }); }
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const created = { type: 'response.created', response: { status: 'in_progress' } };

await check('stream enabled without total timeout or output token parameter', async () => {
  let calls = 0;
  const result = await run(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
    return streamed(event(created) + event(complete()));
  });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.equal(result.audit.eventsReceived, 2);
  assert.equal(result.audit.usage.total_tokens, 5);
});
await check('progress arrives before completion and terminal event need not wait for EOF', async () => {
  let controller;
  const first = deferred();
  const response = streamed(new ReadableStream({ start(c) { controller = c; c.enqueue(encode(event(created))); } }));
  let finished = false;
  const pending = run(async () => response, { onProgress: (p) => { if (p.eventsReceived) first.resolve(); } }).then((r) => { finished = true; return r; });
  await first.promise;
  assert.equal(finished, false);
  controller.enqueue(encode(event(complete())));
  assert.equal((await pending).ok, true);
});
await check('UTF8 and CRLF split at every byte decode correctly', async () => {
  const bytes = encode(event({ type: 'response.output_text.delta', delta: '你好' }, '\r\n') + event(complete('你好'), '\r\n'));
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const result = await run(async () => streamed(body));
  assert.equal(result.content, '你好'); assert.equal(result.ok, true);
});
await check('SSE comments and multiline data are supported', () => {
  const events = [];
  const parser = createEventParser((e) => events.push(e));
  parser.push(': heartbeat\r\nevent: test\r\ndata: {"a":1,\r\ndata: "b":2}\r\n\r');
  parser.push('\n'); parser.end();
  assert.deepEqual(JSON.parse(events[0].data), { a: 1, b: 2 }); assert.equal(events.length, 1);
});
await check('stream EOF without terminal response rejects partial output', async () => {
  const result = await run(async () => streamed(event({ type: 'response.output_text.delta', delta: '{}' })));
  assert.equal(result.audit.error.code, 'truncated'); assert.equal(result.content, null);
});
await check('stream incomplete preserves max token diagnostic', async () => {
  const result = await run(async () => streamed(event({ type: 'response.incomplete', response: {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
  } })));
  assert.equal(result.audit.error.code, 'truncated'); assert.match(result.audit.error.message, /max_output_tokens/);
});
await check('stream provider failure is rejected', async () => {
  const result = await run(async () => streamed(event({ type: 'response.failed', response: { status: 'failed', output: [], error: { code: 'fixture' } } })));
  assert.equal(result.audit.error.code, 'provider-error');
});
await check('SSE error event is rejected', async () => {
  const result = await run(async () => streamed(event({ type: 'error', code: 'fixture' })));
  assert.equal(result.audit.error.code, 'provider-error');
});
await check('stream refusal is not accepted as output', async () => {
  const value = complete(); value.response.output[0].content = [{ type: 'refusal', refusal: 'fixture' }];
  assert.equal((await run(async () => streamed(event(value)))).audit.error.code, 'refusal');
});
await check('malformed event JSON is rejected', async () => {
  assert.equal((await run(async () => streamed('data: {bad}\n\n'))).audit.error.code, 'invalid-response');
});
await check('HTTP error JSON remains diagnosable without retry', async () => {
  assert.equal((await run(async () => new Response('{}', { status: 429 }))).audit.error.code, 'http-error');
});
await check('abort before start sends no request', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await run(async () => { throw new Error('must not fetch'); }, { signal: controller.signal });
  assert.equal(result.audit.error.code, 'cancelled'); assert.equal(result.audit.requestSent, false);
});
await check('abort while waiting for headers cancels request', async () => {
  const controller = new AbortController(); let aborted = false;
  const pending = run(async (_url, init) => { init.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }, { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).audit.error.code, 'cancelled'); assert.equal(aborted, true);
});
await check('abort during stream cancels reader and returns no content', async () => {
  const controller = new AbortController(); const first = deferred(); let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(encode(event(created))); }, cancel() { cancelled = true; } });
  const pending = run(async () => streamed(body), { signal: controller.signal, onProgress: (p) => { if (p.eventsReceived) first.resolve(); } });
  await first.promise; controller.abort(); const result = await pending;
  assert.equal(result.audit.error.code, 'cancelled'); assert.equal(result.content, null); assert.equal(cancelled, true);
});
await check('partial key prefixes and final audit are redacted', async () => {
  const progress = [];
  const result = await run(async () => streamed(event({ type: 'response.output_text.delta', delta: llm.apiKey.slice(0, 6) }) + event(complete(llm.apiKey))), { onProgress: (p) => progress.push(p) });
  assert.equal(result.content, '[REDACTED]'); assert.equal(JSON.stringify(result).includes(llm.apiKey), false);
  assert.equal(progress.some((p) => p.preview.includes(llm.apiKey.slice(0, 6))), false);
});
await check('reasoning events only update status, never expose reasoning text', async () => {
  const progress = [];
  const result = await run(async () => streamed(event({ type: 'response.reasoning_text.delta', delta: 'private-reasoning-fixture' }) + event(complete())), { onProgress: (p) => progress.push(p) });
  assert.equal(result.ok, true); assert.equal(JSON.stringify(progress).includes('private-reasoning-fixture'), false);
});
await check('nonstream JSON fallback remains usable', async () => {
  assert.equal((await run(async () => new Response(JSON.stringify(complete().response)))).ok, true);
});

const directory = resolve('.tmp/shared-model'); mkdirSync(directory, { recursive: true });
const summary = { checks: checks.length, passed: checks.filter((c) => c.pass).length, realNetworkRequests: 0, privateConfigurationReads: 0 };
writeFileSync(join(directory, 'stream-observation.json'), JSON.stringify({ summary, checks }, null, 2) + '\n');
console.log(JSON.stringify({ summary, failures: checks.filter((c) => !c.pass) }, null, 2));
if (summary.passed !== summary.checks) process.exitCode = 1;
