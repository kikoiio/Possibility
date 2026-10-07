import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateDocument, validateWalkability } from '@possibility/voxel-contract'
import { assembleWorld, WorldGeneratorError } from '../src/voxel/generate'
import { normalizePayloadSize, normalizeWorldDocument } from '../src/voxel/normalize'
import { libraryManifest } from '../src/voxel/library-manifest'

type ArchivedCall = { scenario: string; status: number | null; generatedContent: string }
type Archive = { workflowRunId?: string; requests?: { calls?: ArchivedCall[] } }

const REPAIR_LOCATION_NAMES = ['主楼', '温室', '庭院', '书房', '湖畔']
const BUILDING_LOCATION = /咖啡馆|咖啡屋|咖啡店|住宅|民居|公寓|居民楼|住宅楼|店铺|商店|商铺|杂货铺|杂货店|邮局|图书馆|车站|学校|医院|诊所|旅馆|客栈|酒店|餐馆|饭店|餐厅|酒馆|酒吧|教堂|办公楼|厂房|工坊|工作室|\bcafe\b|\bcoffee ?shop\b|\bhouse\b|\bhome\b|\bresidence\b|\bapartment\b|\bshop\b|\bstore\b|\bpost ?office\b|\blibrary\b|\bstation\b|\bschool\b|\bhospital\b|\bclinic\b|\bhotel\b|\binn\b|\brestaurant\b|\boffice\b|\bfactory\b|\bworkshop\b/iu
const BUILDING_OBJECT_TYPES = new Set(['manor-main-house', 'manor-greenhouse'])

function parseObject(content: string): Record<string, unknown> {
  const cleaned = content.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('provider_content_has_no_json_object')
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
}

function issuesFor(
  document: ReturnType<typeof assembleWorld>,
  requiredNames: string[],
  assets: ReturnType<typeof libraryManifest>,
) {
  const issues = [...validateDocument(document, undefined, assets ?? undefined)]
  if (issues.length === 0) issues.push(...validateWalkability(document))
  const boundNames = new Set(document.locations.map(location => location.name))
  for (const name of new Set(requiredNames)) {
    if (!boundNames.has(name)) issues.push({ code: 'location-unbound', message: `必需地点「${name}」尚未绑定到场景物体` })
  }
  const carrierNames = new Map<string, string>()
  for (const location of document.locations) {
    const previousName = carrierNames.get(location.objectId)
    if (previousName) {
      issues.push({ code: 'location-unbound', message: `地点「${previousName}」与「${location.name}」共用承载物「${location.objectId}」；每个地点必须绑定不同承载物` })
    } else carrierNames.set(location.objectId, location.name)
  }
  const buildingCarrierIds = new Set([
    ...document.objects.filter(object => BUILDING_OBJECT_TYPES.has(object.objectType)).map(object => object.id),
    ...(document.assetPlacements ?? []).filter(placement => assets?.assets[placement.assetId]?.category === 'building')
      .map(placement => placement.id).filter((id): id is string => Boolean(id)),
  ])
  for (const location of document.locations) {
    if (requiredNames.includes(location.name) && BUILDING_LOCATION.test(location.name)
      && !buildingCarrierIds.has(location.objectId)) {
      issues.push({ code: 'location-unbound', message: `建筑地点「${location.name}」必须绑定建筑物体或 building 类资产，不能绑定家具、装饰或植被` })
    }
  }
  return issues
}

async function main() {
  const inputPath = process.env.G0_EVIDENCE_FILE
  if (!inputPath) throw new Error('G0_EVIDENCE_FILE is required')
  const outputPath = join(process.env.RUNNER_TEMP || tmpdir(), 'phase1-generation-replay-diagnostics.json')
  const archive = JSON.parse(readFileSync(inputPath, 'utf8')) as Archive
  if (!Array.isArray(archive.requests?.calls)) throw new Error('provider archive requests.calls is missing')

  const drafts = new Map<string, Record<string, unknown>>()
  const sceneCalls: Array<{ scenario: string; responseIndex: number; status: number | null; payload: Record<string, unknown> }> = []
  const responseIndexes = new Map<string, number>()
  for (const call of archive.requests.calls) {
    if (!call || typeof call.scenario !== 'string' || typeof call.generatedContent !== 'string') continue
    let parsed: Record<string, unknown>
    try { parsed = parseObject(call.generatedContent) } catch { continue }
    const isScene = parsed.size !== undefined || parsed.ops !== undefined || parsed.assetPlacements !== undefined
    if (!isScene) {
      if (Array.isArray(parsed.locations)) drafts.set(call.scenario, parsed)
      continue
    }
    const responseIndex = (responseIndexes.get(call.scenario) ?? 0) + 1
    responseIndexes.set(call.scenario, responseIndex)
    sceneCalls.push({ scenario: call.scenario, responseIndex, status: call.status, payload: parsed })
  }

  const assets = libraryManifest()
  const results = []
  for (const call of sceneCalls) {
    const requiredNames = call.scenario === 'original-world-repair'
      ? REPAIR_LOCATION_NAMES
      : ((drafts.get(call.scenario)?.locations as Array<{ name?: unknown }> | undefined) ?? [])
        .flatMap(location => typeof location?.name === 'string' ? [location.name] : [])
    try {
      const normalizedPayload = normalizePayloadSize(call.payload as Parameters<typeof assembleWorld>[0])
      const assembled = assembleWorld(
        normalizedPayload.payload,
        'mist-manor',
        `replay-diagnostic-${call.scenario}-${call.responseIndex}`,
        assets ?? undefined,
      )
      const normalized = normalizeWorldDocument(assembled, assets ?? undefined)
      const issues = issuesFor(normalized.document, requiredNames, assets)
      results.push({
        scenario: call.scenario,
        responseIndex: call.responseIndex,
        providerStatus: call.status,
        stage: issues.length > 0 ? 'validation' : 'passed',
        sizeFixes: normalizedPayload.fixes,
        normalizationFixes: normalized.fixes,
        normalizationRepairable: normalized.repairable,
        issues: issues.map(issue => ({
          code: issue.code,
          message: issue.message,
          ...(issue.at ? { at: issue.at } : {}),
        })),
      })
    } catch (error) {
      results.push({
        scenario: call.scenario,
        responseIndex: call.responseIndex,
        providerStatus: call.status,
        stage: error instanceof WorldGeneratorError ? error.failureStage : 'assembly',
        error: error instanceof Error ? error.message : String(error),
        issues: error instanceof WorldGeneratorError ? error.issues.map(issue => ({
          code: issue.code,
          message: issue.message,
          ...('at' in issue && issue.at ? { at: issue.at } : {}),
        })) : [],
      })
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify({
    sourceRunId: archive.workflowRunId ?? null,
    inputPath,
    assetsAvailable: assets !== null,
    sceneResponseCount: results.length,
    results,
  }, null, 2)}\n`)
  console.log(JSON.stringify({ outputPath, sceneResponseCount: results.length, sourceRunId: archive.workflowRunId ?? null }))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
