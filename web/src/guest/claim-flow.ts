import { demoApi, getGuestToken, type ClaimRequest, type ClaimStatus, type RecoverClaimRequest } from '../api/client'
import { createGuestClaimStore, guestClaimStore, type GuestClaimContext, type GuestClaimPhase, type GuestClaimStore, type GuestClaimStoreRead } from './claim-store'

export interface GuestClaimAccount { id: string; username: string }

export interface GuestClaimFlowState {
  phase: GuestClaimPhase
  context: GuestClaimContext | null
  message: string | null
  account: GuestClaimAccount | null
}
export interface GuestClaimFlow {
  phase: GuestClaimPhase
  context: GuestClaimContext | null
  message: string | null
  afterAuthentication(account: GuestClaimAccount): Promise<void>
  confirmAndSave(): Promise<void>
  refreshStatus(): Promise<void>
  recover(): Promise<void>
  prepareAccountSwitch(): Promise<boolean>
  getState(): GuestClaimFlowState
  subscribe(listener: () => void): () => void
  setAccount(account: GuestClaimAccount | null): void
  dispose(): void
}

interface ClaimClient {
  claimStatus: (input: { requestId: string; expectedBinding: { sessionId: string; worldId: string; generation: number } }) => Promise<ClaimStatus>
  claim: (input: ClaimRequest, options?: { signal?: AbortSignal }) => Promise<ClaimStatus>
  recoverClaim: (input: RecoverClaimRequest) => Promise<ClaimStatus>
}

export interface GuestClaimFlowDeps {
  client?: ClaimClient
  store?: GuestClaimStore
  account?: GuestClaimAccount | null
  now?: () => number
  setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>
  clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void
  getGuestToken?: () => string | null
}

const WAIT_LIMIT_MS = 60_000

function statusMessage(status: ClaimStatus): string | null {
  switch (status.kind) {
    case 'claimed': return '访客副本已保存到当前账号。'
    case 'in-progress': return '保存仍在处理中，请核实结果后再继续。'
    case 'retryable': return '上次保存未完成，可以手动重试。'
    case 'conflict': return '这份访客副本已保存到其他账号。'
    case 'unavailable': return status.code === 'source_changed' ? '原访客副本已发生变化，当前保存请求已停止。' : '原访客副本暂时不可用。'
    case 'not-started': return null
  }
}

function phaseForStatus(status: ClaimStatus, current: GuestClaimPhase): GuestClaimPhase {
  switch (status.kind) {
    case 'claimed': return 'completed'
    case 'retryable': return 'retryable'
    case 'conflict': return 'conflict'
    case 'unavailable': return 'unavailable'
    case 'in-progress': return current === 'unknown' ? 'unknown' : 'saving'
    case 'not-started': return current === 'unknown' || current === 'saving' ? 'unknown' : current
  }
}

function statusEpoch(status: ClaimStatus, fallback: number): number {
  return 'epoch' in status && Number.isInteger(status.epoch) ? status.epoch : fallback
}

function readInitial(store: GuestClaimStore): GuestClaimStoreRead {
  try { return store.read() } catch { return { kind: 'storage-unavailable' } }
}

