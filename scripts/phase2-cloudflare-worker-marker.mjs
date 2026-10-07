import { appendFileSync } from 'node:fs'

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const workerName = process.env.PHASE2_TEMP_WORKER_NAME
const runId = process.env.GITHUB_RUN_ID
const attempt = process.env.GITHUB_RUN_ATTEMPT
const mode = process.argv[2]

if (!accountId || !apiToken || !workerName || !runId || !attempt
  || workerName !== `possibility-p2a-${runId}-${attempt}`) {
  throw new Error('Temporary Worker marker inputs do not match this Actions run')
}

const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/script-settings`
const tags = [`phase2-acceptance-run:${runId}`, `phase2-acceptance-attempt:${attempt}`]
const response = await fetch(url, {
  method: mode === 'set' ? 'PATCH' : 'GET',
  headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json', 'content-type': 'application/json' },
  ...(mode === 'set' ? { body: JSON.stringify({ tags }) } : {}),
})
const result = await response.json().catch(() => null)
if (!response.ok || result?.success !== true) {
  const codes = (result?.errors ?? []).map(error => error.code)
  throw new Error(`Temporary Worker ownership marker ${mode} failed (${response.status}; error codes ${codes.join(',') || 'unavailable'})`)
}
const currentTags = result?.result?.tags ?? []
const markerMatches = tags.every(tag => currentTags.includes(tag))
if (!markerMatches) throw new Error('Temporary Worker ownership marker does not match this run')

if (mode === 'set') {
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, 'PHASE2_TEMP_WORKER_MARKER_SET=true\n')
} else if (mode !== 'verify') {
  throw new Error('Mode must be set or verify')
}
process.stdout.write(JSON.stringify({ mode, workerName, runId, attempt, ownershipTagsVerified: markerMatches }) + '\n')
