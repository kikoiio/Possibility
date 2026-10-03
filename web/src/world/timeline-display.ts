interface ReadableTimeline {
  parentTimelineId: string | null
  forkScenario?: { name?: string | null; whatIf?: string | null } | null
}

export function timelineDisplayName(timeline: ReadableTimeline): string {
  if (!timeline.parentTimelineId) return '主宇宙'
  return timeline.forkScenario?.name?.trim() || timeline.forkScenario?.whatIf?.trim() || '平行宇宙（未记录假设）'
}

export function timelineOptionLabel(timeline: ReadableTimeline): string {
  const name = timelineDisplayName(timeline)
  const hypothesis = timeline.forkScenario?.whatIf?.trim()
  return hypothesis && hypothesis !== name ? `${name} · ${hypothesis}` : name
}

export function forkFieldsError(input: { name?: string; whatIf: string; changedVariable: string }): string {
  if (!input.name?.trim() || input.name.trim().length > 80) return '请填写分支名称（1–80 字）。'
  if (!input.whatIf.trim() || input.whatIf.trim().length > 500) return '请填写假设（1–500 字）。'
  if (!input.changedVariable.trim() || input.changedVariable.trim().length > 200) return '请填写唯一改变的条件（1–200 字）。'
  return ''
}
