import { pruneCompatibilityContinuationsForAuthChange } from '../scene/compatibility-store'

const TOKEN_KEY = 'possibility_token'
const GUEST_TOKEN_KEY = 'possibility_guest_token'
const GUEST_CLAIM_PENDING_KEY = 'possibility_guest_claim_pending'
const AUTH_IDENTITY_CHANGE_EVENT = 'possibility:auth-identity-change'
let guestRequestContext = false

function announceAuthIdentityChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_IDENTITY_CHANGE_EVENT))
}

export function subscribeAuthIdentityChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key === TOKEN_KEY || event.key === GUEST_TOKEN_KEY) {
      pruneCompatibilityContinuationsForAuthChange()
      listener()
    }
  }
  window.addEventListener(AUTH_IDENTITY_CHANGE_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(AUTH_IDENTITY_CHANGE_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** Scope otherwise shared API clients to the guest route while it is mounted. */
export function setGuestRequestContext(active: boolean): void { guestRequestContext = active }

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getGuestToken(): string | null { return localStorage.getItem(GUEST_TOKEN_KEY) }

export function setToken(token: string): void {
  const previous = localStorage.getItem(TOKEN_KEY)
  const changed = previous !== token
  localStorage.setItem(TOKEN_KEY, token)
  if (changed) {
    if (previous !== null) pruneCompatibilityContinuationsForAuthChange()
    announceAuthIdentityChange()
  }
}

export function clearToken(): void {
  const changed = localStorage.getItem(TOKEN_KEY) !== null
  if (changed) pruneCompatibilityContinuationsForAuthChange()
  localStorage.removeItem(TOKEN_KEY)
  if (changed) announceAuthIdentityChange()
}

export function setGuestToken(token: string): void {
  const previous = localStorage.getItem(GUEST_TOKEN_KEY)
  const changed = previous !== token
  localStorage.setItem(GUEST_TOKEN_KEY, token)
  if (changed) {
    if (previous !== null) pruneCompatibilityContinuationsForAuthChange()
    announceAuthIdentityChange()
  }
}
export function clearGuestToken(): void {
  const changed = localStorage.getItem(GUEST_TOKEN_KEY) !== null
  if (changed) pruneCompatibilityContinuationsForAuthChange()
  localStorage.removeItem(GUEST_TOKEN_KEY)
  if (changed) announceAuthIdentityChange()
}
export function isGuestClaimPending(): boolean { return localStorage.getItem(GUEST_CLAIM_PENDING_KEY) === '1' }
export function setGuestClaimPending(pending: boolean): void {
  if (pending) localStorage.setItem(GUEST_CLAIM_PENDING_KEY, '1')
  else localStorage.removeItem(GUEST_CLAIM_PENDING_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** 服务端附带的校验明细（如 422 的 issues 列表），无则 undefined */
    public issues?: { code: string; message: string }[],
    public kind?: string,
    public callsUsed?: number,
    public errorCode?: string,
  ) {
    super(message)
  }
}

type ApiErrorEnvelope = {
  error?: string
  issues?: { code: string; message: string }[]
  kind?: string
  callsUsed?: number
  errorCode?: string
}

async function readApiErrorEnvelope(response: Response): Promise<ApiErrorEnvelope> {
  return response.json().catch(() => ({})) as Promise<ApiErrorEnvelope>
}

export async function apiFetch<T>(path: string, options: RequestInit = {}, behavior: { redirectOnUnauthorized?: boolean } = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (guestRequestContext) headers.delete('Authorization')
  const token = guestRequestContext ? null : getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  else {
    const guestToken = getGuestToken()
    if (guestToken) headers.set('X-Possibility-Guest', guestToken)
  }

  const res = await fetch(path, { ...options, headers })
  if (res.status === 401) {
    const hadToken = !!token
    if (hadToken) clearToken()
    else if (!guestRequestContext) clearGuestToken()
    const data = await readApiErrorEnvelope(res)
    // 持有 token 时的 401 = 会话失效，跳登录页；登录失败则原地展示服务端消息
    if (hadToken && behavior.redirectOnUnauthorized !== false && !location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError(401, data.error ?? '未登录或会话已过期', data.issues, data.kind, data.callsUsed, data.errorCode)
  }
  if (!res.ok) {
    const data = await readApiErrorEnvelope(res)
    throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`, data.issues, data.kind, data.callsUsed, data.errorCode)
  }
  return res.json() as Promise<T>
}

/** Explicit guest identity for recovery routes, even when an account token is present. */
export async function apiFetchAsGuest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const guestToken = getGuestToken()
  if (guestToken) headers.set('X-Possibility-Guest', guestToken)
  headers.delete('Authorization')
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    const data = await readApiErrorEnvelope(res)
    // Keep the guest credential on failure so a pending copy remains recoverable.
    throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`, data.issues, data.kind, data.callsUsed, data.errorCode)
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
  signal?: AbortSignal,
): Promise<void> {
  const token = guestRequestContext ? null : getToken()
  const guestToken = token ? null : getGuestToken()
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(guestToken ? { 'X-Possibility-Guest': guestToken } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })
  if (res.status === 401) {
    const hadToken = !!token
    if (hadToken) clearToken()
    else if (!guestRequestContext) clearGuestToken()
    const data = await readApiErrorEnvelope(res)
    if (hadToken && !location.pathname.startsWith('/login')) location.href = '/login'
    throw new ApiError(401, data.error ?? '未登录或会话已过期', data.issues, data.kind, data.callsUsed, data.errorCode)
  }
  if (!res.ok || !res.body) {
    const data = await readApiErrorEnvelope(res)
    throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`, data.issues, data.kind, data.callsUsed, data.errorCode)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
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
  } finally {
    reader.releaseLock()
  }
}

/* ===== 阶段二：世界服务与公共只读接口 ===== */

import type {
  ChatRequestState,
  Chapter,
  ChapterSummary,
  DemoInfo,
  DialogueDetail,
  ForkInitialAction,
  ForkScenario,
  ForkScenarioInput,
  ForkResult,
  HistoryRange,
  PersonFocus,
  Persona,
  PersonaMention,
  PersonaMessage,
  WorldDraft,
  WorldSnapshot,
  WorldStreamEvent,
  WorldSummary,
  WorldState,
  EventEvidenceDetail,
  ReturnBrief,
  TimelineComparison,
} from './types'
import type { SceneReadResponse, SceneRepairContext, SceneRepairDraftResponse, VoxelSceneDraftResponse } from './types'
import type {
  ConfirmSceneCompatibilityParams,
  CreateSceneCompatibilityDraftParams,
  RecoverSceneCompatibilityParams,
  SceneCandidate,
  SceneCompatibilityDraftView,
  SceneCompatibilityPageQuery,
  SceneCompatibilityRequestResponse,
  SceneEditPreflightResult,
  SceneInspectionResultReady,
} from './types'
import type { SerializedVoxelDocument, SerializedVoxelSpaces } from '@possibility/voxel-contract'
import { createSseParser } from '../lib/sseParser'
import { createWorldStreamGuard } from '../lib/streamGuard'

/** 普通聊天：持久 request ID 是恢复与幂等边界。 */
export const chatApi = {
  history: (conversationId: string) =>
    apiFetch<{ messages: import('./types').Message[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    ),
  send: (
    conversationId: string,
    content: string,
    requestId: string,
    onEvent: (event: SSEEvent) => void,
    signal?: AbortSignal,
  ) => postSSE(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { content, requestId },
    onEvent,
    signal,
  ),
  requestStatus: (conversationId: string, requestId: string) =>
    apiFetch<ChatRequestState>(
      `/api/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}`,
    ),
  pendingRequests: (conversationId: string) =>
    apiFetch<{ requests: Pick<ChatRequestState, 'requestId' | 'channel' | 'status' | 'heartbeatAt' | 'createdAt' | 'updatedAt'>[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/requests/pending`,
    ),
  cancelRequest: (conversationId: string, requestId: string) =>
    apiFetch<ChatRequestState>(
      `/api/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}/cancel`,
      { method: 'POST' },
    ),
  recoverRequest: (conversationId: string, requestId: string) =>
    apiFetch<ChatRequestState>(
      `/api/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}/recover`,
      { method: 'POST' },
    ),
}

export const worldsApi = {
  draft: (prompt: string) => apiFetch<WorldDraft>('/api/worlds/draft', { method: 'POST', body: JSON.stringify({ prompt }) }),
  create: (payload: { name: string; description: string; locations: { name: string; description: string }[]; personIds: string[]; timeZone?: string; scene?: SerializedVoxelDocument | SerializedVoxelSpaces; sceneRequestId?: string }) =>
    apiFetch<{ id: string; timelineId: string }>('/api/worlds', { method: 'POST', body: JSON.stringify(payload) }),
  list: () => apiFetch<{ worlds: WorldSummary[] }>('/api/worlds'),
  timeZone: (worldId: string) => apiFetch<{ timeZone: string }>(`/api/worlds/${encodeURIComponent(worldId)}/time-zone`),
  updateTimeZone: (worldId: string, timeZone: string) => apiFetch<{ timeZone: string }>(`/api/worlds/${encodeURIComponent(worldId)}/time-zone`, { method: 'PUT', body: JSON.stringify({ timeZone }) }),
  snapshot: (worldId: string, timelineId?: string) =>
    apiFetch<WorldSnapshot>(`/api/worlds/${worldId}${timelineId ? `?timelineId=${timelineId}` : ''}`),
  state: (worldId: string, timelineId: string) =>
    apiFetch<WorldState>(`/api/worlds/${worldId}/state?timelineId=${encodeURIComponent(timelineId)}`),
  commandStatus: (worldId: string, commandId: string) =>
    apiFetch<{ id: string; timelineId: string; resultVersion: number }>(`/api/worlds/${worldId}/actions/${encodeURIComponent(commandId)}`),
  command: (worldId: string, body: { id: string; timelineId: string; expectedVersion: number; action: { type: 'environment'; location: string | null; condition: string; value: string } | { type: 'inform'; recipientId: string; topic: string; content: string; sourceFactId?: string } }) =>
    apiFetch<{ commandId: string; factId: string; version: number }>(`/api/worlds/${worldId}/actions`, { method: 'POST', body: JSON.stringify(body) }),
  pause: (worldId: string) => apiFetch<{ ok: true; status: string }>(`/api/worlds/${worldId}/pause`, { method: 'POST' }),
  resume: (worldId: string) => apiFetch<{ ok: true; status: string }>(`/api/worlds/${worldId}/resume`, { method: 'POST' }),
  archive: (worldId: string) => apiFetch<{ ok: true; status: string }>(`/api/worlds/${worldId}/archive`, { method: 'POST' }),
  inject: (worldId: string, text: string, timelineId: string, requestId: string, expectedVersion: number) =>
    apiFetch<{ id: string; timelineId: string; simTime: string; version: number; replayed: boolean }>(`/api/worlds/${worldId}/inject`, {
      method: 'POST',
      body: JSON.stringify({ text, timelineId, requestId, expectedVersion }),
    }),
  fork: (worldId: string, timelineId: string, requestId: string, scenario: ForkScenarioInput,
    f1?: { expectedSourceVersion: number; initialAction: ForkInitialAction }) =>
    apiFetch<ForkResult>(`/api/worlds/${worldId}/timelines/${timelineId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ requestId, scenario, ...f1 }),
    }),
  forkPreview: (worldId: string, timelineId: string, whatIf: string, startTime?: string) =>
    apiFetch<ForkScenario>(`/api/worlds/${worldId}/timelines/${timelineId}/fork/preview`, {
      method: 'POST',
      body: JSON.stringify(startTime ? { whatIf, startTime } : { whatIf }),
    }),
  /** S4/F6:历史可回溯范围(打开分叉弹窗时加载) */
  historyRange: (worldId: string, timelineId: string) =>
    apiFetch<HistoryRange>(`/api/worlds/${worldId}/timelines/${timelineId}/history`),
  /** S4/F6:单点可重建性判定;不可重建时 apiFetch 抛出带原因文案的错误 */
  checkMoment: (worldId: string, timelineId: string, at: string) =>
    apiFetch<{ ok: true; effectiveMoment: string }>(`/api/worlds/${worldId}/timelines/${timelineId}/history/check`, {
      method: 'POST',
      body: JSON.stringify({ at }),
    }),
  archiveTimeline: (timelineId: string) => apiFetch<{ ok: true; status: string }>(`/api/timelines/${timelineId}/archive`, { method: 'POST' }),
  personFocus: (worldId: string, personId: string, timelineId: string) =>
    apiFetch<PersonFocus>(`/api/worlds/${worldId}/persons/${personId}?timelineId=${timelineId}`),
  dialogueDetail: (dialogueId: string, timelineId?: string) => apiFetch<DialogueDetail>(
    `/api/worlds/dialogues/${dialogueId}${timelineId ? `?timelineId=${encodeURIComponent(timelineId)}` : ''}`),
}

export const mapApi = {
  recent: () => apiFetch<{ worldId: string; updatedAt: string } | null>('/api/map/resume/recent'),
  bootstrap: (worldId: string, timelineId?: string, signal?: AbortSignal) => apiFetch<import('./map').MapBootstrap>(
    `/api/worlds/${encodeURIComponent(worldId)}/map/bootstrap${timelineId ? `?timelineId=${encodeURIComponent(timelineId)}` : ''}`,
    { signal },
  ),
  saveResume: (worldId: string, input: { timelineId: string; spaceId: string; mode: 'create' | 'life' | 'possibility' }) =>
    apiFetch<{ ok: true }>(`/api/worlds/${encodeURIComponent(worldId)}/map/resume`, { method: 'PUT', body: JSON.stringify(input) }),
}

export const guestMapApi = {
  bootstrap: (worldId: string, timelineId?: string, signal?: AbortSignal) => apiFetchAsGuest<import('./map').MapBootstrap>(
    `/api/worlds/${encodeURIComponent(worldId)}/map/bootstrap${timelineId ? `?timelineId=${encodeURIComponent(timelineId)}` : ''}`,
    { signal },
  ),
  saveResume: (worldId: string, input: { timelineId: string; spaceId: string; mode: 'create' | 'life' | 'possibility' }) =>
    apiFetchAsGuest<{ ok: true }>(`/api/worlds/${encodeURIComponent(worldId)}/map/resume`, { method: 'PUT', body: JSON.stringify(input) }),
}

export const authApi = {
  me: () => apiFetch<{ user: { id: string; username: string } }>('/api/auth/me'),
}

export const demoApi = {
  start: async () => {
    const result = await apiFetchAsGuest<{ token: string; sessionId: string; worldId: string; timelineId: string; generation: number; expiresAt: string; claimPending?: boolean }>('/api/demo/session', { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) })
    setGuestToken(result.token)
    setGuestClaimPending(false)
    return result
  },
  current: () => apiFetchAsGuest<{ sessionId: string; worldId: string; timelineId: string; generation: number; expiresAt: string; claimPending?: boolean }>('/api/demo/session'),
  reset: async () => {
    const result = await apiFetchAsGuest<{ sessionId: string; worldId: string; timelineId: string; generation: number; expiresAt: string }>('/api/demo/session/reset', { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) })
    setGuestClaimPending(false)
    return result
  },
  claim: async (requestId: string = crypto.randomUUID()) => {
    setGuestClaimPending(true)
    const result = await apiFetch<{ kind: 'claimed'; worldId: string; replayed: boolean }>('/api/demo/session/claim', {
      method: 'POST',
      headers: getGuestToken() ? { 'X-Possibility-Guest': getGuestToken()! } : undefined,
      body: JSON.stringify({ requestId }),
    })
    setGuestClaimPending(false)
    return result
  },
  fork: (worldId: string, timelineId: string, input: Pick<ForkScenarioInput, 'name' | 'whatIf' | 'changedVariable'>, requestId: string = crypto.randomUUID()) => apiFetchAsGuest<ForkResult>(`/api/demo/worlds/${encodeURIComponent(worldId)}/fork`, { method: 'POST', body: JSON.stringify({ ...input, timelineId, requestId }) }),
  compare: (worldId: string, left: string, right: string) => apiFetchAsGuest<{ differences: { facts: unknown[]; states: unknown[]; events: { leftOnly: unknown[]; rightOnly: unknown[] } }; limitations: string[] }>(`/api/demo/worlds/${encodeURIComponent(worldId)}/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`),
}

export const worldSceneApi = {
  // S1 体素创建:提示词 → 世界骨架 + 体素草稿信封(S2 起唯一创建通道)
  draftVoxel: (prompt: string, personIds: string[], requestId = crypto.randomUUID()) => apiFetch<VoxelSceneDraftResponse>('/api/scene-drafts/voxel', { method: 'POST', body: JSON.stringify({ prompt, personIds, requestId }) }),
  repairContext: (worldId: string) => apiFetch<SceneRepairContext>(`/api/worlds/${encodeURIComponent(worldId)}/scene/repair-context`),
  repairDraft: (worldId: string, prompt: string, requestId = crypto.randomUUID()) => apiFetch<SceneRepairDraftResponse>(
    `/api/worlds/${encodeURIComponent(worldId)}/scene/repair-draft`,
    { method: 'POST', body: JSON.stringify({ prompt, requestId }) },
  ),
  commitRepairVoxel: (worldId: string, requestId: string, document: SerializedVoxelDocument) => apiFetch<{ document: SerializedVoxelDocument; version: number; contentHash: string; createdAt: string }>(
    `/api/worlds/${encodeURIComponent(worldId)}/scene/voxel-revision`,
    { method: 'POST', body: JSON.stringify({ expectedVersion: 0, requestId, document, repair: true }) },
  ),
  get: (worldId: string) => apiFetch<SceneReadResponse>(`/api/worlds/${worldId}/scene`),
  // S2b:体素整文档保存通道（T10 服务端 voxel-revision 端点）
  commitVoxel: (worldId: string, expectedVersion: number, requestId: string, document: SerializedVoxelDocument | SerializedVoxelSpaces, spaceId?: string) => apiFetch<{ document: SerializedVoxelDocument | SerializedVoxelSpaces; version: number; contentHash: string; createdAt: string }>(`/api/worlds/${worldId}/scene/voxel-revision`, { method: 'POST', body: JSON.stringify({ expectedVersion, requestId, document, ...(spaceId ? { spaceId } : {}) }) }),
  regenerateDemo: (worldId: string, expectedVersion: number, requestId = crypto.randomUUID()) => apiFetch<{ version: number; document: SerializedVoxelSpaces }>(`/api/worlds/${worldId}/scene/voxel-regenerate`, { method: 'POST', body: JSON.stringify({ expectedVersion, requestId }) }),
  history: (worldId: string) => apiFetch<{ revisions: { version: number; parentVersion: number | null; summary: string; kind: string; createdAt: string }[] }>(`/api/worlds/${worldId}/scene/revisions`),
  restore: (worldId: string, expectedVersion: number, targetVersion: number, requestId = crypto.randomUUID()) => apiFetch<{ version: number }>(`/api/worlds/${worldId}/scene/restore`, { method: 'POST', body: JSON.stringify({ expectedVersion, targetVersion, requestId }) }),
}

/**
 * A1 场景兼容:检查/候选预检/修复草稿生命周期/提交确认与结果恢复。
 * 全部走 apiFetch:结构化中文错误(errorCode+message)以 ApiError 抛出,支持 abort 信号。
 * actorKey、bindings、basis 等权威字段一律由服务端派生,客户端入参不含这些字段。
 */
export const sceneCompatibilityApi = {
  /** 当前或历史版本的兼容检查;非 ready 结果由服务端以 404/422 结构化错误返回。 */
  inspection: (worldId: string, options: { version?: number; signal?: AbortSignal } = {}) =>
    apiFetch<SceneInspectionResultReady>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/inspection${options.version ? `?version=${options.version}` : ''}`,
      { signal: options.signal },
    ),
  /** 完整候选(operations 或 document)编辑前预检。 */
  preflight: (worldId: string, candidate: SceneCandidate, signal?: AbortSignal) =>
    apiFetch<SceneEditPreflightResult>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/preflight`,
      { method: 'POST', body: JSON.stringify({ candidate }), signal },
    ),
  createDraft: (worldId: string, params: CreateSceneCompatibilityDraftParams, signal?: AbortSignal) =>
    apiFetch<SceneCompatibilityDraftView>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/drafts`,
      { method: 'POST', body: JSON.stringify(params), signal },
    ),
  /** 读取草稿预览;问题与修复变化使用独立服务端分页游标。 */
  readDraft: (worldId: string, draftId: string, options: { page?: SceneCompatibilityPageQuery; signal?: AbortSignal } = {}) => {
    const query = new URLSearchParams()
    if (options.page?.limit !== undefined) query.set('limit', String(options.page.limit))
    if (options.page?.offset !== undefined) query.set('offset', String(options.page.offset))
    if (options.page?.issuesOffset !== undefined) query.set('issuesOffset', String(options.page.issuesOffset))
    if (options.page?.changesOffset !== undefined) query.set('changesOffset', String(options.page.changesOffset))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return apiFetch<SceneCompatibilityDraftView>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/drafts/${encodeURIComponent(draftId)}${suffix}`,
      { signal: options.signal },
    )
  },
  cancelDraft: (worldId: string, draftId: string, signal?: AbortSignal) =>
    apiFetch<SceneCompatibilityDraftView>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/drafts/${encodeURIComponent(draftId)}/cancel`,
      { method: 'POST', signal },
    ),
  confirm: (worldId: string, params: ConfirmSceneCompatibilityParams, signal?: AbortSignal) =>
    apiFetch<SceneCompatibilityRequestResponse>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/confirm`,
      { method: 'POST', body: JSON.stringify(params), signal },
    ),
  readRequest: (worldId: string, requestId: string, signal?: AbortSignal) =>
    apiFetch<SceneCompatibilityRequestResponse>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/requests/${encodeURIComponent(requestId)}`,
      { signal },
    ),
  /** 同请求恢复:仅在提交结果未知时用同一 requestId 重试,不产生新权威字段。 */
  recoverRequest: (worldId: string, requestId: string, params: RecoverSceneCompatibilityParams, signal?: AbortSignal) =>
    apiFetch<SceneCompatibilityRequestResponse>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/requests/${encodeURIComponent(requestId)}/recover`,
      { method: 'POST', body: JSON.stringify(params), signal },
    ),
  /** 按空间惰性读取草稿候选(修复后)文档,供只读预览。 */
  readDraftSpace: (worldId: string, draftId: string, spaceId: string, signal?: AbortSignal) =>
    apiFetch<{ spaceId: string; side: 'candidate'; document: unknown }>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/drafts/${encodeURIComponent(draftId)}/spaces/${encodeURIComponent(spaceId)}`,
      { signal },
    ),
  /** 按空间惰性读取来源(修复前)版本文档,供只读预览。 */
  readSourceSpace: (worldId: string, version: number, spaceId: string, signal?: AbortSignal) =>
    apiFetch<{ spaceId: string; side: 'source'; version: number; document: unknown }>(
      `/api/worlds/${encodeURIComponent(worldId)}/scene/compatibility/source/${version}/spaces/${encodeURIComponent(spaceId)}`,
      { signal },
    ),
}

