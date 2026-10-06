/**
 * N1: account backed native2d session adapter.
 *
 * The adapter binds an existing owner account to one real world and timeline.
 * It only reads the account snapshot by default; it never starts a guest
 * session, creates a persona, or creates a fork as part of native2d loading.
 */

import type {
  ForkInitialAction,
  ForkResult,
  ForkScenarioInput,
  TimelineComparison,
  WorldSnapshot,
} from '../api/types'
import { effectiveTimeZone } from '../lib/world-time'
import { apiFetch, postSSE } from '../api/client'
import type {
  SceneDefinition,
  WorldEnvironmentFact,
  WorldReadModel,
  WorldRuntimeState,
  WorldSource,
} from './types'

export type AccountSessionIdentity =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'account'; readonly id: string; readonly name?: string }
  | { readonly kind: 'guest'; readonly id: string }

export interface AccountSessionCapabilities {
  readonly read: boolean
  readonly participate: boolean
  readonly chat: boolean
  readonly intervene: boolean
  readonly fork: boolean
  readonly compare: boolean
}

/** Native2d's normal owner journey is observation only. */
export const READONLY_ACCOUNT_CAPABILITIES: AccountSessionCapabilities = {
  read: true,
  participate: false,
  chat: false,
  intervene: false,
  fork: false,
  compare: false,
}

export interface AccountSessionContext {
  readonly worldId: string
  readonly timelineId: string
  readonly identity: AccountSessionIdentity
  readonly capabilities: AccountSessionCapabilities
  readonly stateVersion: number | null
  readonly simNow: string | null
  readonly runtime: WorldRuntimeState | null
  /** The observer has no position write path; this remains null. */
  readonly position: string | null
  readonly selected: { readonly kind: 'resident' | 'location'; readonly id: string } | null
}

export type AccountSessionAction = 'read' | 'participate' | 'chat' | 'intervene' | 'fork' | 'compare'

export type AccountChatRequestStatus = 'missing' | 'pending' | 'completed' | 'failed'

export class AccountSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_scope'
      | 'capability_denied'
      | 'request_failed'
      | 'timeline_mismatch',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AccountSessionError'
  }
}

