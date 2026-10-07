const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const workerName = process.env.PHASE2_TEMP_WORKER_NAME
const databaseName = process.env.PHASE2_TEMP_DATABASE_NAME
const databaseId = process.env.PHASE2_TEMP_DATABASE_ID
const runId = process.env.GITHUB_RUN_ID
const attempt = process.env.GITHUB_RUN_ATTEMPT
const mode = process.argv[2]
const flagsPath = process.env.PHASE2_CLEANUP_FLAGS_PATH
const evidencePath = process.env.PHASE2_CLEANUP_EVIDENCE_PATH

if (!accountId || !apiToken || !workerName || !databaseName || !runId || !attempt) {
  throw new Error('Cloudflare resource ownership guard inputs are incomplete')
}
if (workerName !== `possibility-p2a-${runId}-${attempt}` || databaseName !== workerName) {
  throw new Error('Resource names are not the exact temporary names for this Actions run')
}
if (!['before-create', 'before-cleanup', 'after-cleanup'].includes(mode)) {
  throw new Error('Mode must be before-create, before-cleanup, or after-cleanup')
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

async function workerExistsByExactName(name) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' } },
  )
  // This exact-name endpoint returns raw script content. Do not read or log it.
  if (response.body) await response.body.cancel().catch(() => {})
  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(`Cloudflare exact Worker lookup failed (${response.status})`)
  }
  return true
}

async function databasesByExactName(name) {
  const query = new URLSearchParams({ name, per_page: '10000' })
  const result = await cloudflare(`/d1/database?${query}`)
  if (!Array.isArray(result)) throw new Error('Cloudflare D1 exact-name lookup returned a malformed result')
  return result.filter(item => item?.name === name)
}

const workerPresent = await workerExistsByExactName(workerName)
const exactDatabases = await databasesByExactName(databaseName)
const db = exactDatabases.length === 1 ? exactDatabases[0] : null

if (mode === 'before-create') {
  const found = { worker: workerPresent, d1: exactDatabases.length > 0 }
  if (workerPresent || exactDatabases.length > 0) {
    throw new Error(`Run-scoped Cloudflare names already exist; refusing to overwrite: ${JSON.stringify(found)}`)
  }
  process.stdout.write(`${JSON.stringify({ mode, runId, attempt, preexistingMatches: found }, null, 2)}\n`)
  process.exit(0)
}

const isRunScoped = workerName === `possibility-p2a-${runId}-${attempt}`
const workerDeleteVerified = isRunScoped && process.env.PHASE2_TEMP_WORKER_DEPLOYED === 'true'
  && process.env.PHASE2_TEMP_WORKER_MARKER_VERIFIED === 'true'
  && workerPresent
const d1DeleteVerified = isRunScoped && process.env.PHASE2_TEMP_DATABASE_CREATED === 'true'
  && typeof databaseId === 'string' && exactDatabases.length === 1
  && db?.name === databaseName && db?.uuid === databaseId

if (mode === 'before-cleanup' && process.env.PHASE2_TEMP_DATABASE_CREATED === 'true'
  && exactDatabases.length > 0 && !d1DeleteVerified) {
  throw new Error('D1 exact-name/UUID lookup did not match the resource created by this run; refusing deletion')
}

if (mode === 'before-cleanup' && flagsPath) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(flagsPath,
    `PHASE2_TEMP_WORKER_DELETE_VERIFIED=${workerDeleteVerified}\nPHASE2_TEMP_D1_DELETE_VERIFIED=${d1DeleteVerified}\nPHASE2_TEMP_WORKER_PRESENT=${workerPresent}\nPHASE2_TEMP_D1_PRESENT=${exactDatabases.length > 0}\n`)
}
if (mode === 'before-cleanup' && process.env.GITHUB_ENV) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_ENV,
    `PHASE2_TEMP_WORKER_DELETE_VERIFIED=${workerDeleteVerified}\nPHASE2_TEMP_D1_DELETE_VERIFIED=${d1DeleteVerified}\nPHASE2_TEMP_WORKER_PRESENT=${workerPresent}\nPHASE2_TEMP_D1_PRESENT=${exactDatabases.length > 0}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Temporary Cloudflare cleanup ownership check\n\nRun ID/attempt: \`${runId}/${attempt}\`. Exact Worker name exists: \`${workerPresent}\`; exact D1 name and captured UUID match: \`${exactDatabases.length === 1 && db?.uuid === databaseId}\`. Only verified resources are passed to deletion.\n`)
}

if (mode === 'after-cleanup') {
  const workerMatches = workerPresent ? 1 : 0
  const d1Matches = exactDatabases.length
  const verifiedAbsent = workerMatches === 0 && d1Matches === 0
  const result = {
    mode,
    runId,
    attempt,
    workerExactNameMatches: workerMatches,
    d1ExactNameMatches: d1Matches,
    result: verifiedAbsent ? 'verified-absent' : 'resources-remain',
  }
  const { writeFileSync } = await import('node:fs')
  if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`)
  if (flagsPath) {
    writeFileSync(flagsPath,
      `PHASE2_TEMP_WORKER_POST_DELETE_MATCHES=${workerMatches}\nPHASE2_TEMP_D1_POST_DELETE_MATCHES=${d1Matches}\nPHASE2_TEMP_CLEANUP_VERIFIED_ABSENT=${verifiedAbsent}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Temporary Cloudflare post-delete verification\n\nRun ID/attempt: \`${runId}/${attempt}\`. Exact Worker matches: \`${workerMatches}\`; exact D1 matches: \`${d1Matches}\`; result: \`${result.result}\`.\n`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = verifiedAbsent ? 0 : 1
}

if (mode === 'before-cleanup') {
  process.stdout.write(JSON.stringify({
    mode,
    runId,
    attempt,
    workerName,
    workerDeploySucceeded: process.env.PHASE2_TEMP_WORKER_DEPLOYED === 'true',
    workerMarkerVerified: process.env.PHASE2_TEMP_WORKER_MARKER_VERIFIED === 'true',
    workerPresent,
    workerDeleteVerified,
    databaseName,
    d1CreateReturnedCapturedId: process.env.PHASE2_TEMP_DATABASE_CREATED === 'true',
    databaseIdMatched: Boolean(db && db.name === databaseName && db.uuid === databaseId),
    d1DeleteVerified,
  }, null, 2) + '\n')
}
