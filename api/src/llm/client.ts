/** OpenAI 兼容协议客户端：chat completions + streaming + tools（N5） */

import { LlmContractError, llmError } from './contracts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ApiToolCall[]
  tool_call_id?: string
}

export interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done' }

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  provider?: { fetch(request: Request): Promise<Response> }
  reserve?: ReceiptReservation
}

export type ReceiptOutcome = 'completed' | 'failed' | 'cancelled'
export type ReceiptReservation = ((details: {
  requestId: string | null
  contextHash: string
  contractVersion: string
}) => Promise<string | void>) & {
  settle?: (receiptId: string, status: ReceiptOutcome, errorCode?: string | null) => Promise<void>
}

export function configFromEnv(env: {
  LLM_BASE_URL: string
  LLM_API_KEY: string
  LLM_MODEL: string
  LLM_PROVIDER?: { fetch(request: Request): Promise<Response> }
}, reserve?: ReceiptReservation): LlmConfig {
  return {
    baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    provider: env.LLM_PROVIDER,
    reserve,
  }
}

export interface CallOptions {
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  requestId?: string
  contractVersion?: string
  responseFormat?: { type: 'json_object' }
  thinking?: { type: 'enabled' | 'disabled' }
}

export interface ContractCallOptions<T> extends CallOptions {
  contractVersion: string
  parse: (content: string) => T
}

/** Covers headers AND body, even when a mocked/noncompliant transport ignores abort. */
function requestScope(opts: CallOptions, defaultTimeout: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(new LlmContractError('cancelled', 'LLM 请求已取消', {
    cause: opts.signal?.reason,
  }))
  if (opts.signal?.aborted) abort()
  else opts.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new LlmContractError('timeout', 'LLM 请求超时')),
    opts.timeoutMs ?? defaultTimeout)
  return {
    signal: controller.signal,
    async wait<T>(promise: Promise<T>): Promise<T> {
      const signal = controller.signal
      signal.throwIfAborted()
      let onAbort!: () => void
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const result = await Promise.race([promise, cancelled])
        signal.throwIfAborted()
        return result
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
    close() {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      controller.abort()
    },
  }
}
type RequestScope = ReturnType<typeof requestScope>

async function readText(res: Response, scope: RequestScope): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const cancel = () => { void reader.cancel(scope.signal.reason).catch(() => {}) }
  scope.signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      scope.signal.throwIfAborted()
      const { done, value } = await scope.wait(reader.read())
      if (done) return text + decoder.decode()
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    scope.signal.removeEventListener('abort', cancel)
    await reader.cancel(scope.signal.reason).catch(() => {})
    reader.releaseLock()
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function receiptFailure(error: unknown, scope: RequestScope): { status: 'failed' | 'cancelled'; errorCode: string } {
  const normalized = scope.signal.aborted ? llmError(scope.signal.reason) : llmError(error)
  return {
    status: normalized.code === 'timeout' || normalized.code === 'cancelled' ? 'cancelled' : 'failed',
    errorCode: normalized.code,
  }
}

async function settleReceipt(
  config: LlmConfig,
  receiptId: string | null,
  status: ReceiptOutcome,
  errorCode: string | null = null,
): Promise<void> {
  if (receiptId && config.reserve?.settle) await config.reserve.settle(receiptId, status, errorCode)
}

async function postChat(
  config: LlmConfig,
  payload: Record<string, unknown>,
  scope: RequestScope,
  opts: CallOptions,
): Promise<{ response: Response; receiptId: string | null }> {
  const body = JSON.stringify(payload)
  scope.signal.throwIfAborted()
  if (!config.reserve) throw new Error('LLM 调用缺少预算 reservation')
  const receiptId = await config.reserve({
    requestId: opts.requestId ?? null,
    contextHash: await sha256(body),
    contractVersion: opts.contractVersion ?? 'chat-completions/v1',
  }) ?? null
  try {
    scope.signal.throwIfAborted()
    const url = `${config.baseUrl}/chat/completions`
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: scope.signal,
    }
    const pending = config.provider ? config.provider.fetch(new Request(url, init)) : fetch(url, init)
    // A transport resolving headers after cancellation must not leave an unread body alive.
    void pending.then((res) => {
      if (scope.signal.aborted) void res.body?.cancel().catch(() => {})
    }, () => {})
    const res = await scope.wait(pending)
    if (!res.ok) {
      const text = await readText(res, scope)
      throw new LlmContractError('provider_http_error', `LLM 请求失败（${res.status}）：${text.slice(0, 500)}`)
    }
    return { response: res, receiptId }
  } catch (error) {
    const failure = receiptFailure(error, scope)
    await settleReceipt(config, receiptId, failure.status, failure.errorCode)
    throw error
  }
}

