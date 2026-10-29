// Offline observation only: in-memory inputs and injected fetch; never loads config or contacts a model.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildResponsesEndpoint, callModel } from './model-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, '.tmp/shared-model/client-path-observation.json');
const llm = {
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture-model',
  apiKey: 'fixture-secret-key',
  timeoutMs: 1000,
  maxOutputTokens: 32,
};
const messages = [{ role: 'user', content: 'fixture' }];
const usage = { input_tokens: 3, output_tokens: 5, total_tokens: 8 };
const successBody = JSON.stringify({
  id: 'resp_fixture',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '{}' }] }],
  usage,
});
const observations = [];
let injectedFetchCalls = 0;
const injected = (fetchImpl) => async (...args) => {
  injectedFetchCalls += 1;
  return fetchImpl(...args);
};

async function observe(name, run) {
  try {
    const detail = await run();
    observations.push({ name, passed: true, ...(detail ? { detail } : {}) });
  } catch (error) {
    observations.push({ name, passed: false, error: error?.name ?? 'Error' });
  }
}

const endpointCases = [
  ['https://fixture.invalid', 'https://fixture.invalid/responses'],
  ['https://fixture.invalid/', 'https://fixture.invalid/responses'],
  ['https://fixture.invalid/v1', 'https://fixture.invalid/v1/responses'],
  ['https://fixture.invalid/v1///', 'https://fixture.invalid/v1/responses'],
  ['https://fixture.invalid/v2', 'https://fixture.invalid/v2/responses'],
  ['https://fixture.invalid/custom/path', 'https://fixture.invalid/custom/path/responses'],
  ['https://fixture.invalid/v1/responses', 'https://fixture.invalid/v1/responses'],
  ['https://fixture.invalid/v1/responses///', 'https://fixture.invalid/v1/responses'],
  ['http://fixture.invalid/v2', 'http://fixture.invalid/v2/responses'],
];

for (const [baseUrl, expected] of endpointCases) {
  await observe(`endpoint: ${baseUrl}`, async () => {
    assert.equal(buildResponsesEndpoint(baseUrl), expected);
    let calls = 0;
    const result = await callModel({ llm: { ...llm, baseUrl }, messages,
      fetchImpl: injected(async (url, options) => {
        calls += 1;
        assert.equal(url, expected);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, `Bearer ${llm.apiKey}`);
        const wire = JSON.parse(options.body);
        assert.deepEqual(wire, {
          model: llm.model,
          input: messages,
          text: { format: { type: 'json_object' } },
          stream: true,
          max_output_tokens: llm.maxOutputTokens,
          store: false,
        });
        for (const chatField of ['messages', 'response_format', 'max_completion_tokens']) {
          assert.equal(Object.hasOwn(wire, chatField), false);
        }
        return new Response(successBody, { status: 200 });
      }),
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.content, '{}');
    assert.equal(result.audit.requestSent, true);
    assert.equal(result.audit.responseComplete, true);
    assert.equal(result.audit.protocol, 'responses');
    assert.equal(result.audit.finishReason, 'completed');
    assert.equal(result.audit.incompleteReason ?? null, null);
    assert.deepEqual(result.audit.usage, usage);
    assert.deepEqual(result.audit.request.body, {
      model: llm.model,
      input: messages,
      text: { format: { type: 'json_object' } },
      stream: true,
      max_output_tokens: llm.maxOutputTokens,
      store: false,
    });
    return { endpoint: expected, finishReason: result.audit.finishReason, usage: result.audit.usage };
  });
}

