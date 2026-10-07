import type { PaneId, PaneTarget, PresentationKind } from './presentation-types'

export interface PresentationRoute {
  left: PaneTarget
  right: PaneTarget | null
}

function presentationOrDefault(value: unknown, fallback: PresentationKind): PresentationKind {
  return value === 'native2d' || value === 'voxel3d' ? value : fallback
}

function optionalId(value: string | null): string | undefined {
  return value != null && value.trim() !== '' ? value : undefined
}

/** worldId comes from the left world's path; the query never overrides it. */
export function readPresentationRoute(
  worldId: string,
  query: URLSearchParams,
  defaultPresentation?: PresentationKind | null,
): PresentationRoute {
  const fallback = presentationOrDefault(defaultPresentation, 'voxel3d')
  const timelineId = optionalId(query.get('timeline'))
  const left: PaneTarget = {
    worldId,
    ...(timelineId === undefined ? {} : { timelineId }),
    presentation: presentationOrDefault(query.get('presentation'), fallback),
  }
  const rightWorld = optionalId(query.get('rightWorld'))
  const rightTimeline = optionalId(query.get('right'))
  const right: PaneTarget | null = rightWorld === undefined && rightTimeline === undefined
    ? null
    : {
      worldId: rightWorld ?? worldId,
      ...(rightTimeline === undefined ? {} : { timelineId: rightTimeline }),
      presentation: presentationOrDefault(query.get('rightPresentation'), fallback),
    }
  return { left, right }
}

export function updatePanePresentation(
  query: URLSearchParams,
  paneId: PaneId,
  kind: PresentationKind,
): URLSearchParams {
  const next = new URLSearchParams(query)
  next.set(paneId === 'right' ? 'rightPresentation' : 'presentation', kind)
  return next
}

export function updatePaneTimeline(
  query: URLSearchParams,
  paneId: PaneId,
  timelineId: string | null,
): URLSearchParams {
  const next = new URLSearchParams(query)
  const key = paneId === 'right' ? 'right' : 'timeline'
  const id = optionalId(timelineId)
  if (id === undefined) next.delete(key)
  else next.set(key, id)
  return next
}

/** Closing the right pane removes its whole target; left path/query stay untouched. */
export function updateRightPaneTarget(
  query: URLSearchParams,
  target: PaneTarget | null,
): URLSearchParams {
  const next = new URLSearchParams(query)
  if (target === null) {
    next.delete('rightWorld')
    next.delete('right')
    next.delete('rightPresentation')
  } else {
    next.set('rightWorld', target.worldId)
    const timelineId = optionalId(target.timelineId ?? null)
    if (timelineId !== undefined) next.set('right', timelineId)
    else next.delete('right')
    next.set('rightPresentation', target.presentation)
  }
  return next
}