function toApiTools(tools: ToolDef[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

async function completeParsed<T>(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: CallOptions,
  parse: (content: string) => T,
): Promise<T> {
  const scope = requestScope(opts, 180_000)
  let receiptId: string | null = null
  try {
    const posted = await postChat(
      config,
      {
        model: config.model,
        messages,
        stream: false,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
      },
      scope,
      opts,
    )
    receiptId = posted.receiptId
    let data: { choices?: { message?: { content?: string } }[] }
    try {
      data = JSON.parse(await readText(posted.response, scope)) as typeof data
    } catch (error) {
      throw new LlmContractError('invalid_json', 'LLM 返回的 JSON 无法解析', { cause: error })
    }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new LlmContractError('invalid_response', 'LLM 返回缺少内容')
    }
    // “completed” means the caller-visible contract has passed, not merely that
    // the provider returned a non-empty string. Contract callers therefore parse
    // inside this receipt boundary.
    const result = parse(content)
    await settleReceipt(config, receiptId, 'completed')
    receiptId = null
    return result
  } catch (error) {
    if (receiptId) {
      const failure = receiptFailure(error, scope)
      await settleReceipt(config, receiptId, failure.status, failure.errorCode)
      receiptId = null
    }
    throw error
  } finally {
    scope.close()
  }
}

/** 非流式一次性调用，返回文本；timeoutMs 防挂死。 */
export async function complete(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<string> {
  return completeParsed(config, messages, opts, content => content)
}

/**
 * 结构化合同调用。只有 parse 完成后 receipt 才进入 completed；解析或业务合同
 * 校验失败会以稳定错误码进入 failed，避免“传输成功”冒充“合同成功”。
 */
export async function completeContract<T>(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: ContractCallOptions<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await completeParsed(config, messages, opts, opts.parse)
    } catch (error) {
      const isRetryableEmptyJson = opts.responseFormat?.type === 'json_object'
        && error instanceof LlmContractError && error.code === 'invalid_response'
      if (attempt > 0 || !isRetryableEmptyJson) throw error
    }
  }
  throw new Error('unreachable')
}

/**
 * 流式调用：产出文本增量；tool_calls 分片累积完整后产出；
 * 流结束产出 done。timeoutMs 防挂死（缺省 120s，超时中断整个流）。
 */
export async function* streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  tools?: ToolDef[],
  opts: CallOptions = {},
): AsyncIterable<StreamEvent> {
  const apiTools = toApiTools(tools)
  const scope = requestScope(opts, 120_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let receiptId: string | null = null
  let settled = false
  const cancel = () => { void reader?.cancel(scope.signal.reason).catch(() => {}) }
  try {
    const posted = await postChat(
      config,
      {
        model: config.model,
        messages,
        stream: true,
        ...(apiTools ? { tools: apiTools, tool_choice: 'auto' } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      },
      scope,
      opts,
    )
  receiptId = posted.receiptId
  const res = posted.response
  if (!res.body) throw new Error('LLM 流式响应缺少 body')

  reader = res.body.getReader()
  scope.signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  // tool_calls 分片累积：index → 完整调用
  const pending = new Map<number, { id: string; name: string; arguments: string }>()

  function drainToolCalls(): StreamEvent[] {
    const out: StreamEvent[] = []
    for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      let args: unknown = {}
      try {
        args = JSON.parse(tc.arguments || '{}')
      } catch {
        args = { _raw: tc.arguments }
      }
      out.push({ type: 'tool_call', id: tc.id, name: tc.name, args })
    }
    pending.clear()
    return out
  }

  for (;;) {
    scope.signal.throwIfAborted()
    const { done, value } = await scope.wait(reader.read())
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2))
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') {
          for (const ev of drainToolCalls()) yield ev
          await settleReceipt(config, receiptId, 'completed')
          settled = true
          yield { type: 'done' }
          return
        }
        let json: {
          type?: string
          choices?: {
            delta?: {
              content?: string | null
              tool_calls?: {
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }[]
            }
            finish_reason?: string | null
          }[]
        }
        try {
          json = JSON.parse(data)
        } catch (error) {
          throw new LlmContractError('malformed_stream', 'LLM 流包含无法解析的数据帧', { cause: error })
        }
        if (json.type === 'response.completed' || json.type === 'message_stop') {
          for (const ev of drainToolCalls()) yield ev
          await settleReceipt(config, receiptId, 'completed')
          settled = true
          yield { type: 'done' }
          return
        }
        const choice = json.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text', delta: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const i = part.index ?? 0
            const cur = pending.get(i) ?? { id: '', name: '', arguments: '' }
            if (part.id) cur.id = part.id
            if (part.function?.name) cur.name += part.function.name
            if (part.function?.arguments) cur.arguments += part.function.arguments
            pending.set(i, cur)
          }
        }
        if (choice.finish_reason === 'tool_calls') {
          for (const ev of drainToolCalls()) yield ev
        }
      }
    }
  }
  throw new LlmContractError('truncated', buffer.trim()
    ? 'LLM 流在完整数据帧中途结束'
    : 'LLM 流在明确完成标志前结束')
  } catch (error) {
    if (receiptId && !settled) {
      const failure = receiptFailure(error, scope)
      await settleReceipt(config, receiptId, failure.status, failure.errorCode)
      settled = true
    }
    throw error
  } finally {
    if (receiptId && !settled) await settleReceipt(config, receiptId, 'cancelled', 'consumer_cancelled')
    scope.signal.removeEventListener('abort', cancel)
    cancel()
    reader?.releaseLock()
    scope.close()
  }
}
