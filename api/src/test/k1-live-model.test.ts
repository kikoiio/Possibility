import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildWorldSnapshot } from '../agent/engine-context'
import { dialogueTurns, dialogues, llmCallLog, persons, personStates, userLlmConfigs, worldPersons } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from './world-fixture'
import { dialogueExecutor } from '../engine/steps/dialogue'
import { worldReservation } from '../engine/guard'
import { budgetFromEnv } from '../engine/budget'
import { forkTimeline } from '../life/fork'
import { resolveLlmConfig } from '../llm/resolve'
import { commitWorldCommand } from '../world-state/commit'
import { startNpcDialogue } from '../world-state/system'

const varsPath = join(dirname(fileURLToPath(import.meta.url)), '../../.dev.vars.k1-test')
const mayRun = process.env.K1_RUN_LIVE_MODEL === '1' && existsSync(varsPath)
const CONSTRUCTOR_CANARY = 'K1_CONSTRUCTOR_ONLY_19d4b7'
const ADA_PRIVATE_CANARY = 'K1_ADA_PRIVATE_84c2a1'
const emptyModel = JSON.stringify({ identity: [], behavior: [], speech: [], skills: [], memories: [],
  relationships: [], boundaries: [], unknowns: [] })

function readLiveConfig(): { baseUrl: string; apiKey: string; model: string } {
  const permissions = statSync(varsPath).mode & 0o777
  if ((permissions & 0o077) !== 0) throw new Error('api/.dev.vars.k1-test 权限过宽；请执行 chmod 600')
  const values = new Map<string, string>()
  for (const line of readFileSync(varsPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(K1_TEST_LLM_BASE_URL|K1_TEST_LLM_API_KEY|K1_TEST_LLM_MODEL)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const value = match[2]!.replace(/^(?:"(.*)"|'(.*)')$/, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)
    values.set(match[1]!, value)
  }
  const baseUrl = values.get('K1_TEST_LLM_BASE_URL')
  const apiKey = values.get('K1_TEST_LLM_API_KEY')
  const model = values.get('K1_TEST_LLM_MODEL')
  if (!baseUrl || !apiKey || !model) throw new Error('专用测试模型配置缺少字段；请检查变量名')
  const endpoint = new URL(baseUrl)
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)) {
    throw new Error('专用测试模型 endpoint 必须使用 HTTPS（本机回环地址可使用 HTTP）')
  }
  return { baseUrl, apiKey, model }
}

afterEach(() => vi.unstubAllGlobals())