export interface AccountSessionRequestOptions {
  readonly request?: <T>(path: string, options?: RequestInit) => Promise<T>
  readonly stream?: (
    path: string,
    body: unknown,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly identity?: AccountSessionIdentity
  readonly capabilities?: AccountSessionCapabilities
}

export interface AccountSessionAdapter extends WorldSource {
  readonly context: () => AccountSessionContext
  readonly refresh: (signal?: AbortSignal) => Promise<WorldReadModel>
  /** Observation only changes presentation intent and never writes world state. */
  readonly observe: (spaceId: string) => { readonly spaceId: string; readonly wroteWorld: false }
  readonly select: (
    selection: { readonly kind: 'resident' | 'location'; readonly id: string } | null,
  ) => void
  readonly participate: (input: {
    readonly name: string
    readonly description: string
  }) => Promise<{ id: string; name: string; location: string | null }>
  readonly chat: (
    content: string,
    requestId: string,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ) => Promise<void>
  /** Query/recover/cancel use the server's durable request state after SSE loss. */
  readonly chatStatus: (requestId: string) => Promise<AccountChatRequestStatus>
  readonly recoverChat: (requestId: string) => Promise<AccountChatRequestStatus>
  readonly cancelChat: (requestId: string) => Promise<AccountChatRequestStatus>
  readonly intervene: (input: {
    readonly expectedVersion: number
    readonly action: ForkInitialAction
    readonly commandId: string
  }) => Promise<{ readonly commandId: string; readonly version: number }>
  readonly fork: (
    requestId: string,
    scenario: ForkScenarioInput,
    initialAction?: {
      readonly expectedSourceVersion: number
      readonly initialAction: ForkInitialAction
    },
  ) => Promise<ForkResult>
  readonly compare: (
    leftTimelineId: string,
    rightTimelineId: string,
    simTime?: string,
  ) => Promise<TimelineComparison>
}

function requireScope(
  worldId: string,
  timelineId?: string,
): { readonly worldId: string; readonly timelineId?: string } {
  if (!worldId.trim()) throw new AccountSessionError('账户会话缺少 worldId', 'invalid_scope')
  if (timelineId !== undefined && !timelineId.trim()) {
    throw new AccountSessionError('账户会话的 timelineId 不能为空', 'invalid_scope')
  }
  return { worldId, timelineId }
}

function requires(capabilities: AccountSessionCapabilities, action: AccountSessionAction): void {
  if (!capabilities[action]) {
    throw new AccountSessionError(`当前账户会话不允许${action}操作`, 'capability_denied')
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError')
  )
}

function abortError(): Error {
  const error = new Error('账户世界读取已取消')
  error.name = 'AbortError'
  return error
}

function requestFailure(error: unknown): AccountSessionError {
  if (error instanceof AccountSessionError) return error
  const status =
    typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined
  const detail = error instanceof Error && error.message ? `：${error.message}` : ''
  return new AccountSessionError(`读取账户世界失败${detail}`, 'request_failed', status)
}

function adaptEnvironment(snapshot: WorldSnapshot): readonly WorldEnvironmentFact[] {
  return snapshot.currentFacts
    .filter((fact) => fact.factType === 'environment')
    .map((fact) => ({
      id: fact.id,
      locationName: typeof fact.value.location === 'string' ? fact.value.location : null,
      condition: typeof fact.value.condition === 'string' ? fact.value.condition : '',
      value: typeof fact.value.value === 'string' ? fact.value.value : String(fact.value.value ?? ''),
      simTime: fact.simTime,
      version: fact.version,
    }))
}

function adaptRuntime(snapshot: WorldSnapshot): WorldRuntimeState {
  return {
    status: snapshot.world.status,
    pauseReason: snapshot.world.pauseReason,
    callsToday: snapshot.world.callsToday,
    worldModelVersion: snapshot.worldModelVersion,
    evidenceStatus: snapshot.evidenceStatus,
  }
}

function adaptSnapshot(snapshot: WorldSnapshot, scene: SceneDefinition): WorldReadModel {
  const scope = {
    source: 'public' as const,
    worldId: snapshot.world.id,
    timelineId: snapshot.currentTimelineId,
    sceneId: scene.id,
    sceneVersion: scene.version,
  }
  return {
    scope,
    worldName: snapshot.world.name,
    simNow: snapshot.simNow,
    timeZone: effectiveTimeZone(snapshot.timeZone ?? snapshot.world.timeZone),
    stateVersion: snapshot.stateVersion,
    locations: snapshot.world.locations.map((location) => ({ ...location })),
    residents: snapshot.locationBoard.flatMap((entry) =>
      entry.persons.map((person) => ({
        personId: person.id,
        name: person.name,
        locationName: entry.location,
        activity: person.activity.trim() ? person.activity : null,
      })),
    ),
    environment: adaptEnvironment(snapshot),
    runtime: adaptRuntime(snapshot),
  }
}

export function createAccountSessionAdapter(
  scene: SceneDefinition,
  worldId: string,
  timelineId?: string,
  options: AccountSessionRequestOptions = {},
): AccountSessionAdapter {
  const initial = requireScope(worldId, timelineId)
  const request = options.request ?? apiFetch
  const stream: NonNullable<AccountSessionRequestOptions['stream']> =
    options.stream ??
    ((path, body, onEvent, signal) =>
      postSSE(path, body, onEvent as Parameters<typeof postSSE>[2], signal))
  const identity = options.identity ?? { kind: 'anonymous' as const }
  const capabilities = options.capabilities ?? READONLY_ACCOUNT_CAPABILITIES
  let pinnedTimelineId = initial.timelineId ?? null
  let latest: WorldSnapshot | null = null
  let selected: AccountSessionContext['selected'] = null

  function pathForSnapshot(): string {
    const query = pinnedTimelineId ? `?timelineId=${encodeURIComponent(pinnedTimelineId)}` : ''
    return `/api/worlds/${encodeURIComponent(initial.worldId)}${query}`
  }

  async function refresh(signal?: AbortSignal): Promise<WorldReadModel> {
    requires(capabilities, 'read')
    if (signal?.aborted) throw abortError()
    let snapshot: WorldSnapshot
    try {
      snapshot = await request<WorldSnapshot>(pathForSnapshot(), { signal })
    } catch (error) {
      if (isAbortError(error, signal)) throw abortError()
      throw requestFailure(error)
    }
    if (isAbortError(undefined, signal)) throw abortError()
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.world || typeof snapshot.world.id !== 'string') {
      throw new AccountSessionError('账户世界快照结构不完整', 'request_failed')
    }
    if (snapshot.world.id !== initial.worldId) {
      throw new AccountSessionError('账户快照与请求的 worldId 不一致', 'invalid_scope')
    }
    if (pinnedTimelineId && snapshot.currentTimelineId !== pinnedTimelineId) {
      throw new AccountSessionError(
        '账户快照的 timelineId 已变化，本次读取未应用',
        'timeline_mismatch',
      )
    }
    pinnedTimelineId = snapshot.currentTimelineId
    latest = snapshot
    return adaptSnapshot(snapshot, scene)
  }

  function context(): AccountSessionContext {
    return {
      worldId: initial.worldId,
      timelineId: pinnedTimelineId ?? initial.timelineId ?? '',
      identity,
      capabilities,
      stateVersion: latest?.stateVersion ?? null,
      simNow: latest?.simNow ?? null,
      runtime: latest ? adaptRuntime(latest) : null,
      position: null,
      selected,
    }
  }

