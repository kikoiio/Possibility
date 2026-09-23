/** Accept an async world result only while its request still belongs to the selected line. */
export function isTimelineUpdateCurrent(
  active: boolean,
  requestedTimelineId: string | null,
  selectedTimelineId: string | null,
  responseTimelineId?: string | null,
): boolean {
  if (!active || requestedTimelineId !== selectedTimelineId) return false
  return !requestedTimelineId || !responseTimelineId || responseTimelineId === requestedTimelineId
}
