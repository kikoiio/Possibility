import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const apiUrl = process.env.PHASE2_TEMP_API_URL?.replace(/\/$/, '')
const databaseName = process.env.PHASE2_TEMP_DATABASE_NAME
const wranglerConfig = process.env.PHASE2_TEMP_WRANGLER_CONFIG
if (!apiUrl || !databaseName || !wranglerConfig) throw new Error('temporary Worker bootstrap inputs are missing')

async function request(path, { token, method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
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

function requireStatus(result, status, label) {
  if (result.status !== status) throw new Error(`${label} returned HTTP ${result.status}: ${JSON.stringify(result.body)}`)
}

function isWorkersDevScriptNotFound(result) {
  const body = result?.body
  return result?.status === 404
    && body?.cloudflare_error === true
    && body?.error_category === 'worker'
    && body?.error_code === 1042
    && body?.error_name === 'workers_dev_script_not_found'
    && body?.title === 'Error 1042: Cloudflare Error'
    && body?.detail === 'No Workers script was found for this host on workers.dev.'
}

function logRegistrationAttempt({ attempt, result, retryScheduled }) {
  const edgeError = isWorkersDevScriptNotFound(result)
  process.stdout.write(`${JSON.stringify({
    event: 'temporary-registration-attempt',
    attempt,
    status: result.status,
    retryableEdgePropagationError: edgeError,
    ...(edgeError ? { edgeErrorCode: 1042, edgeErrorName: 'workers_dev_script_not_found' } : {}),
    retryScheduled,
  })}\n`)
}

async function verifyHealthBeforeRetry(nextAttempt) {
  const healthUrl = `${apiUrl}/api/health`
  let healthStatus = null
  try {
    const response = await fetch(healthUrl, { headers: { accept: 'application/json' } })
    healthStatus = response.status
    // Do not log a health response body; it is not needed for this gate.
    if (response.body) await response.body.cancel().catch(() => {})
  } catch {
    process.stdout.write(`${JSON.stringify({
      event: 'temporary-registration-retry-health',
      beforeAttempt: nextAttempt,
      reachable: false,
      status: null,
    })}\n`)
    throw new Error(`registration retry ${nextAttempt} stopped because the same Worker health endpoint was unreachable`)
  }
  const reachable = healthStatus === 200
  process.stdout.write(`${JSON.stringify({
    event: 'temporary-registration-retry-health',
    beforeAttempt: nextAttempt,
    reachable,
    status: healthStatus,
  })}\n`)
  if (!reachable) {
    throw new Error(`registration retry ${nextAttempt} stopped because the same Worker health endpoint returned HTTP ${healthStatus}`)
  }
}

async function registerTemporaryAccount(username, password) {
  const retryDelaysMs = [1500, 3000]
  for (let attempt = 1; attempt <= retryDelaysMs.length + 1; attempt += 1) {
    const result = await request('/api/auth/register', {
      method: 'POST',
      body: { username, password },
    })
    const retryable = isWorkersDevScriptNotFound(result)
    const retryScheduled = retryable && attempt <= retryDelaysMs.length
    logRegistrationAttempt({ attempt, result, retryScheduled })
    if (result.status === 200) return result
    if (!retryable || !retryScheduled) {
      const errorCode = retryable ? '1042 workers_dev_script_not_found' : 'not retryable'
      throw new Error(`temporary account registration stopped after attempt ${attempt}: HTTP ${result.status} (${errorCode})`)
    }

    await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt - 1]))
    await verifyHealthBeforeRetry(attempt + 1)
  }
  throw new Error('temporary account registration exhausted its bounded retry attempts')
}

const runSuffix = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${randomBytes(3).toString('hex')}`
const username = `phase2_${runSuffix}`
const password = randomBytes(32).toString('base64url')
const registration = await registerTemporaryAccount(username, password)
const token = registration.body?.token
if (typeof token !== 'string' || !token) throw new Error('registration response did not include a session token')

const person = await request('/api/persons', {
  token,
  method: 'POST',
  body: {
    name: 'Temporary phase 2 acceptance resident',
    model: { identity: [{ text: 'A temporary acceptance fixture.', provenance: 'known' }] },
  },
})
requireStatus(person, 200, 'temporary person creation')
if (typeof person.body?.id !== 'string') throw new Error('person response did not include an ID')

const world = await request('/api/worlds', {
  token,
  method: 'POST',
  body: {
    name: `Phase 2 temporary acceptance ${runSuffix}`,
    description: 'An isolated, disposable world for the Phase 2 deployed Worker acceptance journey.',
    locations: ['North room', 'Garden', 'Workshop', 'Market', 'Station'].map(name => ({ name, description: 'Temporary acceptance location.' })),
    personIds: [person.body.id],
    timeZone: 'UTC',
  },
})
requireStatus(world, 200, 'temporary world creation')
const worldId = world.body?.id
const timelineId = world.body?.timelineId
if (typeof worldId !== 'string' || typeof timelineId !== 'string') throw new Error('world response did not include world and timeline IDs')
if (!/^[0-9a-f-]{36}$/i.test(worldId)) throw new Error('world ID failed the UUID check')

const removeResident = spawnSync('npx', [
  'wrangler', 'd1', 'execute', databaseName, '--remote', '--config', wranglerConfig,
  '--command', `DELETE FROM world_persons WHERE world_id = '${worldId}';`,
], { encoding: 'utf8' })
if (removeResident.status !== 0) {
  throw new Error(`could not isolate the temporary world from resident/model activity (${removeResident.status ?? 'signal'})`)
}

process.stdout.write(`::add-mask::${token}\n`)
appendFileSync(process.env.GITHUB_ENV, `DEPLOYMENT_TOKEN=${token}\nDEPLOYMENT_WORLD_ID=${worldId}\nDEPLOYMENT_TIMELINE_ID=${timelineId}\n`)
appendFileSync(process.env.GITHUB_ENV, `DEPLOYMENT_API_URL=${apiUrl}\n`)
appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `## Temporary Cloudflare acceptance bootstrap\n\nCreated a run-scoped test account, one static person, world, and main timeline on the newly created temporary Worker/D1. Registration/world/person API calls succeeded; the resident association was removed from this isolated test world to avoid model-provider calls during engine ticks. IDs: world \`${worldId}\`, timeline \`${timelineId}\`.\n`)
process.stdout.write(JSON.stringify({
  registrationStatus: registration.status,
  personStatus: person.status,
  worldStatus: world.status,
  worldId,
  timelineId,
  residentAssociationRemoved: true,
}, null, 2) + '\n')
