import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'

const root = resolve(new URL('..', import.meta.url).pathname)
const config = process.env.S01_REMOTE_D1_CONFIG
const expectedDatabaseId = process.env.S01_REMOTE_D1_ID
const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
const basePort = 20_000 + Math.floor(Math.random() * 20_000)
const ports = [basePort, basePort + 1]
const session = 's01-local-worker-session'
const secret = 's01-remote-acceptance-secret'
const tag = randomUUID().replaceAll('-', '').slice(0, 12)
const childId = `s01-remote-child-${tag}`
const grandchildId = `s01-remote-grandchild-${tag}`
const requestId = `s01-remote-cancel-${tag}`
const crashRequestId = `s01-remote-provider-crash-${tag}`
const crashWorkerName = `possibility-s01-api-crash-${tag}`
const children: ChildProcess[] = []
let safeTarget = false
let crashWorkerConfig: string | undefined
let crashWorkerDeployed = false

function run(args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const proc = spawn(wrangler, args, { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', chunk => { out += String(chunk) })
    proc.stderr.on('data', chunk => { out += String(chunk) })
    proc.once('error', reject)
    proc.once('close', code => code === 0 ? resolveRun(out) : reject(new Error(`wrangler exited ${code}: ${out}`)))
  })
}

function query(args: string[]) {
  return run(['d1', 'execute', 'DB', '--remote', '--config', config!, '--json', '--command', ...args])
}

function rows(output: string): Record<string, unknown>[] {
  const start = output.indexOf('[')
  if (start < 0) throw new Error(`Could not parse D1 JSON output: ${output}`)
  return (JSON.parse(output.slice(start)) as { results?: Record<string, unknown>[] }[]).flatMap(item => item.results ?? [])
}

function startWorker(index: number) {
  const port = ports[index]!
  const child = spawn(wrangler, [
    'dev', '--remote', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 10_000),
    '--name', `possibility-s01-remote-journey-${tag}-${index}`, '--log-level', 'error', '--config', config!,
    '--var', `ENGINE_TICK_SECRET:${secret}`, '--var', 'LLM_API_KEY:s01-unused', '--var', 'LLM_MODEL:s01-fixture',
    '--var', 'LLM_BASE_URL:https://llm.invalid/v1', '--var', 'DIRECTOR_LLM:0', '--var', 'WORLD_SPEED:360',
  ], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => process.stdout.write(String(chunk)))
  child.stderr.on('data', chunk => process.stderr.write(String(chunk)))
  children.push(child)
  return child
}

