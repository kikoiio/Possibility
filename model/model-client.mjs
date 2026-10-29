import { createEventParser } from './stream-events.mjs';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const REDACTED = '[REDACTED]';

const ERROR_MESSAGES = {
  'invalid-config': 'Invalid model client configuration or messages.',
  'http-error': 'The model endpoint returned an unsuccessful HTTP status.',
  'network-error': 'The model request failed before a complete response was received.',
  timeout: 'The model request timed out.',
  cancelled: 'The model request was cancelled. No future facts were committed.',
  'response-too-large': 'The model response exceeded the 1 MiB safety limit.',
  'invalid-response': 'The model endpoint returned an invalid response.',
  'provider-error': 'The model provider reported a failed response.',
  truncated: 'The model response ended before it was complete.',
  refusal: 'The model refused or filtered the request.',
  'empty-content': 'The model response contained no content.',
};

class ResponseReadError extends Error {
  constructor(code, partial = null) {
    super(code);
    this.code = code;
    this.partial = partial;
  }
}

function redactString(value, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return value;
  return value.split(secret).join(REDACTED);
}

function redactDeep(value, secret) {
  if (typeof value === 'string') return redactString(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactString(key, secret),
      redactDeep(item, secret),
    ]));
  }
  return value;
}

function makeId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to a local identifier if the runtime crypto getter is unavailable.
  }
  return `model-call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function utf8ByteLength(value) {
  if (value.length > MAX_RESPONSE_BYTES) return MAX_RESPONSE_BYTES + 1;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > MAX_RESPONSE_BYTES) return bytes;
  }
  return bytes;
}

function toBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Unsupported response chunk');
}

function cancelQuietly(cancel) {
  try {
    const result = cancel?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Cancellation is best effort; the caller already has the primary failure.
  }
}

async function readResponseBody(response, onPartial, setCancel) {
  if (response?.body && typeof response.body.getReader === 'function') {
    let reader;
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      reader = response.body.getReader();
      setCancel(() => reader.cancel());
      while (true) {
        const result = await reader.read();
        if (!result || typeof result !== 'object') throw new TypeError('Invalid stream result');
        if (result.done) {
          text += decoder.decode();
          onPartial(text);
          return text;
        }
        const chunk = toBytes(result.value);
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          cancelQuietly(() => reader.cancel());
          throw new ResponseReadError('response-too-large');
        }
        text += decoder.decode(chunk, { stream: true });
        onPartial(text);
      }
    } catch (error) {
      if (error instanceof ResponseReadError) throw error;
      throw new ResponseReadError('truncated', text);
    } finally {
      try { reader?.releaseLock(); } catch { /* A pending read may still own the lock. */ }
    }
  }

  if (typeof response?.text === 'function') {
    setCancel(() => response.body?.cancel?.());
    let text;
    try {
      text = await response.text();
    } catch {
      throw new ResponseReadError('truncated', null);
    }
    if (typeof text !== 'string') throw new ResponseReadError('invalid-response');
    if (utf8ByteLength(text) > MAX_RESPONSE_BYTES) {
      cancelQuietly(() => response.body?.cancel?.());
      throw new ResponseReadError('response-too-large');
    }
    onPartial(text);
    return text;
  }

  throw new ResponseReadError('invalid-response');
}

function isNonEmptyObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractUsage(rawResponse) {
  try {
    const parsed = JSON.parse(rawResponse);
    return isNonEmptyObject(parsed?.usage) ? parsed.usage : null;
  } catch {
    return null;
  }
}

async function readResponseEvents(response, setCancel, progress) {
  if (typeof response.body?.getReader !== 'function') throw new ResponseReadError('invalid-response');
  const reader = response.body.getReader();
  setCancel(() => reader.cancel());
  const decoder = new TextDecoder();
  let terminal = null;
  const parser = createEventParser(({ event, data }) => {
    if (terminal || data === '[DONE]') return;
    let value;
    try { value = JSON.parse(data); } catch { throw new ResponseReadError('invalid-response'); }
    const type = value.type ?? event;
    progress(type, value);
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
      if (!isNonEmptyObject(value.response)) throw new ResponseReadError('invalid-response');
      terminal = value.response;
    } else if (type === 'error') {
      terminal = { status: 'failed', error: value.error ?? { code: value.code, message: value.message }, output: [] };
    }
  });
  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) { parser.push(decoder.decode()); parser.end(); break; }
      parser.push(decoder.decode(toBytes(value), { stream: true }));
    }
    if (!terminal) throw new ResponseReadError('truncated');
    const raw = JSON.stringify(terminal);
    if (utf8ByteLength(raw) > MAX_RESPONSE_BYTES) throw new ResponseReadError('response-too-large');
    return raw;
  } catch (error) {
    if (error instanceof ResponseReadError) throw error;
    throw new ResponseReadError('truncated');
  } finally {
    cancelQuietly(() => reader.cancel());
    try { reader.releaseLock(); } catch { /* Cancellation may still be settling. */ }
  }
}

function isValidConfig(llm, messages, fetchImpl) {
  return Boolean(
    llm && typeof llm === 'object'
      && typeof llm.baseUrl === 'string' && llm.baseUrl.trim().length > 0
      && typeof llm.model === 'string' && llm.model.trim().length > 0
      && typeof llm.apiKey === 'string' && llm.apiKey.length > 0
      && (llm.timeoutMs == null || (Number.isSafeInteger(llm.timeoutMs) && llm.timeoutMs > 0 && llm.timeoutMs <= MAX_TIMEOUT_MS))
      && (llm.maxOutputTokens == null || (Number.isSafeInteger(llm.maxOutputTokens) && llm.maxOutputTokens > 0))
      && (llm.reasoningEffort == null || ['none', 'low', 'medium', 'high', 'max'].includes(llm.reasoningEffort))
      && Array.isArray(messages)
      && typeof fetchImpl === 'function',
  );
}

export function buildResponsesEndpoint(baseUrl) {
  const invalid = () => new TypeError('Invalid model API base URL.');
  if (typeof baseUrl !== 'string' || baseUrl !== baseUrl.trim()
    || /[\\\s]/.test(baseUrl)
    || !/^https?:\/\//i.test(baseUrl) || /[?#]/.test(baseUrl)
    || /^https?:\/\/[^/\\]*@/i.test(baseUrl)) throw invalid();
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) throw invalid();
  const endpoint = baseUrl.replace(/\/+$/, '');
  let path;
  try { path = decodeURIComponent(parsed.pathname).replace(/\/+$/, ''); } catch { throw invalid(); }
  if (/\/(?:chat\/completions|completions|messages)$/i.test(path)) throw invalid();
  return endpoint.endsWith('/responses') ? endpoint : `${endpoint}/responses`;
}

export async function callModel({ llm, messages, fetchImpl = globalThis.fetch, signal, onProgress, jsonMode = true } = {}) {
  const startedClock = globalThis.performance?.now?.() ?? Date.now();
  const startedAt = new Date().toISOString();
  const secret = typeof llm?.apiKey === 'string' ? llm.apiKey : null;
  const audit = {
    id: makeId(),
    startedAt,
    model: typeof llm?.model === 'string' ? llm.model : null,
    request: { body: null, rawBody: null },
    requestSent: false,
    responseStatus: null,
    rawResponse: null,
    responseComplete: false,
    elapsedMs: 0,
    usage: null,
    protocol: 'responses',
    streaming: true,
    firstEventMs: null,
    firstTextMs: null,
    headersReceivedMs: null,
    streamedResponse: false,
    eventsReceived: 0,
    finishReason: null,
    incompleteReason: null,
    error: null,
  };
  let content = null;

  const finish = (code = null, message = null) => {
    const endedClock = globalThis.performance?.now?.() ?? Date.now();
    audit.elapsedMs = Math.max(0, endedClock - startedClock);
    audit.error = code === null ? null : { code, message: message ?? ERROR_MESSAGES[code] };
    const safeAudit = redactDeep(audit, secret);
    return {
      ok: code === null,
      content: typeof content === 'string' ? redactString(content, secret) : null,
      audit: safeAudit,
    };
  };

  if (!isValidConfig(llm, messages, fetchImpl)) return finish('invalid-config');

  let url;
  try { url = buildResponsesEndpoint(llm.baseUrl); } catch { return finish('invalid-config'); }

  const body = {
    model: llm.model,
    input: messages,
    ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}),
    stream: true,
    ...(llm.reasoningEffort ? { reasoning: { effort: llm.reasoningEffort } } : {}),
    ...(llm.maxOutputTokens == null ? {} : { max_output_tokens: llm.maxOutputTokens }),
    store: false,
  };
  let rawRequest;
  try {
    rawRequest = JSON.stringify(body);
    audit.request.body = JSON.parse(rawRequest);
    audit.request.rawBody = rawRequest;
  } catch {
    return finish('invalid-config');
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let response = null;
  let cancelInFlight = () => {};
  let outputText = '';
  let lastProgressAt = -Infinity;
  let lastPhase;
  const progress = (phase, force = false) => {
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (!force && phase === lastPhase && now - lastProgressAt < 100) return;
    lastProgressAt = now; lastPhase = phase;
    // Retain a bounded preview; do not publish a trailing partial secret.
    let safe = redactString(outputText, secret);
    for (let n = Math.min((secret?.length ?? 0) - 1, safe.length); n > 0; n--) {
      if (safe.endsWith(secret.slice(0, n))) { safe = safe.slice(0, -n); break; }
    }
    try { onProgress?.({ phase, elapsedMs: now - startedClock, eventsReceived: audit.eventsReceived, outputCharacters: outputText.length,
      headersReceivedMs: audit.headersReceivedMs, firstEventMs: audit.firstEventMs, firstTextMs: audit.firstTextMs, preview: safe.slice(-800) }); } catch { /* UI observers do not own model execution. */ }
  };
  const streamProgress = (type, event) => {
    audit.eventsReceived++;
    const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedClock;
    audit.firstEventMs ??= elapsed;
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      audit.firstTextMs ??= elapsed;
      outputText = (outputText + event.delta).slice(-MAX_RESPONSE_BYTES);
    }
    progress(outputText ? 'receiving' : 'generating', audit.eventsReceived === 1);
  };
  let cancelResolve;
  const cancelled = new Promise((resolve) => { cancelResolve = resolve; });
  const abort = () => {
    try { controller?.abort(); } catch { /* Race still resolves. */ }
    cancelQuietly(cancelInFlight);
    cancelResolve({ cancelled: true });
  };
  if (signal?.aborted) return finish('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  progress('connecting', true);

  const operation = (async () => {
    audit.requestSent = true;
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: rawRequest,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (Number.isInteger(response?.status)) audit.responseStatus = response.status;
    audit.headersReceivedMs = (globalThis.performance?.now?.() ?? Date.now()) - startedClock;
    const setCancel = (cancel) => {
      cancelInFlight = cancel;
    };
    const streamed = response?.status >= 200 && response?.status < 300
      && response.headers?.get?.('content-type')?.includes('text/event-stream');
    audit.streamedResponse = Boolean(streamed);
    progress('generating', true);
    const raw = streamed ? await readResponseEvents(response, setCancel, streamProgress)
      : await readResponseBody(response, (partial) => { audit.rawResponse = partial; }, setCancel);
    audit.rawResponse = raw;
    audit.responseComplete = true;
    audit.usage = extractUsage(raw);
    return raw;
  })();

  let timer;
  const races = [operation.then((raw) => ({ raw }), (error) => ({ error })), cancelled];
  if (llm.timeoutMs != null) races.push(new Promise((resolve) => {
    timer = setTimeout(() => {
      try { controller?.abort(); } catch { /* The race below still enforces the timeout. */ }
      cancelQuietly(cancelInFlight);
      cancelQuietly(() => response?.body?.cancel?.());
      resolve({ timedOut: true });
    }, llm.timeoutMs);
  }));

  const outcome = await Promise.race(races);
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);

  if (outcome.cancelled || signal?.aborted) return finish('cancelled');
  if (outcome.timedOut) {
    return finish('timeout');
  }
  if (outcome.error) {
    const error = outcome.error;
    if (error instanceof ResponseReadError) {
      if (error.code === 'response-too-large') audit.rawResponse = null;
      else if (typeof error.partial === 'string') audit.rawResponse = error.partial;
      audit.usage = typeof audit.rawResponse === 'string' ? extractUsage(audit.rawResponse) : null;
      return finish(error.code);
    }
    return finish(response ? 'truncated' : 'network-error');
  }

  const status = audit.responseStatus;
  if (status === null) return finish('invalid-response');
  if (status === 404) {
    return finish('http-error', 'HTTP 404：API路由未找到，检查Responses基址路径；支持完整/responses URL。');
  }
  if (status < 200 || status >= 300) return finish('http-error', `The model endpoint returned HTTP ${status}.`);

  let parsed;
  try {
    parsed = JSON.parse(outcome.raw);
  } catch {
    return finish('invalid-response');
  }
  if (!isNonEmptyObject(parsed)) return finish('invalid-response');
  audit.usage = isNonEmptyObject(parsed.usage) ? parsed.usage : null;

  audit.finishReason = typeof parsed.status === 'string' ? parsed.status : null;
  audit.incompleteReason = typeof parsed.incomplete_details?.reason === 'string'
    ? parsed.incomplete_details.reason : null;
  if (parsed.error != null || parsed.status === 'failed') return finish('provider-error');

  const texts = [];
  let invalidOutput = !Array.isArray(parsed.output);
  let refused = audit.incompleteReason === 'content_filter' || audit.incompleteReason === 'refusal';
  for (const item of Array.isArray(parsed.output) ? parsed.output : []) {
    if (!isNonEmptyObject(item)) { invalidOutput = true; continue; }
    if (item.type === 'reasoning') continue;
    if (item.type === 'refusal' || item.type === 'content_filter') { refused = true; continue; }
    if (item.type !== 'message' || !Array.isArray(item.content)) {
      invalidOutput = true;
      continue;
    }
    for (const part of item.content) {
      if (part?.type === 'refusal' || part?.type === 'content_filter') refused = true;
      else if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      else invalidOutput = true;
    }
  }
  if (refused) return finish('refusal');
  if (parsed.status === 'incomplete') return finish('truncated', audit.incompleteReason === 'max_output_tokens'
    ? 'The model provider stopped at max_output_tokens before completing its response.'
    : null);
  if (parsed.status !== 'completed' || invalidOutput) return finish('invalid-response');
  if (texts.join('').trim().length === 0) return finish('empty-content');

  content = texts.join('');
  return finish();
}

