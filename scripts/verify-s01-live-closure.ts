import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq, ne } from 'drizzle-orm'
import { buildAgentContext } from '../api/src/agent/context'
import { buildEngineContext, buildWorldSnapshot } from '../api/src/agent/engine-context'
import { buildBeatPrompt, buildDialoguePrompt, buildScenePrompt, buildSummaryPrompt } from '../api/src/agent/engine-prompt'
import { buildSystemPrompt } from '../api/src/agent/prompt'
import { budgetFromEnv } from '../api/src/engine/budget'
import { worldReservation } from '../api/src/engine/guard'
import { applyBeatOutput, normalizeBeatJson } from '../api/src/engine/steps/beat'
import { normalizeDialogueJson } from '../api/src/engine/steps/dialogue'
import { normalizeSummaryJson } from '../api/src/engine/steps/summary'
import { aggregateImportance } from '../api/src/agent/memory'
import { complete, completeContract, configFromEnv, type ChatMessage } from '../api/src/llm/client'
import { LLM_CONTRACT_VERSIONS, llmError, parseContractObject } from '../api/src/llm/contracts'
import { parseSceneOutput } from '../api/src/scene/parse'
import {
  llmCallLog,
  memories,
  persons,
  personStates,
  universeRevisions,
  worldCommands,
  worldFacts,
  worldModelVersions,
  worldPersons,
  worlds,
} from '../api/src/db/schema'
import { createWorldFixture, WORLD_TIME } from '../api/src/test/world-fixture'
import { commitWorldCommand } from '../api/src/world-state/commit'
import { collectReplayInput, readCurrentProjection } from '../api/src/world-state/evidence'
import { createRootProjectionBaseline, ensureUniverseRevision } from '../api/src/world-state/model'
import { rebuildProjection } from '../api/src/world-state/rebuild'
import { recordDialogueTurn, recordMemorySummary, startNpcDialogue } from '../api/src/world-state/system'
import type { WorldAction } from '../api/src/world-state/types'

const MAX_LIVE_ATTEMPTS = 8
const WORLD_ID = 'home-world'
const TIMELINE_ID = 'home-main'
let stage = 'startup'

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

function preservesUncertainty(text: string): boolean {
  return /传闻|听说|未证实|尚未证实|不确定|rumou?r|unconfirmed|not verified/i.test(text)
}

