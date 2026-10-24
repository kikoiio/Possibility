import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { authApi, getGuestToken, getToken, sceneCompatibilityApi, worldSceneApi, subscribeAuthIdentityChange } from '../api/client'
import type { CompatibilityPurpose, SceneScope, SceneTarget } from '../api/types'
import { SceneCompatibilityPanel } from '../components/scene/SceneCompatibilityPanel'
import { SceneRepairPreview } from '../components/scene/SceneRepairPreview'
import { createCompatibilitySession, type CompatibilitySession, type CompatibilitySessionClient } from './compatibility-session'
import { startCompatibilityPolling } from './compatibility-polling'
import type { CompatibilityContinuation } from './compatibility-store'

interface WorldSceneCompatibilityOptions {
  worldId: string
  timelineId: string
  guest: boolean
  canEdit: boolean
  archived: boolean
  timeZone?: string
  closeSceneHistory(): void
}

type EntryScope = {
  worldId: string
  timelineId: string
  identityEpoch: number
  identityKind: 'account' | 'guest'
}

type OpenIntent = { purpose: CompatibilityPurpose; target: SceneTarget }
type EntryStage = 'attach' | 'current-scene' | 'check'
type EntryState =
  | { state: 'idle' }
  | { state: 'opening'; scope: EntryScope; attempt: number; intent: OpenIntent; stage: EntryStage }
  | { state: 'failed'; scope: EntryScope; attempt: number; intent: OpenIntent; stage: EntryStage }

const IDLE_ENTRY: EntryState = { state: 'idle' }

function sameScope(left: EntryScope, right: EntryScope): boolean {
  return left.worldId === right.worldId
    && left.timelineId === right.timelineId
    && left.identityEpoch === right.identityEpoch
    && left.identityKind === right.identityKind
}

function isOpeningAttempt(entry: EntryState, scope: EntryScope, attempt: number): boolean {
  return entry.state === 'opening' && entry.attempt === attempt && sameScope(entry.scope, scope)
}

function sameTarget(left: SceneTarget | null, right: SceneTarget): boolean {
  if (!left || left.kind !== right.kind) return false
  return left.kind === 'current'
    || (right.kind === 'history' && left.version === right.version && left.targetRevisionId === right.targetRevisionId)
}

function entryFailureMessage(stage: EntryStage): string {
  if (stage === 'attach') return '暂时无法连接场景修复服务。'
  if (stage === 'current-scene') return '暂时无法读取当前场景。'
  return '暂时无法完成场景检查。'
}

function readIdentityToken(kind: EntryScope['identityKind']): string | null {
  return kind === 'guest' ? getGuestToken() : getToken()
}

