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
  const [authIdentityEpoch, setAuthIdentityEpoch] = useState(0)
  const authIdentityEpochRef = useRef(0)
  const sessionRef = useRef<CompatibilitySession | null>(null)
  const pendingOpenRef = useRef<{ purpose: CompatibilityPurpose; target: SceneTarget } | null>(null)
  const timelineRef = useRef(timelineId)
  const closeHistoryRef = useRef(closeSceneHistory)
  timelineRef.current = timelineId
  closeHistoryRef.current = closeSceneHistory

  useEffect(() => subscribeAuthIdentityChange(() => {
    authIdentityEpochRef.current += 1
    setAuthIdentityEpoch(authIdentityEpochRef.current)
  }), [])

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | null = null
    let session: CompatibilitySession | null = null
    const identityEpoch = authIdentityEpoch
    const identityToken = guest ? getGuestToken() : getToken()
    if (!timelineId) return
    setReadyScope(null)
    setContinuation(null)
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
      && authIdentityEpochRef.current === identityEpoch
      && (guest ? getGuestToken() : getToken()) === identityToken

    const attachAuthorizedSession = async () => {
      try {
        const actorKey = guest ? 'guest' : (await authApi.me({ redirectOnUnauthorized: false })).user.id
        if (!identityIsCurrent()) return
        const current = await worldSceneApi.get(worldId, { timelineId, representation: 'voxel' }, { redirectOnUnauthorized: false })
        if (!identityIsCurrent()) return
        session = createCompatibilitySession({ scope: { actorKey: `${actorKey}\u001f${timelineId}\u001fvoxel`, worldId }, client })
        sessionRef.current = session
        unsubscribe = session.subscribe(setContinuation)
        setContinuation(session.snapshot())
        setReadyScope({ worldId, timelineId, authIdentityEpoch: identityEpoch })
        const pending = pendingOpenRef.current
        if (pending) {
          pendingOpenRef.current = null
          void session.check({
            purpose: pending.purpose,
            target: pending.target,
            expectedCurrentVersion: current.status === 'ready' ? current.version : 0,
          }).catch(() => undefined)
        }
      } catch {
        if (active) {
          setContinuation(null)
          setReadyScope(null)
        }
      }
    }

    void attachAuthorizedSession()
    return () => {
      active = false
      pendingOpenRef.current = null
      unsubscribe?.()
      session?.dispose()
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [worldId, guest, authIdentityEpoch, timelineId])

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
    const session = sessionRef.current
    if (!session) {
      pendingOpenRef.current = { purpose, target }
      return
    }
    pendingOpenRef.current = null
    try {
      const scope: SceneScope = { timelineId, representation: 'voxel' }
      const current = await worldSceneApi.get(worldId, scope)
      if (timelineRef.current !== scope.timelineId || session !== sessionRef.current) return
      await session.check({ purpose, target, expectedCurrentVersion: current.status === 'ready' ? current.version : 0 })
    } catch {
      // The session keeps failed and unknown checks in its continuation.
    }
  }, [worldId, timelineId, archived])

  const close = useCallback(() => {
    const session = sessionRef.current
    if (!session) {
      setContinuation(null)
      return
    }
    const state = session.snapshot().state
    if (state === 'submitting' || state === 'unknown') setContinuation(null)
    else session.reset()
  }, [])

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
  const panel = currentContinuation && currentContinuation.state !== 'idle'
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

  return { open, panel }
}
