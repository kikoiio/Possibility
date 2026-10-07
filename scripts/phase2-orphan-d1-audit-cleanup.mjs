import { appendFileSync } from 'node:fs'

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN
const targetName = 'possibility-p2a-37569677434-1'
const observedUuid = process.env.PHASE2_ORPHAN_OBSERVED_UUID ?? ''
const mode = process.argv[2]

if (!accountId || !apiToken) throw new Error('Cloudflare audit inputs are incomplete')
if (!['audit', 'cleanup'].includes(mode)) throw new Error('Mode must be audit or cleanup')

async function request(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success !== true) {
    const codes = (body?.errors ?? []).map(error => error.code)
    throw new Error(`Cloudflare D1 request failed (${response.status}; error codes ${codes.join(',') || 'unavailable'})`)
  }
  return body
}

async function findTarget() {
  const query = new URLSearchParams({ name: targetName, per_page: '100' })
  const body = await request(`/d1/database?${query}`)
  const records = Array.isArray(body.result) ? body.result : []
  return records
    .filter(item => item?.name === targetName)
    .map(item => ({ name: item.name, uuid: item.uuid ?? item.id, created_at: item.created_at }))
}

function report(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## Orphan D1 audit / cleanup',
      '',
      `- Mode: \`${result.mode}\``,
      `- Exact D1 name: \`${targetName}\``,
      `- Result: \`${result.result}\``,
    ]
    if (result.uuid) lines.push(`- UUID: \`${result.uuid}\``)
    if (result.created_at) lines.push(`- Created at: \`${result.created_at}\``)
    for (const match of result.matches ?? []) {
      lines.push(`- Match: UUID \`${match.uuid}\`; created at \`${match.created_at ?? 'unknown'}\``)
    }
    if (result.mode === 'audit' && result.matches?.length === 0) lines.push('- Exact-name matches: `0`')
    if (result.preDeleteMatches !== undefined) lines.push(`- Exact name + UUID matched before delete: \`${result.preDeleteMatches}\``)
    if (result.postDeleteMatches !== undefined) lines.push(`- Exact-name matches after delete: \`${result.postDeleteMatches}\``)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
}

if (mode === 'audit') {
  const matches = await findTarget()
  report({
    mode,
    result: matches.length === 0 ? 'absent' : matches.length === 1 ? 'one-match' : 'ambiguous-multiple-matches',
    name: targetName,
    matches,
  })
  if (matches.length > 1) process.exitCode = 1
} else {
  if (!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(observedUuid)) {
    throw new Error('Cleanup requires the UUID returned by a reviewed audit dispatch')
  }
  if (process.env.PHASE2_ORPHAN_RUN_EVIDENCE_VERIFIED !== 'true') {
    throw new Error('Historical run evidence was not verified; refusing cleanup')
  }

  const before = await findTarget()
  const matches = before.filter(item => item.uuid?.toLowerCase() === observedUuid.toLowerCase())
  if (before.length !== 1 || matches.length !== 1) {
    throw new Error(`Cleanup refused: exact name/UUID match count is ${matches.length}; exact-name resource count is ${before.length}`)
  }
  const target = matches[0]
  if (target.name !== targetName || target.uuid.toLowerCase() !== observedUuid.toLowerCase()) {
    throw new Error('Cleanup refused: exact name and UUID did not both match')
  }

  await request(`/d1/database/${encodeURIComponent(target.uuid)}`, { method: 'DELETE' })
  const after = await findTarget()
  if (after.length !== 0) {
    throw new Error(`D1 delete returned success but ${after.length} exact-name match(es) remain`)
  }
  report({
    mode,
    result: 'deleted-and-verified-absent',
    name: targetName,
    uuid: target.uuid,
    created_at: target.created_at,
    preDeleteMatches: matches.length,
    postDeleteMatches: after.length,
  })
}
