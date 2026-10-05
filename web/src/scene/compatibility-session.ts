import type {
  CompatibilityPurpose,
  ConfirmCompatibilityInput,
  CreateCompatibilityDraftInput,
  SceneCompatibilityDraftView,
  SceneCompatibilityFailure,
  SceneCompatibilityFailureView,
  SceneCompatibilityRequestResponse,
  SceneInspectionResult,
  SceneTarget,
} from '@possibility/voxel-contract'
import {
  type CompatibilityContinuation,
  type CompatibilityScope,
  type CompatibilityState,
  createCompatibilityStore,
  emptyCompatibilityContinuation,
  type CompatibilityDraftSummary,
  toCompatibilityDraftSummary,
  type CompatibilityStore,
} from './compatibility-store'

export interface CompatibilitySessionClient {
  inspect(input: {
    worldId: string
    purpose: CompatibilityPurpose
    target: SceneTarget
    expectedCurrentVersion: number
  }): Promise<SceneInspectionResult>
  createDraft(input: CreateCompatibilityDraftInput): Promise<SceneCompatibilityDraftView>
  submit(input: ConfirmCompatibilityInput): Promise<SceneCompatibilityRequestResponse>
  query(input: { worldId: string; requestId: string }): Promise<SceneCompatibilityRequestResponse>
  recover(input: {
    worldId: string
    requestId: string
    draftId: string
    expectedCurrentVersion: number
    expectedAttempt: number
  }): Promise<SceneCompatibilityRequestResponse>
}

export interface CompatibilitySessionOptions {
  scope: CompatibilityScope
  client: CompatibilitySessionClient
  store?: CompatibilityStore
  now?: () => Date
  requestId?: () => string
}

export interface CompatibilitySession {
  snapshot(): CompatibilityContinuation
  subscribe(listener: (snapshot: CompatibilityContinuation) => void): () => void
  reset(): void
  check(input: CompatibilityCheckInput): Promise<CompatibilityContinuation>
  build(input?: Partial<Pick<CompatibilityBuildInput, 'draftRequestId'>>): Promise<CompatibilityContinuation>
  submit(): Promise<CompatibilityContinuation>
  queryResult(): Promise<CompatibilityContinuation>
}

export interface CompatibilityCheckInput {
  purpose: CompatibilityPurpose
  target: SceneTarget
  expectedCurrentVersion: number
}

export interface CompatibilityBuildInput {
  draftRequestId: string
}

export class CompatibilitySessionError extends Error {
  constructor(
    message: string,
    public readonly state: CompatibilityState,
    public readonly failure?: SceneCompatibilityFailureView,
  ) {
    super(message)
    this.name = 'CompatibilitySessionError'
  }
}

function newRequestId(): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isConflict(failure: SceneCompatibilityFailureView | undefined): boolean {
  return failure?.code === 'scene-changed'
    || failure?.code === 'basis-changed'
    || failure?.code === 'request-mismatch'
    || failure?.code === 'preflight-required'
}

function toFailureView(failure: SceneCompatibilityFailure): SceneCompatibilityFailureView {
  if (!failure.report) return { code: failure.code, message: failure.message, action: failure.action }
  return {
    code: failure.code,
    message: failure.message,
    action: failure.action,
    report: {
      ...failure.report,
      issues: {
        items: failure.report.issues,
        offset: 0,
        limit: failure.report.issues.length,
        total: failure.report.issues.length,
        countIsExact: failure.report.countIsExact,
        hasMore: false,
      },
    },
  }
}

function failureFromUnknown(error: unknown): SceneCompatibilityFailureView | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { failure?: unknown; errorCode?: unknown; message?: unknown }
  if (value.failure && typeof value.failure === 'object') {
    const failure = value.failure as SceneCompatibilityFailure
    return typeof failure.code === 'string' && typeof failure.message === 'string' && typeof failure.action === 'string'
      ? toFailureView(failure)
      : undefined
  }
  if (typeof value.errorCode === 'string' && typeof value.message === 'string') {
    return { code: value.errorCode as SceneCompatibilityFailureView['code'], message: value.message, action: 'return' }
  }
  return undefined
}