async function waitReady(child: ChildProcess, port: number) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`remote Worker ${port} exited before readiness (${child.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok && (await response.json() as { ok?: boolean }).ok) return
    } catch { /* remote Worker still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`remote Worker ${port} did not become ready`)
}

async function stop(child: ChildProcess, hard = false) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill(hard ? 'SIGKILL' : 'SIGTERM')
  await Promise.race([
    new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
    new Promise<void>(resolveExit => setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, 10_000)),
  ])
}

async function deleteCrashWorker() {
  try {
    await run(['delete', crashWorkerName, '--config', crashWorkerConfig!, '--force'])
    crashWorkerDeployed = false
  }
  catch (error) {
    if (!String(error).includes('This Worker does not exist on this account.')) throw error
    crashWorkerDeployed = false
  }
}

async function main() {
  if (!config || !expectedDatabaseId) throw new Error('Set S01_REMOTE_D1_CONFIG and S01_REMOTE_D1_ID explicitly.')
  const configText = await (await import('node:fs/promises')).readFile(resolve(root, config), 'utf8')
  if (!configText.includes(`database_id = "${expectedDatabaseId}"`)) throw new Error('Config database_id does not match S01_REMOTE_D1_ID.')
  const databaseName = configText.match(/database_name\s*=\s*"([^"]+)"/)?.[1] ?? ''
  if (!/(test|staging|acceptance)/i.test(databaseName)) throw new Error(`Refusing remote acceptance on non-test database: ${databaseName}`)
  const baseline = rows(await query(["SELECT (SELECT COUNT(*) FROM worlds) AS worlds, (SELECT COUNT(*) FROM d1_migrations) AS migrations, (SELECT COUNT(*) FROM timelines WHERE id='s01-main') AS root"]))[0]
  if (!baseline || Number(baseline.worlds) !== 1 || Number(baseline.migrations) !== 22 || Number(baseline.root) !== 1) {
    throw new Error(`Refusing remote journey unless the dedicated one-world acceptance fixture is present: ${JSON.stringify(baseline)}`)
  }
  safeTarget = true
  const workers = ports.map((_, index) => startWorker(index))
  await Promise.all(workers.map((worker, index) => waitReady(worker, ports[index]!)))

  const fork = async (port: number, sourceId: string, id: string, whatIf: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/worlds/s01-world/timelines/${sourceId}/fork`, {
      method: 'POST', headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: id, scenario: { whatIf, changedVariable: 'message delivery' } }),
    })
    const body = await response.json() as { id?: string; error?: string }
    if (!response.ok || body.id !== id) throw new Error(`Remote Fork ${sourceId}→${id} failed: ${response.status} ${JSON.stringify(body)}`)
  }
  await fork(ports[0]!, 's01-main', childId, 'The message reaches the child branch')
  await fork(ports[1]!, childId, grandchildId, 'The message reaches the grandchild branch')

  const personaResponse = await fetch(`http://127.0.0.1:${ports[0]}/api/worlds/s01-world/persona`, {
    method: 'POST', headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'S01 Remote Visitor', description: 'Synthetic remote acceptance persona.' }),
  })
  if (!personaResponse.ok) throw new Error(`Could not register the synthetic visitor: ${personaResponse.status} ${await personaResponse.text()}`)
  const revision = rows(await query([`SELECT version FROM universe_revisions WHERE timeline_id='${grandchildId}'`]))[0]
  const enter = await fetch(`http://127.0.0.1:${ports[0]}/api/worlds/s01-world/scene/position`, {
    method: 'POST', headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timelineId: grandchildId, location: 'Cafe', commandId: `enter-${tag}`, expectedVersion: Number(revision?.version) }),
  })
  if (!enter.ok) throw new Error(`Could not enter the grandchild: ${enter.status} ${await enter.text()}`)

  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${ports[0]}/api/worlds/s01-world/scene`, {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timelineId: grandchildId, location: 'Cafe', content: 'A cancelled acceptance message.', requestId }),
  })
  if (!response.body) throw new Error('Remote scene response did not provide an SSE body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let frame = ''
  while (!(frame.includes('scene_start') && /\r?\n\r?\n/.test(frame)) && !frame.includes('"type":"error"')) {
    const next = await reader.read()
    if (next.done) break
    frame += decoder.decode(next.value, { stream: true })
  }
  if (!frame.includes('scene_start')) throw new Error(`Remote scene did not open before cancellation: ${frame}`)
  const dialogueId = frame.match(/"dialogueId":"([^"]+)"/)?.[1]
  if (!dialogueId) throw new Error(`scene_start omitted dialogueId: ${frame}`)
  await reader.cancel()
  controller.abort()
  const revisionAfterOpen = rows(await query([`SELECT version FROM universe_revisions WHERE timeline_id='${grandchildId}'`]))[0]
  const statusUrl = `http://127.0.0.1:${ports[1]}/api/worlds/s01-world/scene/requests/${requestId}?timelineId=${grandchildId}`
  let status: { status: string; recoverable?: boolean } = { status: 'pending' }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && status.status === 'pending') {
    const current = await fetch(statusUrl, { headers: { Authorization: `Bearer ${session}` } })
    status = await current.json() as typeof status
    if (status.status === 'pending') await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  if (status.status !== 'failed') throw new Error(`Cancelled remote scene did not fail cleanly: ${JSON.stringify(status)}`)

  const accountId = configText.match(/account_id\s*=\s*"([^"]+)"/)?.[1]
  const databaseId = configText.match(/database_id\s*=\s*"([^"]+)"/)?.[1]
  if (!accountId || !databaseId) throw new Error('Staging config must include account_id and database_id for the temporary crash fixture.')
  const secret = randomUUID()
  const fixtureDir = await mkdtemp(join(tmpdir(), 's01-crash-fixture-'))
  crashWorkerConfig = join(fixtureDir, 'wrangler.toml')
  await writeFile(crashWorkerConfig, [
    `name = "${crashWorkerName}"`,
    `main = "${join(root, 'scripts/fixtures/s01-crash-product-api.ts')}"`,
    'compatibility_date = "2025-01-01"',
    `account_id = "${accountId}"`,
    'workers_dev = true',
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = "${databaseName}"`,
    `database_id = "${databaseId}"`,
    `migrations_dir = "${join(root, 'api/drizzle')}"`,
    '',
    '[vars]',
    `CRASH_FIXTURE_SECRET = "${secret}"`,
    `ENGINE_TICK_SECRET = "${secret}"`,
    'LLM_API_KEY = "s01-unused"',
    'LLM_MODEL = "s01-fixture"',
    'LLM_BASE_URL = "https://llm.invalid/v1"',
    'DIRECTOR_LLM = "0"',
    'WORLD_SPEED = "360"',
    '',
  ].join('\n'))
  try {
    crashWorkerDeployed = true
    const deployOutput = await run(['deploy', '--config', crashWorkerConfig, '--name', crashWorkerName, '--outdir', join(fixtureDir, 'dist')])
    const fixtureUrl = deployOutput.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0]
    if (!fixtureUrl) throw new Error(`Could not find the temporary Worker URL in Wrangler output: ${deployOutput}`)
    let runtimeFailure: { status: number; body: string } | undefined
    const crashScene = await fetch(`${fixtureUrl}/api/worlds/s01-world/scene`, {
      method: 'POST', headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json',
        'x-s01-provider-crash': secret },
      body: JSON.stringify({ timelineId: grandchildId, location: 'Cafe', content: 'A provider-wait runtime crash acceptance request.', requestId: crashRequestId }),
      signal: AbortSignal.timeout(30_000),
    })
    let crashDialogueId: string | undefined
    try {
      if (!crashScene.body) throw new Error('Product API crash Worker returned no SSE body')
      const reader = crashScene.body.getReader()
      const decoder = new TextDecoder()
      let frame = ''
      while (!frame.includes('scene_start') && !frame.includes('"type":"error"')) {
        const next = await reader.read()
        if (next.done) break
        frame += decoder.decode(next.value, { stream: true })
      }
      crashDialogueId = frame.match(/"dialogueId":"([^"]+)"/)?.[1]
      if (!crashDialogueId) throw new Error(`Product API did not reserve/open a scene before provider failure: ${frame}`)
      try {
        const next = await reader.read()
        runtimeFailure = { status: crashScene.status, body: next.done ? 'stream ended' : decoder.decode(next.value).slice(0, 500) }
      } catch (error) {
        runtimeFailure = { status: crashScene.status, body: String(error).slice(0, 500) }
      }
    } catch (error) {
      if (!runtimeFailure) runtimeFailure = { status: crashScene.status, body: String(error).slice(0, 500) }
    }
    const inFlightState = rows(await query([`SELECT status, heartbeat_at, created_at FROM scene_requests WHERE id='${crashRequestId}'`]))[0]
    if (!inFlightState || inFlightState.status !== 'pending'
      || Number(inFlightState.heartbeat_at) < Number(inFlightState.created_at)) {
      throw new Error(`Product API request did not remain pending after Cloudflare terminated its invocation: ${JSON.stringify({ runtimeFailure, inFlightState })}`)
    }
    const invocationLog = `${runtimeFailure.status} ${runtimeFailure.body}`
    if (!/stream ended|terminated|reset|resource|limit|error|1101|500|503/i.test(invocationLog)) {
      throw new Error(`Product API invocation did not expose a recognizable runtime failure: ${JSON.stringify(runtimeFailure)}`)
    }
    await run(['d1', 'execute', 'DB', '--remote', '--config', config!, '--command',
      `UPDATE scene_requests SET heartbeat_at=${Date.now() - 300_001} WHERE id='${crashRequestId}' AND status='pending'`])
    const runtimeRevision = rows(await query([`SELECT version FROM universe_revisions WHERE timeline_id='${grandchildId}'`]))[0]
    const crashStatusUrl = `http://127.0.0.1:${ports[1]}/api/worlds/s01-world/scene/requests/${crashRequestId}?timelineId=${grandchildId}`
    const recoverable = await fetch(crashStatusUrl, { headers: { Authorization: `Bearer ${session}` } })
    const recoverableState = await recoverable.json() as { status: string; recoverable?: boolean }
    if (recoverableState.status !== 'pending' || recoverableState.recoverable !== true) {
      throw new Error(`Recovery Worker did not expose the expired reservation: ${JSON.stringify(recoverableState)}`)
    }
    const recovered = await fetch(`http://127.0.0.1:${ports[1]}/api/worlds/s01-world/scene/requests/${crashRequestId}/recover?timelineId=${grandchildId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${session}` },
    })
    const recoveredState = await recovered.json() as { status: string; recoverable?: boolean }
    const audit = rows(await query([`SELECT
      (SELECT status FROM scene_requests WHERE id='${crashRequestId}') AS request_status,
      (SELECT COUNT(*) FROM world_commands WHERE id='scene:${crashRequestId}' AND timeline_id='${grandchildId}') AS committed_scene_commands,
      (SELECT COUNT(*) FROM dialogue_turns WHERE dialogue_id='${crashDialogueId}') AS turns,
      (SELECT version FROM universe_revisions WHERE timeline_id='${grandchildId}') AS revision`]))[0]
    if (!recovered.ok || recoveredState.status !== 'failed' || audit?.request_status !== 'failed'
      || Number(audit.committed_scene_commands) !== 0 || Number(audit.turns) !== 0
      || Number(audit.revision) !== Number(runtimeRevision?.version)) {
      throw new Error(`Remote runtime recovery had partial conversation effects: ${JSON.stringify({ recoveredState, audit })}`)
    }
    console.log(JSON.stringify({ remoteD1: true, nestedForks: [childId, grandchildId], cancelledRequest: status.status,
      productApiProviderWaitRuntimeFailure: runtimeFailure, recoveredByOtherWorker: recoveredState.status,
      noCommittedConversation: true, sceneOpenRevisionStableAfterRecovery: true,
      immutableAcceptanceHistory: 'retained in archived synthetic timelines' }, null, 2))
  } finally {
    if (crashWorkerDeployed) {
      try { await deleteCrashWorker() }
      catch (error) { console.error(`Temporary Worker cleanup after the acceptance attempt: ${String(error)}`); process.exitCode = 1 }
    }
    await rm(fixtureDir, { recursive: true, force: true })
    crashWorkerConfig = undefined
  }
}

try { await main() }
catch (error) {
  console.error(`Remote S01 journey failed: ${String(error)}`)
  process.exitCode = 1
}
finally {
  if (crashWorkerDeployed && crashWorkerConfig) {
    try { await deleteCrashWorker() }
    catch (error) { console.error(`Could not delete the temporary Cloudflare crash Worker: ${String(error)}`); process.exitCode = 1 }
  }
  if (crashWorkerConfig) await rm(join(crashWorkerConfig, '..'), { recursive: true, force: true })
  if (safeTarget) {
    try {
      await run(['d1', 'execute', 'DB', '--remote', '--config', config!, '--command',
        `UPDATE timelines SET status='archived' WHERE id IN ('${childId}','${grandchildId}')`])
    } catch (error) {
      console.error(`Could not archive the synthetic acceptance timelines: ${String(error)}`)
      process.exitCode = 1
    }
  }
  for (const child of children.reverse()) await stop(child)
}
