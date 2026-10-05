import type { SceneStopReason, SceneWorkBudget, SceneWorkControl, SceneControl } from './scene-compatibility'

/** Approved A1 defaults. Limits are independent; reaching one never truncates input. */
export const DEFAULT_SCENE_BUDGET: Readonly<SceneWorkBudget> = Object.freeze({
  maxWorkUnits: 12_000_000,
  maxVisitedPerFlood: 200_000,
  maxCollectedIssues: 256,
  maxRepairCandidates: 256,
  maxRepairPasses: 3,
  maxWallMs: 3_000,
  maxWorkspaceBytes: 16 * 1024 * 1024,
  maxSerializedBytes: 1_500_000,
  maxSpaces: 8,
  maxRepairChanges: 64,
  maxDraftWallMs: 10_000,
})

export function sceneBudget(overrides: Partial<SceneWorkBudget> = {}): SceneWorkBudget {
  return {
    maxWorkUnits: normalizeLimit(overrides.maxWorkUnits, DEFAULT_SCENE_BUDGET.maxWorkUnits),
    maxVisitedPerFlood: normalizeLimit(overrides.maxVisitedPerFlood, DEFAULT_SCENE_BUDGET.maxVisitedPerFlood),
    maxCollectedIssues: normalizeLimit(overrides.maxCollectedIssues, DEFAULT_SCENE_BUDGET.maxCollectedIssues),
    maxRepairCandidates: normalizeLimit(overrides.maxRepairCandidates, DEFAULT_SCENE_BUDGET.maxRepairCandidates),
    maxRepairPasses: normalizeLimit(overrides.maxRepairPasses, DEFAULT_SCENE_BUDGET.maxRepairPasses),
    maxWallMs: normalizeLimit(overrides.maxWallMs, DEFAULT_SCENE_BUDGET.maxWallMs),
    maxWorkspaceBytes: normalizeLimit(overrides.maxWorkspaceBytes, DEFAULT_SCENE_BUDGET.maxWorkspaceBytes),
    maxSerializedBytes: normalizeLimit(overrides.maxSerializedBytes, DEFAULT_SCENE_BUDGET.maxSerializedBytes),
    maxSpaces: normalizeLimit(overrides.maxSpaces, DEFAULT_SCENE_BUDGET.maxSpaces),
    maxRepairChanges: normalizeLimit(overrides.maxRepairChanges, DEFAULT_SCENE_BUDGET.maxRepairChanges ?? 64),
    maxDraftWallMs: normalizeLimit(overrides.maxDraftWallMs, DEFAULT_SCENE_BUDGET.maxDraftWallMs ?? 10_000),
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** Count UTF-8 bytes without requiring a Node or browser-specific import. */
export function byteCount(value: unknown): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength
  if (value instanceof Uint8Array) return value.byteLength
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value.byteLength
  try {
    return byteCount(JSON.stringify(value))
  } catch {
    return 0
  }
}

export const sceneByteCount = byteCount

export interface SceneWorkCounter {
  readonly workUnits: number
  readonly visited: number
  readonly bytes: number
  readonly workspaceBytes: number
  readonly checks: number
  readonly stopped: boolean
  readonly stopReason?: SceneStopReason
  work(units?: number): boolean
  visit(count?: number): boolean
  check(count?: number): boolean
  addBytes(bytes: number): boolean
  addWorkspaceBytes(bytes: number): boolean
  inspect(value: unknown, checks?: number): boolean
  stop(reason: SceneStopReason): void
  shouldStop(): boolean
  reset(): void
}

function toControl(control: SceneWorkControl | SceneControl = {}): {
  budget: SceneWorkBudget
  signal?: AbortSignal
  now: () => number
  deadlineAt: number
  onStop?: (reason: SceneStopReason) => void
  yieldControl: () => Promise<void>
} {
  const legacy = control as SceneControl
  const budget = sceneBudget(legacy.budget)
  const now = 'nowMs' in control && typeof control.nowMs === 'function'
    ? control.nowMs
    : legacy.now ?? (() => Date.now())
  const deadlineAt = legacy.deadlineAt ?? now() + budget.maxWallMs
  return {
    budget,
    signal: control.signal,
    now,
    deadlineAt,
    onStop: legacy.onStop,
    yieldControl: 'yieldControl' in control && typeof control.yieldControl === 'function'
      ? control.yieldControl
      : async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) },
  }
}

