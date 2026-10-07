import { appendFileSync, writeFileSync } from 'node:fs'

const apiUrl = process.env.PHASE2_TEMP_API_URL?.replace(/\/$/, '')
const token = process.env.DEPLOYMENT_TOKEN
const worldId = process.env.DEPLOYMENT_WORLD_ID
const timelineId = process.env.DEPLOYMENT_TIMELINE_ID
const evidencePath = process.env.PHASE2_TEMP_READONLY_EVIDENCE
if (!apiUrl || !token || !worldId || !timelineId || !evidencePath) {
  const skipped = 'Temporary world archive/read-only check: SKIPPED (bootstrap did not provide complete API/world/timeline/session inputs).'
  process.stdout.write(`${skipped}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Temporary Cloudflare archive/read-only check\n\n${skipped}\n`)
  process.exit(0)
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : null } catch { value = text }
  return { status: response.status, body: value }
}

const archive = await request(`/api/worlds/${encodeURIComponent(worldId)}/archive`, { method: 'POST' })
const worlds = await request('/api/worlds')
const world = worlds.body?.worlds?.find(item => item.id === worldId)
const read = await request(`/api/worlds/${encodeURIComponent(worldId)}/state?timelineId=${encodeURIComponent(timelineId)}`)
const refusedWrite = await request(`/api/worlds/${encodeURIComponent(worldId)}/actions`, {
  method: 'POST',
  body: {
    id: `phase2-archived-readonly-${worldId}`,
    timelineId,
    expectedVersion: 0,
    action: { type: 'environment', location: null, condition: 'weather', value: 'clear' },
  },
})

const evidence = {
  environment: 'run-scoped temporary Cloudflare Worker and D1; cleanup follows this step',
  httpStatuses: { archive: archive.status, worldsRead: worlds.status, archivedStateRead: read.status, archivedWriteAttempt: refusedWrite.status },
  assertions: {
    worldArchived: archive.status === 200 && archive.body?.status === 'archived' && world?.status === 'archived',
    archivedStateReadable: read.status === 200,
    archivedWorldWriteRejected: refusedWrite.status === 409,
  },
  worldId,
  timelineId,
  responseBodies: { archive: archive.body, archivedWriteAttempt: refusedWrite.body },
}
evidence.ok = Object.values(evidence.assertions).every(Boolean)
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `## Temporary Cloudflare archive/read-only check\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`)
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
if (!evidence.ok) process.exitCode = 1
