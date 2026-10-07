import { appendFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULTS = Object.freeze({
  consecutiveHealthyRequired: 3,
  intervalMs: 3000,
  timeoutMs: 60000,
  requestTimeoutMs: 5000,
})

function parseJson(text) {
  try { return text ? JSON.parse(text) : null } catch { return null }
}

function cloudflareErrorCode(body) {
  if (body?.cloudflare_error !== true) return null
  const code = body.error_code ?? body.errors?.[0]?.code
  return typeof code === 'number' || typeof code === 'string' ? code : null
}

export async function waitForWorkerReadiness({
  apiUrl,
  fetchImpl = fetch,
  now = () => performance.now(),
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  onSample = () => {},
  consecutiveHealthyRequired = DEFAULTS.consecutiveHealthyRequired,
  intervalMs = DEFAULTS.intervalMs,
  timeoutMs = DEFAULTS.timeoutMs,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
} = {}) {
  let baseUrl
  try {
    baseUrl = new URL(apiUrl)
  } catch {
    throw new Error('Temporary Worker readiness requires a valid HTTPS API origin')
  }
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password
    || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
    throw new Error('Temporary Worker readiness requires an HTTPS API URL')
  }
  if (!Number.isInteger(consecutiveHealthyRequired) || consecutiveHealthyRequired < 1
    || !Number.isFinite(intervalMs) || intervalMs < 1000
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Temporary Worker readiness limits are invalid')
  }

  const healthUrl = new URL('/api/health', baseUrl).toString()
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  let consecutiveHealthy = 0
  let attempts = 0
  let lastSample = null

  while (now() < deadline) {
    const remainingMs = deadline - now()
    if (remainingMs <= 0) break
    attempts += 1

    let status = null
    let jsonOk = false
    let errorCode = null
    let cfRay = null
    let transportError = null
    try {
      const response = await fetchImpl(healthUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs))),
      })
      status = response.status
      cfRay = response.headers?.get?.('cf-ray') ?? null
      const body = parseJson(await response.text())
      jsonOk = body !== null && typeof body === 'object' && !Array.isArray(body) && body.ok === true
      errorCode = cloudflareErrorCode(body)
    } catch (error) {
      transportError = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network-error'
    }

    consecutiveHealthy = status === 200 && jsonOk ? consecutiveHealthy + 1 : 0
    lastSample = {
      attempt: attempts,
      httpStatus: status,
      jsonOk,
      cloudflareErrorCode: errorCode,
      cfRay,
      transportError,
      consecutiveHealthy,
    }
    onSample({ event: 'temporary-worker-readiness-sample', ...lastSample })

    if (consecutiveHealthy >= consecutiveHealthyRequired) {
      return {
        attempts,
        consecutiveHealthy,
        elapsedMs: now() - startedAt,
        healthUrl,
      }
    }

    const waitMs = Math.min(intervalMs, Math.max(0, deadline - now()))
    if (waitMs > 0) await sleep(waitMs)
  }

  throw new Error(`Temporary Worker readiness timed out after ${timeoutMs}ms; required ${consecutiveHealthyRequired} consecutive HTTP 200 JSON {ok:true} samples; last sample: ${JSON.stringify(lastSample)}`)
}

async function main() {
  const apiUrl = process.env.PHASE2_TEMP_API_URL
  if (!apiUrl) throw new Error('PHASE2_TEMP_API_URL is required for temporary Worker readiness')
  const evidencePath = process.env.PHASE2_READINESS_EVIDENCE_PATH
  const record = event => {
    const line = `${JSON.stringify(event)}\n`
    process.stdout.write(line)
    if (evidencePath) appendFileSync(evidencePath, line)
  }
  const result = await waitForWorkerReadiness({
    apiUrl,
    onSample: record,
  })
  record({ event: 'temporary-worker-readiness-passed', ...result })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}

export { DEFAULTS }