/** 访客公共只读接口（不依赖登录态；若本地有 token 也无妨，服务端不做校验） */
export const publicApi = {
  demo: () => apiFetch<DemoInfo>('/api/public/demo'),
  scene: (worldId: string, signal?: AbortSignal) => apiFetch<SceneReadResponse>(`/api/public/worlds/${encodeURIComponent(worldId)}/scene`, { signal }),
  snapshot: (worldId: string, timelineId?: string, signal?: AbortSignal) =>
    apiFetch<WorldSnapshot>(`/api/public/worlds/${worldId}${timelineId ? `?timelineId=${timelineId}` : ''}`, { signal }),
  personFocus: (worldId: string, personId: string, timelineId: string) =>
    apiFetch<PersonFocus>(`/api/public/worlds/${worldId}/persons/${personId}?timelineId=${timelineId}`),
  dialogueDetail: (dialogueId: string, timelineId?: string) => apiFetch<DialogueDetail>(
    `/api/public/dialogues/${dialogueId}${timelineId ? `?timelineId=${encodeURIComponent(timelineId)}` : ''}`),
}

/** 章节：时间线的小说化回顾 */
export const chaptersApi = {
  generate: (worldId: string, timelineId: string) =>
    apiFetch<Chapter>(`/api/worlds/${worldId}/chapters`, { method: 'POST', body: JSON.stringify({ timelineId }) }),
  list: (worldId: string, timelineId?: string) =>
    apiFetch<{ chapters: ChapterSummary[] }>(
      `/api/worlds/${worldId}/chapters${timelineId ? `?timelineId=${timelineId}` : ''}`,
    ),
  get: (chapterId: string) => apiFetch<Chapter>(`/api/chapters/${chapterId}`),
}