for (const baseUrl of [
  'https://fixture.invalid?key=fixture-secret-key',
  'https://fixture.invalid/v1/responses?key=fixture-secret-key',
  'https://fixture.invalid?',
  'https://fixture.invalid#fixture-secret-key',
  'https://fixture.invalid#',
  'https://user:fixture-secret-key@fixture.invalid/v1',
  'https://fixture-secret-key@fixture.invalid',
  'https://@fixture.invalid',
  'ftp://fixture.invalid',
  '/v1',
  'not-a-url',
  ' https://fixture.invalid ',
  'https://fixture.invalid/v1/chat/completions',
  'https://fixture.invalid/v1/chat/completions///',
  'https://fixture.invalid/messages',
  'https://fixture.invalid/v1/messages/',
  null,
]) {
  await observe('reject unsafe/invalid URL', async () => {
    assert.throws(() => buildResponsesEndpoint(baseUrl), {
      name: 'TypeError', message: 'Invalid model API base URL.',
    });
    let calls = 0;
    const result = await callModel({ llm: { ...llm, baseUrl }, messages,
      fetchImpl: injected(async () => { calls += 1; throw new Error('Must not fetch'); }),
    });
    assert.equal(calls, 0);
    assert.equal(result.audit.error.code, 'invalid-config');
    assert.equal(result.audit.requestSent, false);
    assert.equal(result.audit.responseStatus, null);
    assert.equal(JSON.stringify(result).includes(llm.apiKey), false);
  });
}

await observe('Responses 404 diagnosis and single fetch', async () => {
  let calls = 0;
  let requestedUrl = null;
  const result = await callModel({ llm, messages, fetchImpl: injected(async (url) => {
    calls += 1;
    requestedUrl = url;
    return new Response('404 route not found for Responses', { status: 404 });
  }) });
  assert.equal(calls, 1);
  assert.equal(requestedUrl, 'https://fixture.invalid/v1/responses');
  assert.equal(result.ok, false);
  assert.equal(result.content, null);
  assert.equal(result.audit.error.code, 'http-error');
  assert.match(result.audit.error.message, /404/);
  assert.match(result.audit.error.message, /responses/i);
  assert.equal(result.audit.error.message.includes(llm.apiKey), false);
  assert.equal(JSON.stringify(result).includes(llm.apiKey), false);
  assert.equal(result.audit.responseStatus, 404);
  assert.equal(result.audit.requestSent, true);
  assert.equal(result.audit.responseComplete, true);
});

await observe('HTTP error raw body and request secret redaction', async () => {
  const result = await callModel({ llm,
    messages: [{ role: 'user', content: llm.apiKey }],
    fetchImpl: injected(async () => new Response(`500 ${llm.apiKey}`, { status: 500 })),
  });
  assert.equal(result.audit.error.code, 'http-error');
  assert.equal(result.audit.rawResponse, '500 [REDACTED]');
  assert.equal(result.audit.request.body.input[0].content, '[REDACTED]');
  assert.equal(JSON.stringify(result).includes(llm.apiKey), false);
  assert.equal(result.audit.requestSent, true);
});

await observe('non-404 HTTP error makes one request', async () => {
  let calls = 0;
  const result = await callModel({ llm, messages, fetchImpl: injected(async () => {
    calls += 1;
    return new Response('unavailable', { status: 503 });
  }) });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.audit.error.code, 'http-error');
  assert.equal(result.audit.responseStatus, 503);
});

await observe('completed response aggregates reasoning-prefixed text blocks and preserves raw usage', async () => {
  const body = {
    id: 'resp_multi_part',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_fixture', summary: [] },
      { type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: '{"value":' },
        { type: 'output_text', text: '4' },
      ] },
      { type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: '2' },
        { type: 'output_text', text: '}' },
      ] },
    ],
    usage,
  };
  const result = await callModel({ llm, messages,
    fetchImpl: injected(async () => new Response(JSON.stringify(body), { status: 200 })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, '{"value":42}');
  assert.deepEqual(JSON.parse(result.content), { value: 42 });
  assert.equal(result.audit.protocol, 'responses');
  assert.equal(result.audit.finishReason, 'completed');
  assert.deepEqual(result.audit.usage, usage);
});

await observe('refusal content item is rejected', async () => {
  const body = {
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'refusal', refusal: 'Synthetic refusal.' }] }],
  };
  let calls = 0;
  const result = await callModel({ llm, messages,
    fetchImpl: injected(async () => { calls += 1; return new Response(JSON.stringify(body)); }),
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.content, null);
  assert.equal(result.audit.error.code, 'refusal');
});