function updateState(
  current: CompatibilityContinuation,
  patch: Partial<CompatibilityContinuation> & { state: CompatibilityState },
  now: () => Date,
): CompatibilityContinuation {
  return {
    ...current,
    ...patch,
    scope: { ...current.scope },
    updatedAt: now().toISOString(),
  }
}

export function createCompatibilitySession(options: CompatibilitySessionOptions): CompatibilitySession {
  const store = options.store ?? createCompatibilityStore({ now: options.now })
  const now = options.now ?? (() => new Date())
  const requestId = options.requestId ?? newRequestId
  const listeners = new Set<(snapshot: CompatibilityContinuation) => void>()
  let state = store.load(options.scope) ?? emptyCompatibilityContinuation(options.scope, now())

  function publish(next: CompatibilityContinuation): CompatibilityContinuation {
    state = next
    store.save(state)
    for (const listener of listeners) listener(state)
    return state
  }

  function requireState(...allowed: CompatibilityState[]): void {
    if (!allowed.includes(state.state)) {
      throw new CompatibilitySessionError(`Compatibility session is ${state.state}`, state.state)
    }
  }

  return {
    snapshot: () => structuredClone(state),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset() {
      store.clear(options.scope)
      publish(emptyCompatibilityContinuation(options.scope, now()))
    },
    async check(input) {
      if (state.state !== 'idle' && state.state !== 'diagnosed' && state.state !== 'conflict' && state.state !== 'unknown') {
        requireState('idle', 'diagnosed', 'conflict', 'unknown')
      }
      const request = state.state === 'conflict' ? requestId() : state.requestId ?? requestId()
      publish(updateState(state, {
        state: 'checking',
        requestId: request,
        draftId: null,
        purpose: input.purpose,
        target: structuredClone(input.target),
        expectedCurrentVersion: input.expectedCurrentVersion,
        nextAttempt: null,
        source: null,
        basis: null,
        inspection: null,
        draft: null,
        failure: null,
        receipt: null,
        message: null,
      }, now))
      try {
        const inspection = await options.client.inspect({ worldId: options.scope.worldId, ...input })
        if (inspection.status === 'ready') {
          return publish(updateState(state, {
            state: 'diagnosed',
            source: structuredClone(inspection.source),
            basis: structuredClone(inspection.basis),
            inspection: structuredClone(inspection),
            message: inspection.canCreateRepairDraft ? null : '当前检查结果不能创建修复草稿。',
          }, now))
        }
        return publish(updateState(state, {
          state: 'diagnosed',
          inspection: null,
          failure: toFailureView(inspection.error),
          message: inspection.error.message,
        }, now))
      } catch (error) {
        const failure = failureFromUnknown(error)
        const nextState = isConflict(failure) ? 'conflict' : 'unknown'
        publish(updateState(state, { state: nextState, failure: failure ?? null, message: error instanceof Error ? error.message : '检查结果未知。' }, now))
        throw new CompatibilitySessionError(state.message ?? '检查结果未知。', nextState, failure)
      }
    },
    async build(input = {}) {
      requireState('diagnosed')
      if (!state.purpose || !state.target || state.expectedCurrentVersion === null || !state.inspection) {
        throw new CompatibilitySessionError('Compatibility diagnosis is incomplete', state.state)
      }
      if (!state.inspection.canCreateRepairDraft) {
        throw new CompatibilitySessionError(state.message ?? 'Repair draft is unavailable', state.state, state.failure ?? undefined)
      }
      const draftRequestId = input.draftRequestId ?? state.requestId ?? requestId()
      publish(updateState(state, { state: 'building', requestId: draftRequestId, message: null, failure: null }, now))
      try {
        const draft = await options.client.createDraft({
          draftRequestId,
          worldId: options.scope.worldId,
          purpose: state.purpose,
          target: structuredClone(state.target),
          expectedCurrentVersion: state.expectedCurrentVersion,
        })
        const summary: CompatibilityDraftSummary = toCompatibilityDraftSummary(draft)
        const nextState: CompatibilityState = draft.status === 'building' ? 'building' : 'preview'
        return publish(updateState(state, {
          state: nextState,
          draftId: draft.id,
          draft: summary,
          basis: structuredClone(draft.basis),
          message: draft.canConfirm ? null : '修复草稿当前不能提交。',
        }, now))
      } catch (error) {
        const failure = failureFromUnknown(error)
        const nextState = isConflict(failure) ? 'conflict' : 'unknown'
        publish(updateState(state, { state: nextState, failure: failure ?? null, message: error instanceof Error ? error.message : '草稿构建结果未知。' }, now))
        throw new CompatibilitySessionError(state.message ?? '草稿构建结果未知。', nextState, failure)
      }
    },
    async submit() {
      requireState('preview')
      if (!state.draftId || !state.requestId || state.expectedCurrentVersion === null) {
        throw new CompatibilitySessionError('Compatibility preview is incomplete', state.state)
      }
      if (!state.draft?.canConfirm || !state.purpose) {
        throw new CompatibilitySessionError(state.message ?? '修复草稿当前不能提交。', state.state, state.failure ?? undefined)
      }
      publish(updateState(state, { state: 'submitting', message: null, failure: null }, now))
      try {
        const response = await options.client.submit({
          worldId: options.scope.worldId,
          draftId: state.draftId,
          requestId: state.requestId,
          expectedCurrentVersion: state.expectedCurrentVersion,
          expectedAttempt: state.nextAttempt ?? 0,
        })
        if (response.status === 'completed') {
          return publish(updateState(state, { state: 'completed', receipt: structuredClone(response.result), message: null }, now))
        }
        if (response.status === 'submitting') {
          return publish(updateState(state, { state: 'submitting', message: '提交仍在处理中。' }, now))
        }
        if (response.status === 'not-committed' && response.retryAllowed) {
          return publish(updateState(state, { state: 'preview', nextAttempt: response.nextAttempt, message: '提交尚未落库，可以使用同一请求重试。' }, now))
        }
        if (response.status === 'not-committed') {
          const failure = structuredClone(response.error)
          const nextState = isConflict(failure) ? 'conflict' : 'unknown'
          return publish(updateState(state, { state: nextState, failure, message: failure.message }, now))
        }
        const nextState: CompatibilityState = response.status === 'unknown' ? 'unknown' : 'unknown'
        return publish(updateState(state, { state: nextState, message: '提交结果未知。' }, now))
      } catch (error) {
        const failure = failureFromUnknown(error)
        const nextState = isConflict(failure) ? 'conflict' : 'unknown'
        publish(updateState(state, { state: nextState, failure: failure ?? null, message: error instanceof Error ? error.message : '提交结果未知。' }, now))
        throw new CompatibilitySessionError(state.message ?? '提交结果未知。', nextState, failure)
      }
    },
    async queryResult() {
      requireState('submitting', 'unknown')
      if (!state.requestId) {
        throw new CompatibilitySessionError('没有可查询的提交记录。', state.state)
      }
      try {
        const response = await options.client.query({ worldId: options.scope.worldId, requestId: state.requestId })
        if (response.status === 'completed') {
          return publish(updateState(state, { state: 'completed', receipt: structuredClone(response.result), message: null }, now))
        }
        if (response.status === 'submitting') {
          return publish(updateState(state, { state: 'submitting', message: '提交仍在处理中。' }, now))
        }
        if (response.status === 'not-committed' && response.retryAllowed) {
          return publish(updateState(state, {
            state: 'preview',
            nextAttempt: response.nextAttempt,
            message: '提交尚未落库，可以使用同一请求重试。',
          }, now))
        }
        if (response.status === 'not-committed') {
          const failure = structuredClone(response.error)
          const nextState = isConflict(failure) ? 'conflict' : 'unknown'
          return publish(updateState(state, { state: nextState, failure, message: failure.message }, now))
        }
        if (response.status === 'missing') {
          return publish(updateState(state, { state: 'unknown', message: '没有找到可恢复的提交记录。' }, now))
        }
        return publish(updateState(state, { state: 'unknown', message: '提交结果未知。' }, now))
      } catch (error) {
        publish(updateState(state, { state: 'unknown', message: error instanceof Error ? error.message : '提交结果未知。' }, now))
        throw new CompatibilitySessionError(state.message ?? '提交结果未知。', 'unknown')
      }
    },
  }
}
