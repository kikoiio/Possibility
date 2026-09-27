import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedSql } from './verify-s01-workers.ts'

const root = resolve(new URL('..', import.meta.url).pathname)
const config = process.env.S01_REMOTE_D1_CONFIG
const expectedDatabaseId = process.env.S01_REMOTE_D1_ID
const workerPorts = [8787, 8788]
const runId = Date.now().toString(36)
const loadForkIds = Array.from({ length: 24 }, (_, index) => `s01-remote-${runId}-load-${String(index).padStart(2, '0')}`)
const forkIds = [`s01-remote-${runId}-baseline`, `s01-remote-${runId}-fork-a`, `s01-remote-${runId}-fork-b`, ...loadForkIds]
const forkIdsSql = forkIds.map(id => `'${id}'`).join(',')
const auth = 's01-local-worker-session'
const secret = 's01-remote-acceptance-secret'
const classifyToken = 's01-remote-classification-token'
const providerName = `possibility-s01-llm-${Date.now().toString(36)}`
const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
const temp = await mkdtemp(join(tmpdir(), 's01-remote-workers-'))
const children: ChildProcess[] = []
let safeTarget = false
let providerDeployed = false
let providerConfig: string | null = null
let remoteWorkerConfig: string | null = null
let providerBaseUrl = ''

function run(args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(wrangler, args, { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('error', rejectRun)
    child.once('close', code => code === 0 ? resolveRun(output) : rejectRun(new Error(`wrangler exited ${code}: ${output}`)))
  })
}

function startWorker(index: number): ChildProcess {
  const port = workerPorts[index]!
  const child = spawn(wrangler, [
    'dev', '--remote', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 10_000),
    '--name', `possibility-s01-remote-check-${index + 1}`, '--log-level', 'error', '--config', remoteWorkerConfig!,
    '--var', `ENGINE_TICK_SECRET:${secret}`, '--var', 'LLM_API_KEY:s01-unused', '--var', 'LLM_MODEL:s01-fixture',
    '--var', `LLM_BASE_URL:${providerBaseUrl}/v1`,
    '--var', 'DIRECTOR_LLM:0', '--var', 'WORLD_SPEED:360',
  ], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => process.stdout.write(String(chunk)))
  child.stderr.on('data', chunk => process.stderr.write(String(chunk)))
  children.push(child)
  return child
}