  async function participate(input: { readonly name: string; readonly description: string }) {
    requires(capabilities, 'participate')
    const result = await request<{
      persona: { id: string; name: string; location: string | null }
    }>(`/api/worlds/${encodeURIComponent(initial.worldId)}/persona`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return result.persona
  }

  async function chat(
    content: string,
    requestId: string,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    requires(capabilities, 'chat')
    const currentTimelineId = pinnedTimelineId ?? initial.timelineId
    if (!currentTimelineId) {
      throw new AccountSessionError('聊天需要已确定的 timelineId', 'invalid_scope')
    }
    try {
      await stream(
        `/api/worlds/${encodeURIComponent(initial.worldId)}/scene`,
        { timelineId: currentTimelineId, content, requestId },
        onEvent,
        signal,
      )
    } catch (error) {
      if (isAbortError(error, signal)) throw abortError()
      throw requestFailure(error)
    }
  }

  function requestTimelinePath(requestId: string, suffix = ''): string {
    const currentTimelineId = pinnedTimelineId ?? initial.timelineId
    if (!currentTimelineId) {
      throw new AccountSessionError('对话请求需要已确定的 timelineId', 'invalid_scope')
    }
    if (!requestId.trim()) {
      throw new AccountSessionError('对话请求缺少 requestId', 'invalid_scope')
    }
    return `/api/worlds/${encodeURIComponent(initial.worldId)}/scene/requests/${encodeURIComponent(requestId)}${suffix}?timelineId=${encodeURIComponent(currentTimelineId)}`
  }

  async function chatStatus(requestId: string): Promise<AccountChatRequestStatus> {
    requires(capabilities, 'chat')
    try {
      const result = await request<{ status: AccountChatRequestStatus }>(requestTimelinePath(requestId))
      return result.status
    } catch (error) {
      throw requestFailure(error)
    }
  }

  async function recoverChat(requestId: string): Promise<AccountChatRequestStatus> {
    requires(capabilities, 'chat')
    try {
      const result = await request<{ status: AccountChatRequestStatus }>(requestTimelinePath(requestId, '/recover'), { method: 'POST' })
      return result.status
    } catch (error) {
      throw requestFailure(error)
    }
  }

  async function cancelChat(requestId: string): Promise<AccountChatRequestStatus> {
    requires(capabilities, 'chat')
    try {
      const result = await request<{ status: AccountChatRequestStatus }>(requestTimelinePath(requestId, '/cancel'), { method: 'POST' })
      return result.status
    } catch (error) {
      throw requestFailure(error)
    }
  }

  async function intervene(input: {
    readonly expectedVersion: number
    readonly action: ForkInitialAction
    readonly commandId: string
  }) {
    requires(capabilities, 'intervene')
    const currentTimelineId = pinnedTimelineId ?? initial.timelineId
    if (!currentTimelineId) {
      throw new AccountSessionError('干预需要已确定的 timelineId', 'invalid_scope')
    }
    return request<{ commandId: string; version: number }>(
      `/api/worlds/${encodeURIComponent(initial.worldId)}/actions`,
      {
        method: 'POST',
        body: JSON.stringify({
          id: input.commandId,
          timelineId: currentTimelineId,
          expectedVersion: input.expectedVersion,
          action: input.action,
        }),
      },
    )
  }

  async function fork(
    requestId: string,
    scenario: ForkScenarioInput,
    initialAction?: {
      readonly expectedSourceVersion: number
      readonly initialAction: ForkInitialAction
    },
  ) {
    requires(capabilities, 'fork')
    const currentTimelineId = pinnedTimelineId ?? initial.timelineId
    if (!currentTimelineId) {
      throw new AccountSessionError('分叉需要已确定的 timelineId', 'invalid_scope')
    }
    return request<ForkResult>(
      `/api/worlds/${encodeURIComponent(initial.worldId)}/timelines/${encodeURIComponent(currentTimelineId)}/fork`,
      { method: 'POST', body: JSON.stringify({ requestId, scenario, ...initialAction }) },
    )
  }

  async function compare(leftTimelineId: string, rightTimelineId: string, simTime?: string) {
    requires(capabilities, 'compare')
    if (!leftTimelineId || !rightTimelineId) {
      throw new AccountSessionError('比较需要两个 timelineId', 'invalid_scope')
    }
    const query = new URLSearchParams({ left: leftTimelineId, right: rightTimelineId })
    if (simTime) query.set('simTime', simTime)
    return request<TimelineComparison>(
      `/api/worlds/${encodeURIComponent(initial.worldId)}/compare?${query.toString()}`,
    )
  }

  return {
    load: refresh,
    context,
    refresh,
    observe(spaceId) {
      if (!spaceId.trim()) throw new AccountSessionError('观察空间不能为空', 'invalid_scope')
      return { spaceId, wroteWorld: false as const }
    },
    select(value) {
      selected = value
    },
    participate,
    chat,
    chatStatus,
    recoverChat,
    cancelChat,
    intervene,
    fork,
    compare,
  }
}
