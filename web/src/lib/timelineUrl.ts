export function withTimelineParam(current: URLSearchParams, timelineId: string | null): URLSearchParams {
  const next = new URLSearchParams(current)
  if (timelineId) next.set('timeline', timelineId)
  else next.delete('timeline')
  return next
}

export function timelineHref(path: string, timelineId: string): string {
  const params = new URLSearchParams({ timeline: timelineId })
  return `${path}?${params.toString()}`
}
