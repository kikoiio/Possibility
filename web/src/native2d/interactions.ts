/**
 * N1 account interaction entry points for the native 2D view.
 *
 * This module contains no React or viewport code.  It is deliberately a small
 * stateful boundary that a page can wire to its existing selection/follow
 * controller.  Observation changes the rendered space only; it never calls a
 * world position endpoint.  World writes go through the account adapter and
 * retain their request id so a lost response can be recovered safely.
 */

import type {
  ForkInitialAction,
  ForkResult,
  ForkScenarioInput,
  TimelineComparison,
} from '../api/types'
import type { Selection } from './types'
import type {
  AccountChatRequestStatus,
  AccountSessionAdapter,
} from './session-adapter'

export interface FollowTarget {
  readonly status: 'visible' | 'unrepresented' | 'unknown'
  readonly spaceId?: string | null
  readonly reason?: string | null
}

export interface Native2dInteractionOptions {
  readonly session: AccountSessionAdapter
  /** Resolve a resident against the latest native2d read model. */
  readonly resolveFollowTarget?: (personId: string) => FollowTarget | null
  /** Called only when a resident can be observed in another rendered space. */
  readonly onObserve?: (spaceId: string) => void
  readonly createRequestId?: () => string
}

export type DialogueStatus =
  | 'idle'
  | 'sending'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DialogueInteractionState {
  readonly status: DialogueStatus
  readonly requestId: string | null
  readonly content: string | null
  readonly text: string
  readonly error: string | null
  readonly canRetry: boolean
}

export type CommandStatus = 'idle' | 'submitting' | 'completed' | 'failed' | 'cancelled'

export interface InterventionInteractionState {
  readonly status: CommandStatus
  readonly commandId: string | null
  readonly error: string | null
  readonly canRetry: boolean
}

export interface ForkInteractionState {
  readonly status: CommandStatus
  readonly requestId: string | null
  readonly scenario: ForkScenarioInput | null
  readonly error: string | null
  readonly result: ForkResult | null
  readonly canRetry: boolean
}

export interface CompareInteractionState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed'
  readonly leftTimelineId: string | null
  readonly rightTimelineId: string | null
  readonly simTime: string | null
  readonly result: TimelineComparison | null
  readonly error: string | null
}

export interface Native2dInteractionState {
  readonly selection: Selection | null
  readonly followPersonId: string | null
  readonly followStatus: 'following' | 'paused' | null
  readonly followReason: string | null
  readonly spaceId: string | null
  readonly dialogue: DialogueInteractionState
  readonly intervention: InterventionInteractionState
  readonly fork: ForkInteractionState
  readonly compare: CompareInteractionState
  readonly notice: string | null
}

