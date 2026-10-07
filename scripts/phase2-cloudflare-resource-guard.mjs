const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const workerName = process.env.PHASE2_TEMP_WORKER_NAME
const databaseName = process.env.PHASE2_TEMP_DATABASE_NAME
const databaseId = process.env.PHASE2_TEMP_DATABASE_ID
const runId = process.env.GITHUB_RUN_ID
const attempt = process.env.GITHUB_RUN_ATTEMPT
const mode = process.argv[2]
const flagsPath = process.env.PHASE2_CLEANUP_FLAGS_PATH

if (!accountId || !apiToken || !workerName || !databaseName || !runId || !attempt) {
  throw new Error('Cloudflare resource ownership guard inputs are incomplete')
}
if (workerName !== `possibility-p2a-${runId}-${attempt}` || databaseName !== workerName) {
  throw new Error('Resource names are not the exact temporary names for this Actions run')
}

async function cloudflare(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
    headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success !== true) {
    const errorCodes = (body?.errors ?? []).map(error => error.code)
    throw new Error(`Cloudflare ownership lookup failed (${response.status}; error codes ${errorCodes.join(',') || 'unavailable'})`)
  }
  return body.result
}

const scripts = await cloudflare('/workers/scripts')
const databases = await cloudflare(`/d1/database?name=${encodeURIComponent(databaseName)}&per_page=10000`)
const script = Array.isArray(scripts) ? scripts.find(item => item.id === workerName) : null
const db = Array.isArray(databases) ? databases.find(item => item.name === databaseName) : null

if (mode === 'before-create') {
  const found = { worker: Boolean(script), d1: Boolean(db) }
  if (script || db) throw new Error(`Run-scoped Cloudflare names already exist; refusing to overwrite: ${JSON.stringify(found)}`)
  process.stdout.write(`${JSON.stringify({ mode, runId, attempt, preexistingMatches: found }, null, 2)}\n`)
  process.exit(0)
}

if (mode !== 'before-cleanup') throw new Error('Mode must be before-create or before-cleanup')
const isRunScoped = workerName === `possibility-p2a-${runId}-${attempt}`
const workerDeleteVerified = isRunScoped && process.env.PHASE2_TEMP_WORKER_DEPLOYED === 'true'
  && process.env.PHASE2_TEMP_WORKER_MARKER_VERIFIED === 'true'
  && script?.id === workerName
const d1DeleteVerified = isRunScoped && process.env.PHASE2_TEMP_DATABASE_CREATED === 'true'
  && typeof databaseId === 'string' && db?.name === databaseName && db?.uuid === databaseId

if (process.env.PHASE2_TEMP_WORKER_DEPLOYED === 'true' && script && script.id !== workerName) {
  throw new Error('Worker name lookup did not match the exact run-scoped script; refusing deletion')
}
if (process.env.PHASE2_TEMP_DATABASE_CREATED === 'true' && db && !d1DeleteVerified) {
  throw new Error('D1 name/UUID does not match the resource created by this run; refusing deletion')
}

if (flagsPath) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(flagsPath,
    `PHASE2_TEMP_WORKER_DELETE_VERIFIED=${workerDeleteVerified}\nPHASE2_TEMP_D1_DELETE_VERIFIED=${d1DeleteVerified}\n`)
}
if (process.env.GITHUB_ENV) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_ENV,
    `PHASE2_TEMP_WORKER_DELETE_VERIFIED=${workerDeleteVerified}\nPHASE2_TEMP_D1_DELETE_VERIFIED=${d1DeleteVerified}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Temporary Cloudflare cleanup ownership check\n\nRun ID/attempt: \`${runId}/${attempt}\`. Worker exact-name match: \`${script?.id === workerName}\`; D1 exact-name and created UUID match: \`${db?.name === databaseName && db?.uuid === databaseId}\`. Only verified resources are passed to deletion.\n`)
}
process.stdout.write(JSON.stringify({
  mode,
  runId,
  attempt,
  workerName,
  workerDeploySucceeded: process.env.PHASE2_TEMP_WORKER_DEPLOYED === 'true',
  workerMarkerVerified: process.env.PHASE2_TEMP_WORKER_MARKER_VERIFIED === 'true',
  workerPresent: Boolean(script),
  workerDeleteVerified,
  databaseName,
  d1CreateReturnedCapturedId: process.env.PHASE2_TEMP_DATABASE_CREATED === 'true',
  databaseIdMatched: Boolean(db && db.name === databaseName && db.uuid === databaseId),
  d1DeleteVerified,
}, null, 2) + '\n')
