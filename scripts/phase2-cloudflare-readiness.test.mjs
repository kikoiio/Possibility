import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULTS, waitForWorkerReadiness } from './phase2-cloudflare-readiness.mjs'

function healthResponse(status, body, cfRay = null) {
  return {
    status,
    headers: { get: name => name.toLowerCase() === 'cf-ray' ? cfRay : null },
    text: async () => body === null ? '' : JSON.stringify(body),
  }
}

test('readiness requires three consecutive 200 ok responses and records safe fields', async () => {
  let clock = 1000
  const sequence = [
    healthResponse(200, { ok: true }, 'ray-a'),
    healthResponse(302, null, 'ray-redirect'),
    healthResponse(200, { ok: true }, 'ray-b'),
    healthResponse(200, { ok: true }, 'ray-c'),
    healthResponse(200, { ok: true }, 'ray-d'),
  ]
  const samples = []
  const requests = []
  const result = await waitForWorkerReadiness({
    apiUrl: 'https://temporary.example.workers.dev/',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return sequence.shift()
    },
    now: () => clock,
    sleep: async ms => { clock += ms },
    onSample: sample => samples.push(sample),
    intervalMs: DEFAULTS.intervalMs,
    timeoutMs: 20000,
  })

  assert.equal(result.attempts, 5)
  assert.equal(result.consecutiveHealthy, 3)
  assert.deepEqual(samples.map(sample => sample.consecutiveHealthy), [1, 0, 1, 2, 3])
  assert.equal(samples[0].cfRay, 'ray-a')
  assert.equal(requests[0].url, 'https://temporary.example.workers.dev/api/health')
  assert.equal(requests[0].options.method, 'GET')
  assert.equal(requests[0].options.redirect, 'manual')
})

test('readiness is bounded and times out without accepting ordinary 404 responses', async () => {
  let clock = 0
  let attempts = 0
  await assert.rejects(waitForWorkerReadiness({
    apiUrl: 'https://temporary.example.workers.dev',
    fetchImpl: async () => {
      attempts += 1
      return healthResponse(404, { error: 'not found' })
    },
    now: () => clock,
    sleep: async ms => { clock += ms },
    timeoutMs: 6500,
    intervalMs: 3000,
  }), /readiness timed out after 6500ms/)

  assert.equal(attempts, 3)
  assert.equal(clock, 6500)
})

test('readiness logs Cloudflare error code without exposing the response body', async () => {
  let clock = 0
  const samples = []
  await assert.rejects(waitForWorkerReadiness({
    apiUrl: 'https://temporary.example.workers.dev',
    fetchImpl: async () => healthResponse(404, {
      cloudflare_error: true,
      error_code: 1042,
      error_name: 'workers_dev_script_not_found',
      secretLikeValue: 'must-not-be-logged',
    }, 'ray-error'),
    now: () => clock,
    sleep: async ms => { clock += ms },
    onSample: sample => samples.push(sample),
    timeoutMs: 1,
  }), /readiness timed out/)

  assert.equal(samples[0].cloudflareErrorCode, 1042)
  assert.equal(samples[0].cfRay, 'ray-error')
  assert.equal(JSON.stringify(samples).includes('must-not-be-logged'), false)
})

test('readiness rejects URLs that could redirect the probe away from the Worker origin', async () => {
  let requests = 0
  const fetchImpl = async () => {
    requests += 1
    return healthResponse(200, { ok: true })
  }
  for (const apiUrl of [
    'http://temporary.example.workers.dev',
    'https://user:pass@temporary.example.workers.dev',
    'https://temporary.example.workers.dev/other-path',
    'https://temporary.example.workers.dev/?target=elsewhere',
  ]) {
    await assert.rejects(waitForWorkerReadiness({ apiUrl, fetchImpl }), /HTTPS API/)
  }
  await assert.rejects(waitForWorkerReadiness({
    apiUrl: 'https://temporary.example.workers.dev',
    fetchImpl,
    intervalMs: 0,
  }), /limits are invalid/)
  assert.equal(requests, 0)
})

test('workflow passes the API URL to readiness in the current step and preserves GITHUB_ENV', () => {
  const workflow = readFileSync(new URL('../.github/workflows/phase2-cloudflare-temporary-acceptance.yml', import.meta.url), 'utf8')
  assert.match(workflow, /echo "PHASE2_TEMP_API_URL=\$api_url" >> "\$GITHUB_ENV"/)
  assert.match(workflow, /PHASE2_TEMP_API_URL="\$api_url" node scripts\/phase2-cloudflare-readiness\.mjs/)
})
