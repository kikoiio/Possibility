const TOKEN_KEY = 'possibility_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(path, { ...options, headers })
  if (res.status === 401) {
    const hadToken = !!token
    clearToken()
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    // 持有 token 时的 401 = 会话失效，跳登录页；登录失败则原地展示服务端消息
    if (hadToken && !location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError(401, data.error ?? '未登录或会话已过期')
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`)
  }
  return res.json() as Promise<T>
}

/** SSE 事件（后端 data: {...}\n\n 格式） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SSEEvent = { type: string; [key: string]: any }

/**
 * POST 一个请求并按 SSE 逐事件回调（fetch + ReadableStream）。
 * 流结束（或收到 done 事件后连接关闭）时 resolve。
 */
export async function postSSE(
  path: string,
  body: unknown,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  const token = getToken()
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    const hadToken = !!token
    clearToken()
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (hadToken && !location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError(401, data.error ?? '未登录或会话已过期')
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) {
        try {
          onEvent(JSON.parse(data) as SSEEvent)
        } catch {
          // 忽略无法解析的心跳/注释行
        }
      }
    }
  }
}

/* ===== 阶段二：世界服务与公共只读接口 ===== */

import type {
  DemoInfo,
  DialogueDetail,
  PersonFocus,
  WorldDraft,
  WorldSnapshot,
  WorldStreamEvent,
  WorldSummary,
} from './types'

export const worldsApi = {
  draft: (prompt: string) => apiFetch<WorldDraft>('/api/worlds/draft', { method: 'POST', body: JSON.stringify({ prompt }) }),
  create: (payload: { name: string; description: string; locations: { name: string; description: string }[]; personIds: string[] }) =>
    apiFetch<{ id: string; timelineId: string }>('/api/worlds', { method: 'POST', body: JSON.stringify(payload) }),
  list: () => apiFetch<{ worlds: WorldSummary[] }>('/api/worlds'),
  snapshot: (worldId: string, timelineId?: string) =>
    apiFetch<WorldSnapshot>(`/api/worlds/${worldId}${timelineId ? `?timelineId=${timelineId}` : ''}`),
  pause: (worldId: string) => apiFetch<{ ok: true; status: string }>(`/api/worlds/${worldId}/pause`, { method: 'POST' }),
  resume: (worldId: string) => apiFetch<{ ok: true; status: string }>(`/api/worlds/${worldId}/resume`, { method: 'POST' }),
  inject: (worldId: string, text: string, timelineId?: string) =>
    apiFetch<{ id: string; timelineId: string; simTime: string }>(`/api/worlds/${worldId}/inject`, {
      method: 'POST',
      body: JSON.stringify({ text, timelineId }),
    }),
  fork: (worldId: string, timelineId: string) =>
    apiFetch<{ id: string; simNow: string }>(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, { method: 'POST' }),
  archiveTimeline: (timelineId: string) => apiFetch<{ ok: true; status: string }>(`/api/timelines/${timelineId}/archive`, { method: 'POST' }),
  personFocus: (worldId: string, personId: string, timelineId: string) =>
    apiFetch<PersonFocus>(`/api/worlds/${worldId}/persons/${personId}?timelineId=${timelineId}`),
  dialogueDetail: (dialogueId: string) => apiFetch<DialogueDetail>(`/api/worlds/dialogues/${dialogueId}`),
}

/** 访客公共只读接口（不依赖登录态；若本地有 token 也无妨，服务端不做校验） */
export const publicApi = {
  demo: () => apiFetch<DemoInfo>('/api/public/demo'),
  snapshot: (worldId: string, timelineId?: string) =>
    apiFetch<WorldSnapshot>(`/api/public/worlds/${worldId}${timelineId ? `?timelineId=${timelineId}` : ''}`),
  personFocus: (worldId: string, personId: string, timelineId: string) =>
    apiFetch<PersonFocus>(`/api/public/worlds/${worldId}/persons/${personId}?timelineId=${timelineId}`),
  dialogueDetail: (dialogueId: string) => apiFetch<DialogueDetail>(`/api/public/dialogues/${dialogueId}`),
}

/**
 * GET SSE 订阅世界流（fetch + ReadableStream，按 event 名分发）。
 * 返回取消函数；连接断开由调用方决定是否重建。
 */
export function subscribeWorldStream(
  worldId: string,
  timelineId: string,
  onEvent: (event: WorldStreamEvent) => void,
  opts: { isPublic?: boolean; onError?: (e: unknown) => void } = {},
): () => void {
  const controller = new AbortController()
  const base = opts.isPublic ? `/api/public/worlds/${worldId}/stream` : `/api/worlds/${worldId}/stream`
  const token = getToken()

  void (async () => {
    try {
      const res = await fetch(`${base}?timelineId=${timelineId}`, {
        headers: token && !opts.isPublic ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`流连接失败（${res.status}）`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          let eventName = 'message'
          const dataLines: string[] = []
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          const data = dataLines.join('\n')
          if (!data || eventName === 'ping') continue
          try {
            onEvent(JSON.parse(data) as WorldStreamEvent)
          } catch {
            // 忽略无法解析的帧
          }
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) opts.onError?.(e)
    }
  })()

  return () => controller.abort()
}
