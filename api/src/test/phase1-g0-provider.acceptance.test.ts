import { createHash } from 'node:crypto'
import { mkdirSync, unlinkSync, existsSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { isSerializedVoxelDocument } from '@possibility/voxel-contract'
import app from '../index'
import { buildTestPolicyActivationSql } from '../../scripts/prepare-scene-compatibility-fixture'
import { createTestDb } from './db'
import { llmCallLog, persons, sessions, timelines, universeEvidence, users, worldPersons, worldScenes, worldSceneRevisions, worlds } from '../db/schema'

const RAW_REQUEST_CAP = 25
const PER_SCENARIO_CAP = 5
const MAX_TOKENS = 16_000
const COST_CAP_USD = 10
const MILLION = 1_000_000
const PEAK_PRICE = { cacheHitInput: 0.006, cacheMissInput: 0.30, output: 1.20 }
const MAX_REQUEST_COST_USD = ((MILLION - MAX_TOKENS) * PEAK_PRICE.cacheMissInput + MAX_TOKENS * PEAK_PRICE.output) / MILLION

type Usage = { promptTokens: number; cacheHitTokens: number; cacheMissTokens: number; completionTokens: number; costUsd: number }
type ProviderCall = { scenario: string; status: number | null; usage: Usage | null; maxTokens: number; thinkingDisabled: boolean }
type Draft = { world: { name: string; description: string; locations: { name: string; description: string }[] }; document: unknown }
type ScenarioResult = {
  id: string
  apiStatus: number
  valid: boolean
  failureStage?: string
  normalizationFixes?: string[]
  worldReady: boolean
  validDocument: boolean
  forbiddenAbsent: boolean
  errorKind?: string
  issueCodes: string[]
  semanticGroups: Record<string, boolean>
  locationCount: number
  objectCount: number
  carrierCount: number
  carriersUnique: boolean
  carriersResolved: boolean
  carriersMatchWorld: boolean
  providerRequests: number
  llmCallLogRows: number
  worldIdHash?: string
}

const SCENARIOS = [
  {
    id: 'custom-1',
    prompt: '一条笔直的鹅卵石路从南到北穿过小镇，路旁有一家咖啡馆和一栋两层住宅，路的北端是一个小广场，广场中央有一盏石灯。',
    groups: {
      cobblestonePath: /鹅卵石|卵石|石板|铺石/u,
      northSouth: /南北|南到北|北向|纵贯|贯穿/u,
      cafe: /咖啡/u,
      twoStoryHome: /两层|二层/u,
      northPlaza: /广场/u,
      stoneLantern: /石灯/u,
    },
  },
  {
    id: 'custom-2',
    prompt: '小镇广场旁的一条街，街上有一家咖啡馆。',
    groups: { plaza: /广场/u, street: /街|路/u, cafe: /咖啡/u },
  },
  {
    id: 'custom-3',
    prompt: '一片开阔的草地，中间有一条直路，路边只有一间带大院子的咖啡馆，没有围墙没有走廊。',
    groups: {
      openGrass: /草地|草坪|草原|开阔/u,
      straightPath: /直路|道路|小路|直街/u,
      cafe: /咖啡/u,
      courtyard: /大院|院子|庭院|院落/u,
    },
    forbidden: /围墙|走廊/u,
  },
  {
    id: 'official-example',
    prompt: '海边旧车站旁的小街，路边有咖啡馆、花园和安静的住宅。',
    groups: {
      coast: /海边|海岸|海滨|海景/u,
      oldStation: /旧车站|车站/u,
      street: /小街|街道|街巷/u,
      cafe: /咖啡/u,
      garden: /花园|庭院|花圃/u,
      residence: /住宅|住家|民居|小屋/u,
    },
  },
] as const

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function numeric(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }

describe('Phase 1 G0 real-provider API acceptance (manual cloud workflow only)', () => {
  it('generates four prompt cases, saves the official example, repairs the original world, caps, reconciles, and cleans the isolated D1', async () => {
    const dbPath = process.env.G0_D1_PATH
    const reportPath = process.env.G0_EVIDENCE_FILE
    const baseUrl = process.env.LLM_BASE_URL
    const apiKey = process.env.LLM_API_KEY
    const model = process.env.LLM_MODEL
    const runId = (process.env.GITHUB_RUN_ID || `local-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-')
    const ownerId = `g0-${runId}-owner`
    const ownerName = `phase1-g0-${runId}-single`
    const repairWorldId = `phase1-g0-${runId}-repair-id`
    const repairWorldName = `phase1-g0-${runId}-repair`
    const personId = `g0-${runId}-resident`
    const token = `g0-${runId}-session`
    const now = new Date().toISOString()
    const repairLocations = [
      { name: '主楼', description: '原世界主楼' },
      { name: '温室', description: '原世界温室' },
      { name: '庭院', description: '原世界庭院' },
      { name: '书房', description: '原世界书房' },
      { name: '湖畔', description: '原世界湖畔' },
    ]
    const scenarios: ScenarioResult[] = []
    const providerCalls: ProviderCall[] = []
    const blockedAttempts: string[] = []
    const failures: string[] = []
    let activeScenario = 'setup'
    let fixture: ReturnType<typeof createTestDb> | undefined
    let singleWorldId: string | undefined
    let singleTimelineId: string | undefined
    let officialDraft: Draft | undefined
    let singleSaved = false
    let repairSaved = false
    let repairDraftStatus: number | null = null
    let repairDraftKind: string | null = null
    let repairDraftFailureStage: string | null = null
    let repairDraftNormalizationFixes: string[] = []
    let repairDraftIssueCodes: string[] = []
    let repairProviderRequests = 0
    let repairLedgerRowCount = -1
    let reconciled = false
    let cleanup = { exactNameCounts: {} as Record<string, number>, remainingTableRows: -1, d1Deleted: false }
    let actualCostUsd = 0
    let usageUnavailable = 0
    let finalLedgerRows = -1
    let finalLedgerSummary: { purpose: string; status: string | null; errorCode: string | null }[] = []
    if (!dbPath) failures.push('missing_G0_D1_PATH')
    if (!reportPath) failures.push('missing_G0_EVIDENCE_FILE')
    if (!apiKey) failures.push('missing_LLM_API_KEY')
    if (baseUrl !== 'https://api.deepseek.com') failures.push('unexpected_LLM_BASE_URL')
    if (model !== 'deepseek-flash') failures.push('unexpected_LLM_MODEL')

    const fetcher = {
      async fetch(request: Request): Promise<Response> {
        const perScenario = providerCalls.filter(call => call.scenario === activeScenario).length
        if (providerCalls.length >= RAW_REQUEST_CAP || perScenario >= PER_SCENARIO_CAP
          || (providerCalls.length + 1) * MAX_REQUEST_COST_USD > COST_CAP_USD) {
          blockedAttempts.push(activeScenario)
          throw new Error('g0_provider_request_budget_exhausted')
        }
        if (new URL(request.url).origin !== baseUrl) throw new Error('g0_unapproved_provider_origin')
        const requestBody = await request.clone().json().catch(() => null) as Record<string, unknown> | null
        const requestMaxTokens = numeric(requestBody?.max_tokens) ?? 0
        if (requestBody?.model !== model || requestMaxTokens < 1 || requestMaxTokens > MAX_TOKENS) {
          throw new Error('g0_provider_request_contract_violation')
        }
        // Acceptance-only provider contract; product generation defaults are unchanged.
        const outboundHeaders = new Headers(request.headers)
        outboundHeaders.set('content-type', 'application/json')
        outboundHeaders.delete('content-length')
        const outboundRequest = new Request(request.url, {
          method: request.method,
          headers: outboundHeaders,
          body: JSON.stringify({ ...requestBody, max_tokens: Math.min(requestMaxTokens, MAX_TOKENS), thinking: { type: 'disabled' } }),
          redirect: request.redirect,
        })
        const thinkingDisabled = true

        let responseStatus: number | null = null
        let usage: Usage | null = null
        const call = { scenario: activeScenario, status: responseStatus, usage, maxTokens: requestMaxTokens, thinkingDisabled }
        providerCalls.push(call)
        try {
          const response = await fetch(outboundRequest)
          responseStatus = response.status
          call.status = responseStatus
          const payload = await response.clone().json().catch(() => null) as { usage?: Record<string, unknown> } | null
          const rawUsage = payload?.usage
          const promptTokens = numeric(rawUsage?.prompt_tokens)
          const completionTokens = numeric(rawUsage?.completion_tokens)
          if (promptTokens !== null && completionTokens !== null) {
            const cacheHitTokens = numeric(rawUsage?.prompt_cache_hit_tokens) ?? 0
            const cacheMissTokens = numeric(rawUsage?.prompt_cache_miss_tokens) ?? Math.max(0, promptTokens - cacheHitTokens)
            const costUsd = (cacheHitTokens * PEAK_PRICE.cacheHitInput
              + cacheMissTokens * PEAK_PRICE.cacheMissInput
              + completionTokens * PEAK_PRICE.output) / MILLION
            usage = { promptTokens, cacheHitTokens, cacheMissTokens, completionTokens, costUsd }
            call.usage = usage
            actualCostUsd += costUsd
          } else usageUnavailable++
          return response
        } catch (error) {
          call.status = responseStatus
          throw error
        }
      },
    }

    const ledgerRows = async () => fixture!.db.select().from(llmCallLog).where(eq(llmCallLog.userId, ownerId)).all()
    const callApi = (path: string, body: unknown) => app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, fixture!.env)

    async function generateScenario(scenario: typeof SCENARIOS[number]): Promise<{ valid: boolean; draft?: Draft }> {
      activeScenario = scenario.id
      const ledgerBefore = (await ledgerRows()).length
      const providerBefore = providerCalls.length
      const response = await callApi('/api/scene-drafts/voxel', {
        requestId: `${runId}-${scenario.id}`, prompt: scenario.prompt, personIds: [personId],
      })
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      const draft = payload as unknown as Draft
      const world = draft.world
      const document = draft.document
      const hasWorld = !!world && Array.isArray(world.locations)
      const validDocument = isSerializedVoxelDocument(document)
      const carrierRows = validDocument && Array.isArray(document.locations) ? document.locations : []
      const carrierIds = carrierRows.map(location => location.objectId).filter((value): value is string => typeof value === 'string')
      const objectIds = new Set(validDocument ? document.objects.map(object => object.id) : [])
      const placementIds = new Set(validDocument ? (document.assetPlacements ?? []).map(placement => placement.id) : [])
      const carriersUnique = carrierIds.length === world?.locations?.length && new Set(carrierIds).size === carrierIds.length
      const carriersResolved = carrierIds.every(id => objectIds.has(id) || placementIds.has(id))
      const carriersMatchWorld = validDocument && hasWorld
        && document.locations.length === world.locations.length
        && world.locations.every(location => document.locations.some(carrier => carrier.name === location.name))
      const corpus = hasWorld ? JSON.stringify({ name: world.name, description: world.description, locations: world.locations }) : ''
      const semanticGroups = Object.fromEntries(Object.entries(scenario.groups).map(([key, pattern]) => [key, pattern.test(corpus)]))
      const objectTypeCorpus = validDocument
        ? JSON.stringify({ objects: document.objects.map(object => object.objectType), assets: (document.assetPlacements ?? []).map(asset => asset.id) })
        : ''
      const forbiddenAbsent = !('forbidden' in scenario) || !/wall|fence|corridor|hallway|围墙|走廊/iu.test(objectTypeCorpus)
      const worldReady = hasWorld && world.name.trim().length > 0 && world.description.trim().length > 0
        && world.locations.length >= 5 && world.locations.length <= 8
      const valid = response.ok && worldReady && validDocument && Object.values(semanticGroups).every(Boolean)
        && forbiddenAbsent && carriersUnique && carriersResolved && carriersMatchWorld
      const afterLedger = await ledgerRows()
      scenarios.push({
        id: scenario.id, apiStatus: response.status, valid,
        ...(typeof payload.failureStage === 'string' ? { failureStage: payload.failureStage } : {}),
        ...(Array.isArray(payload.normalizationFixes) ? { normalizationFixes: payload.normalizationFixes.filter((value): value is string => typeof value === 'string') } : {}),
        worldReady, validDocument, forbiddenAbsent,
        ...(typeof payload.kind === 'string' ? { errorKind: payload.kind } : {}),
        issueCodes: Array.isArray(payload.issues) ? payload.issues.flatMap(issue => issue && typeof issue === 'object' && 'code' in issue && typeof issue.code === 'string' ? [issue.code] : []) : [],
        semanticGroups, locationCount: hasWorld ? world.locations.length : 0,
        objectCount: validDocument ? document.objects.length : 0,
        carrierCount: carrierIds.length, carriersUnique, carriersResolved, carriersMatchWorld,
        providerRequests: providerCalls.length - providerBefore,
        llmCallLogRows: afterLedger.length - ledgerBefore,
      })
      return { valid, ...(valid ? { draft } : {}) }
    }

    try {
      if (failures.length || !dbPath || !reportPath || !apiKey || !baseUrl || !model) {
        throw new Error('harness_configuration_invalid')
      }
      mkdirSync(dirname(dbPath!), { recursive: true })
      fixture = createTestDb(dbPath!)
      fixture.env.LLM_BASE_URL = baseUrl!
      fixture.env.LLM_API_KEY = apiKey!
      fixture.env.LLM_MODEL = model!
      fixture.env.LLM_PROVIDER = fetcher as unknown as NonNullable<typeof fixture.env.LLM_PROVIDER>
      fixture.env.PREWORLD_DAILY_CAP = String(RAW_REQUEST_CAP)
      fixture.sqlite.exec(await buildTestPolicyActivationSql(now))
      await fixture.db.insert(users).values({ id: ownerId, username: ownerId, passwordHash: 'not-used', createdAt: now })
      await fixture.db.insert(sessions).values({ token, userId: ownerId, expiresAt: '2099-01-01T00:00:00.000Z' })
      await fixture.db.insert(persons).values({ id: personId, userId: ownerId, name: '隔离验收居民', modelJson: '{}', createdAt: now })

      await fixture.db.insert(worlds).values({
        id: repairWorldId, userId: ownerId, name: repairWorldName, description: 'Phase 1 G0 repair acceptance target',
        locationsJson: JSON.stringify(repairLocations), status: 'running', isDemo: false, callsToday: 0,
        callsDay: now.slice(0, 10), lastUserActivityAt: now, createdAt: now,
      })
      const repairTimelineId = `${repairWorldId}-main`
      await fixture.db.insert(timelines).values({ id: repairTimelineId, worldId: repairWorldId, parentTimelineId: null,
        simNow: now, createdAt: now, status: 'active', ancestorIdsJson: '[]' })
      await fixture.db.insert(worldPersons).values({ worldId: repairWorldId, personId, joinedAt: now })
      await fixture.db.insert(universeEvidence).values({ timelineId: repairTimelineId, level: 'complete', assessedVersion: 0,
        baselineVersion: 0, reasonCodesJson: '["phase1_g0_repair_fixture"]', assessedAt: now })

      for (const scenario of SCENARIOS) {
        const generated = await generateScenario(scenario)
        if (scenario.id === 'official-example' && generated.valid) officialDraft = generated.draft
      }

      if (officialDraft) {
        // The save reuses the official-example draft; any accidental provider call
        // remains charged to the official-example scenario budget.
        activeScenario = 'official-example'
        const saveResponse = await callApi('/api/worlds', {
          name: ownerName,
          description: officialDraft.world.description,
          locations: officialDraft.world.locations,
          personIds: [personId],
          scene: officialDraft.document,
          sceneRequestId: `${runId}-official-example-single-save`,
        })
        if (saveResponse.ok) {
          const saved = await saveResponse.json() as { id?: unknown; timelineId?: unknown }
          if (typeof saved.id === 'string' && typeof saved.timelineId === 'string') {
            singleWorldId = saved.id
            singleTimelineId = saved.timelineId
            const savedWorld = await fixture.db.select().from(worlds).where(eq(worlds.id, saved.id)).get()
            const savedTimeline = await fixture.db.select().from(timelines).where(eq(timelines.id, saved.timelineId)).get()
            const savedScene = await fixture.db.select().from(worldScenes).where(eq(worldScenes.worldId, saved.id)).get()
            const savedRevision = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, saved.id)).get()
            singleSaved = savedWorld?.id === saved.id && savedWorld.userId === ownerId && savedWorld.name === ownerName
              && savedTimeline?.id === saved.timelineId && savedTimeline.worldId === saved.id
              && savedScene?.currentVersion === 1 && savedRevision?.kind === 'initial' && savedRevision.version === 1
              && isSerializedVoxelDocument(JSON.parse(savedRevision.documentJson))
          }
        }
        if (!singleSaved) failures.push('official_example_single_space_save_not_verified')
      }

      activeScenario = 'original-world-repair'
      const repairBeforeWorld = await fixture.db.select({ id: worlds.id, name: worlds.name, locationsJson: worlds.locationsJson })
        .from(worlds).where(eq(worlds.id, repairWorldId)).get()
      const repairBeforeTimeline = await fixture.db.select().from(timelines).where(eq(timelines.id, repairTimelineId)).get()
      const repairBeforeResidents = await fixture.db.select().from(worldPersons).where(eq(worldPersons.worldId, repairWorldId)).all()
      const repairLedgerBefore = (await ledgerRows()).length
      const repairProviderBefore = providerCalls.length
      const contextResponse = await app.request(`/api/worlds/${repairWorldId}/scene/repair-context`, {
        headers: { Authorization: `Bearer ${token}` },
      }, fixture.env)
      if (!contextResponse.ok) failures.push('repair_context_failed')
      const repairDraftResponse = await callApi(`/api/worlds/${repairWorldId}/scene/repair-draft`, {
        requestId: `${runId}-original-world-repair`,
        prompt: '沿用原来的主楼、温室、庭院、书房和湖畔，补齐入口之间可步行的石板路。',
      })
      repairDraftStatus = repairDraftResponse.status
      const repairPayload = await repairDraftResponse.clone().json().catch(() => ({})) as Record<string, unknown>
      repairDraftKind = typeof repairPayload.kind === 'string' ? repairPayload.kind : null
      repairDraftFailureStage = typeof repairPayload.failureStage === 'string' ? repairPayload.failureStage : null
      repairDraftNormalizationFixes = Array.isArray(repairPayload.normalizationFixes)
        ? repairPayload.normalizationFixes.filter((value): value is string => typeof value === 'string')
        : []
      repairDraftIssueCodes = Array.isArray(repairPayload.issues)
        ? repairPayload.issues.flatMap(issue => issue && typeof issue === 'object' && 'code' in issue && typeof issue.code === 'string' ? [issue.code] : [])
        : []
      if (repairDraftResponse.ok) {
        const repairDraft = repairPayload as { document?: unknown; worldId?: string }
        if (repairDraft.worldId !== repairWorldId || !isSerializedVoxelDocument(repairDraft.document)) {
          failures.push('repair_draft_world_or_document_mismatch')
        } else {
          const response = await callApi(`/api/worlds/${repairWorldId}/scene/voxel-revision`, {
            requestId: `${runId}-original-world-repair-save`, expectedVersion: 0, repair: true, document: repairDraft.document,
          })
          if (response.ok) {
            const revision = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, repairWorldId)).get()
            const afterWorld = await fixture.db.select({ id: worlds.id, name: worlds.name, locationsJson: worlds.locationsJson })
              .from(worlds).where(eq(worlds.id, repairWorldId)).get()
            const afterTimeline = await fixture.db.select().from(timelines).where(eq(timelines.id, repairTimelineId)).get()
            const afterResidents = await fixture.db.select().from(worldPersons).where(eq(worldPersons.worldId, repairWorldId)).all()
            repairSaved = afterWorld?.id === repairBeforeWorld?.id && afterWorld?.name === repairBeforeWorld?.name
              && afterWorld?.locationsJson === repairBeforeWorld?.locationsJson
              && afterTimeline?.id === repairBeforeTimeline?.id && afterTimeline?.simNow === repairBeforeTimeline?.simNow
              && JSON.stringify(afterResidents) === JSON.stringify(repairBeforeResidents)
              && revision?.worldId === repairWorldId && revision.kind === 'scene-repair' && revision.version === 1
          } else failures.push('repair_save_rejected')
        }
      } else failures.push('repair_draft_rejected')

      repairProviderRequests = providerCalls.length - repairProviderBefore
      repairLedgerRowCount = (await ledgerRows()).length - repairLedgerBefore

      const ledger = await ledgerRows()
      finalLedgerRows = ledger.length
      finalLedgerSummary = ledger.map(row => ({ purpose: row.purpose, status: row.status, errorCode: row.errorCode }))
      const requestsByScenario = Object.fromEntries([...SCENARIOS.map(scenario => scenario.id), 'original-world-repair']
        .map(id => [id, providerCalls.filter(call => call.scenario === id).length]))
      reconciled = ledger.length === providerCalls.length && providerCalls.length <= RAW_REQUEST_CAP
        && Object.values(requestsByScenario).every(count => count <= PER_SCENARIO_CAP)
        && scenarios.every(result => result.providerRequests === result.llmCallLogRows)
        && repairProviderRequests === repairLedgerRowCount
      if (!reconciled) failures.push('llm_call_log_provider_request_reconciliation_failed')
      if (scenarios.some(result => !result.valid)) failures.push('one_or_more_prompt_scenarios_invalid')
      if (!repairSaved) failures.push('original_world_repair_save_not_verified')
    } catch (error) {
      failures.push(`harness_error:${error instanceof Error ? error.name : 'unknown'}`)
    } finally {
      if (fixture) {
        try {
          fixture.sqlite.exec('PRAGMA foreign_keys = OFF')
          const tableNames = fixture.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
          for (const { name } of tableNames) fixture.sqlite.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`)
          for (const name of [ownerName, repairWorldName]) {
            const row = fixture.sqlite.prepare('SELECT count(*) AS n FROM worlds WHERE name = ?').get(name) as { n: number }
            cleanup.exactNameCounts[name] = Number(row.n)
          }
          cleanup.remainingTableRows = tableNames.reduce((total, { name }) => {
            const row = fixture!.sqlite.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }
            return total + Number(row.n)
          }, 0)
          cleanup.d1Deleted = Object.values(cleanup.exactNameCounts).every(count => count === 0) && cleanup.remainingTableRows === 0
        } catch {
          failures.push('isolated_d1_cleanup_or_zero_row_assertion_failed')
        }
        fixture.close()
        fixture = undefined
      }
      if (dbPath) {
        try {
          for (const suffix of ['', '-wal', '-shm']) {
            const path = `${dbPath}${suffix}`
            if (existsSync(path)) unlinkSync(path)
          }
          cleanup.d1Deleted = cleanup.d1Deleted && !existsSync(dbPath)
        } catch {
          failures.push('isolated_d1_file_deletion_failed')
          cleanup.d1Deleted = false
        }
      }
      const report = {
        schema: 'phase1-g0-provider-acceptance-v1',
        workflowRunId: runId,
        commit: process.env.GITHUB_SHA ?? 'local-uncommitted',
        provider: { baseUrl, model, keyConfigured: !!apiKey },
        limits: { rawProviderRequests: RAW_REQUEST_CAP, perScenario: PER_SCENARIO_CAP, apiMaxTokens: MAX_TOKENS, thinking: 'disabled', costCapUsd: COST_CAP_USD },
        pricing: { source: 'https://api-docs.deepseek.com/quick_start/pricing/', peakUsdPerMillion: PEAK_PRICE,
          oneMillionContextWorstCaseFor25RequestsUsd: Number((25 * MAX_REQUEST_COST_USD).toFixed(6)) },
        scenarios: scenarios.map(result => ({ ...result, ...(result.id === 'official-example' && singleWorldId ? { savedWorldIdHash: sha(singleWorldId) } : {}) })),
        singleSpace: { saved: singleSaved, worldIdHash: singleWorldId ? sha(singleWorldId) : null, timelineIdHash: singleTimelineId ? sha(singleTimelineId) : null, source: 'official-example' },
        repair: { saved: repairSaved, draftStatus: repairDraftStatus, draftKind: repairDraftKind,
          draftFailureStage: repairDraftFailureStage, draftNormalizationFixes: repairDraftNormalizationFixes,
          draftIssueCodes: repairDraftIssueCodes,
          providerRequests: repairProviderRequests, llmCallLogRows: repairLedgerRowCount,
          originalWorldIdHash: sha(repairWorldId), originalWorldName: repairWorldName },
        requests: {
          totalRawProviderRequests: providerCalls.length, blockedAttempts: blockedAttempts.length,
          byScenario: Object.fromEntries([...SCENARIOS.map(scenario => scenario.id), 'original-world-repair']
            .map(id => [id, providerCalls.filter(call => call.scenario === id).length])),
          llmCallLogRows: finalLedgerRows, llmCallLogSummary: finalLedgerSummary, reconciled,
          calls: providerCalls.map(call => call),
        },
        usage: { actualCostUsd: Number(actualCostUsd.toFixed(6)), usageUnavailableRequests: usageUnavailable,
          reservedWorstCaseUsd: Number((providerCalls.length * MAX_REQUEST_COST_USD).toFixed(6)) },
        cleanup,
        failures,
        passed: failures.length === 0 && scenarios.length === 4 && scenarios.every(result => result.valid)
          && singleSaved && repairSaved && reconciled && cleanup.d1Deleted,
      }
      if (reportPath) {
        mkdirSync(dirname(reportPath), { recursive: true })
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      }
    }

    expect(failures, 'G0 acceptance failure codes').toEqual([])
    expect(scenarios).toHaveLength(4)
    expect(scenarios.every(result => result.valid)).toBe(true)
    expect(singleSaved).toBe(true)
    expect(repairSaved).toBe(true)
    expect(reconciled).toBe(true)
    expect(cleanup.d1Deleted).toBe(true)
  }, 40 * 60 * 1000)
})
