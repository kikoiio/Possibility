import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildEngineContext, buildWorldSnapshot } from '../api/src/agent/engine-context'
import { runTick } from '../api/src/engine/tick'
import { llmCallLog, persons, personStates, schedules, timelines, universeRevisions, worldModelVersions, worldPersons, worlds } from '../api/src/db/schema'
import { createWorldFixture, WORLD_TIME } from '../api/src/test/world-fixture'
import { createRootProjectionBaseline } from '../api/src/world-state/model'
import { collectReplayInput, readCurrentProjection } from '../api/src/world-state/evidence'
import { rebuildProjection } from '../api/src/world-state/rebuild'

const MAX_ATTEMPTS = 8
let attempts = 0

function readDevVars() {
  const result: Record<string, string> = {}
  for (const line of readFileSync(resolve('api/.dev.vars'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(LLM_BASE_URL|LLM_API_KEY|LLM_MODEL)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[match[1]!] = value
  }
  if (!result.LLM_BASE_URL || !result.LLM_API_KEY || !result.LLM_MODEL) {
    throw new Error('Local api/.dev.vars must define LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.')
  }
  return result as { LLM_BASE_URL: string; LLM_API_KEY: string; LLM_MODEL: string }
}

async function main() {
  if (process.env.S01_LIVE_JOURNEY_ACK !== 'YES') {
    throw new Error('Set S01_LIVE_JOURNEY_ACK=YES to authorize one additional billable attempt.')
  }
  const fixture = await createWorldFixture()
  try {
    const now = Date.now()
    const state = { personId: 'live-resident', timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Follow the day',
      currentDialogueId: null, lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME }
    const model = { identity: [{ text: 'A careful local resident.', provenance: 'known' }],
      behavior: [{ text: 'Respond honestly and preserve uncertainty.', provenance: 'known' }],
      speech: [{ text: 'Speak plainly.', provenance: 'known' }], skills: [], memories: [], relationships: [],
      boundaries: [], unknowns: [] }
    await fixture.db.insert(persons).values({ id: state.personId, userId: 'owner', name: 'Mina',
      modelJson: JSON.stringify(model), createdAt: WORLD_TIME })
    await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: state.personId, joinedAt: WORLD_TIME })
    await fixture.db.insert(personStates).values(state)
    const schedule = [
      { start: '00:00', end: '08:00', location: 'Cafe', activity: 'Sleeping', kind: 'sleep' },
      { start: '08:00', end: '09:00', location: 'Cafe', activity: 'Reading' },
      { start: '09:00', end: '11:00', location: 'Library', activity: 'Researching' },
      { start: '11:00', end: '13:00', location: 'Harbor', activity: 'Walking' },
      { start: '13:00', end: '15:00', location: 'Cafe', activity: 'Writing' },
      { start: '15:00', end: '20:00', location: 'Library', activity: 'Reading' },
      { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Resting', kind: 'sleep' },
    ]
    const scheduleRow = { personId: state.personId, timelineId: 'home-main',
      worldDate: WORLD_TIME.slice(0, 10), itemsJson: JSON.stringify(schedule), generatedAt: WORLD_TIME, createdVersion: null }
    await fixture.db.insert(schedules).values(scheduleRow)
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [state])
    baseline.rows.schedules = [scheduleRow]
    await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
      modelJson: JSON.stringify({ name: 'Home world', description: 'A small town',
        locations: [{ name: 'Cafe', description: 'A cafe' }, { name: 'Library', description: 'A library' },
          { name: 'Harbor', description: 'A harbor' }], residents: [{ id: state.personId, name: 'Mina', model }],
        projectionBaseline: baseline }) })
    await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0,
      simTime: WORLD_TIME, worldModelVersion: 1, updatedAt: WORLD_TIME })
    await fixture.db.update(worlds).set({ status: 'running', callsToday: 0, callsDay: new Date().toISOString().slice(0, 10),
      lastUserActivityAt: new Date().toISOString() }).where(eq(worlds.id, 'home-world'))
    const env = { ...fixture.env, ...readDevVars(), WORLD_SPEED: '360', TICK_CALL_CAP: '1',
      DAILY_CALL_CAP: String(MAX_ATTEMPTS), DIRECTOR_LLM: '0', IDLE_ARCHIVE_DAYS: '30' }

    for (let index = 0; index < MAX_ATTEMPTS; index++) {
      if (attempts >= MAX_ATTEMPTS) throw new Error('Live attempt safety cap reached')
      const realNow = Date.now()
      await fixture.db.update(timelines).set({ lastRealTickAt: new Date(realNow - 15_000).toISOString() })
        .where(eq(timelines.id, 'home-main'))
      const result = await runTick(env, fixture.db)
      attempts++
      const calls = await fixture.db.select().from(llmCallLog).where(eq(llmCallLog.worldId, 'home-world')).all()
      if (calls.length > MAX_ATTEMPTS) throw new Error('Live call ledger exceeded the eight-attempt safety cap')
      void result
    }

    const receipts = await fixture.db.select().from(llmCallLog).where(eq(llmCallLog.worldId, 'home-world')).all()
    const snapshot = await buildWorldSnapshot(fixture.db, 'home-world', 'home-main')
    const freshContext = snapshot && await buildEngineContext(fixture.db, state.personId, snapshot)
    const replay = await rebuildProjection(fixture.db, 'home-world', 'home-main',
      await collectReplayInput(fixture.db, 'home-world', 'home-main'),
      await readCurrentProjection(fixture.db, 'home-world', 'home-main'))
    const result = {
      isolatedDatabase: true,
      liveAttempts: attempts,
      hardCap: MAX_ATTEMPTS,
      retries: 0,
      continuousDecisionPoints: receipts.length,
      receiptOutcomes: receipts.map(receipt => ({ status: receipt.status, errorCode: receipt.errorCode })),
      allReceiptsHaveContextAndContract: receipts.every(receipt => /^[a-f0-9]{64}$/.test(receipt.contextHash ?? '')
        && receipt.contractVersion === 'beat/v1' && receipt.status === 'completed'),
      freshReentryContextAvailable: !!freshContext && freshContext.state.lastBeatSimTime !== WORLD_TIME,
      replay: { status: replay.status, differences: replay.differences.map(difference => ({ domain: difference.domain,
        kind: difference.kind, reasonCode: difference.reasonCode })) },
    }
    console.log(JSON.stringify(result, null, 2))
    if (receipts.length < 2 || !result.allReceiptsHaveContextAndContract || !result.freshReentryContextAvailable
      || replay.status !== 'complete' || replay.differences.length > 0) process.exitCode = 1
  } finally {
    fixture.close()
  }
}

try { await main() }
catch (error) {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error'
  console.error(`S01 live journey failed after ${attempts}/${MAX_ATTEMPTS} authorized attempts (${name}); raw prompts, responses, credentials and private markers were not printed.`)
  process.exitCode = 1
}
