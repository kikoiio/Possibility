import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import { lifeApi, subscribeWorldStream, worldsApi } from '../api/client'
import type { TimelineComparison, WorldSnapshot } from '../api/types'
import { buildAlignedAxis, filterAt } from './alignedTimeline'

type AsyncReadState<T> =
  | { status: 'closed' | 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string }

interface WorldTimelineComparisonOptions {
  worldId: string
  snapshot: WorldSnapshot | null
  readonly: boolean
  guest: boolean
  search: URLSearchParams
  setSearch: SetURLSearchParams
}

export function useWorldTimelineComparison({
  worldId,
  snapshot,
  readonly,
  guest,
  search,
  setSearch,
}: WorldTimelineComparisonOptions) {
  const [rightSceneRead, setRightSceneRead] = useState<AsyncReadState<WorldSnapshot>>({ status: 'closed' })
  const [rightTimelineId, setRightTimelineId] = useState<string | null>(() => search.get('right'))
  const [comparisonRead, setComparisonRead] = useState<AsyncReadState<TimelineComparison>>({ status: 'closed' })
  const rightSnapshotRequestId = useRef(0)
  const comparisonRequestId = useRef(0)
  const [scrubAt, setScrubAt] = useState<string | null>(null)
  const [mode, setMode] = useState<'life' | 'possibility'>(() => search.get('mode') === 'possibility' ? 'possibility' : 'life')

  const otherSnapshot = rightSceneRead.status === 'ready' ? rightSceneRead.value : null
  const comparison = comparisonRead.status === 'ready' ? comparisonRead.value : null
  const compareSummary = useMemo(() => comparison ? {
    facts: comparison.differences.facts.length,
    states: comparison.differences.states.length,
    events: comparison.differences.events.leftOnly.length + comparison.differences.events.rightOnly.length,
  } : null, [comparison])

  const readRightScene = useCallback(async (targetId: string) => {
    const requestId = ++rightSnapshotRequestId.current
    setRightSceneRead({ status: 'loading' })
    try {
      const result = await worldsApi.snapshot(worldId, targetId)
      if (requestId !== rightSnapshotRequestId.current || result.currentTimelineId !== targetId) return
      setRightSceneRead({ status: 'ready', value: result })
    } catch {
      if (requestId === rightSnapshotRequestId.current) setRightSceneRead({ status: 'error', message: '另一种发展暂时无法读取。请重试，或关闭分屏。' })
    }
  }, [worldId])

  const readComparison = useCallback(async (currentId: string, targetId: string) => {
    const requestId = ++comparisonRequestId.current
    setComparisonRead({ status: 'loading' })
    try {
      const result = await lifeApi.compare(worldId, currentId, targetId)
      if (requestId !== comparisonRequestId.current) return
      setComparisonRead({ status: 'ready', value: result })
    } catch {
      if (requestId === comparisonRequestId.current) setComparisonRead({ status: 'error', message: '时间线对照暂时无法读取。请重试。' })
    }
  }, [worldId])

  useEffect(() => {
    const currentId = snapshot?.currentTimelineId
    const target = snapshot?.timelines.find(item => item.id === rightTimelineId && item.id !== currentId)
      ?? snapshot?.timelines.find(item => item.id !== currentId)
    if (mode !== 'possibility' || !currentId || !target) {
      ++rightSnapshotRequestId.current
      ++comparisonRequestId.current
      setRightSceneRead({ status: 'closed' })
      setComparisonRead({ status: 'closed' })
      if (mode !== 'possibility') setScrubAt(null)
      return
    }
    if (target.id !== rightTimelineId) setRightTimelineId(target.id)
    void readRightScene(target.id)
    void readComparison(currentId, target.id)
    return () => {
      ++rightSnapshotRequestId.current
      ++comparisonRequestId.current
    }
  }, [mode, snapshot?.currentTimelineId, snapshot?.timelines, rightTimelineId, readRightScene, readComparison])

  const retryRightScene = useCallback(() => {
    const currentId = snapshot?.currentTimelineId
    const targetId = rightTimelineId ?? snapshot?.timelines.find(item => item.id !== currentId)?.id
    if (currentId && targetId) void readRightScene(targetId)
  }, [snapshot, rightTimelineId, readRightScene])

  const retryComparison = useCallback(() => {
    const currentId = snapshot?.currentTimelineId
    const targetId = rightTimelineId ?? snapshot?.timelines.find(item => item.id !== currentId)?.id
    if (currentId && targetId) void readComparison(currentId, targetId)
  }, [snapshot, rightTimelineId, readComparison])

  useEffect(() => {
    if (mode !== 'possibility' || !otherSnapshot || guest) return
    const rightId = otherSnapshot.currentTimelineId
    let active = true
    let version = otherSnapshot.stateVersion
    const unsubscribe = subscribeWorldStream(worldId, rightId, event => {
      if (!active || event.timelineId !== rightId || event.stateVersion <= version) return
      void worldsApi.snapshot(worldId, rightId).then(next => {
        if (!active || next.currentTimelineId !== rightId) return
        version = Math.max(version, next.stateVersion)
        setRightSceneRead(current => current.status === 'ready' && current.value.currentTimelineId === rightId && current.value.stateVersion < next.stateVersion
          ? { status: 'ready', value: next } : current)
      }).catch(() => {})
    }, { isPublic: readonly, onError: () => {} })
    return () => {
      active = false
      unsubscribe()
    }
  }, [mode, otherSnapshot?.currentTimelineId, worldId, readonly, guest])

  useEffect(() => {
    if (search.get('mode') === 'possibility' && mode !== 'possibility') setMode('possibility')
    const urlRight = search.get('right')
    if (urlRight && urlRight !== rightTimelineId) setRightTimelineId(urlRight)
  }, [search])

  useEffect(() => {
    const params = new URLSearchParams(search)
    let changed = false
    if (mode === 'possibility') {
      if (params.get('mode') !== 'possibility') {
        params.set('mode', 'possibility')
        changed = true
      }
      if (rightTimelineId && params.get('right') !== rightTimelineId) {
        params.set('right', rightTimelineId)
        changed = true
      }
    } else {
      if (params.has('mode')) {
        params.delete('mode')
        changed = true
      }
      const presentationComparison = params.has('rightWorld') || params.has('rightPresentation') || params.get('presentation') === 'native2d'
      if (params.has('right') && !presentationComparison) {
        params.delete('right')
        changed = true
      }
    }
    if (changed) setSearch(params, { replace: true })
  }, [mode, rightTimelineId, search, setSearch])

  const axis = useMemo(() => comparison ? buildAlignedAxis(comparison) : null, [comparison])
  const scrubbed = useMemo(() => axis && scrubAt ? filterAt(axis, scrubAt) : null, [axis, scrubAt])
  const [alignedComparison, setAlignedComparison] = useState<TimelineComparison | null>(null)

  useEffect(() => {
    if (!scrubAt || !snapshot || !otherSnapshot) {
      setAlignedComparison(null)
      return
    }
    const leftId = snapshot.currentTimelineId
    const rightId = otherSnapshot.currentTimelineId
    let active = true
    const timer = setTimeout(() => {
      void lifeApi.compare(worldId, leftId, rightId, { simTime: scrubAt })
        .then(result => { if (active) setAlignedComparison(result) })
        .catch(() => { if (active) setAlignedComparison(null) })
    }, 300)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [scrubAt, snapshot, otherSnapshot, worldId])

  const splitEvents = useCallback((side: 'left' | 'right', targetSnapshot: WorldSnapshot | null) => {
    if (!targetSnapshot) return []
    let events = targetSnapshot.events
    if (scrubbed) {
      const ids = new Set([...scrubbed.shared, ...(side === 'left' ? scrubbed.left : scrubbed.right)].map(marker => marker.eventId))
      events = events.filter(event => ids.has(event.id))
    }
    return events.slice(-5)
  }, [scrubbed])

  const swapSplit = useCallback(() => {
    if (!otherSnapshot || !snapshot) return
    setRightTimelineId(snapshot.currentTimelineId)
    const params = new URLSearchParams(search)
    params.set('timeline', otherSnapshot.currentTimelineId)
    setSearch(params)
  }, [otherSnapshot, snapshot, search, setSearch])

  const closeSplit = useCallback((side: 'left' | 'right') => {
    const params = new URLSearchParams(search)
    if (side === 'left' && otherSnapshot) params.set('timeline', otherSnapshot.currentTimelineId)
    params.delete('mode')
    params.delete('right')
    setSearch(params)
    setMode('life')
  }, [otherSnapshot, search, setSearch])

  return {
    mode,
    setMode,
    rightTimelineId,
    setRightTimelineId,
    rightSceneRead,
    retryRightScene,
    comparisonRead,
    retryComparison,
    otherSnapshot,
    comparison,
    compareSummary,
    scrubAt,
    setScrubAt,
    axis,
    alignedComparison,
    splitEvents,
    swapSplit,
    closeSplit,
  }
}