await observe('refusal output item is rejected', async () => {
  const body = { status: 'completed', output: [{ type: 'refusal', refusal: 'Synthetic refusal.' }] };
  const result = await callModel({ llm, messages,
    fetchImpl: injected(async () => new Response(JSON.stringify(body))),
  });
  assert.equal(result.ok, false);
  assert.equal(result.audit.error.code, 'refusal');
});

await observe('content-filter incomplete response is a refusal', async () => {
  const body = { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] };
  const result = await callModel({ llm, messages,
    fetchImpl: injected(async () => new Response(JSON.stringify(body))),
  });
  assert.equal(result.ok, false);
  assert.equal(result.content, null);
  assert.equal(result.audit.error.code, 'refusal');
  assert.equal(result.audit.incompleteReason, 'content_filter');
});

await observe('max-output incomplete response is truncated', async () => {
  const body = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] };
  const result = await callModel({ llm, messages,
    fetchImpl: injected(async () => new Response(JSON.stringify(body))),
  });
  assert.equal(result.ok, false);
  assert.equal(result.content, null);
  assert.equal(result.audit.error.code, 'truncated');
  assert.equal(result.audit.incompleteReason, 'max_output_tokens');
  assert.match(result.audit.error.message, /max_output_tokens/);
});

await observe('failed Responses status is provider error', async () => {
  const body = { status: 'failed', error: { code: 'server_error', message: 'Synthetic provider failure.' } };
  const result = await callModel({ llm, messages,
    fetchImpl: injected(async () => new Response(JSON.stringify(body))),
  });
  assert.equal(result.ok, false);
  assert.equal(result.content, null);
  assert.equal(result.audit.error.code, 'provider-error');
});

await observe('legacy choices format is rejected without fallback', async () => {
  let calls = 0;
  const legacy = { choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { total_tokens: 4 } };
  const result = await callModel({ llm, messages, fetchImpl: injected(async () => {
    calls += 1;
    return new Response(JSON.stringify(legacy));
  }) });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.content, null);
  assert.equal(result.audit.error.code, 'invalid-response');
});

await observe('fetch that ignores AbortSignal still times out', async () => {
  let calls = 0;
  let signal = null;
  const result = await callModel({ llm: { ...llm, timeoutMs: 15 }, messages,
    fetchImpl: injected(async (_url, options) => {
      calls += 1;
      signal = options.signal;
      return new Promise(() => {});
    }),
  });
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.equal(result.audit.error.code, 'timeout');
  assert.equal(result.audit.requestSent, true);
  assert.equal(result.audit.responseComplete, false);
});

await observe('body timeout cancels a stalled response with one fetch', async () => {
  let calls = 0;
  let cancelled = false;
  const result = await callModel({ llm: { ...llm, timeoutMs: 15 }, messages,
    fetchImpl: injected(async () => {
      calls += 1;
      return { status: 200, body: { getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => { cancelled = true; },
        releaseLock() {},
      }) } };
    }),
  });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.equal(result.audit.error.code, 'timeout');
  assert.equal(result.audit.requestSent, true);
  assert.equal(result.audit.responseComplete, false);
});

await observe('1 MiB body limit cancels oversized response with one fetch', async () => {
  let calls = 0;
  let cancelled = false;
  const result = await callModel({ llm, messages, fetchImpl: injected(async () => {
    calls += 1;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }));
  }) });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.equal(result.audit.error.code, 'response-too-large');
  assert.equal(result.audit.requestSent, true);
  assert.equal(result.audit.responseComplete, false);
  assert.equal(result.audit.rawResponse, null);
});

const summary = {
  passed: observations.filter((item) => item.passed).length,
  failed: observations.filter((item) => !item.passed).length,
  total: observations.length,
  injectedFetchCalls,
  realNetworkRequests: 0,
};
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  summary,
  observations,
  limitation: 'Synthetic in-memory Responses fixtures only; no model or network request was made.',
};
mkdirSync(dirname(EVIDENCE), { recursive: true, mode: 0o700 });
writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(`${summary.failed === 0 ? 'PASS' : 'FAIL'}: ${summary.passed}/${summary.total} observations; injected fetches ${summary.injectedFetchCalls}; real requests 0; evidence ${EVIDENCE}`);
if (summary.failed > 0) process.exitCode = 1;
