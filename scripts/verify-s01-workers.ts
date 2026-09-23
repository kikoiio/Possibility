import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(root, 'api', 'wrangler.toml')
const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
const temporaryParent = resolve(tmpdir())
const workerPorts = [8787, 8788]
const workerSecret = 's01-local-worker-secret'
const ownerSessionToken = 's01-local-worker-session'
const startTime = new Date(Date.now() - 15_000).toISOString()
const realStartTime = new Date(Date.now() - 15_000).toISOString()

type Mode = 'full' | 'dry-run' | 'prepare-only' | 'readiness-only' | 'manual-ui' | 'help'

function modeFromArgs(args: string[]): Mode {
  const modes = args.filter(arg => arg.startsWith('--')).filter(arg => ['--dry-run', '--prepare-only', '--readiness-only', '--manual-ui', '--help'].includes(arg))
  if (modes.length > 1 || args.some(arg => arg.startsWith('--') && !modes.includes(arg))) {
    throw new Error('Only one of --dry-run, --prepare-only, --readiness-only, --manual-ui, or --help is supported.')
  }
  return modes[0]?.slice(2) as Mode ?? 'full'
}

function help() {
  console.log(`Usage: npm run verify:s01:workers [-- --dry-run|--prepare-only|--readiness-only|--manual-ui|--help]

Runs D1 migrations and a deterministic tick race against one temporary local D1
directory shared by two independent Wrangler Workers. The directory and child
processes are removed when the command exits.`)
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, options: { quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk); if (!options.quiet) process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk); if (!options.quiet) process.stderr.write(chunk) })
    child.once('error', rejectRun)
    child.once('close', code => code === 0 ? resolveRun(output) : rejectRun(new Error(`${command} exited ${code ?? 'without a status'}\n${output}`)))
  })
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  return child
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolveStop => child.once('exit', () => resolveStop())),
    new Promise<void>(resolveStop => setTimeout(() => { child.kill('SIGKILL'); resolveStop() }, 5_000)),
  ])
}

async function waitForHealthy(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 45_000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Worker on port ${port} exited before becoming ready`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok && (await response.json() as { ok?: boolean }).ok) return
    } catch (error) { lastError = error }
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error(`Worker on port ${port} was not ready: ${String(lastError ?? 'health check timed out')}`)
}

async function verifyOwnerSession(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/worlds`, {
    headers: { Authorization: `Bearer ${ownerSessionToken}` },
  })
  if (!response.ok) throw new Error(`Worker on port ${port} rejected the synthetic owner session: ${response.status} ${await response.text()}`)
  const body = await response.json() as { worlds?: { id: string }[] }
  if (!body.worlds?.some(world => world.id === 's01-world')) {
    throw new Error(`Worker on port ${port} did not read the seeded world through the shared D1`)
  }
}

async function startMockLlm(): Promise<{ server: Server; baseUrl: string; firstRequest: Promise<void> }> {
  let signalFirst!: () => void
  const firstRequest = new Promise<void>(resolveFirst => { signalFirst = resolveFirst })
  let delayedFirst = false
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      let payload: { messages?: { content?: string }[] } = {}
      try { payload = JSON.parse(body) as typeof payload } catch { /* return a deterministic malformed-request response below */ }
      const prompt = payload.messages?.map(message => message.content ?? '').join('\n') ?? ''
      const isSchedule = prompt.includes('安排今日日程')
      const content = isSchedule ? JSON.stringify({ items: [
        { start: '00:00', end: '08:00', location: 'Cafe', activity: 'Resting', kind: 'sleep' },
        { start: '08:00', end: '09:00', location: 'Library', activity: 'Researching' },
        { start: '09:00', end: '12:00', location: 'Cafe', activity: 'Reading' },
        { start: '12:00', end: '13:00', location: 'Library', activity: 'Having lunch' },
        { start: '13:00', end: '17:00', location: 'Cafe', activity: 'Working' },
        { start: '17:00', end: '20:00', location: 'Library', activity: 'Researching' },
        { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' },
      ] }) : JSON.stringify({ events: [], thought: 'A quiet local verification tick.', memory: null,
        nextLocation: null, nextActivity: null, mood: null, goal: null })
      if (isSchedule && !delayedFirst) {
        delayedFirst = true
        signalFirst()
        setTimeout(() => send(response, content), 1_500)
      } else send(response, content)
    })
  })
  const listening = new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  await listening
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not determine local model stub port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, firstRequest }
}