/** 设置(F5/S3):全局 BYOK 配置与日预算;Key 只写不读,回显仅掩码 */
export interface LlmSettings {
  baseUrl: string | null
  model: string | null
  hasKey: boolean
  keyPreview: string | null
  verification: { status: 'incomplete' | 'unverified' | 'verified'; verifiedAt: string | null }
}
export interface BudgetSettings { dailyCallCap: number | null; usedToday: number; fallbackUsedToday?: number; unlimitedEligible?: boolean }
export interface WorldLlmConfig { baseUrl: string | null; model: string | null; hasKey: boolean; keyPreview: string | null }

export const settingsApi = {
  getLlm: () => apiFetch<LlmSettings>('/api/settings/llm'),
  putLlm: (patch: { baseUrl?: string | null; apiKey?: string | null; model?: string | null }) =>
    apiFetch<LlmSettings>('/api/settings/llm', { method: 'PUT', body: JSON.stringify(patch) }),
  deleteLlm: () => apiFetch<{ ok: true }>('/api/settings/llm', { method: 'DELETE' }),
  testLlm: () => apiFetch<{ ok: true; verifiedAt: string }>('/api/settings/llm/test', { method: 'POST' }),
  getBudget: () => apiFetch<BudgetSettings>('/api/settings/budget'),
  putBudget: (dailyCallCap: number | null) =>
    apiFetch<BudgetSettings>('/api/settings/budget', { method: 'PUT', body: JSON.stringify({ dailyCallCap }) }),
}

