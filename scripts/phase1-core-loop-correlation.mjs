export function validateCoreJourneyCorrelation(correlation, expectedRunId) {
  const errors = []
  const trace = Array.isArray(correlation?.apiTrace) ? correlation.apiTrace : []
  const context = correlation?.context ?? {}
  const created = trace.find(item => item.method === 'POST' && item.path === '/api/worlds'
    && item.status === 200 && item.requestId === correlation?.requestId)
  const bootstrap = trace.find(item => item.method === 'GET'
    && item.path === `/api/worlds/${context.worldId}/map/bootstrap`)
  const draft = trace.find(item => item.method === 'POST' && item.path === '/api/scene-drafts/voxel'
    && item.status === 200 && item.requestId === correlation?.draftRequestId)
  const contextMatches = typeof context.worldId === 'string' && context.worldId.length > 0
    && typeof context.timelineId === 'string' && context.timelineId.length > 0
    && context.spaceId === 'exterior'
    && typeof context.simNow === 'string' && !Number.isNaN(Date.parse(context.simNow))
    && created?.worldId === context.worldId
    && created?.timelineId === context.timelineId
    && bootstrap?.status === 200
    && bootstrap?.worldId === context.worldId
    && bootstrap?.timelineId === context.timelineId
    && bootstrap?.spaceId === context.spaceId
    && bootstrap?.simNow === context.simNow

  if (correlation?.runId !== expectedRunId) errors.push('runId does not match the baseline manifest runId')
  if (typeof correlation?.requestId !== 'string' || !correlation.requestId) errors.push('requestId is missing')
  if (typeof correlation?.draftRequestId !== 'string' || !correlation.draftRequestId) errors.push('draftRequestId is missing')
  if (correlation?.sameDocument !== true) errors.push('created scene does not match the generated draft')
  if (!draft) errors.push('successful scene draft is not linked to the journey draftRequestId')
  if (!created) errors.push('successful world create is not linked to the journey requestId')
  if (!contextMatches) errors.push('world/timeline/space/simNow do not match the authoritative bootstrap')
  if (!correlation?.page || !Array.isArray(correlation.page.labels) || !correlation.page.url) errors.push('page correlation evidence is incomplete')
  return { passed: errors.length === 0, errors }
}
