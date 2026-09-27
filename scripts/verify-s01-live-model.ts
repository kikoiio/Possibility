import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildEngineContext, buildWorldSnapshot } from '../api/src/agent/engine-context'
import { buildDialoguePrompt } from '../api/src/agent/engine-prompt'
import { budgetFromEnv } from '../api/src/engine/budget'
import { worldReservation } from '../api/src/engine/guard'
import { configFromEnv, complete } from '../api/src/llm/client'
import { extractJson } from '../api/src/agent/engine-prompt'
import { memories, persons, personStates, universeRevisions, worldCommands, worldFacts, worldModelVersions, worldPersons } from '../api/src/db/schema'
import { createWorldFixture, WORLD_TIME } from '../api/src/test/world-fixture'
import { createRootProjectionBaseline } from '../api/src/world-state/model'

let currentStage = 'startup'
let totalCalls = 0
const MAX_LIVE_ATTEMPTS = 8

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
    throw new Error('The local api/.dev.vars must define LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.')
  }
  return result as { LLM_BASE_URL: string; LLM_API_KEY: string; LLM_MODEL: string }
}

function answerText(output: string, marker: string) {
  try {
    const parsed = extractJson(output) as { utterance?: unknown; thought?: unknown }
    return [parsed.utterance].filter((value): value is string => typeof value === 'string').join(' / ')
      .replaceAll(marker, '[私密标记]')
  } catch { return output.slice(0, 300).replaceAll(marker, '[私密标记]') }
}