export interface Native2dInteractions {
  getState(): Native2dInteractionState
  subscribe(listener: () => void): () => void
  select(selection: Selection | null): void
  follow(personId: string): void
  cancelFollow(): void
  observe(spaceId: string): { readonly spaceId: string; readonly wroteWorld: false }
  sendDialogue(content: string, requestId?: string): Promise<void>
  cancelDialogue(): Promise<void>
  recoverDialogue(requestId?: string): Promise<AccountChatRequestStatus>
  retryDialogue(): Promise<void>
  intervene(input: {
    readonly expectedVersion: number
    readonly action: ForkInitialAction
    readonly commandId?: string
  }): Promise<void>
  retryIntervention(): Promise<void>
  cancelIntervention(): void
  fork(
    scenario: ForkScenarioInput,
    requestId?: string,
    initialAction?: {
      readonly expectedSourceVersion: number
      readonly initialAction: ForkInitialAction
    },
  ): Promise<ForkResult | null>
  retryFork(): Promise<ForkResult | null>
  cancelFork(): void
  compare(leftTimelineId: string, rightTimelineId: string, simTime?: string): Promise<TimelineComparison | null>
  dispose(): void
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function cryptoRequestId(): string {
  const candidate = globalThis.crypto?.randomUUID
  return candidate ? candidate.call(globalThis.crypto) : `native2d-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function initialDialogue(): DialogueInteractionState {
  return { status: 'idle', requestId: null, content: null, text: '', error: null, canRetry: false }
}

export function createNative2dInteractions(options: Native2dInteractionOptions): Native2dInteractions {
  const makeRequestId = options.createRequestId ?? cryptoRequestId
  let disposed = false
  let dialogueAbort: AbortController | null = null
  let dialogueDone = false
  let dialogueError = false
  let dialogueEpoch = 0
  let interventionEpoch = 0
  let forkEpoch = 0
  let pendingIntervention: {
    readonly expectedVersion: number
    readonly action: ForkInitialAction
    readonly commandId: string
  } | null = null
  let pendingFork: {
    readonly scenario: ForkScenarioInput
    readonly requestId: string
    readonly initialAction?: {
      readonly expectedSourceVersion: number
      readonly initialAction: ForkInitialAction
    }
  } | null = null
  let state: Native2dInteractionState = {
    selection: null,
    followPersonId: null,
    followStatus: null,
    followReason: null,
    spaceId: null,
    dialogue: initialDialogue(),
    intervention: { status: 'idle', commandId: null, error: null, canRetry: false },
    fork: { status: 'idle', requestId: null, scenario: null, error: null, result: null, canRetry: false },
    compare: { status: 'idle', leftTimelineId: null, rightTimelineId: null, simTime: null, result: null, error: null },
    notice: null,
  }
  const listeners = new Set<() => void>()

  function update(patch: Partial<Native2dInteractionState>): void {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function updateDialogue(patch: Partial<DialogueInteractionState>): void {
    update({ dialogue: { ...state.dialogue, ...patch } })
  }

  async function queryDialogue(requestId: string): Promise<AccountChatRequestStatus> {
    try {
      return await options.session.chatStatus(requestId)
    } catch (error) {
      updateDialogue({ error: errorMessage(error, '暂时无法确认对话请求状态') })
      return 'pending'
    }
  }

  async function sendDialogue(content: string, requestId = makeRequestId()): Promise<void> {
    if (disposed) return
    const text = content.trim()
    if (!text) {
      updateDialogue({ status: 'failed', content, requestId, error: '对话内容不能为空', canRetry: true })
      return
    }
    if (state.dialogue.status === 'sending' || state.dialogue.status === 'recovering') return
    const epoch = ++dialogueEpoch
    dialogueAbort?.abort()
    const controller = new AbortController()
    dialogueAbort = controller
    dialogueDone = false
    dialogueError = false
    updateDialogue({ status: 'sending', requestId, content: text, text: '', error: null, canRetry: false })
    try {
      await options.session.chat(text, requestId, (event) => {
        if (disposed || epoch !== dialogueEpoch) return
        const type = typeof event.type === 'string' ? event.type : ''
        if (type === 'text') {
          const delta = typeof event.delta === 'string' ? event.delta : ''
          updateDialogue({ text: state.dialogue.text + delta })
        } else if (type === 'utterance') {
          const delta = typeof event.text === 'string' ? event.text : ''
          updateDialogue({ text: state.dialogue.text + delta })
        } else if (type === 'error') {
          dialogueError = true
          updateDialogue({ error: typeof event.message === 'string' ? event.message : '对话失败' })
        } else if (type === 'done') {
          dialogueDone = true
        }
      }, controller.signal)
      if (disposed || epoch !== dialogueEpoch) return
      if (dialogueDone && !dialogueError) {
        updateDialogue({ status: 'completed', canRetry: false })
        return
      }
      const status = await queryDialogue(requestId)
      if (status === 'completed') {
        updateDialogue({ status: 'completed', canRetry: false, error: null })
      } else if (status === 'failed' || status === 'missing') {
        updateDialogue({ status: 'failed', canRetry: true, error: state.dialogue.error ?? '对话未写入世界' })
      } else {
        updateDialogue({ status: 'recovering', canRetry: false, error: state.dialogue.error ?? '对话仍在处理中；可恢复同一请求' })
      }
    } catch (error) {
      if (disposed || epoch !== dialogueEpoch) return
      if (isAbortError(error)) {
        updateDialogue({ status: 'cancelled', canRetry: state.dialogue.content !== null, error: '对话已取消' })
        return
      }
      const status = await queryDialogue(requestId)
      if (status === 'completed') {
        updateDialogue({ status: 'completed', canRetry: false, error: null })
      } else if (status === 'pending') {
        updateDialogue({ status: 'recovering', canRetry: false, error: errorMessage(error, '连接中断，对话仍在处理中') })
      } else {
        updateDialogue({ status: 'failed', canRetry: true, error: errorMessage(error, '对话失败') })
      }
    } finally {
      if (dialogueAbort === controller) dialogueAbort = null
    }
  }

  async function cancelDialogue(): Promise<void> {
    if (disposed || !state.dialogue.requestId || (state.dialogue.status !== 'sending' && state.dialogue.status !== 'recovering')) return
    const requestId = state.dialogue.requestId
    dialogueEpoch += 1
    dialogueAbort?.abort()
    dialogueAbort = null
    try {
      const status = await options.session.cancelChat(requestId)
      if (status === 'completed') {
        updateDialogue({ status: 'completed', error: null, canRetry: false })
      } else if (status === 'pending') {
        updateDialogue({ status: 'recovering', error: '取消请求尚未生效；对话仍在处理中' })
      } else {
        updateDialogue({ status: 'cancelled', error: '对话已取消', canRetry: state.dialogue.content !== null })
      }
    } catch (error) {
      updateDialogue({ status: 'recovering', error: errorMessage(error, '取消结果尚未确认；可恢复同一请求'), canRetry: false })
    }
  }

  async function recoverDialogue(requestId = state.dialogue.requestId ?? ''): Promise<AccountChatRequestStatus> {
    if (disposed || !requestId) return 'missing'
    updateDialogue({ status: 'recovering', requestId, error: null, canRetry: false })
    let status = await queryDialogue(requestId)
    if (status === 'pending') {
      try {
        status = await options.session.recoverChat(requestId)
      } catch (error) {
        updateDialogue({ status: 'recovering', error: errorMessage(error, '恢复对话失败；请稍后重试') })
        return 'pending'
      }
    }
    if (status === 'completed') updateDialogue({ status: 'completed', error: null })
    else if (status === 'failed' || status === 'missing') updateDialogue({ status: 'failed', canRetry: true, error: '上一次对话未写入世界；可以安全重试' })
    else updateDialogue({ status: 'recovering', error: '对话仍在处理中；再次恢复会复用同一请求编号' })
    return status
  }

  async function retryDialogue(): Promise<void> {
    if (!state.dialogue.content || !state.dialogue.canRetry) return
    await sendDialogue(state.dialogue.content, makeRequestId())
  }

  async function intervene(input: {
    readonly expectedVersion: number
    readonly action: ForkInitialAction
    readonly commandId?: string
  }): Promise<void> {
    if (disposed) return
    const epoch = ++interventionEpoch
    const commandId = input.commandId ?? makeRequestId()
    pendingIntervention = { ...input, commandId }
    update({ intervention: { status: 'submitting', commandId, error: null, canRetry: false } })
    try {
      await options.session.intervene(pendingIntervention)
      if (disposed || epoch !== interventionEpoch) return
      pendingIntervention = null
      update({ intervention: { status: 'completed', commandId, error: null, canRetry: false } })
    } catch (error) {
      if (disposed || epoch !== interventionEpoch) return
      update({ intervention: { status: 'failed', commandId, error: errorMessage(error, '干预未提交；可用同一编号重试'), canRetry: true } })
    }
  }

  async function retryIntervention(): Promise<void> {
    if (!pendingIntervention || !state.intervention.canRetry) return
    await intervene(pendingIntervention)
  }

  function cancelIntervention(): void {
    if (disposed || !pendingIntervention) return
    interventionEpoch += 1
    const commandId = pendingIntervention.commandId
    pendingIntervention = null
    update({ intervention: { status: 'cancelled', commandId, error: '干预已取消', canRetry: false } })
  }

  async function fork(
    scenario: ForkScenarioInput,
    requestId = state.fork.requestId ?? makeRequestId(),
    initialAction?: { readonly expectedSourceVersion: number; readonly initialAction: ForkInitialAction },
  ): Promise<ForkResult | null> {
    if (disposed) return null
    const epoch = ++forkEpoch
    pendingFork = { scenario, requestId, initialAction }
    update({ fork: { status: 'submitting', requestId, scenario, error: null, result: null, canRetry: false } })
    try {
      const result = await options.session.fork(requestId, scenario, initialAction)
      if (disposed || epoch !== forkEpoch) return null
      pendingFork = null
      update({ fork: { status: 'completed', requestId, scenario, error: null, result, canRetry: false } })
      return result
    } catch (error) {
      if (disposed || epoch !== forkEpoch) return null
      update({ fork: { status: 'failed', requestId, scenario, error: errorMessage(error, '分叉未完成；输入已保留，可重试'), result: null, canRetry: true } })
      return null
    }
  }

  async function retryFork(): Promise<ForkResult | null> {
    if (!pendingFork || !state.fork.canRetry) return null
    return fork(pendingFork.scenario, pendingFork.requestId, pendingFork.initialAction)
  }

  function cancelFork(): void {
    if (disposed || !pendingFork) return
    forkEpoch += 1
    const requestId = pendingFork.requestId
    pendingFork = null
    update({ fork: { status: 'cancelled', requestId, scenario: state.fork.scenario, error: '分叉已取消', result: null, canRetry: false } })
  }

  async function compare(leftTimelineId: string, rightTimelineId: string, simTime?: string): Promise<TimelineComparison | null> {
    if (disposed) return null
    update({ compare: { status: 'loading', leftTimelineId, rightTimelineId, simTime: simTime ?? null, result: null, error: null } })
    try {
      const result = await options.session.compare(leftTimelineId, rightTimelineId, simTime)
      update({ compare: { status: 'ready', leftTimelineId, rightTimelineId, simTime: simTime ?? null, result, error: null } })
      return result
    } catch (error) {
      update({ compare: { status: 'failed', leftTimelineId, rightTimelineId, simTime: simTime ?? null, result: null, error: errorMessage(error, '比较失败；当前时间线保持不变') } })
      return null
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    select(selection) {
      if (disposed) return
      const adapterSelection = selection && (selection.kind === 'resident' || selection.kind === 'location')
        ? { kind: selection.kind, id: selection.kind === 'resident' ? selection.personId : selection.locationKey }
        : null
      options.session.select(adapterSelection)
      update({ selection })
    },
    follow(personId) {
      if (disposed || !personId.trim()) return
      options.session.select({ kind: 'resident', id: personId })
      const target = options.resolveFollowTarget?.(personId)
      if (!target || target.status === 'visible') {
        const spaceId = target?.spaceId ?? null
        if (spaceId) {
          const observed = options.session.observe(spaceId)
          options.onObserve?.(observed.spaceId)
          update({ spaceId: observed.spaceId })
        }
        update({ selection: { kind: 'resident', personId }, followPersonId: personId, followStatus: 'following', followReason: null, notice: null })
        return
      }
      update({ selection: { kind: 'resident', personId }, followPersonId: personId, followStatus: 'paused', followReason: target.reason ?? '该居民暂时无法在 2D 场景中定位', notice: target.reason ?? '该居民暂时无法在 2D 场景中定位' })
    },
    cancelFollow() {
      if (disposed) return
      update({ followPersonId: null, followStatus: null, followReason: null, notice: '已取消跟随' })
    },
    observe(spaceId) {
      if (disposed) return { spaceId, wroteWorld: false as const }
      const result = options.session.observe(spaceId)
      options.onObserve?.(result.spaceId)
      update({ spaceId: result.spaceId, notice: null })
      return result
    },
    sendDialogue,
    cancelDialogue,
    recoverDialogue,
    retryDialogue,
    intervene,
    retryIntervention,
    cancelIntervention,
    fork,
    retryFork,
    cancelFork,
    compare,
    dispose() {
      if (disposed) return
      disposed = true
      dialogueEpoch += 1
      dialogueAbort?.abort()
      dialogueAbort = null
      listeners.clear()
    },
  }
}

/** Naming alias for callers that treat this boundary as a controller. */
export const createNative2dInteractionController = createNative2dInteractions