export const worldLlmConfigApi = {
  get: (worldId: string) => apiFetch<WorldLlmConfig>(`/api/worlds/${worldId}/llm-config`),
  put: (worldId: string, llmConfig: { baseUrl?: string | null; apiKey?: string | null; model?: string | null } | null) =>
    apiFetch<WorldLlmConfig>(`/api/worlds/${worldId}`, { method: 'PATCH', body: JSON.stringify({ llmConfig }) }),
}

/** 记忆可审计：校正 / 删除（人物会立刻忘掉） */
export const memoriesApi = {
  update: (memoryId: string, patch: { content?: string; importance?: number; personId: string; timelineId: string;
    expectedVersion: number; commandId: string; before: { type: string; content: string; importance: number;
      simTime: string | null; createdAt: string; summarized: boolean } }) =>
    apiFetch<{ ok: true }>(`/api/memories/${memoryId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (memoryId: string, body: { personId: string; timelineId: string; expectedVersion: number; commandId: string;
    before: { type: string; content: string; importance: number; simTime: string | null; createdAt: string; summarized: boolean } }) =>
    apiFetch<{ ok: true }>(`/api/memories/${memoryId}`, { method: 'DELETE', body: JSON.stringify(body) }),
}

/** 你在世界里：登记/改写在场身份 */
export const personaApi = {
  get: (worldId: string, timelineId?: string) => apiFetch<{ persona: Persona | null; unread: number }>(`/api/worlds/${worldId}/persona${timelineId ? `?timelineId=${encodeURIComponent(timelineId)}` : ''}`),
  upsert: (worldId: string, body: { name: string; description: string }) =>
    apiFetch<{ persona: Persona }>(`/api/worlds/${worldId}/persona`, { method: 'POST', body: JSON.stringify(body) }),
  messages: (worldId: string, timelineId: string) =>
    apiFetch<{ messages: PersonaMessage[]; mentions: PersonaMention[] }>(`/api/worlds/${worldId}/persona/messages?timelineId=${encodeURIComponent(timelineId)}`),
  read: (worldId: string, timelineId: string, ids: string[]) => apiFetch<{ok: true}>(`/api/worlds/${worldId}/persona/messages/read`, { method: 'POST', body: JSON.stringify({timelineId, ids}) }),
}

/** 你在世界里：到场交谈（SSE 逐句回应；每人一句 = 1 次 LLM 调用，走预算护栏） */
export type SceneIntentResolution = {
  requestId: string; timelineId: string; expectedVersion: number; currentLocation: string;
  status: 'proposal' | 'clarification' | 'rejected'; confirmationRequired?: true;
  proposal?: { type: 'move'; to: string } | { type: 'inform'; recipientId: string; recipientName: string; topic: string; content: string };
  question?: string; reason?: string; recovery?: 'refresh_state';
  alternatives?: { locations: string[]; residents: { id: string; name: string }[] };
}

export const sceneApi = {
  /** 各地点「清醒且空闲」的可交谈人数（避免扑空） */
  board: (worldId: string, timelineId: string) => apiFetch<{ board: { location: string; count: number; people: { id: string; name: string }[] }[] }>(`/api/worlds/${worldId}/scene/board?timelineId=${encodeURIComponent(timelineId)}`),
  history: (worldId: string, timelineId: string, location?: string) => apiFetch<{dialogueId: string | null; location: string | null; turns: {id: string; personId: string; name: string; utterance: string}[]}>(`/api/worlds/${worldId}/scene/history?timelineId=${encodeURIComponent(timelineId)}${location ? `&location=${encodeURIComponent(location)}` : ''}`),
  requestStatus: (worldId: string, timelineId: string, requestId: string) => apiFetch<{status: 'missing' | 'pending' | 'completed' | 'failed'; recoverable: boolean}>(`/api/worlds/${worldId}/scene/requests/${encodeURIComponent(requestId)}?timelineId=${encodeURIComponent(timelineId)}`),
  recoverRequest: (worldId: string, timelineId: string, requestId: string) => apiFetch<{status: 'missing' | 'pending' | 'completed' | 'failed'; recoverable: boolean}>(`/api/worlds/${worldId}/scene/requests/${encodeURIComponent(requestId)}/recover?timelineId=${encodeURIComponent(timelineId)}`, { method: 'POST' }),
  cancelRequest: (worldId: string, timelineId: string, requestId: string) => apiFetch<{status: 'missing' | 'pending' | 'completed' | 'failed'}>(`/api/worlds/${worldId}/scene/requests/${encodeURIComponent(requestId)}/cancel?timelineId=${encodeURIComponent(timelineId)}`, { method: 'POST' }),
  resolveIntent: (worldId: string, body: { timelineId: string; content: string; requestId: string }) =>
    apiFetch<SceneIntentResolution>(`/api/worlds/${worldId}/scene/intent`, { method: 'POST', body: JSON.stringify(body) }, { redirectOnUnauthorized: false }),
  pendingIntent: (worldId: string, timelineId: string) =>
    apiFetch<{ text: string; result: SceneIntentResolution } | { proposal: null }>(
      `/api/worlds/${worldId}/scene/intent/pending?timelineId=${encodeURIComponent(timelineId)}`),
  cancelIntent: (worldId: string, requestId: string) =>
    apiFetch<{ status: 'cancelled' | 'missing' }>(`/api/worlds/${worldId}/scene/intent/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' }),
  send: (worldId: string, body: { timelineId: string; location?: string; content: string; dialogueId?: string; requestId?: string }, onEvent: (event: SSEEvent) => void, signal?: AbortSignal) =>
    postSSE(`/api/worlds/${worldId}/scene`, body, onEvent, signal),
  position: (worldId: string, body: { timelineId: string; location: string; commandId: string; expectedVersion: number }) =>
    apiFetch<{ commandId: string; version: number; location: string }>(`/api/worlds/${worldId}/scene/position`, { method: 'POST', body: JSON.stringify(body) }),
  inform: (worldId: string, body: { timelineId: string; recipientId: string; topic: string; content: string; commandId: string; expectedVersion: number }) =>
    apiFetch<{ commandId: string; version: number; certainty: 'rumor' }>(`/api/worlds/${worldId}/scene/inform`, { method: 'POST', body: JSON.stringify(body) }),
}

export const lifeApi = {
  returnBrief: (worldId: string, timelineId: string, page?: { eventCursor?: number; revisionVersion?: number }) => {
    const query = new URLSearchParams({ timelineId })
    if (page?.eventCursor !== undefined) query.set('eventCursor', String(page.eventCursor))
    if (page?.revisionVersion !== undefined) query.set('revisionVersion', String(page.revisionVersion))
    return apiFetch<ReturnBrief>(`/api/worlds/${worldId}/return?${query.toString()}`)
  },
  eventEvidence: (worldId: string, timelineId: string, eventId: string) =>
    apiFetch<EventEvidenceDetail>(`/api/worlds/${worldId}/events/${encodeURIComponent(eventId)}/evidence?timelineId=${encodeURIComponent(timelineId)}`),
  markSeen: (worldId: string, timelineId: string, eventCursor: number, revisionVersion = 0) =>
    apiFetch<{ok: true}>(`/api/worlds/${worldId}/return/seen`, {method:'POST', body: JSON.stringify({timelineId, eventCursor, revisionVersion})}),
  act: (worldId: string, commitmentId: string, action: string, explanation?: string) => apiFetch<{ok:true;status:string}>(`/api/worlds/${worldId}/commitments/${commitmentId}`, {method:'POST', body: JSON.stringify({action, explanation})}),
  compare: (worldId: string, left: string, right: string, opts: { simTime?: string } = {}) =>
    apiFetch<TimelineComparison>(`/api/worlds/${worldId}/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}${opts.simTime ? `&simTime=${encodeURIComponent(opts.simTime)}` : ''}`),
}

/**
 * GET SSE 订阅世界流（fetch + ReadableStream，按 event 名分发）。
 * 返回取消函数；连接断开由调用方决定是否重建。
 */
export function subscribeWorldStream(
  worldId: string,
  timelineId: string,
  onEvent: (event: WorldStreamEvent) => void,
  opts: { isPublic?: boolean; onError?: (e: unknown) => void; generation?: number;
    isGenerationCurrent?: (generation: number) => boolean } = {},
): () => void {
  const controller = new AbortController()
  let active = true
  const generation = opts.generation ?? 0
  const guard = createWorldStreamGuard({ worldId, timelineId, generation,
    isGenerationCurrent: opts.isGenerationCurrent ?? (() => active) })
  const base = opts.isPublic ? `/api/public/worlds/${worldId}/stream` : `/api/worlds/${worldId}/stream`
  const token = getToken()
  const guestToken = token ? null : getGuestToken()

  void (async () => {
    while (!controller.signal.aborted) {
      try {
      const res = await fetch(`${base}?timelineId=${timelineId}`, {
        headers: opts.isPublic ? {} : token ? { Authorization: `Bearer ${token}` } : guestToken ? { 'X-Possibility-Guest': guestToken } : {},
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`流连接失败（${res.status}）`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const parser = createSseParser()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event === 'ping') continue
          try {
            const event = JSON.parse(frame.data) as WorldStreamEvent
            if (guard.accept(event)) onEvent(event)
          } catch {
            // 忽略无法解析的帧
          }
        }
      }
      } catch (e) {
        if (!controller.signal.aborted) opts.onError?.(e)
      }
      if (controller.signal.aborted) break
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2000)
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  })()

  return () => { active = false; guard.invalidate(); controller.abort() }
}