async function main() {
  if (process.env.S01_LIVE_CLOSURE_ACK !== 'YES') {
    throw new Error('Set S01_LIVE_CLOSURE_ACK=YES to authorize exactly eight or fewer billable model attempts.')
  }
  const fixture = await createWorldFixture()
  try {
    stage = 'fixture'
    const marker = `KITE-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`
    const model = {
      identity: [{ text: '你是谨慎的档案管理员。', provenance: 'known' }],
      behavior: [{ text: '区分传闻与确证；不知道时直接说明。', provenance: 'known' }],
      speech: [{ text: '简洁、诚实。', provenance: 'known' }], skills: [], memories: [], relationships: [],
      boundaries: [{ text: '不得声称知道未送达给自己的私人消息。', provenance: 'known' }],
      unknowns: ['未被告知的私人档案内容'],
    }
    const visitorModel = { ...model, identity: [{ text: '你是来访者。', provenance: 'known' }] }
    const states = ['ada', 'bo', 'visitor'].map(personId => ({
      personId, timelineId: TIMELINE_ID, simTime: WORLD_TIME, location: 'Cafe', activity: '整理档案',
      mood: '平静', goal: '核对记录', currentDialogueId: null, lastBeatSimTime: WORLD_TIME, updatedRealAt: WORLD_TIME,
    }))
    await fixture.db.insert(persons).values([
      { id: 'ada', userId: 'owner', name: 'Ada', modelJson: JSON.stringify(model), createdAt: WORLD_TIME },
      { id: 'bo', userId: 'owner', name: 'Bo', modelJson: JSON.stringify(model), createdAt: WORLD_TIME },
      { id: 'visitor', userId: 'owner', name: 'Visitor', modelJson: JSON.stringify(visitorModel), isUser: true, createdAt: WORLD_TIME },
    ])
    await fixture.db.insert(worldPersons).values(['ada', 'bo', 'visitor'].map(personId => ({
      worldId: WORLD_ID, personId, joinedAt: WORLD_TIME,
    })))
    await fixture.db.insert(personStates).values(states)
    const pinnedModel = {
      name: 'Home world', description: 'A small town',
      locations: [{ name: 'Cafe', description: '档案阅览处' }, { name: 'Library', description: '图书馆' }],
      residents: [
        { id: 'ada', name: 'Ada', model }, { id: 'bo', name: 'Bo', model },
        { id: 'visitor', name: 'Visitor', model: visitorModel },
      ],
      projectionBaseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, states),
    }
    await fixture.db.insert(worldModelVersions).values({
      worldId: WORLD_ID, version: 1, createdAt: WORLD_TIME, modelJson: JSON.stringify(pinnedModel),
    })
    await fixture.db.insert(universeRevisions).values({
      timelineId: TIMELINE_ID, version: 0, simTime: WORLD_TIME, worldModelVersion: 1, updatedAt: WORLD_TIME,
    })
    await fixture.db.update(worlds).set({ callsToday: 0, callsDay: new Date().toISOString().slice(0, 10), status: 'running' })
      .where(eq(worlds.id, WORLD_ID))

    const env = { ...fixture.env, ...readDevVars(), DAILY_CALL_CAP: String(MAX_LIVE_ATTEMPTS + 1) }
    const budget = budgetFromEnv(env)
    const receipts = () => fixture.db.select().from(llmCallLog).where(eq(llmCallLog.worldId, WORLD_ID)).all()
    const assertCallBudget = async () => {
      const rows = await receipts()
      if (rows.length > MAX_LIVE_ATTEMPTS) throw new Error(`Live call safety cap exceeded: ${rows.length}`)
      return rows
    }
    const callText = async (purpose: 'chat', personId: string, messages: ChatMessage[]) => {
      if ((await assertCallBudget()).length >= MAX_LIVE_ATTEMPTS) throw new Error('Live call safety cap reached')
      const reserve = worldReservation(fixture.db, WORLD_ID, budget, { timelineId: TIMELINE_ID, personId, purpose })
      return complete(configFromEnv(env, reserve), messages, {
        maxTokens: 240, timeoutMs: 60_000, contractVersion: 'chat-completions/v1',
      })
    }
    const callContract = async <T>(purpose: 'scene' | 'dialogue_turn' | 'beat' | 'summary', personId: string,
      contractVersion: string, messages: ChatMessage[], parse: (raw: string) => T, maxTokens = 900) => {
      if ((await assertCallBudget()).length >= MAX_LIVE_ATTEMPTS) throw new Error('Live call safety cap reached')
      const reserve = worldReservation(fixture.db, WORLD_ID, budget, { timelineId: TIMELINE_ID, personId, purpose })
      return completeContract(configFromEnv(env, reserve), messages, {
        maxTokens, timeoutMs: 60_000, contractVersion, parse,
      })
    }
    const commit = async (id: string, action: WorldAction, actorKind: 'owner' | 'visitor' | 'system' = 'owner', actorPersonId?: string) => {
      const revision = await ensureUniverseRevision(fixture.db, WORLD_ID, TIMELINE_ID)
      return commitWorldCommand(fixture.db, {
        id, worldId: WORLD_ID, timelineId: TIMELINE_ID, userId: 'owner', actorKind, actorPersonId,
        expectedVersion: revision.version, action,
      })
    }

    const privateKnowledge = await commit('live-closure-private-inform', {
      type: 'inform', recipientId: 'ada', topic: 'S01 archive marker',
      content: `The east archive marker is ${marker}.`,
    })

    stage = 'call-1:ordinary-chat'
    const chatContext = await buildAgentContext(fixture.db, {
      userId: 'owner', personId: 'ada', timelineId: TIMELINE_ID, mode: 'chat',
    })
    if (!chatContext) throw new Error('Could not build ordinary chat context')
    const chatReply = await callText('chat', 'ada', [
      { role: 'system', content: buildSystemPrompt(chatContext) },
      { role: 'user', content: '请告诉我 S01 archive marker，并明确说明它是传闻还是已证实。' },
    ])
    const ordinaryChatPass = chatReply.includes(marker) && preservesUncertainty(chatReply)

    stage = 'call-2:in-person-scene'
    let snapshot = await buildWorldSnapshot(fixture.db, WORLD_ID, TIMELINE_ID)
    let adaContext = snapshot && await buildEngineContext(fixture.db, 'ada', snapshot)
    if (!snapshot || !adaContext) throw new Error('Could not build scene context')
    const scenePrompt = buildScenePrompt(adaContext, { name: 'Visitor', profile: '来核对档案的访客' }, 'Cafe', [
      { personName: 'Visitor', utterance: '请告诉我 S01 archive marker，并保留它当前的可信度。' },
    ])
    const scene = await callContract('scene', 'ada', LLM_CONTRACT_VERSIONS.sceneResponse, [
      { role: 'system', content: scenePrompt.system }, { role: 'user', content: scenePrompt.user },
    ], raw => parseSceneOutput(parseContractObject(raw, LLM_CONTRACT_VERSIONS.sceneResponse)))
    const scenePass = scene.utterance.includes(marker) && preservesUncertainty(scene.utterance)

    stage = 'call-3:dialogue-private-isolation'
    snapshot = await buildWorldSnapshot(fixture.db, WORLD_ID, TIMELINE_ID)
    const boBefore = snapshot && await buildEngineContext(fixture.db, 'bo', snapshot)
    if (!snapshot || !boBefore) throw new Error('Could not build isolated dialogue context')
    const privateExcluded = !boBefore.knownFacts?.some(fact => fact.text.includes(marker))
    const boBeforePrompt = buildDialoguePrompt(boBefore, ['Ada'], [
      { personName: 'Ada', utterance: '你知道 S01 archive marker 的确切值吗？不知道就直说。' },
    ], { isLastTurn: false, location: 'Cafe' })
    const boUnknown = await callContract('dialogue_turn', 'bo', LLM_CONTRACT_VERSIONS.dialogue, [
      { role: 'system', content: boBeforePrompt.system }, { role: 'user', content: boBeforePrompt.user },
    ], raw => normalizeDialogueJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.dialogue)))
    const privateIsolationPass = privateExcluded && !boUnknown.utterance.includes(marker)

    const relayed = await commit('live-closure-relay', {
      type: 'inform', recipientId: 'bo', topic: 'S01 archive marker',
      content: `Ada relayed that the east archive marker is ${marker}.`, sourceFactId: privateKnowledge.factId,
    })
    await startNpcDialogue(fixture.db, {
      worldId: WORLD_ID, timelineId: TIMELINE_ID, sourceKey: 'live-closure-npc-dialogue',
      participantIds: ['bo', 'ada'], location: 'Cafe', turnLimit: 1,
    })

    stage = 'call-4:multi-hop-dialogue'
    snapshot = await buildWorldSnapshot(fixture.db, WORLD_ID, TIMELINE_ID)
    const boAfter = snapshot && await buildEngineContext(fixture.db, 'bo', snapshot)
    if (!snapshot || !boAfter) throw new Error('Could not build relayed dialogue context')
    const relayedFact = boAfter.knownFacts?.find(fact => fact.text.includes(marker))
    const boAfterPrompt = buildDialoguePrompt(boAfter, ['Ada'], [
      { personName: 'Ada', utterance: '请复述你收到的 S01 archive marker，并说明可信度。' },
    ], { isLastTurn: true, location: 'Cafe' })
    const boRelays = await callContract('dialogue_turn', 'bo', LLM_CONTRACT_VERSIONS.dialogue, [
      { role: 'system', content: boAfterPrompt.system }, { role: 'user', content: boAfterPrompt.user },
    ], raw => normalizeDialogueJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.dialogue)))
    const relayedRow = await fixture.db.select().from(worldFacts).where(eq(worldFacts.id, relayed.factId)).get()
    const relayedValue = relayedRow ? JSON.parse(relayedRow.valueJson) as Record<string, unknown> : null
    const relayChainPass = relayedFact?.certainty === 'rumor' && relayedFact.sourceFactId === relayed.factId
      && relayedValue?.sourceFactId === privateKnowledge.factId && relayedValue.certainty === 'rumor'
    const relayResponsePass = boRelays.utterance.includes(marker) && preservesUncertainty(boRelays.utterance)
    const multiHopPass = relayChainPass && relayResponsePass
    await recordDialogueTurn(fixture.db, {
      worldId: WORLD_ID, timelineId: TIMELINE_ID, sourceKey: 'live-closure-npc-dialogue:0',
      action: { type: 'dialogue_turn', dialogueId: 'dialogue:' + await (async () => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('live-closure-npc-dialogue'))
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      })(), speakerId: 'bo', turnIndex: 0, utterance: boRelays.utterance, thought: boRelays.thought,
      memory: boRelays.memory, shouldEnd: true },
    })

    stage = 'call-5:engine-beat'
    snapshot = await buildWorldSnapshot(fixture.db, WORLD_ID, TIMELINE_ID)
    adaContext = snapshot && await buildEngineContext(fixture.db, 'ada', snapshot)
    if (!snapshot || !adaContext) throw new Error('Could not build beat context')
    const beatPrompt = buildBeatPrompt(adaContext, null, 60)
    beatPrompt.user += `\n验收要求：thought 必须提到 ${marker}，并明确它仍是未证实传闻。`
    const beat = await callContract('beat', 'ada', LLM_CONTRACT_VERSIONS.beat, [
      { role: 'system', content: beatPrompt.system }, { role: 'user', content: beatPrompt.user },
    ], raw => normalizeBeatJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.beat), ['Cafe', 'Library'], 60))
    const beatPass = beat.thought.includes(marker) && preservesUncertainty(beat.thought)
    await applyBeatOutput(fixture.db, { worldId: WORLD_ID, timelineId: TIMELINE_ID, personId: 'ada', simNow: WORLD_TIME,
      windowStart: new Date(Date.parse(WORLD_TIME) - 60 * 60_000).toISOString(), beat,
      sourceKey: 'live-closure-valid-beat' })

    stage = 'call-6:memory-summary'
    const summaryBatch = (await fixture.db.select().from(memories).where(and(
      eq(memories.personId, 'ada'), eq(memories.timelineId, TIMELINE_ID), eq(memories.summarized, false), ne(memories.type, 'summary'),
    )).all()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (!summaryBatch.length || !summaryBatch.some(memory => memory.content.includes(marker))) {
      throw new Error('Versioned beat did not create a marker-bearing summary source')
    }
    snapshot = await buildWorldSnapshot(fixture.db, WORLD_ID, TIMELINE_ID)
    adaContext = snapshot && await buildEngineContext(fixture.db, 'ada', snapshot)
    if (!snapshot || !adaContext) throw new Error('Could not build summary context')
    const summaryPrompt = buildSummaryPrompt(adaContext, summaryBatch)
    summaryPrompt.user += '\n验收要求：摘要必须保留 S01 archive marker 的值和“未证实传闻”限定。'
    const summary = await callContract('summary', 'ada', LLM_CONTRACT_VERSIONS.summary, [
      { role: 'system', content: summaryPrompt.system }, { role: 'user', content: summaryPrompt.user },
    ], raw => normalizeSummaryJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.summary)))
    const summaryPass = summary.content.includes(marker) && preservesUncertainty(summary.content)
    const latestMemory = summaryBatch.at(-1)!
    await recordMemorySummary(fixture.db, { worldId: WORLD_ID, timelineId: TIMELINE_ID, personId: 'ada',
      sourceMemoryIds: summaryBatch.map(memory => memory.id), content: summary.content, importance: aggregateImportance(summaryBatch),
      simTime: latestMemory.simTime ?? latestMemory.createdAt, createdAt: latestMemory.createdAt })

    stage = 'call-7:invalid-output'
    const commandsBeforeInvalid = await fixture.db.select().from(worldCommands).all()
    const factsBeforeInvalid = await fixture.db.select().from(worldFacts).all()
    const revisionBeforeInvalid = await ensureUniverseRevision(fixture.db, WORLD_ID, TIMELINE_ID)
    const projectionBeforeInvalid = JSON.stringify(await readCurrentProjection(fixture.db, WORLD_ID, TIMELINE_ID))
    let invalidErrorCode: string | null = null
    try {
      await callContract('beat', 'ada', LLM_CONTRACT_VERSIONS.beat, [
        { role: 'system', content: 'This is a contract-failure acceptance sample. Output exactly the supplied JSON object and nothing else.' },
        { role: 'user', content: '{"events":[],"thought":"","memory":null,"nextLocation":null,"nextActivity":null,"mood":null,"goal":null}' },
      ], raw => normalizeBeatJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.beat), ['Cafe', 'Library'], 60), 180)
    } catch (error) {
      invalidErrorCode = llmError(error).code
    }
    const commandsAfterInvalid = await fixture.db.select().from(worldCommands).all()
    const factsAfterInvalid = await fixture.db.select().from(worldFacts).all()
    const revisionAfterInvalid = await ensureUniverseRevision(fixture.db, WORLD_ID, TIMELINE_ID)
    const projectionAfterInvalid = JSON.stringify(await readCurrentProjection(fixture.db, WORLD_ID, TIMELINE_ID))
    const invalidOutputPass = ['invalid_json', 'contract_violation'].includes(invalidErrorCode ?? '')
      && commandsAfterInvalid.length === commandsBeforeInvalid.length
      && factsAfterInvalid.length === factsBeforeInvalid.length
      && revisionAfterInvalid.version === revisionBeforeInvalid.version
      && projectionAfterInvalid === projectionBeforeInvalid

    stage = 'call-8:recovery-beat'
    snapshot = await buildWorldSnapshot(fixture.db, WORLD_ID, TIMELINE_ID)
    adaContext = snapshot && await buildEngineContext(fixture.db, 'ada', snapshot)
    if (!snapshot || !adaContext) throw new Error('Could not rebuild context after invalid output')
    const recoveryPrompt = buildBeatPrompt(adaContext, null, 60)
    recoveryPrompt.user += `\n验收要求：thought 必须提到 ${marker}，并明确它仍是未证实传闻。`
    const recoveryBeat = await callContract('beat', 'ada', LLM_CONTRACT_VERSIONS.beat, [
      { role: 'system', content: recoveryPrompt.system }, { role: 'user', content: recoveryPrompt.user },
    ], raw => normalizeBeatJson(parseContractObject(raw, LLM_CONTRACT_VERSIONS.beat), ['Cafe', 'Library'], 60))
    const recoveryOutputPass = recoveryBeat.thought.includes(marker) && preservesUncertainty(recoveryBeat.thought)
    stage = 'call-8:apply-recovery-beat'
    await applyBeatOutput(fixture.db, { worldId: WORLD_ID, timelineId: TIMELINE_ID, personId: 'ada', simNow: WORLD_TIME,
      windowStart: new Date(Date.parse(WORLD_TIME) - 60 * 60_000).toISOString(), beat: recoveryBeat,
      sourceKey: 'live-closure-recovery-beat' })

    stage = 'final:receipt-audit'
    const finalReceipts = await assertCallBudget()
    stage = 'final:projection-replay'
    const replay = await rebuildProjection(fixture.db, WORLD_ID, TIMELINE_ID,
      await collectReplayInput(fixture.db, WORLD_ID, TIMELINE_ID),
      await readCurrentProjection(fixture.db, WORLD_ID, TIMELINE_ID))
    const failedReceipts = finalReceipts.filter(receipt => receipt.status === 'failed')
    const result = {
      isolatedDatabase: true,
      liveAttempts: finalReceipts.length,
      hardCap: MAX_LIVE_ATTEMPTS,
      automaticRetries: 0,
      channels: {
        ordinaryChat: ordinaryChatPass,
        inPersonScene: scenePass,
        privateDialogueIsolation: privateIsolationPass,
        multiHopDialogue: multiHopPass,
        engineBeat: beatPass,
        memorySummary: summaryPass,
      },
      invalidOutput: {
        rejected: invalidOutputPass,
        errorCode: invalidErrorCode,
        historyUnchanged: commandsAfterInvalid.length === commandsBeforeInvalid.length
          && factsAfterInvalid.length === factsBeforeInvalid.length && revisionAfterInvalid.version === revisionBeforeInvalid.version,
      },
      recoveryBeat: recoveryOutputPass,
      receipts: finalReceipts.map(receipt => ({ purpose: receipt.purpose, contractVersion: receipt.contractVersion,
        status: receipt.status, errorCode: receipt.errorCode, hasContextHash: /^[a-f0-9]{64}$/.test(receipt.contextHash ?? '') })),
      exactlyOneFailedContractReceipt: failedReceipts.length === 1
        && ['invalid_json', 'contract_violation'].includes(failedReceipts[0]!.errorCode ?? ''),
      versionedRelay: { sourceFactIdPreserved: relayChainPass, modelPreservedUncertainty: relayResponsePass },
      replay: { status: replay.status, differences: replay.differences.length },
    }
    console.log(JSON.stringify(result, null, 2))
    const allChannels = Object.values(result.channels).every(Boolean)
    const allReceiptsSettled = finalReceipts.every(receipt => receipt.status !== 'reserved'
      && /^[a-f0-9]{64}$/.test(receipt.contextHash ?? ''))
    if (finalReceipts.length !== MAX_LIVE_ATTEMPTS || !allChannels || !invalidOutputPass || !recoveryOutputPass
      || !result.exactlyOneFailedContractReceipt || !allReceiptsSettled
      || replay.status !== 'complete' || replay.differences.length !== 0) process.exitCode = 1
  } finally {
    try { fixture.close() } catch { /* isolated in-memory cleanup only */ }
  }
}

try { await main() }
catch (error) {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error'
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : null
  console.error(`S01 live closure failed at ${stage} (${name}${code ? `/${code}` : ''}). Credentials, prompts, raw responses and private markers were not printed.`)
  process.exitCode = 1
}
