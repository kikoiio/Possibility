const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const workerName = process.env.PHASE2_TEMP_WORKER_NAME
const runId = process.env.GITHUB_RUN_ID
const attempt = process.env.GITHUB_RUN_ATTEMPT

if (!accountId || !apiToken || !workerName || !runId || !attempt) {
  throw new Error('Temporary Worker deletion inputs are incomplete')
}
if (workerName !== `possibility-p2a-${runId}-${attempt}`) {
  throw new Error('Refusing Worker deletion because the name is not this run exact name')
}
if (process.env.PHASE2_TEMP_WORKER_DEPLOYED !== 'true'
  || process.env.PHASE2_TEMP_WORKER_MARKER_VERIFIED !== 'true'
  || process.env.PHASE2_TEMP_WORKER_DELETE_VERIFIED !== 'true') {
  throw new Error('Refusing Worker deletion because deploy, marker, or before-cleanup guard was not verified')
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`
const response = await fetch(endpoint, {
  method: 'DELETE',
  headers: {
    authorization: `Bearer ${apiToken}`,
    accept: 'application/json',
  },
})
const text = await response.text()
let body = null
let parsedJson = false
if (text) {
  try {
    body = JSON.parse(text)
    parsedJson = true
  } catch {
    throw new Error(`Cloudflare Worker delete returned HTTP ${response.status} with a non-JSON response`)
  }
}

const successfulStatus = response.status === 200 || response.status === 204
const successfulBody = text.length === 0
  || (response.status === 200 && parsedJson && body?.success === true
    && (!Array.isArray(body.errors) || body.errors.length === 0))
if (!successfulStatus || !successfulBody) {
  const errorCodes = Array.isArray(body?.errors)
    ? body.errors.map(error => error?.code).filter(code => Number.isInteger(code))
    : []
  throw new Error(`Cloudflare exact-name Worker delete failed (HTTP ${response.status}; error codes ${errorCodes.join(',') || 'none'})`)
}

process.stdout.write(`${JSON.stringify({
  mode: 'delete-worker',
  runId,
  attempt,
  workerName,
  httpStatus: response.status,
  responseBody: text.length === 0 ? 'empty-success' : 'success-true',
  result: 'deleted',
})}\n`)