async function main() {
  if (process.env.S01_LIVE_MODEL_ACK !== 'YES') {
    throw new Error('Set S01_LIVE_MODEL_ACK=YES to authorize up to eight billable model attempts.')
  }
  currentStage = 'fixture'
  const fixture = await createWorldFixture()
  try {
    const marker = `KITE-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`
    const model = {
      identity: [{ text: '你是谨慎的档案管理员。', provenance: 'known' }],
      behavior: [{ text: '区分传闻与确证；不知道时直接说明。', provenance: 'known' }],
      speech: [{ text: '简洁、诚实。', provenance: 'known' }], skills: [], memories: [], relationships: [],
      boundaries: [{ text: '不得声称知道未送达给自己的私人消息。', provenance: 'known' }],
      unknowns: ['未被告知的私人档案内容'],
    }
    const states = ['ada', 'bo'].map(personId => ({ personId, timelineId: 'home-main', simTime: WORLD_TIME,
      location: 'Cafe', activity: '整理档案', mood: '平静', goal: '核对记录', currentDialogueId: null,
      lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME }))
    await fixture.db.insert(persons).values([
      { id: 'ada', userId: 'owner', name: 'Ada', modelJson: JSON.stringify(model), createdAt: WORLD_TIME },
      { id: 'bo', userId: 'owner', name: 'Bo', modelJson: JSON.stringify(model), createdAt: WORLD_TIME },
    ])
    await fixture.db.insert(worldPersons).values(['ada', 'bo'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
    await fixture.db.insert(personStates).values(states)
    const pinnedModel = { name: 'Home world', description: 'A small town',
      locations: [{ name: 'Cafe', description: '档案阅览处' }, { name: 'Library', description: '图书馆' }],
      residents: ['ada', 'bo'].map(id => ({ id, name: id === 'ada' ? 'Ada' : 'Bo', model })),
      projectionBaseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, states) }
    await fixture.db.insert(worldModelVersions).values({ worldId: 'home-world', version: 1, createdAt: WORLD_TIME,
      modelJson: JSON.stringify(pinnedModel) })
    await fixture.db.insert(universeRevisions).values({ timelineId: 'home-main', version: 0, simTime: WORLD_TIME,
      worldModelVersion: 1, updatedAt: WORLD_TIME })

    const action = { type: 'inform', recipientId: 'ada', topic: 'S01 archive marker',
      content: `The east archive marker is ${marker}.`, sourceFactId: null }
    const commandId = 'live-acceptance-private-message'
    await fixture.db.insert(worldCommands).values({ id: commandId, worldId: 'home-world', timelineId: 'home-main',
      actorKind: 'builder', actorId: 'owner', type: 'inform', payloadJson: JSON.stringify(action), expectedVersion: 0,
      resultVersion: 1, tickLeaseToken: null, createdAt: WORLD_TIME })
    await fixture.db.update(universeRevisions).set({ version: 1, updatedAt: WORLD_TIME })
      .where(eq(universeRevisions.timelineId, 'home-main'))
    await fixture.db.insert(worldFacts).values({ id: 'live-acceptance-private-fact', timelineId: 'home-main', version: 1,
      simTime: WORLD_TIME, factType: 'knowledge', subjectId: 'ada:S01 archive marker',
      valueJson: JSON.stringify({ ...action, certainty: 'rumor' }), sourceCommandId: commandId, visibility: 'private', supersedesId: null })

    const env = { ...fixture.env, ...readDevVars(), DAILY_CALL_CAP: '10' }
    const call = async (personId: string, utterance: string) => {
      if (totalCalls >= MAX_LIVE_ATTEMPTS) throw new Error(`S01 live model safety cap reached (${MAX_LIVE_ATTEMPTS})`)
      currentStage = `model-call-${totalCalls + 1}:${personId}`
      const snapshot = await buildWorldSnapshot(fixture.db, 'home-world', 'home-main')
      if (!snapshot) throw new Error('Could not build acceptance snapshot')
      const context = await buildEngineContext(fixture.db, personId, snapshot)
      if (!context) throw new Error(`Could not build context for ${personId}`)
      const prompt = buildDialoguePrompt(context, ['Visitor'], [{ personName: 'Visitor', utterance }],
        { isLastTurn: false, location: 'Cafe' })
      const reservation = worldReservation(fixture.db, 'home-world', budgetFromEnv(env), {
        timelineId: 'home-main', personId, purpose: 'dialogue_turn',
      })
      let output: string
      try {
        output = await complete(configFromEnv(env, reservation), [
          { role: 'system', content: prompt.system }, { role: 'user', content: prompt.user },
        ], { maxTokens: 180, timeoutMs: 60_000 })
      } finally { totalCalls += reservation.calls }
      return { context, output }
    }

    currentStage = 'model-call-1:ada'
    const adaFirst = await call('ada', '你知道 S01 archive marker 是什么吗？请说明它是确证还是传闻。')
    const adaKnowsOnlyAsRumor = adaFirst.context.knownFacts?.some(fact => fact.text.includes(marker)
      && fact.certainty === 'rumor') === true
    const adaResponseRespectsCertainty = adaFirst.output.includes(marker)
      && /传闻|听说|未证实|尚未证实/.test(adaFirst.output)

    currentStage = 'model-call-2:bo'
    const boFirst = await call('bo', '你知道 S01 archive marker 的确切值吗？不知道就明确说不知道。')
    const boHasNoPrivateFact = boFirst.context.knownFacts?.some(fact => fact.text.includes(marker)) !== true
    const boDoesNotGuessCanary = !boFirst.output.includes(marker)

    await fixture.db.insert(memories).values({ id: 'live-acceptance-memory', personId: 'ada', timelineId: 'home-main',
      type: 'relationship', content: `Visitor previously told Ada the S01 archive marker is ${marker}; it remains an unconfirmed rumor.`,
      importance: 8, simTime: WORLD_TIME, createdAt: WORLD_TIME, summarized: false })
    currentStage = 'model-call-3:ada-followup'
    const adaFollowup = await call('ada', '你还记得之前听到的 S01 archive marker 吗？它确定了吗？')
    const adaRetainsContext = adaFollowup.context.memories.some(memory => memory.content.includes(marker))
      && adaFollowup.output.includes(marker)
      && /传闻|听说|未证实|尚未证实/.test(adaFollowup.output)

    // Simulate leaving and re-entering: construct fresh snapshots and contexts from
    // the persisted ledger rather than carrying an in-memory model context forward.
    const adaRestored = await call('ada', '重新进入后，请回顾 S01 archive marker，并说明当前可信度。')
    const adaRestoredHasPersistedMemory = adaRestored.context.memories.some(memory => memory.content.includes(marker))
      && adaRestored.output.includes(marker)
      && /传闻|听说|未证实|尚未证实/.test(adaRestored.output)

    const result = { localIsolatedDatabase: true, liveCalls: totalCalls, maxLiveAttempts: MAX_LIVE_ATTEMPTS,
      automaticRetries: 0, privateFactVisibleOnlyToRecipient: boHasNoPrivateFact && adaKnowsOnlyAsRumor,
      recipientPreservesRumorCertainty: adaResponseRespectsCertainty, otherResidentDoesNotGuessPrivateCanary: boDoesNotGuessCanary,
      followupContextRetainsMemoryAndUncertainty: adaRetainsContext,
      leaveAndReturnRestoresMemoryAndUncertainty: adaRestoredHasPersistedMemory,
      reviewedResponses: { recipient: answerText(adaFirst.output, marker), otherResident: answerText(boFirst.output, marker),
        followup: answerText(adaFollowup.output, marker), restored: answerText(adaRestored.output, marker) } }
    console.log(JSON.stringify(result, null, 2))
    if (!result.privateFactVisibleOnlyToRecipient || !result.recipientPreservesRumorCertainty
      || !result.otherResidentDoesNotGuessPrivateCanary || !result.followupContextRetainsMemoryAndUncertainty
      || !result.leaveAndReturnRestoresMemoryAndUncertainty || totalCalls > MAX_LIVE_ATTEMPTS) process.exitCode = 1
  } finally {
    try { fixture.close() }
    catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error'
      console.error(`Isolated SQLite cleanup reported ${name}.`)
    }
  }
}

try { await main() }
catch (error) {
  const info = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown; cause?: unknown } : {}
  const message = typeof info.message === 'string' ? info.message : ''
  const providerStatus = message.match(/LLM 请求失败（(\d{3})）/)?.[1]
  const transportCode = (info.cause && typeof info.cause === 'object'
    ? (info.cause as { code?: unknown }).code : undefined)
  const safeCause = typeof transportCode === 'string' && /^[A-Z0-9_]{2,32}$/.test(transportCode) ? transportCode : undefined
  const safeDetail = currentStage === 'fixture' ? `: ${message}`
    : providerStatus ? `: provider HTTP ${providerStatus}`
      : safeCause ? `: transport ${safeCause}`
        : /fetch failed/i.test(message) ? ': fetch transport failed'
          : /超时|timeout/i.test(message) ? ': request timed out' : ''
  console.error(`S01 live model acceptance failed at ${currentStage} after ${totalCalls} reserved call(s) (${String(info.name ?? 'Error')})${safeDetail}. Provider credentials and raw responses were not printed.`)
  process.exitCode = 1
}