function send(response: import('node:http').ServerResponse, content: string) {
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content } }] }))
}

function seedSql(): string {
  const residentModel = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] }
  const baseline = {
    source: 'root', version: 0, capturedAt: startTime, simTime: startTime,
    completeDomains: ['clock', 'states', 'schedules', 'events', 'commitments', 'memories', 'dialogues', 'dialogueTurns', 'personaMessages', 'knowledge'],
    rows: { states: [{ personId: 's01-resident', timelineId: 's01-main', simTime: startTime, location: 'Cafe',
      activity: 'Resting', mood: 'Calm', goal: 'Explore', currentDialogueId: null, lastBeatSimTime: startTime, updatedRealAt: startTime }],
      schedules: [], events: [], commitments: [], memories: [], dialogues: [], dialogueTurns: [], personaMessages: [] },
  }
  const model = { name: 's01 local worker world', description: 'Isolated verification fixture',
    locations: [{ name: 'Cafe', description: '' }, { name: 'Library', description: '' }],
    residents: [{ id: 's01-resident', name: 'Local Resident', model: residentModel }],
    initialStates: { capturedAt: startTime, states: [{ personId: 's01-resident', simTime: startTime, location: 'Cafe',
      activity: 'Resting', mood: 'Calm', goal: 'Explore', currentDialogueId: null, lastBeatSimTime: startTime }] },
    initialEvents: { timelineId: 's01-main', eventIds: [] }, projectionBaseline: baseline }
  const createdAt = new Date().toISOString()
  return [
    `INSERT INTO users (id, username, password_hash, created_at) VALUES ('s01-owner', 's01-owner', 'f5f8e59a69cd168d28eb5b8494d47186:db6aae3b459afd21002d1c380b8b64508571b41563bef8db76275d8531bf8556', ${sql(createdAt)});`,
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (${sql(ownerSessionToken)}, 's01-owner', '2099-01-01T00:00:00.000Z');`,
    `INSERT INTO worlds (id, user_id, name, description, locations_json, status, calls_today, calls_day, created_at) VALUES ('s01-world', 's01-owner', 's01 local worker world', 'isolated', ${sql(JSON.stringify(model.locations))}, 'running', 0, ${sql(createdAt.slice(0, 10))}, ${sql(createdAt)});`,
    `INSERT INTO persons (id, user_id, name, model_json, is_user, created_at) VALUES ('s01-resident', 's01-owner', 'Local Resident', ${sql(JSON.stringify(residentModel))}, 0, ${sql(createdAt)});`,
    `INSERT INTO world_persons (world_id, person_id, joined_at) VALUES ('s01-world', 's01-resident', ${sql(createdAt)});`,
    `INSERT INTO timelines (id, world_id, parent_timeline_id, fork_scenario_json, sim_now, created_at, status, ancestor_ids_json, last_real_tick_at) VALUES ('s01-main', 's01-world', NULL, NULL, ${sql(startTime)}, ${sql(createdAt)}, 'active', '[]', ${sql(realStartTime)});`,
    `INSERT INTO person_states (person_id, timeline_id, sim_time, location, activity, mood, goal, updated_real_at, current_dialogue_id, last_beat_sim_time) VALUES ('s01-resident', 's01-main', ${sql(startTime)}, 'Cafe', 'Resting', 'Calm', 'Explore', ${sql(startTime)}, NULL, ${sql(startTime)});`,
    `INSERT INTO world_model_versions (world_id, version, model_json, created_at) VALUES ('s01-world', 1, ${sql(JSON.stringify(model))}, ${sql(createdAt)});`,
    `INSERT INTO universe_revisions (timeline_id, version, sim_time, world_model_version, updated_at) VALUES ('s01-main', 0, ${sql(startTime)}, 1, ${sql(startTime)});`,
  ].join('\n')
}

function wranglerArgs(args: string[]): string[] {
  return [...args, '--config', configPath, '--cwd', root]
}

async function queryLocalD1(persistDir: string, env: NodeJS.ProcessEnv, command: string): Promise<Record<string, unknown>> {
  const output = await run(wrangler, wranglerArgs([
    'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--json', '--command', command,
  ]), env, { quiet: true })
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error(`Could not parse local D1 verification output: ${output}`)
  const result = JSON.parse(output.slice(jsonStart)) as { results?: Record<string, unknown>[] }[]
  const row = result.flatMap(item => item.results ?? [])[0]
  if (!row) throw new Error(`Local D1 verification query returned no rows: ${command}`)
  return row
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text()
  try { return JSON.parse(body) as Record<string, unknown> }
  catch { return { error: body || `HTTP ${response.status} returned no JSON body` } }
}

async function main() {
  const mode = modeFromArgs(process.argv.slice(2))
  if (mode === 'help') { help(); return }
  const tempRoot = await mkdtemp(join(temporaryParent, 'possibility-s01-'))
  const persistDir = join(tempRoot, 'd1')
  const configHome = join(tempRoot, 'config')
  const sqlPath = join(tempRoot, 'seed.sql')
  const childProcesses: ChildProcess[] = []
  let mockServer: Server | null = null
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: configHome, CI: '1' }
  try {
    await mkdir(persistDir, { recursive: true })
    await mkdir(configHome, { recursive: true })
    const resolvedPersist = resolve(persistDir)
    if (!resolvedPersist.startsWith(`${temporaryParent}/`) || resolvedPersist.includes('/.wrangler/state')) {
      throw new Error(`Unsafe Wrangler persistence path: ${resolvedPersist}`)
    }
    if (mode === 'dry-run') {
      console.log(JSON.stringify({ mode, persistDir: resolvedPersist, remote: false, workers: 0, metrics: false }, null, 2))
      return
    }
    const migrate = wranglerArgs(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir])
    await run(wrangler, migrate, env, { quiet: true })
    await writeFile(sqlPath, seedSql(), 'utf8')
    await run(wrangler, wranglerArgs(['d1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--file', sqlPath]), env, { quiet: true })
    console.log(`Prepared isolated local D1 at ${resolvedPersist}; remote=false; metrics=false`)
    if (mode === 'prepare-only') return

    const llm = await startMockLlm()
    mockServer = llm.server
    const startWorker = (index: number) => {
      const port = workerPorts[index]
      const child = start(wrangler, wranglerArgs([
      'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persistDir,
      '--inspector-port', String(port + 10_000), '--name', `possibility-s01-worker-${index + 1}`, '--log-level', 'error',
      '--var', `ENGINE_TICK_SECRET:${workerSecret}`, '--var', `LLM_BASE_URL:${llm.baseUrl}`,
      '--var', 'LLM_API_KEY:s01-local-only', '--var', 'LLM_MODEL:s01-fixture', '--var', 'WORLD_SPEED:360',
      '--var', 'DIRECTOR_LLM:0',
      ]), env)
      childProcesses.push(child)
      return child
    }
    const firstWorker = startWorker(0)
    await waitForHealthy(firstWorker, workerPorts[0])
    if (mode === 'manual-ui') {
      await verifyOwnerSession(workerPorts[0])
      console.log(`Manual UI mode: API=http://127.0.0.1:${workerPorts[0]}, login=s01-owner / s01-local-password, world=s01-world, D1=${resolvedPersist}`)
      await new Promise<void>(resolveStop => {
        process.once('SIGINT', resolveStop)
        process.once('SIGTERM', resolveStop)
      })
      return
    }
    if (mode === 'readiness-only') {
      const secondWorker = startWorker(1)
      await waitForHealthy(secondWorker, workerPorts[1])
      for (const port of workerPorts) await verifyOwnerSession(port)
      console.log(`Both Workers authenticated the synthetic owner and read s01-world from the shared isolated D1 at ${resolvedPersist}`)
      return
    }

    const requestTick = (port: number) => fetch(`http://127.0.0.1:${port}/api/engine/tick`, {
      method: 'POST', headers: { 'x-engine-secret': workerSecret },
    })
    const ownerPromise = requestTick(workerPorts[0])
    await Promise.race([
      llm.firstRequest,
      ownerPromise.then(async response => { throw new Error(`First Worker returned ${response.status} before reaching the local model stub: ${await response.text()}`) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('First Worker never reached the local deterministic model stub')), 30_000)),
    ])
    const secondWorker = startWorker(1)
    await waitForHealthy(secondWorker, workerPorts[1])
    console.log(`Both Workers are ready and share isolated D1 at ${resolvedPersist}`)
    const contender = await requestTick(workerPorts[1])
    if (contender.status !== 409) throw new Error(`Expected the competing Worker to receive 409, got ${contender.status}: ${await contender.text()}`)
    const owner = await ownerPromise
    if (!owner.ok) throw new Error(`Lease owner returned ${owner.status}: ${await owner.text()}`)

    const requestFork = (port: number, requestId: string, whatIf: string) => fetch(
      `http://127.0.0.1:${port}/api/worlds/s01-world/timelines/s01-main/fork`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerSessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, scenario: { whatIf, changedVariable: 'message delivery' } }),
      },
    )
    const forkAttempts = await Promise.all([
      requestFork(workerPorts[0], 's01-concurrent-fork-a', 'The message arrives in branch A'),
      requestFork(workerPorts[1], 's01-concurrent-fork-b', 'The message arrives in branch B'),
    ])
    const forkResults = await Promise.all(forkAttempts.map(async response => await readJsonResponse(response) as { id?: string; error?: string }))
    if (forkAttempts.some((response, index) => response.status !== 200 && (response.status !== 409 || !forkResults[index].error))) {
      throw new Error(`Concurrent Fork returned an unclassified result: ${forkAttempts.map((response, index) => `${response.status} ${JSON.stringify(forkResults[index])}`).join('; ')}`)
    }
    const successfulFork = forkResults.find((result, index) => forkAttempts[index].status === 200 && result.id === ['s01-concurrent-fork-a', 's01-concurrent-fork-b'][index])
    if (!successfulFork?.id) throw new Error(`Concurrent Fork produced no complete child: ${forkAttempts.map((response, index) => `${response.status} ${JSON.stringify(forkResults[index])}`).join('; ')}`)
    const replay = await requestFork(workerPorts[1], successfulFork.id, successfulFork.id === 's01-concurrent-fork-a' ? 'The message arrives in branch A' : 'The message arrives in branch B')
    const replayResult = await replay.json() as { id?: string; error?: string }
    if (!replay.ok || replayResult.id !== successfulFork.id) {
      throw new Error(`Same-payload Fork replay did not return the existing child: ${replay.status} ${JSON.stringify(replayResult)}`)
    }
    const payloadConflict = await requestFork(workerPorts[0], successfulFork.id, 'A different message reaches the branch')
    if (payloadConflict.status !== 409) {
      throw new Error(`Expected different-payload Fork replay to return 409, got ${payloadConflict.status}: ${await payloadConflict.text()}`)
    }
    const successfulIds = forkAttempts.flatMap((response, index) => response.status === 200 ? [forkResults[index].id!] : [])
    const forkAudit = await queryLocalD1(persistDir, env,
      `SELECT (SELECT COUNT(*) FROM timelines WHERE id IN (${successfulIds.map(sql).join(',')}) AND parent_timeline_id = 's01-main' AND status = 'active') AS fork_rows, (SELECT COUNT(*) FROM universe_revisions WHERE timeline_id IN (${successfulIds.map(sql).join(',')}) AND version = 0) AS fork_revisions, (SELECT COUNT(*) FROM person_states WHERE timeline_id IN (${successfulIds.map(sql).join(',')})) AS fork_states, (SELECT COUNT(*) FROM timelines WHERE world_id = 's01-world' AND status = 'active') AS active_timelines`)
    if (Number(forkAudit.fork_rows) !== successfulIds.length || Number(forkAudit.fork_revisions) !== successfulIds.length || Number(forkAudit.fork_states) !== successfulIds.length || Number(forkAudit.active_timelines) !== 1 + successfulIds.length) {
      throw new Error(`Concurrent Fork left incomplete or duplicate rows: ${JSON.stringify(forkAudit)}`)
    }
    const releaseSourceRaceSlot = await fetch(`http://127.0.0.1:${workerPorts[1]}/api/timelines/${successfulIds[0]}/archive`, {
      method: 'POST', headers: { Authorization: `Bearer ${ownerSessionToken}` },
    })
    if (!releaseSourceRaceSlot.ok) {
      throw new Error(`Could not release one verified child for the source-version race: ${releaseSourceRaceSlot.status} ${await releaseSourceRaceSlot.text()}`)
    }

    const sourceBefore = await queryLocalD1(persistDir, env,
      "SELECT version FROM universe_revisions WHERE timeline_id = 's01-main'")
    const expectedVersion = Number(sourceBefore.version)
    const requestAction = (port: number) => fetch('http://127.0.0.1:' + port + '/api/worlds/s01-world/actions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerSessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 's01-source-race-action', timelineId: 's01-main', expectedVersion,
        action: { type: 'environment', location: 'Cafe', condition: 'weather', value: 'Clear' } }),
    })
    const [sourceFork, sourceAction] = await Promise.all([
      requestFork(workerPorts[0], 's01-source-race-fork', 'Fork before or after a source update'),
      requestAction(workerPorts[1]),
    ])
    const [sourceForkResult, sourceActionResult] = await Promise.all([
      readJsonResponse(sourceFork) as Promise<{ id?: string; error?: string; snapshot?: { sourceStateVersion?: number } }>,
      readJsonResponse(sourceAction) as Promise<{ version?: number; error?: string }>,
    ])
    if (![200, 409].includes(sourceFork.status) || ![200, 409].includes(sourceAction.status)) {
      throw new Error(`Source version race returned an unclassified result: Fork ${sourceFork.status} ${JSON.stringify(sourceForkResult)}; action ${sourceAction.status} ${JSON.stringify(sourceActionResult)}`)
    }
    if (sourceFork.status === 409 && sourceAction.status === 409) {
      throw new Error(`Both source version race requests conflicted without progress: ${JSON.stringify({ sourceForkResult, sourceActionResult })}`)
    }
    if (sourceFork.status === 200) {
      const storedFork = await queryLocalD1(persistDir, env,
        "SELECT json_extract(fork_snapshot_json, '$.sourceTimelineId') AS source_id, json_extract(fork_snapshot_json, '$.sourceStateVersion') AS source_version FROM timelines WHERE id = 's01-source-race-fork'")
      if (storedFork.source_id !== 's01-main' || ![expectedVersion, sourceActionResult.version].includes(Number(storedFork.source_version))) {
        throw new Error(`Fork snapshot did not match a valid source revision: ${JSON.stringify({ expectedVersion, sourceActionResult, storedFork })}`)
      }
    }
    const sourceRaceAudit = await queryLocalD1(persistDir, env,
      "SELECT (SELECT COUNT(*) FROM timelines WHERE id = 's01-source-race-fork' AND parent_timeline_id = 's01-main') AS fork_rows, (SELECT COUNT(*) FROM universe_revisions WHERE timeline_id = 's01-source-race-fork') AS fork_revisions, (SELECT COUNT(*) FROM person_states WHERE timeline_id = 's01-source-race-fork') AS fork_states, (SELECT COUNT(*) FROM world_commands WHERE id = 's01-source-race-action') AS action_commands, (SELECT COUNT(*) FROM world_facts WHERE source_command_id = 's01-source-race-action') AS action_facts, (SELECT version FROM universe_revisions WHERE timeline_id = 's01-main') AS source_version")
    const expectedForkRows = sourceFork.status === 200 ? 1 : 0
    const expectedActionRows = sourceAction.status === 200 ? 1 : 0
    if (Number(sourceRaceAudit.fork_rows) !== expectedForkRows || Number(sourceRaceAudit.fork_revisions) !== expectedForkRows
      || Number(sourceRaceAudit.fork_states) !== expectedForkRows || Number(sourceRaceAudit.action_commands) !== expectedActionRows
      || Number(sourceRaceAudit.action_facts) !== expectedActionRows
      || (expectedActionRows === 1 && Number(sourceRaceAudit.source_version) !== Number(sourceActionResult.version))) {
      throw new Error(`Source version race left partial or inconsistent records: ${JSON.stringify({ sourceForkStatus: sourceFork.status, sourceActionStatus: sourceAction.status, sourceRaceAudit })}`)
    }

    let activeCount = Number((await queryLocalD1(persistDir, env,
      "SELECT COUNT(*) AS count FROM timelines WHERE world_id = 's01-world' AND status = 'active'")).count)
    let capacityForkIndex = 0
    while (activeCount < 3) {
      const id = `s01-capacity-fill-${capacityForkIndex++}`
      const fill = await requestFork(workerPorts[capacityForkIndex % workerPorts.length], id, `Fill active timeline slot ${capacityForkIndex}`)
      const fillResult = await readJsonResponse(fill)
      if (!fill.ok || fillResult.id !== id) throw new Error(`Could not prepare active timeline capacity fixture: ${fill.status} ${JSON.stringify(fillResult)}`)
      activeCount = Number((await queryLocalD1(persistDir, env,
        "SELECT COUNT(*) AS count FROM timelines WHERE world_id = 's01-world' AND status = 'active'")).count)
    }
    const capacityBefore = await queryLocalD1(persistDir, env,
      "SELECT (SELECT COUNT(*) FROM timelines WHERE world_id = 's01-world') AS timelines, (SELECT version FROM universe_revisions WHERE timeline_id = 's01-main') AS source_version")
    const capacityConflict = await requestFork(workerPorts[0], 's01-capacity-conflict', 'This fork exceeds the active limit')
    const capacityConflictResult = await readJsonResponse(capacityConflict)
    const capacityAfter = await queryLocalD1(persistDir, env,
      "SELECT (SELECT COUNT(*) FROM timelines WHERE world_id = 's01-world') AS timelines, (SELECT version FROM universe_revisions WHERE timeline_id = 's01-main') AS source_version")
    if (capacityConflict.status !== 409 || capacityBefore.timelines !== capacityAfter.timelines || capacityBefore.source_version !== capacityAfter.source_version) {
      throw new Error(`Active timeline capacity conflict caused a side effect: ${JSON.stringify({ status: capacityConflict.status, capacityConflictResult, capacityBefore, capacityAfter })}`)
    }

    const rollbackSqlPath = join(tempRoot, 'rollback.sql')
    await writeFile(rollbackSqlPath, `UPDATE timelines SET status = 'archived' WHERE id = (SELECT id FROM timelines WHERE world_id = 's01-world' AND parent_timeline_id IS NOT NULL AND status = 'active' LIMIT 1);\nCREATE TRIGGER fail_s01_fork_state BEFORE INSERT ON person_states WHEN NEW.timeline_id <> 's01-main' BEGIN SELECT RAISE(ABORT, 'forced fork copy failure'); END;\n`, 'utf8')
    await run(wrangler, wranglerArgs(['d1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--file', rollbackSqlPath]), env, { quiet: true })
    const rollbackFork = await requestFork(workerPorts[0], 's01-rollback-fork', 'This fork should roll back on a forced write error')
    const rollbackBody = await readJsonResponse(rollbackFork)
    const rollbackAudit = await queryLocalD1(persistDir, env,
      "SELECT (SELECT COUNT(*) FROM timelines WHERE id = 's01-rollback-fork') AS child_rows, (SELECT COUNT(*) FROM universe_revisions WHERE timeline_id = 's01-rollback-fork') AS revisions, (SELECT COUNT(*) FROM person_states WHERE timeline_id = 's01-rollback-fork') AS states, (SELECT COUNT(*) FROM world_commands WHERE timeline_id = 's01-rollback-fork') AS commands, (SELECT COUNT(*) FROM world_facts WHERE timeline_id = 's01-rollback-fork') AS facts")
    if (rollbackFork.status < 400 || Object.values(rollbackAudit).some(value => Number(value) !== 0)) {
      throw new Error(`Injected Fork write failure left partial rows: ${JSON.stringify({ status: rollbackFork.status, rollbackBody, rollbackAudit })}`)
    }
    const auditOutput = await run(wrangler, wranglerArgs([
      'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--json', '--command',
      "SELECT (SELECT COUNT(*) FROM world_facts WHERE timeline_id = 's01-main' AND fact_type = 'clock') AS clock_facts, (SELECT version FROM universe_revisions WHERE timeline_id = 's01-main') AS revision, (SELECT sim_now FROM timelines WHERE id = 's01-main') AS sim_time, (SELECT COUNT(*) FROM engine_tick_leases) AS active_leases",
    ]), env, { quiet: true })
    const jsonStart = auditOutput.indexOf('[')
    if (jsonStart < 0) throw new Error(`Could not parse local D1 verification output: ${auditOutput}`)
    const queryResult = JSON.parse(auditOutput.slice(jsonStart)) as { results?: Record<string, unknown>[] }[]
    const audit = queryResult.flatMap(item => item.results ?? [])[0]
    if (!audit || Number(audit.clock_facts) !== 1 || Number(audit.revision) < 1 || Date.parse(String(audit.sim_time)) <= Date.parse(startTime)
      || Number(audit.active_leases) !== 0) {
      throw new Error(`Shared D1 did not record exactly one completed tick: ${JSON.stringify(audit)}`)
    }
    console.log(JSON.stringify({ mode, workers: 2, contenderStatus: contender.status, ownerStatus: owner.status,
      concurrentForkStatuses: forkAttempts.map(response => response.status), successfulForkIds: successfulIds,
      forkReplayStatus: replay.status, payloadConflictStatus: payloadConflict.status,
      forkAudit, sourceRaceStatuses: [sourceFork.status, sourceAction.status], sourceForkResult, sourceActionResult, sourceRaceAudit,
      capacityConflictStatus: capacityConflict.status, rollbackStatus: rollbackFork.status, rollbackAudit,
      clockFacts: audit.clock_facts, revision: audit.revision, simTime: audit.sim_time, activeLeases: audit.active_leases,
      persistence: resolvedPersist, remote: false, metrics: false }, null, 2))
  } finally {
    for (const child of childProcesses.reverse()) await stop(child)
    if (mockServer) await new Promise<void>(resolveClose => mockServer!.close(() => resolveClose()))
    await rm(tempRoot, { recursive: true, force: true })
    console.log(`Cleaned isolated directory ${tempRoot}`)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