it.skipIf(!mayRun)('makes one bounded live dialogue turn per resident and records private-test request evidence', async () => {
  const config = readLiveConfig()
  const fixture = await createWorldFixture()
  const captured: { personId: string; system: string; user: string; output?: string; status: string }[] = []
  const providerStatuses: number[] = []
  const evidencePath = `/tmp/possibility-k1-live-model-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  let runStatus = 'running'
  try {
    fixture.env.LLM_BASE_URL = config.baseUrl
    fixture.env.LLM_API_KEY = config.apiKey
    fixture.env.LLM_MODEL = config.model
    const originalFetch = globalThis.fetch.bind(globalThis)
    fixture.env.LLM_PROVIDER = {
      fetch: async (request: Request) => {
        const response = await originalFetch(request)
        providerStatuses.push(response.status)
        return response
      },
    } as unknown as NonNullable<typeof fixture.env.LLM_PROVIDER>
    // Two residents × one decide step, with the contract client's single invalid-JSON retry.
    // The finite cap leaves one slot so the world is not paused before the final write commits.
    await fixture.db.insert(userLlmConfigs).values({ userId: 'owner', dailyCallCap: 5, updatedAt: new Date().toISOString() })
    await fixture.db.insert(persons).values(['ada', 'bo'].map(id => ({ id, userId: 'owner', name: id.toUpperCase(),
      modelJson: emptyModel, createdAt: WORLD_TIME })))
    await fixture.db.insert(worldPersons).values(['ada', 'bo'].map(personId => ({ worldId: 'home-world', personId, joinedAt: WORLD_TIME })))
    await fixture.db.insert(personStates).values(['ada', 'bo'].map(personId => ({ personId, timelineId: 'home-main',
      simTime: WORLD_TIME, location: 'Cafe', activity: 'Talking', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })))
    await commitWorldCommand(fixture.db, { id: 'live-seed-private', worldId: 'home-world', timelineId: 'home-main',
      userId: 'owner', expectedVersion: 0, action: { type: 'inform', recipientId: 'ada', topic: 'sealed note',
        content: `${ADA_PRIVATE_CANARY} may be under the chapel` } })
    const fork = await forkTimeline(fixture.db, 'home-world', 'home-main', { whatIf: CONSTRUCTOR_CANARY,
      startTime: WORLD_TIME, changedVariable: 'weather', participants: ['ada', 'bo'], invariants: [] }, 'live-k1-fork')
    await startNpcDialogue(fixture.db, { worldId: 'home-world', timelineId: fork.id, sourceKey: 'live-k1-dialogue',
      participantIds: ['ada', 'bo'], location: 'Cafe', turnLimit: 2 })
    const dialogue = (await fixture.db.select().from(dialogues).where(eq(dialogues.timelineId, fork.id)).get())!

    for (const personId of ['ada', 'bo']) {
      const snapshot = await buildWorldSnapshot(fixture.db, 'home-world', fork.id)
      const step = { kind: 'dialogue_turn' as const, worldId: 'home-world', timelineId: fork.id,
        personId, priority: 1, dialogueId: dialogue.id }
      const input = await dialogueExecutor.perceive(fixture.db, step, snapshot!)
      if (!input) throw new Error(`居民 ${personId} 的隔离测试对话上下文不可用`)
      const text = `${input.prompt.system}\n${input.prompt.user}`
      if (text.includes(CONSTRUCTOR_CANARY)) throw new Error('居民提示输入包含构造者专用 canary')
      if (personId === 'bo' && !text.includes('转述中的传闻仍是传闻')) throw new Error('后续居民提示缺少传闻边界说明')
      if (personId === 'bo' && captured[0]?.output && !text.includes(captured[0].output)) {
        throw new Error('后续居民提示没有包含实际听到的上一轮发言')
      }
      if (personId === 'bo' && text.includes(ADA_PRIVATE_CANARY) && !captured[0]?.output?.includes(ADA_PRIVATE_CANARY)) {
        throw new Error('后续居民在该信息说出口前收到其他居民的私人 canary')
      }
      captured.push({ personId, system: input.prompt.system, user: input.prompt.user, status: 'prompt_built' })
      const reserve = worldReservation(fixture.db, 'home-world', budgetFromEnv(fixture.env), {
        timelineId: fork.id, personId, purpose: 'dialogue_turn',
      })
      const resolution = await resolveLlmConfig(fixture.db, fixture.env, { userId: 'owner', worldId: 'home-world' }, reserve)
      const decision = await dialogueExecutor.decide(fixture.env, input, { maxCalls: 1, reserve,
        llm: { baseUrl: resolution.config.baseUrl, apiKey: resolution.config.apiKey, model: resolution.config.model,
          source: resolution.source, apiKeySource: resolution.apiKeySource, apiKeyVerified: resolution.verificationValid } })
      if (!decision.value || decision.value.failed) {
        captured[captured.length - 1]!.status = 'provider_or_contract_failure'
        throw new Error(`隔离测试模型未返回有效居民发言（${personId}）`)
      }
      captured[captured.length - 1]!.output = decision.value.utterance
      captured[captured.length - 1]!.status = 'provider_response_valid'
      await dialogueExecutor.act(fixture.db, fixture.env, input, decision.value)
    }

    expect(captured.some(item => item.system.includes(CONSTRUCTOR_CANARY) || item.user.includes(CONSTRUCTOR_CANARY))).toBe(false)
    expect(await fixture.db.select().from(dialogueTurns).where(eq(dialogueTurns.dialogueId, dialogue.id)).all()).toHaveLength(2)
    const receipts = await fixture.db.select().from(llmCallLog).all()
    expect(receipts.length).toBeGreaterThanOrEqual(2)
    expect(receipts.length).toBeLessThanOrEqual(4)
    expect(receipts.map(receipt => ({ personId: receipt.personId, purpose: receipt.purpose, status: receipt.status })))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ personId: 'ada', purpose: 'dialogue_turn', status: 'completed' }),
        expect.objectContaining({ personId: 'bo', purpose: 'dialogue_turn', status: 'completed' }),
      ]))
    runStatus = 'passed'
  } catch (error) {
    runStatus = 'failed'
    throw error
  } finally {
    const receipts = await fixture.db.select().from(llmCallLog).all()
    const evidence = { date: new Date().toISOString(), model: config.model, status: runStatus,
      requestCount: receipts.length, inputsAndObservedOutputs: captured,
      providerHttpStatuses: providerStatuses,
      retryBudget: 'At most two provider attempts per resident turn; total limit 4',
      observations: { constructorScenarioCanaryInInputs: captured.some(item =>
        item.system.includes(CONSTRUCTOR_CANARY) || item.user.includes(CONSTRUCTOR_CANARY)),
        adaPrivateInformationSpoken: captured[0]?.output?.includes(ADA_PRIVATE_CANARY) ?? false,
        rumorBoundaryIncludedForBo: captured[1] ? (captured[1].system + captured[1].user).includes('转述中的传闻仍是传闻') : false },
      calls: receipts.map(receipt => ({ personId: receipt.personId, purpose: receipt.purpose,
        status: receipt.status, errorCode: receipt.errorCode })) }
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    console.info(`K1 live evidence saved: ${evidencePath}`)
    fixture.close()
  }
})