export function createGuestClaimFlow(deps: GuestClaimFlowDeps = {}): GuestClaimFlow {
  const client = deps.client ?? demoApi
  const store = deps.store ?? guestClaimStore
  const timerSet = deps.setTimeout ?? ((handler, timeout) => globalThis.setTimeout(handler, timeout))
  const timerClear = deps.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle))
  const readGuestToken = deps.getGuestToken ?? getGuestToken
  let account = deps.account ?? null
  let readResult = readInitial(store)
  let context = readResult.kind === 'ready' ? readResult.context : null
  let phase: GuestClaimPhase = readResult.kind === 'storage-unavailable' || readResult.kind === 'corrupt' ? 'storage-error' : context?.phase ?? 'needs-auth'
  let message: string | null = readResult.kind === 'storage-unavailable' ? '浏览器存储不可用，暂时无法可靠恢复保存意图。' : readResult.kind === 'corrupt' ? '保存意图无法读取，请返回原访客副本确认。' : null
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null
  let disposed = false
  let requestSerial = 0
  let abortController: AbortController | null = null

  function emit(): void { if (!disposed) listeners.forEach(listener => listener()) }
  function setState(nextPhase: GuestClaimPhase, nextMessage: string | null = message): void {
    phase = nextPhase; message = nextMessage
    if (context && context.phase !== nextPhase) context = { ...context, phase: nextPhase }
    emit()
  }
  function persist(next: GuestClaimContext): boolean {
    const result = store.write(next)
    if (!result.ok) { setState('storage-error', '浏览器存储不可用，保存意图仍保留在当前页面，请勿关闭页面。'); return false }
    context = next
    emit()
    return true
  }
  function clearWait(): void { if (timer !== null) { timerClear(timer); timer = null } }
  function binding(value: GuestClaimContext) {
    return { sessionId: value.source.sessionId, worldId: value.source.worldId, generation: value.source.generation }
  }
  async function complete(status: Extract<ClaimStatus, { kind: 'claimed' }>, captured: GuestClaimContext, capturedAccount: GuestClaimAccount): Promise<void> {
    const guestToken = readGuestToken() ?? ''
    const result = store.completeConfirmedClaim({ guestToken, requestId: captured.requestId, targetUserId: capturedAccount.id }, { worldId: status.worldId, targetUserId: capturedAccount.id })
    if (!result.ok) {
      context = { ...captured, phase: 'completed', receipt: { worldId: status.worldId, targetUserId: capturedAccount.id } }
      phase = 'completed'
      message = '保存已确认；浏览器清理尚未完成，刷新后会继续处理。'
      emit()
      return
    }
    context = null; phase = 'completed'; message = statusMessage(status); emit()
  }
  async function refreshStatus(): Promise<void> {
    if (disposed) return
    if (!context) {
      const refreshed = readInitial(store)
      if (refreshed.kind === 'ready') { context = refreshed.context; phase = refreshed.context.phase; message = null; emit() }
      else if (refreshed.kind === 'storage-unavailable' || refreshed.kind === 'corrupt') setState('storage-error', '浏览器存储不可用，暂时无法可靠恢复保存意图。')
    }
    if (!context || !context.submitted) return
    const captured = context
    const serial = ++requestSerial
    setState('checking', null)
    try {
      const status = await client.claimStatus({ requestId: captured.requestId, expectedBinding: binding(captured) })
      if (disposed || serial !== requestSerial || context?.requestId !== captured.requestId) return
      if (status.kind === 'claimed' && account && captured.target?.userId === account.id) {
        await complete(status, captured, account)
        return
      }
      const next = { ...captured, expectedEpoch: statusEpoch(status, captured.expectedEpoch), observedExecutionId: status.kind === 'in-progress' ? (status.executionId ?? null) : captured.observedExecutionId, phase: phaseForStatus(status, captured.phase) }
      context = next
      phase = next.phase
      message = statusMessage(status)
      if (status.kind === 'not-started' || status.kind === 'in-progress') phase = 'unknown'
      emit()
    } catch (error) {
      if (disposed || serial !== requestSerial) return
      setState('unknown', error instanceof Error ? '暂时无法核实保存结果，请稍后重试。' : '保存结果尚未确认。')
    }
  }
  async function confirmAndSave(): Promise<void> {
    if (disposed || !context || !account || phase === 'saving') return
    if (phase === 'unknown' || phase === 'checking') return
    const captured = context
    const capturedAccount = account
    const submitted: GuestClaimContext = {
      ...captured,
      target: { userId: capturedAccount.id, username: capturedAccount.username },
      submitted: true,
      confirmationRequired: true,
      phase: 'saving',
    }
    if (!persist(submitted)) return
    clearWait(); abortController?.abort(); abortController = new AbortController()
    setState('saving', null)
    const serial = ++requestSerial
    timer = timerSet(() => {
      if (serial !== requestSerial || disposed) return
      abortController?.abort()
      timer = null
      setState('unknown', '保存请求等待时间较长，结果尚未确认。请先核实结果。')
    }, WAIT_LIMIT_MS)
    try {
      const status = await client.claim({ requestId: captured.requestId, expectedEpoch: captured.expectedEpoch, expectedBinding: binding(captured) }, { signal: abortController.signal })
      if (disposed || serial !== requestSerial || context?.requestId !== captured.requestId) return
      clearWait()
      if (status.kind === 'claimed' && capturedAccount.id === (context?.target?.userId ?? capturedAccount.id)) {
        await complete(status, { ...submitted }, capturedAccount)
        return
      }
      context = { ...submitted, expectedEpoch: statusEpoch(status, submitted.expectedEpoch), observedExecutionId: status.kind === 'in-progress' ? (status.executionId ?? null) : submitted.observedExecutionId, phase: phaseForStatus(status, submitted.phase) }
      phase = phaseForStatus(status, submitted.phase)
      message = statusMessage(status)
      emit()
    } catch (error) {
      if (disposed || serial !== requestSerial) return
      clearWait()
      setState(error instanceof DOMException && error.name === 'AbortError' ? 'unknown' : 'unknown', '保存结果尚未确认，请先核实结果。')
    }
  }
  async function afterAuthentication(nextAccount: GuestClaimAccount): Promise<void> {
    account = nextAccount
    if (!context) return
    if (context.submitted || context.target) {
      context = { ...context, target: { userId: nextAccount.id, username: nextAccount.username }, confirmationRequired: true, phase: 'confirm-account' }
      phase = 'confirm-account'; message = `当前保存目标账号：${nextAccount.username}。请确认后保存。`; emit()
      return
    }
    const prepared = { ...context, target: { userId: nextAccount.id, username: nextAccount.username }, confirmationRequired: false }
    if (!persist(prepared)) return
    await confirmAndSave()
  }
  async function recover(): Promise<void> {
    if (disposed || !context || !context.submitted) return
    const captured = context
    const serial = ++requestSerial
    setState('checking', null)
    try {
      const status = await client.recoverClaim({ requestId: captured.requestId, observedEpoch: captured.expectedEpoch, observedExecutionId: captured.observedExecutionId, expectedBinding: binding(captured) })
      if (disposed || serial !== requestSerial || context?.requestId !== captured.requestId) return
      if (status.kind === 'claimed' && account && captured.target?.userId === account.id) { await complete(status, captured, account); return }
      const next = { ...captured, expectedEpoch: statusEpoch(status, captured.expectedEpoch), observedExecutionId: status.kind === 'in-progress' ? (status.executionId ?? null) : null, phase: phaseForStatus(status, captured.phase) }
      context = next; phase = next.phase; message = statusMessage(status); emit()
    } catch (error) {
      if (disposed || serial !== requestSerial) return
      setState('unknown', error instanceof Error ? '主动恢复尚未完成，请再次核实结果。' : '保存结果尚未确认。')
    }
  }
  async function prepareAccountSwitch(): Promise<boolean> {
    if (!context || !context.submitted) return true
    await refreshStatus()
    return phase === 'retryable' || phase === 'completed'
  }
  function setAccount(next: GuestClaimAccount | null): void { account = next; emit() }
  function getState(): GuestClaimFlowState { return { phase, context, message, account } }
  function subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
  function dispose(): void { disposed = true; clearWait(); abortController?.abort(); listeners.clear() }

  return {
    get phase() { return phase },
    get context() { return context },
    get message() { return message },
    afterAuthentication,
    confirmAndSave,
    refreshStatus,
    recover,
    prepareAccountSwitch,
    getState,
    subscribe,
    setAccount,
    dispose,
  }
}

export function createDefaultGuestClaimFlow(): GuestClaimFlow {
  return createGuestClaimFlow({ store: createGuestClaimStore() })
}