async function waitReady(child: ChildProcess, port: number) {
  const end = Date.now() + 90_000
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`remote Worker ${port} exited before ready (${child.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok && (await response.json() as { ok?: boolean }).ok) return
    } catch { /* remote worker is still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`remote Worker ${port} did not become ready`)
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise<void>(r => child.once('exit', () => r())), new Promise<void>(r => setTimeout(() => { child.kill('SIGKILL'); r() }, 10_000))])
}

async function classifyLegacyRoot(databaseName: string, databaseId: string, accountId: string) {
  const port = 8792
  const workerConfig = join(temp, 'classify-worker.toml')
  await writeFile(workerConfig, [
    'name = "possibility-s01-classifier"',
    `main = "${resolve(root, 'scripts/fixtures/s01-classify-universe.ts')}"`,
    'compatibility_date = "2025-01-01"',
    `account_id = "${accountId}"`,
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = "${databaseName}"`,
    `database_id = "${databaseId}"`,
    '',
  ].join('\n'), 'utf8')
  const child = spawn(wrangler, [
    'dev', '--remote', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 10_000),
    '--log-level', 'error', '--config', workerConfig, '--var', `S01_CLASSIFY_TOKEN:${classifyToken}`,
  ], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', chunk => { logs += String(chunk) })
  child.stderr.on('data', chunk => { logs += String(chunk) })
  children.push(child)
  const end = Date.now() + 90_000
  let response: Response | undefined
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`classification Worker exited (${child.exitCode}): ${logs}`)
    try {
      response = await fetch(`http://127.0.0.1:${port}/classify`, {
        method: 'POST', headers: { authorization: `Bearer ${classifyToken}` },
      })
      if (response.status !== 404) break
    } catch { /* remote classifier is still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  if (!response || response.status === 404) throw new Error(`classification Worker did not become ready: ${logs}`)
  const body = await response.text()
  if (!response.ok) throw new Error(`Legacy root classification failed (${response.status}): ${body}`)
  const result = JSON.parse(body) as { level?: string; assessedVersion?: number | null; baselineVersion?: number | null; reasonCodes?: string[]; upgraded?: boolean }
  if (result.level !== 'complete') throw new Error(`Staging root cannot be safely upgraded from immutable evidence: ${JSON.stringify(result)}`)
  return result
}

function rows(output: string): Record<string, unknown>[] {
  const start = output.indexOf('[')
  if (start < 0) throw new Error(`Could not parse D1 JSON result: ${output}`)
  const value = JSON.parse(output.slice(start)) as { results?: Record<string, unknown>[] }[]
  return value.flatMap(item => item.results ?? [])
}

async function main() {
  if (!config || !expectedDatabaseId) throw new Error('Set S01_REMOTE_D1_CONFIG and S01_REMOTE_D1_ID explicitly.')
  const configText = await (await import('node:fs/promises')).readFile(resolve(root, config), 'utf8')
  if (!configText.includes(`database_id = "${expectedDatabaseId}"`)) throw new Error('Config database_id does not match S01_REMOTE_D1_ID.')
  const databaseName = configText.match(/database_name\s*=\s*"([^"]+)"/)?.[1] ?? ''
  const databaseId = configText.match(/database_id\s*=\s*"([^"]+)"/)?.[1] ?? ''
  const accountId = configText.match(/account_id\s*=\s*"([^"]+)"/)?.[1] ?? ''
  if (!/(test|staging|acceptance)/i.test(databaseName)) throw new Error(`Refusing remote Worker test on non-test database name: ${databaseName}`)
  safeTarget = true
  const before = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    "SELECT (SELECT COUNT(*) FROM worlds) AS worlds, (SELECT COUNT(*) FROM d1_migrations) AS migrations, (SELECT COUNT(*) FROM timelines WHERE id='s01-main') AS root"]))[0]
  if (!before || Number(before.migrations) !== 22 || Number(before.worlds) > 1 || (Number(before.worlds) === 1 && Number(before.root) !== 1)) {
    throw new Error(`Refusing to seed unless this is the dedicated empty acceptance D1 or its single S01 fixture: ${JSON.stringify(before)}`)
  }
  if (Number(before.worlds) === 0) {
    const seedPath = join(temp, 'seed.sql')
    await writeFile(seedPath, seedSql(), 'utf8')
    await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--file', seedPath])
  }
  const evidenceRows = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    "SELECT e.level FROM universe_evidence e JOIN timelines t ON t.id=e.timeline_id WHERE t.id='s01-main' AND t.world_id='s01-world'"]))
  let evidenceReview: Record<string, unknown> = { level: evidenceRows[0]?.level ?? 'missing', upgraded: false }
  if (evidenceReview.level !== 'complete') {
    if (!databaseId || !accountId) throw new Error('Remote classifier requires account_id and database_id in the staging config.')
    evidenceReview = await classifyLegacyRoot(databaseName, databaseId, accountId)
  }
  const leaseNow = Date.now()
  const leaseUntil = leaseNow + 180_000
  const claim = (owner: string) => run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    `INSERT INTO engine_tick_leases (id, owner_token, lease_until, updated_at) VALUES ('autonomous-world-tick', '${owner}', ${leaseUntil}, ${leaseNow}) ON CONFLICT(id) DO UPDATE SET owner_token='${owner}', lease_until=${leaseUntil}, updated_at=${leaseNow} WHERE engine_tick_leases.lease_until <= ${leaseNow} RETURNING owner_token`])
  const leaseClaims = await Promise.all([claim('s01-remote-lease-a'), claim('s01-remote-lease-b')])
  const leaseWinners = leaseClaims.flatMap(result => rows(result).map(row => String(row.owner_token)))
  if (leaseWinners.length !== 1) throw new Error(`Expected exactly one Cloudflare D1 lease owner, got ${JSON.stringify(leaseWinners)}`)
  const leaseAudit = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    "SELECT owner_token FROM engine_tick_leases WHERE id='autonomous-world-tick'"]))[0]
  if (leaseAudit?.owner_token !== leaseWinners[0]) throw new Error(`Cloudflare D1 lease owner mismatch: ${JSON.stringify({ leaseWinners, leaseAudit })}`)
  await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--command',
    "DELETE FROM engine_tick_leases WHERE id='autonomous-world-tick' AND owner_token IN ('s01-remote-lease-a','s01-remote-lease-b')"])
  if (!accountId) throw new Error('Staging config must include account_id for the temporary deterministic chat provider.')
  providerConfig = join(temp, 'chat-provider.toml')
  await writeFile(providerConfig, [
    `name = "${providerName}"`,
    `main = "${resolve(root, 'scripts/fixtures/s01-llm-provider.ts')}"`,
    'compatibility_date = "2025-01-01"',
    `account_id = "${accountId}"`,
    'workers_dev = true',
    '',
  ].join('\n'), 'utf8')
  providerDeployed = true
  const providerDeploy = await run(['deploy', '--config', providerConfig, '--name', providerName])
  providerBaseUrl = providerDeploy.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] ?? ''
  if (!providerBaseUrl) throw new Error('Could not identify the temporary deterministic chat provider URL.')
  let providerReady = false
  let providerLastStatus = 'unreachable'
  const providerDeadline = Date.now() + 30_000
  while (Date.now() < providerDeadline) {
    try {
      const probe = await fetch(`${providerBaseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      providerLastStatus = String(probe.status)
      if (probe.ok) { await probe.arrayBuffer(); providerReady = true; break }
    } catch { /* wait for deployment propagation */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
  }
  if (!providerReady) throw new Error(`Temporary deterministic provider did not return HTTP 200 from its expected endpoint (last status ${providerLastStatus}).`)
  remoteWorkerConfig = join(temp, 'remote-api.toml')
  await writeFile(remoteWorkerConfig, [
    'name = "possibility-s01-remote-api-check"',
    `main = "${resolve(root, 'api/src/index.ts')}"`,
    'compatibility_date = "2025-01-01"',
    `account_id = "${accountId}"`,
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = "${databaseName}"`,
    `database_id = "${databaseId}"`,
    `migrations_dir = "${resolve(root, 'api/drizzle')}"`,
    '',
    '[[services]]',
    'binding = "LLM_PROVIDER"',
    `service = "${providerName}"`,
    '',
    '[vars]',
    'ENVIRONMENT = "local"',
    '',
  ].join('\n'), 'utf8')

  const workers = workerPorts.map((_, index) => startWorker(index))
  await Promise.all(workers.map((worker, index) => waitReady(worker, workerPorts[index]!)))
  for (const port of workerPorts) {
    const response = await fetch(`http://127.0.0.1:${port}/api/worlds`, { headers: { Authorization: `Bearer ${auth}` } })
    if (!response.ok) throw new Error(`remote Worker ${port} rejected seeded owner session: ${response.status}`)
  }
  const convoResponse = await fetch(`http://127.0.0.1:${workerPorts[0]}/api/persons/s01-resident/conversations`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timelineId: 's01-main' }),
  })
  if (!convoResponse.ok) throw new Error(`Could not create remote chat conversation: ${convoResponse.status} ${await convoResponse.text()}`)
  const convo = await convoResponse.json() as { id?: string }
  if (!convo.id) throw new Error('Remote chat conversation omitted its id.')
  const chatRequestId = `s01-remote-chat-${runId}`
  const chatContent = 'S01 remote chat delayed cross-worker recovery'
  const sendChat = (port: number, content = chatContent) => fetch(
    `http://127.0.0.1:${port}/api/conversations/${convo.id}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content, requestId: chatRequestId }),
    })
  const originalChat = await sendChat(workerPorts[0]!)
  if (!originalChat.ok) throw new Error(`Remote chat did not open: ${originalChat.status} ${await originalChat.text()}`)
  const pendingReplay = await sendChat(workerPorts[1]!)
  const pendingBody = await pendingReplay.text()
  if (!pendingReplay.ok || !pendingBody.includes('"type":"pending"')) {
    throw new Error(`Cross-Worker remote pending chat replay failed: ${pendingReplay.status} ${pendingBody.slice(0, 500)}`)
  }
  const originalBody = await originalChat.text()
  if (!originalBody.includes('确定性回复')) throw new Error('Remote original chat did not stream the deterministic reply.')
  const completedReplay = await sendChat(workerPorts[1]!)
  const completedBody = await completedReplay.text()
  const chatConflict = await sendChat(workerPorts[1]!, 'Remote payload conflict must not call the model')
  const chatAudit = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    `SELECT (SELECT status FROM chat_requests WHERE request_id='${chatRequestId}') AS status,
      (SELECT COUNT(*) FROM messages WHERE id=(SELECT user_message_id FROM chat_requests WHERE request_id='${chatRequestId}') AND role='user') AS users,
      (SELECT COUNT(*) FROM messages WHERE id=(SELECT reply_message_id FROM chat_requests WHERE request_id='${chatRequestId}') AND role='person') AS replies,
      (SELECT COUNT(*) FROM llm_call_log WHERE request_id='${chatRequestId}') AS receipts`]))[0]
  if (!completedReplay.ok || !completedBody.includes('"replayed":true') || chatConflict.status !== 409
    || chatAudit?.status !== 'completed' || Number(chatAudit.users) !== 1 || Number(chatAudit.replies) !== 1
    || Number(chatAudit.receipts) !== 1) {
    throw new Error(`Remote cross-Worker chat left duplicate or incomplete records: ${JSON.stringify({ replay: completedReplay.status, conflict: chatConflict.status, chatAudit })}`)
  }
  const lockNow = Date.now()
  await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--command',
    `INSERT INTO engine_tick_leases (id, owner_token, lease_until, updated_at) VALUES ('autonomous-world-tick', 's01-remote-held-lease', ${lockNow + 180_000}, ${lockNow})`])
  const tickBefore = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    "SELECT (SELECT version FROM universe_revisions WHERE timeline_id='s01-main') AS revision, (SELECT COUNT(*) FROM world_facts WHERE timeline_id='s01-main' AND fact_type='clock') AS clocks"]))[0]
  const tickResponses = await Promise.all(workerPorts.map(port => fetch(`http://127.0.0.1:${port}/api/engine/tick`, {
    method: 'POST', headers: { 'x-engine-secret': secret },
  })))
  const tickStatuses = tickResponses.map(response => response.status)
  const tickAfter = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    "SELECT (SELECT version FROM universe_revisions WHERE timeline_id='s01-main') AS revision, (SELECT COUNT(*) FROM world_facts WHERE timeline_id='s01-main' AND fact_type='clock') AS clocks, (SELECT owner_token FROM engine_tick_leases WHERE id='autonomous-world-tick') AS owner"]))[0]
  if (tickStatuses.some(status => status !== 409) || tickBefore?.revision !== tickAfter?.revision
    || tickBefore?.clocks !== tickAfter?.clocks || tickAfter?.owner !== 's01-remote-held-lease') {
    throw new Error(`Remote Workers ignored held D1 tick lease or changed world state: ${JSON.stringify({ tickStatuses, tickBefore, tickAfter })}`)
  }
  await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--command',
    "DELETE FROM engine_tick_leases WHERE id='autonomous-world-tick' AND owner_token='s01-remote-held-lease'"])

  const staleLeaseNow = Date.now()
  await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--command',
    `INSERT INTO engine_tick_leases (id, owner_token, lease_until, updated_at) VALUES ('autonomous-world-tick', 's01-crashed-worker', ${staleLeaseNow - 1}, ${staleLeaseNow - 180_001})`])
  const takeoverBefore = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    "SELECT (SELECT version FROM universe_revisions WHERE timeline_id='s01-main') AS revision, (SELECT COUNT(*) FROM world_facts WHERE timeline_id='s01-main' AND fact_type='clock') AS clocks"]))[0]
  const takeoverTicks = await Promise.all(workerPorts.map(port => fetch(`http://127.0.0.1:${port}/api/engine/tick`, {
    method: 'POST', headers: { 'x-engine-secret': secret },
  })))
  const takeoverStatuses = takeoverTicks.map(response => response.status)
  const takeoverAfter = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    "SELECT (SELECT version FROM universe_revisions WHERE timeline_id='s01-main') AS revision, (SELECT COUNT(*) FROM world_facts WHERE timeline_id='s01-main' AND fact_type='clock') AS clocks, (SELECT COUNT(*) FROM engine_tick_leases WHERE id='autonomous-world-tick') AS leases"]))[0]
  if (takeoverStatuses.filter(status => status === 200).length !== 1 || takeoverStatuses.filter(status => status === 409).length !== 1
    || Number(takeoverAfter?.revision) <= Number(takeoverBefore?.revision)
    || Number(takeoverAfter?.clocks) <= Number(takeoverBefore?.clocks) || Number(takeoverAfter?.leases) !== 0) {
    throw new Error(`Expired lease takeover did not produce one successful tick, one losing Worker, and one released lease: ${JSON.stringify({ takeoverStatuses, takeoverBefore, takeoverAfter })}`)
  }

  const fork = (port: number, requestId: string, whatIf: string) => fetch(
    `http://127.0.0.1:${port}/api/worlds/s01-world/timelines/s01-main/fork`, {
      method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, scenario: { whatIf, changedVariable: 'message delivery' } }),
    })
  const baselineFork = await fork(workerPorts[0]!, forkIds[0]!, 'The message arrives in the baseline branch')
  if (!baselineFork.ok) throw new Error(`Could not reserve one fork slot before race: ${baselineFork.status} ${await baselineFork.text()}`)
  const attempts = await Promise.all(loadForkIds.map((requestId, index) =>
    fork(workerPorts[index % workerPorts.length]!, requestId, `Concurrent branch request ${index}`)))
  const bodies = await Promise.all(attempts.map(async response => await response.json() as { id?: string; error?: string }))
  const statuses = attempts.map(r => r.status)
  if (statuses.filter(s => s === 200).length !== 1 || statuses.filter(s => s === 409).length !== loadForkIds.length - 1) {
    throw new Error(`Expected remote D1 24-request fork stress to return one 200 and the rest 409, got ${JSON.stringify({ statuses, bodies })}`)
  }
  const winnerIndex = statuses.indexOf(200)
  const winnerId = bodies[winnerIndex]?.id
  if (!winnerId) throw new Error(`Winning Fork has no id: ${JSON.stringify(bodies)}`)
  const winnerScenario = `Concurrent branch request ${winnerIndex}`
  const replay = await fork(workerPorts[1 - (winnerIndex % workerPorts.length)]!, winnerId, winnerScenario)
  if (!replay.ok || (await replay.json() as { id?: string }).id !== winnerId) throw new Error('Remote cross-Worker idempotent Fork replay failed')
  const conflict = await fork(workerPorts[1 - (winnerIndex % workerPorts.length)]!, winnerId, 'A changed payload must conflict')
  if (conflict.status !== 409) throw new Error(`Expected payload conflict 409, got ${conflict.status}`)

  const capacity = await fork(workerPorts[0]!, 's01-over-capacity-fork', 'This branch exceeds the active timeline limit')
  if (capacity.status !== 409) throw new Error(`Expected active timeline limit 409, got ${capacity.status}`)
  const audit = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    `SELECT (SELECT COUNT(*) FROM timelines WHERE world_id='s01-world' AND parent_timeline_id='s01-main' AND status='active') AS children, (SELECT COUNT(*) FROM person_states WHERE timeline_id IN (${forkIdsSql})) AS copied_states, (SELECT COUNT(*) FROM universe_revisions WHERE timeline_id IN (${forkIdsSql})) AS revisions`]))[0]
  if (!audit || Number(audit.children) !== 2 || Number(audit.copied_states) !== 2 || Number(audit.revisions) !== 2) {
    throw new Error(`Remote D1 Fork race left invalid projections: ${JSON.stringify(audit)}`)
  }
  console.log(JSON.stringify({ remoteD1: true, workers: 2, authenticatedBoth: true, highConcurrencyForkRequests: loadForkIds.length,
    crossWorkerChat: { pendingReplayStatus: pendingReplay.status, completedReplayStatus: completedReplay.status,
      payloadConflictStatus: chatConflict.status, audit: chatAudit },
    rootEvidenceReview: evidenceReview,
    concurrentForkStatuses: statuses,
    remoteTickWhileHeldStatuses: tickStatuses, remoteTickHadNoWorldEffects: true,
    expiredLeaseTakeoverStatuses: takeoverStatuses, takeoverAdvancedWorld: true, takeoverReleasedLease: true,
    baselineForkStatus: baselineFork.status, winner: winnerId, replayStatus: replay.status,
    payloadConflictStatus: conflict.status, capacityStatus: capacity.status,
    concurrentLeaseWinners: leaseWinners, leaseOwnerMatched: true, audit }, null, 2))
}

try { await main() }
catch (error) {
  console.error(`Remote acceptance verification failed: ${String(error)}`)
  process.exitCode = 1
}
finally {
  for (const child of children.reverse()) await stop(child)
  if (providerDeployed && providerConfig) {
    try { await run(['delete', providerName, '--config', providerConfig, '--force']) }
    catch (error) {
      if (!String(error).includes('This Worker does not exist on this account.')) {
        console.error(`Temporary chat provider cleanup failed: ${String(error)}`)
        process.exitCode = 1
      }
    }
  }
  if (safeTarget && config && expectedDatabaseId) {
    try {
      for (const command of [
        `UPDATE timelines SET status='archived' WHERE id IN (${forkIdsSql}) AND status='active'`,
        "DELETE FROM engine_tick_leases WHERE id='autonomous-world-tick' AND owner_token IN ('s01-remote-lease-a','s01-remote-lease-b','s01-remote-held-lease')",
      ]) await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--command', command])
    } catch (error) {
      console.error(`Remote fixture cleanup failed: ${String(error)}`)
      process.exitCode = 1
    }
  }
  await rm(temp, { recursive: true, force: true })
}