/** Mutable bounded counter for synchronous validators and deterministic repair planners. */
export function createSceneWorkCounter(control: SceneWorkControl | SceneControl = {}): SceneWorkCounter {
  const state = toControl(control)
  const budget = state.budget
  let workUnits = 0
  let visited = 0
  let bytes = 0
  let workspaceBytes = 0
  let stopReason: SceneStopReason | undefined

  const stop = (reason: SceneStopReason): void => {
    if (!stopReason) {
      stopReason = reason
      state.onStop?.(reason)
    }
  }

  const shouldStop = (): boolean => {
    if (stopReason) return true
    if (state.signal?.aborted) { stop('cancelled'); return true }
    if (workUnits > budget.maxWorkUnits) { stop('work-limit'); return true }
    if (visited > budget.maxVisitedPerFlood) { stop('visit-limit'); return true }
    if (bytes > budget.maxSerializedBytes) { stop('payload-limit'); return true }
    if (workspaceBytes > budget.maxWorkspaceBytes) { stop('workspace-limit'); return true }
    if (state.now() >= state.deadlineAt) { stop('deadline'); return true }
    return false
  }

  const addWork = (units: number): boolean => {
    if (stopReason) return false
    workUnits += Math.max(0, Math.floor(units))
    return !shouldStop()
  }

  return {
    get workUnits() { return workUnits },
    get visited() { return visited },
    get bytes() { return bytes },
    get workspaceBytes() { return workspaceBytes },
    get checks() { return workUnits },
    get stopped() { return shouldStop() },
    get stopReason() { return stopReason },
    work: addWork,
    visit(count = 1) {
      if (stopReason) return false
      visited += Math.max(0, Math.floor(count))
      return addWork(0)
    },
    check(count = 1) { return addWork(count) },
    addBytes(count) {
      if (stopReason) return false
      bytes += Math.max(0, Math.floor(count))
      return !shouldStop()
    },
    addWorkspaceBytes(count) {
      if (stopReason) return false
      workspaceBytes += Math.max(0, Math.floor(count))
      return !shouldStop()
    },
    inspect(value, count = 1) {
      if (!addWork(count)) return false
      return this.addBytes(byteCount(value))
    },
    stop,
    shouldStop,
    reset() {
      workUnits = 0
      visited = 0
      bytes = 0
      workspaceBytes = 0
      stopReason = undefined
    },
  }
}

export const createSceneWorkCounterAlias = createSceneWorkCounter

export function isSceneWorkStopped(counter: SceneWorkCounter): boolean {
  return counter.shouldStop()
}

export function cancelSceneWork(counter: SceneWorkCounter): void {
  counter.stop('cancelled')
}

export function stopSceneWork(counter: SceneWorkCounter, reason: SceneStopReason = 'work-limit'): void {
  counter.stop(reason)
}

export function sceneDeadline(control: SceneWorkControl | SceneControl = {}): number {
  return toControl(control).deadlineAt
}

/** Cooperative async yield; cancellation is observed before and after the yield. */
export async function yieldSceneWork(
  counter?: SceneWorkCounter,
  signal?: AbortSignal,
): Promise<void> {
  if (counter?.shouldStop() || signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 0)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
  if (counter?.shouldStop() || signal?.aborted) counter?.stop('cancelled')
}

export const yieldToSceneWork = yieldSceneWork

export function checkSceneWork(counter: SceneWorkCounter): boolean {
  return !counter.shouldStop()
}

/** A plan-shaped controller factory for async validators. */
export function createSceneWorkControl(
  overrides: Partial<SceneWorkControl> & { budget?: Partial<SceneWorkBudget> } = {},
): SceneWorkControl {
  const startedAt = overrides.nowMs?.() ?? Date.now()
  return {
    signal: overrides.signal ?? new AbortController().signal,
    nowMs: overrides.nowMs ?? (() => Date.now()),
    yieldControl: overrides.yieldControl ?? (async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) }),
    ...(startedAt === undefined ? {} : {}),
  }
}