export function useWorldSceneCompatibility({
  worldId,
  timelineId,
  guest,
  canEdit,
  archived,
  timeZone,
  closeSceneHistory,
}: WorldSceneCompatibilityOptions): { open(purpose: CompatibilityPurpose, target: SceneTarget): Promise<void>; panel: ReactNode } {
  const [continuation, setContinuation] = useState<CompatibilityContinuation | null>(null)
  const [readyScope, setReadyScope] = useState<{ worldId: string; timelineId: string; authIdentityEpoch: number } | null>(null)
  const [entryState, setEntryState] = useState<EntryState>(IDLE_ENTRY)
  const [authIdentityEpoch, setAuthIdentityEpoch] = useState(0)
  const authIdentityEpochRef = useRef(0)
  const sessionRef = useRef<CompatibilitySession | null>(null)
  const entryRef = useRef<EntryState>(IDLE_ENTRY)
  const entryAttemptRef = useRef(0)
  const entryIdentityTokenRef = useRef<string | null>(null)
  const entryScopeRef = useRef<EntryScope>({ worldId, timelineId, identityEpoch: authIdentityEpoch, identityKind: guest ? 'guest' : 'account' })
  const attachmentRef = useRef<{ scope: EntryScope; state: 'pending' | 'ready' | 'failed' } | null>(null)
  const attachRef = useRef<() => Promise<void>>(async () => undefined)
  const runOpenRef = useRef<((intent: OpenIntent, attempt: number, session: CompatibilitySession, scope: EntryScope, token: string | null) => Promise<void>) | null>(null)
  const closeHistoryRef = useRef(closeSceneHistory)
  entryScopeRef.current = { worldId, timelineId, identityEpoch: authIdentityEpoch, identityKind: guest ? 'guest' : 'account' }
  closeHistoryRef.current = closeSceneHistory

  const updateEntry = useCallback((next: EntryState) => {
    entryRef.current = next
    setEntryState(next)
  }, [])

  const isCurrentEntry = useCallback((scope: EntryScope, attempt: number, token: string | null) =>
    isOpeningAttempt(entryRef.current, scope, attempt)
      && authIdentityEpochRef.current === scope.identityEpoch
      && sameScope(entryScopeRef.current, scope)
      && entryIdentityTokenRef.current === token
      && readIdentityToken(scope.identityKind) === token, [])

  useEffect(() => subscribeAuthIdentityChange(() => {
    authIdentityEpochRef.current += 1
    setAuthIdentityEpoch(authIdentityEpochRef.current)
  }), [])

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | null = null
    let session: CompatibilitySession | null = null
    let attachAttempt = 0
    const scope: EntryScope = { worldId, timelineId, identityEpoch: authIdentityEpoch, identityKind: guest ? 'guest' : 'account' }
    const identityToken = readIdentityToken(scope.identityKind)
    if (!timelineId) return
    setReadyScope(null)
    setContinuation(null)
    updateEntry(IDLE_ENTRY)
    entryAttemptRef.current += 1
    entryIdentityTokenRef.current = identityToken
    attachmentRef.current = { scope, state: 'pending' }
    const client: CompatibilitySessionClient = {
      inspect: input => sceneCompatibilityApi.inspection(worldId, { timelineId, representation: 'voxel' }, input.target.kind === 'history' ? {
        version: input.target.version,
        targetRevisionId: input.target.targetRevisionId,
      } : {}),
      createDraft: input => sceneCompatibilityApi.createDraft(worldId, { timelineId, representation: 'voxel' }, {
        draftRequestId: input.draftRequestId,
        purpose: input.purpose,
        target: input.target,
        expectedCurrentVersion: input.expectedCurrentVersion,
      }),
      submit: input => sceneCompatibilityApi.confirm(worldId, { timelineId, representation: 'voxel' }, {
        draftId: input.draftId,
        requestId: input.requestId,
        expectedCurrentVersion: input.expectedCurrentVersion,
        expectedAttempt: input.expectedAttempt,
      }),
      query: input => sceneCompatibilityApi.readRequest(worldId, { timelineId, representation: 'voxel' }, input.requestId),
      recover: input => sceneCompatibilityApi.recoverRequest(worldId, { timelineId, representation: 'voxel' }, input.requestId, {
        draftId: input.draftId,
        expectedCurrentVersion: input.expectedCurrentVersion,
        expectedAttempt: input.expectedAttempt,
      }),
    }
    const identityIsCurrent = () => active
      && authIdentityEpochRef.current === scope.identityEpoch
      && sameScope(entryScopeRef.current, scope)
      && readIdentityToken(scope.identityKind) === identityToken

    const failEntry = (attempt: number, intent: OpenIntent, stage: EntryStage, currentSession?: CompatibilitySession) => {
      if (!isCurrentEntry(scope, attempt, identityToken)) return
      const state = currentSession?.snapshot().state
      if (state === 'submitting' || state === 'unknown') {
        updateEntry(IDLE_ENTRY)
        return
      }
      updateEntry({ state: 'failed', scope, attempt, intent, stage })
    }

    const runOpen = async (intent: OpenIntent, attempt: number, currentSession: CompatibilitySession) => {
      if (!isCurrentEntry(scope, attempt, identityToken) || currentSession !== sessionRef.current) return
      if (currentSession.snapshot().state === 'submitting') {
        updateEntry(IDLE_ENTRY)
        return
      }
      const stateBeforeRead = currentSession.snapshot().state
      let stage: EntryStage = 'current-scene'
      updateEntry({ state: 'opening', scope, attempt, intent, stage })
      try {
        const current = await worldSceneApi.get(worldId, { timelineId, representation: 'voxel' }, { redirectOnUnauthorized: false })
        if (!isCurrentEntry(scope, attempt, identityToken) || currentSession !== sessionRef.current) return
        if (currentSession.snapshot().state === 'submitting') {
          updateEntry(IDLE_ENTRY)
          return
        }
        stage = 'check'
        updateEntry({ state: 'opening', scope, attempt, intent, stage })
        await currentSession.check({
          purpose: intent.purpose,
          target: intent.target,
          expectedCurrentVersion: current.status === 'ready' ? current.version : 0,
        })
        if (isCurrentEntry(scope, attempt, identityToken) && currentSession === sessionRef.current) updateEntry(IDLE_ENTRY)
      } catch {
        if (!isCurrentEntry(scope, attempt, identityToken) || currentSession !== sessionRef.current) return
        const snapshot = currentSession.snapshot()
        const checkFailureIsPublished = stage === 'check'
          && (snapshot.state === 'conflict' || snapshot.state === 'unknown')
          && snapshot.purpose === intent.purpose
          && sameTarget(snapshot.target, intent.target)
        if (checkFailureIsPublished || snapshot.state === 'submitting'
          || (stage === 'current-scene' && stateBeforeRead === 'unknown')) {
          updateEntry(IDLE_ENTRY)
          return
        }
        failEntry(attempt, intent, stage, currentSession)
      }
    }
    runOpenRef.current = async (intent, attempt, currentSession, expectedScope, expectedToken) => {
      if (sameScope(scope, expectedScope) && identityToken === expectedToken) await runOpen(intent, attempt, currentSession)
    }

    const attachAuthorizedSession = async () => {
      const currentAttempt = ++attachAttempt
      attachmentRef.current = { scope, state: 'pending' }
      try {
        const actorKey = guest ? 'guest' : (await authApi.me({ redirectOnUnauthorized: false })).user.id
        if (!identityIsCurrent() || currentAttempt !== attachAttempt) return
        session = createCompatibilitySession({ scope: { actorKey: `${actorKey}\u001f${timelineId}\u001fvoxel`, worldId }, client })
        sessionRef.current = session
        unsubscribe?.()
        unsubscribe = session.subscribe(setContinuation)
        setContinuation(session.snapshot())
        setReadyScope({ worldId, timelineId, authIdentityEpoch: scope.identityEpoch })
        attachmentRef.current = { scope, state: 'ready' }
        const pending = entryRef.current
        if (pending.state === 'opening' && pending.stage === 'attach' && sameScope(pending.scope, scope)) {
          void runOpen(pending.intent, pending.attempt, session)
        }
      } catch {
        if (identityIsCurrent() && currentAttempt === attachAttempt) {
          attachmentRef.current = { scope, state: 'failed' }
          setContinuation(null)
          setReadyScope(null)
          const pending = entryRef.current
          if (pending.state === 'opening' && sameScope(pending.scope, scope)) {
            failEntry(pending.attempt, pending.intent, 'attach')
          }
        }
      }
    }

    attachRef.current = attachAuthorizedSession
    void attachAuthorizedSession()
    return () => {
      active = false
      attachAttempt += 1
      if (sameScope(entryScopeRef.current, scope)) {
        entryAttemptRef.current += 1
        entryIdentityTokenRef.current = null
      }
      unsubscribe?.()
      session?.dispose()
      if (sessionRef.current === session) sessionRef.current = null
      if (runOpenRef.current) runOpenRef.current = null
      if (attachmentRef.current?.scope === scope) attachmentRef.current = null
      if (attachRef.current === attachAuthorizedSession) attachRef.current = async () => undefined
    }
  }, [worldId, guest, authIdentityEpoch, timelineId, isCurrentEntry, updateEntry])

  useEffect(() => {
    const currentContinuation = readyScope?.worldId === worldId
      && readyScope.timelineId === timelineId
      && readyScope.authIdentityEpoch === authIdentityEpoch
      ? continuation : null
    const session = sessionRef.current
    if (!session || currentContinuation?.state !== 'submitting' || !currentContinuation.requestId) return
    return startCompatibilityPolling({
      query: async () => { await session.queryResult() },
      isVisible: () => document.visibilityState === 'visible',
      subscribeVisibility: listener => {
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      },
    })
  }, [worldId, timelineId, readyScope, authIdentityEpoch, continuation?.state, continuation?.requestId])

  const open = useCallback(async (purpose: CompatibilityPurpose, target: SceneTarget) => {
    closeHistoryRef.current()
    if (!timelineId || archived) return
    const scope = entryScopeRef.current
    const token = readIdentityToken(scope.identityKind)
    const intent = { purpose, target: structuredClone(target) }
    const attempt = ++entryAttemptRef.current
    entryIdentityTokenRef.current = token
    updateEntry({ state: 'opening', scope, attempt, intent, stage: 'attach' })
    const session = sessionRef.current
    const attachment = attachmentRef.current
    if (session && attachment && attachment.state === 'ready' && sameScope(attachment.scope, scope)) {
      await runOpenRef.current?.(intent, attempt, session, scope, token)
      return
    }
    if (attachment && sameScope(attachment.scope, scope) && attachment.state === 'failed') {
      if (isCurrentEntry(scope, attempt, token)) updateEntry({ state: 'failed', scope, attempt, intent, stage: 'attach' })
    }
  }, [timelineId, archived, isCurrentEntry, updateEntry])

  const retryEntry = useCallback(() => {
    const failed = entryRef.current
    if (failed.state !== 'failed' || !sameScope(failed.scope, entryScopeRef.current)) return
    const token = entryIdentityTokenRef.current
    if (readIdentityToken(failed.scope.identityKind) !== token) return
    const attempt = ++entryAttemptRef.current
    updateEntry({ state: 'opening', scope: failed.scope, attempt, intent: failed.intent, stage: failed.stage })
    if (failed.stage === 'attach' || !sessionRef.current) {
      if (failed.stage !== 'attach') updateEntry({ state: 'opening', scope: failed.scope, attempt, intent: failed.intent, stage: 'attach' })
      void attachRef.current()
      return
    }
    void runOpenRef.current?.(failed.intent, attempt, sessionRef.current, failed.scope, token)
  }, [updateEntry])

  const dismissEntry = useCallback(() => {
    entryAttemptRef.current += 1
    entryIdentityTokenRef.current = null
    updateEntry(IDLE_ENTRY)
  }, [updateEntry])

  const close = useCallback(() => {
    entryAttemptRef.current += 1
    entryIdentityTokenRef.current = null
    updateEntry(IDLE_ENTRY)
    const session = sessionRef.current
    if (!session) {
      setContinuation(null)
      return
    }
    const state = session.snapshot().state
    if (state === 'submitting' || state === 'unknown') setContinuation(null)
    else session.reset()
  }, [updateEntry])

  const currentContinuation = readyScope?.worldId === worldId
    && readyScope.timelineId === timelineId
    && readyScope.authIdentityEpoch === authIdentityEpoch
    ? continuation : null
  const draft = currentContinuation?.draft ?? null
  const sourceVersion = currentContinuation?.source?.version ?? null
  const preview = currentContinuation?.state === 'preview' && draft && sourceVersion !== null
    ? <SceneRepairPreview
        key={draft.id}
        spaces={draft.previewSpaces}
        loadSourceSpace={(spaceId, signal) => sceneCompatibilityApi.readSourceSpace(worldId,
          { timelineId, representation: 'voxel' }, sourceVersion, spaceId, signal,
          currentContinuation.target?.kind === 'history'
            ? { targetRevisionId: currentContinuation.target.targetRevisionId } : undefined).then(result => result.document)}
        loadCandidateSpace={(spaceId, signal) => sceneCompatibilityApi.readDraftSpace(worldId,
          { timelineId, representation: 'voxel' }, draft.id, spaceId, signal).then(result => result.document)}
        changes={draft.changes.items}
        ruleNotes={draft.report?.ruleNotes.items ?? []}
        timeZone={timeZone}
      />
    : undefined
  const sceneScope: SceneScope = { timelineId, representation: 'voxel' }
  const sessionPanel = currentContinuation && currentContinuation.state !== 'idle'
    ? <SceneCompatibilityPanel
        sceneScope={sceneScope}
        continuation={currentContinuation}
        canEdit={canEdit}
        preview={preview}
        onBuild={() => void sessionRef.current?.build().catch(() => undefined)}
        onConfirm={() => void sessionRef.current?.submit().catch(() => undefined)}
        onRecheck={() => {
          const { purpose, target } = currentContinuation
          if (purpose && target) void open(purpose, target)
        }}
        onQueryResult={() => void sessionRef.current?.queryResult().catch(() => undefined)}
        onClose={close}
      />
    : null
  const currentEntry = entryState.state !== 'idle' && sameScope(entryState.scope, entryScopeRef.current) ? entryState : IDLE_ENTRY
  const sessionOwnsRecovery = currentContinuation?.state === 'submitting' || currentContinuation?.state === 'unknown'
  const entryPanel = currentEntry.state === 'failed' && !sessionOwnsRecovery
    ? <div role="alert" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-lg rounded border border-ink-line bg-sheet px-4 py-3 text-sm text-ink shadow-lg">
        <p>{entryFailureMessage(currentEntry.stage)}</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={retryEntry} className="rounded border border-ink-line px-3 py-1">重试</button>
          <button type="button" onClick={dismissEntry} className="rounded border border-ink-line px-3 py-1">关闭</button>
        </div>
      </div>
    : null
  const panel = <>{entryPanel}{sessionPanel}</>

  return { open, panel }
}
