/** OpenAI 兼容协议客户端：chat completions + streaming + tools（N5） */

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
  reserve?: () => Promise<void>
}

export function configFromEnv(env: {
  LLM_BASE_URL: string
  LLM_API_KEY: string
  LLM_MODEL: string
}, reserve?: () => Promise<void>): LlmConfig {
  return {
    baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    reserve,
  }
}

export interface CallOptions {
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** Covers headers AND body, even when a mocked/noncompliant transport ignores abort. */
function requestScope(opts: CallOptions, defaultTimeout: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(opts.signal?.reason ?? new Error('LLM 请求已取消'))
  if (opts.signal?.aborted) abort()
  else opts.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), opts.timeoutMs ?? defaultTimeout)
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
    cancel()
    reader.releaseLock()
  }
}

async function postChat(config: LlmConfig, payload: Record<string, unknown>, scope: RequestScope): Promise<Response> {
  const body = JSON.stringify(payload)
  scope.signal.throwIfAborted()
  if (!config.reserve) throw new Error('LLM 调用缺少预算 reservation')
  await config.reserve()
  scope.signal.throwIfAborted()
  const pending = fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body,
    signal: scope.signal,
  })
  // A transport resolving headers after cancellation must not leave an unread body alive.
  void pending.then((res) => {
    if (scope.signal.aborted) void res.body?.cancel().catch(() => {})
  }, () => {})
  const res = await scope.wait(pending)
  if (!res.ok) {
    const text = await readText(res, scope)
    throw new Error(`LLM 请求失败（${res.status}）：${text.slice(0, 500)}`)
  }
  return res
}

function toApiTools(tools: ToolDef[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/** 非流式一次性调用，返回文本（供蒸馏、Fork 预览等 JSON 输出场景）；timeoutMs 防挂死 */
export async function complete(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<string> {
  const scope = requestScope(opts, 180_000)
  let data: { choices?: { message?: { content?: string } }[] }
  try {
    const res = await postChat(
      config,
      {
        model: config.model,
        messages,
        stream: false,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      },
      scope,
    )
    data = JSON.parse(await readText(res, scope)) as typeof data
  } finally {
    scope.close()
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM 返回缺少内容')
  }
  return content
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
  const cancel = () => { void reader?.cancel(scope.signal.reason).catch(() => {}) }
  try {
    const res = await postChat(
      config,
      {
        model: config.model,
        messages,
        stream: true,
        ...(apiTools ? { tools: apiTools, tool_choice: 'auto' } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      },
      scope,
    )
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
          yield { type: 'done' }
          return
        }
        let json: {
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
        } catch {
          continue
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
  for (const ev of drainToolCalls()) yield ev
  yield { type: 'done' }
  } finally {
    scope.signal.removeEventListener('abort', cancel)
    cancel()
    reader?.releaseLock()
    scope.close()
  }
}
