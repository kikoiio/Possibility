import type { SceneDocument, SceneOperation } from '@possibility/scene-contract'
import { compactCatalogForPrompt, validateScene, contemporaryTheme } from '@possibility/scene-contract'
import { and, eq, inArray } from 'drizzle-orm'
import { completeContract } from '../llm/client'
import { resolveLlmConfig } from '../llm/resolve'
import { parseContractObject, requireString } from '../llm/contracts'
import { budgetFromEnv } from '../engine/budget'
import { userReservation } from '../engine/guard'
import type { Db } from '../db/client'
import { persons } from '../db/schema'
import type { Env } from '../index'
import type { LocationDef } from '../agent/engine-context'
import { s02SceneFixture } from './e2e-fixture'
import { ensureSceneObjectIds, ensureScenePathIds } from './normalize'

export interface SceneWorldDraft { name: string; description: string; locations: LocationDef[] }
export interface SceneDraftResult { world: SceneWorldDraft; scene: SceneDocument; explanation: string; warnings: string[] }
const CONTRACT = 'scene-draft/v1'
const SYSTEM = `你为 Possibility 创造可进入的生活场景。只返回 JSON 对象，不使用 Markdown。画面由可编辑固定素材组成，不能生成图片或描述经营系统。场景坐标是整数网格，大小最多 28x22；对象 position.x/y 是占地矩形左上角坐标，必须按目录 footprint 宽高计算完整矩形，不可只比较锚点。任意两个 objects 的占地格子都不能重叠，也不能越界；在输出前逐格检查冲突，给每栋建筑之间至少留一格。世界地点 5-8 个，每个地点对应一栋有语义绑定的建筑。首轮场景 objects 总数控制在 20-36 个，含地点建筑和所有居民；自然物与装饰共 8-20 个，优先少量代表性素材，不要逐格铺满植被。terrain 项必须形如 {"x":0,"y":0,"assetId":"terrain-grass"}。paths 项必须形如 {"id":"path-1","category":"road","assetId":"road-straight","cells":[{"x":0,"y":0}]}；每条 path 都必须有唯一 id；category 只能是 road 或 water，cells 必须是对象数组。water 可用 water-inner，road 可用 road-single、road-straight、road-corner、road-tee、road-cross。不要使用其他字段替代 id、category、assetId、cells。objects 只能使用目录里 building、nature、decoration、person 类别的可放置 asset ID；terrain、road、water 类资产只能放在 terrain 或 paths，绝不能放进 objects。assetId 必须逐字复制目录第一列的 ID，不要使用名称或自创 ID。绑定规则：只有 building 类素材可以使用 {"kind":"location","locationName":"地点名"}；person 类素材必须使用 {"kind":"person","personId":"传入的稳定 ID"}；自然物、装饰和其他非建筑素材的 binding 一律为 null。选中居民都必须用 person 资产并使用其传入的稳定 ID。场景 schemaVersion=1，主题使用给定 ID。所有可用资产如下：\n${compactCatalogForPrompt(contemporaryTheme)}\n返回结构：{"world":{"name":"...","description":"...","locations":[{"name":"...","description":"..."}]},"scene":{"schemaVersion":1,"themeId":"contemporary-daily-life","size":{"columns":24,"rows":18},"version":0,"terrain":[{"x":0,"y":0,"assetId":"terrain-grass"}],"paths":[{"id":"path-1","category":"road","assetId":"road-straight","cells":[{"x":0,"y":0}]}],"objects":[{"id":"stable-scene-id","assetId":"...","position":{"x":0,"y":0},"binding":null,"label":null,"purpose":null}],"lockedObjectIds":[],"lockedAreas":[]},"explanation":"...","warnings":[]}`

function parseDraft(content: string, selectedPersonIds: string[]): SceneDraftResult {
  const cleaned = content.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
  const root = parseContractObject(candidate, CONTRACT)
  const w = root.world as Record<string, unknown> | undefined
  const s = root.scene as Record<string, unknown> | undefined
  if (!w || !s || !Array.isArray(w.locations) || !Array.isArray(s.objects) || !Array.isArray(s.terrain) || !Array.isArray(s.paths)) throw new Error('场景草稿结构不完整')
  const locations = w.locations.map((item) => {
    const loc = item as Record<string, unknown>
    return { name: String(loc.name ?? '').trim(), description: String(loc.description ?? '').trim() }
  }).filter(loc => loc.name)
  if (locations.length < 5 || locations.length > 8) throw new Error('场景需要 5-8 个可进入地点')
  const world: SceneWorldDraft = { name: requireString(w.name, 'world.name', CONTRACT, 80), description: requireString(w.description, 'world.description', CONTRACT, 4000), locations }
  const scene = s as unknown as SceneDocument
  if (scene.schemaVersion !== 1 || scene.themeId !== contemporaryTheme.id || !Number.isInteger(scene.size?.columns) || !Number.isInteger(scene.size?.rows) || scene.size.columns > 28 || scene.size.rows > 22 || scene.size.columns < 12 || scene.size.rows < 10) throw new Error('画布尺寸或主题不符合场景约束')
  const warnings = Array.isArray(root.warnings) ? root.warnings.map(String).slice(0, 8) : []
  warnings.push(...ensureSceneObjectIds(scene, 8 - warnings.length))
  warnings.push(...ensureScenePathIds(scene, 8 - warnings.length))
  for (const object of scene.objects) {
    const asset = contemporaryTheme.assets.find(candidate => candidate.id === object.assetId)
    if (object.binding?.kind === 'location' && asset && !asset.capabilities.semanticLocation) {
      object.binding = null
      if (warnings.length < 8) warnings.push(`已清除不支持地点关联的素材绑定：${object.assetId}`)
    }
  }
  warnings.push(...resolveObjectOverlaps(scene, 8 - warnings.length))
  scene.version = 0
  const validation = validateScene(scene, contemporaryTheme)
  if (!validation.ok) throw new Error(`场景内容无效：${validation.issues.map(i => i.message).slice(0, 5).join('；')}`)
  const boundLocations = scene.objects.filter(o => o.binding?.kind === 'location').map(o => o.binding?.kind === 'location' ? o.binding.locationName : '')
  if (locations.some(location => !boundLocations.includes(location.name))) throw new Error('有地点没有对应的场景建筑')
  for (const id of selectedPersonIds) if (!scene.objects.some(o => o.binding?.kind === 'person' && o.binding.personId === id)) throw new Error(`场景缺少已选居民 ${id}`)
  const allowedIds = new Set([...locations.map(l => l.name), ...selectedPersonIds])
  for (const object of scene.objects) {
    if (object.binding?.kind === 'location' && !allowedIds.has(object.binding.locationName)) throw new Error('场景含有未知地点绑定')
    if (object.binding?.kind === 'person' && !allowedIds.has(object.binding.personId)) throw new Error('场景含有未选择居民')
  }
  return { world, scene, explanation: String(root.explanation ?? '场景已就绪，可以继续调整。'), warnings }
}

export function resolveObjectOverlaps(scene: SceneDocument, warningLimit = 8): string[] {
  const warnings: string[] = []
  const occupied = new Set<string>()
  const priority = (object: SceneDocument['objects'][number]) =>
    object.binding?.kind === 'location' ? 0 : object.binding?.kind === 'person' ? 1 : 2
  const ordered = [...scene.objects].sort((a, b) => priority(a) - priority(b))
  const key = (x: number, y: number) => `${x},${y}`
  for (const object of ordered) {
    const asset = contemporaryTheme.assets.find(candidate => candidate.id === object.assetId)
    if (!asset?.capabilities.placeable) continue
    const { width, height } = asset.footprint
    const fits = (x: number, y: number) => {
      if (x < 0 || y < 0 || x + width > scene.size.columns || y + height > scene.size.rows) return false
      for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) if (occupied.has(key(x + dx, y + dy))) return false
      return true
    }
    const original = object.position
    let position: { x: number; y: number } | undefined
    const candidates = Array.from({ length: scene.size.rows }, (_, y) =>
      Array.from({ length: scene.size.columns }, (_, x) => ({ x, y }))).flat()
      .sort((a, b) => (Math.abs(a.x - original.x) + Math.abs(a.y - original.y))
        - (Math.abs(b.x - original.x) + Math.abs(b.y - original.y)) || a.y - b.y || a.x - b.x)
    position = candidates.find(candidate => fits(candidate.x, candidate.y))
    if (!position) throw new Error(`没有足够空位容纳素材：${object.assetId}`)
    if (position.x !== original.x || position.y !== original.y) {
      object.position = position
      if (warnings.length < warningLimit) warnings.push(`已自动避让重叠对象：${object.id}`)
    }
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) occupied.add(key(position.x + dx, position.y + dy))
  }
  return warnings
}

export async function createSceneDraft(env: Env, db: Db, userId: string, request: { requestId: string; prompt: string; personIds: string[] }): Promise<SceneDraftResult> {
  const selected = [...new Set(request.personIds)]
  if (selected.length < 1 || selected.length > 6) throw new Error('需要选择 1-6 位居民')
  const owned = await db.select({ id: persons.id, name: persons.name }).from(persons).where(and(eq(persons.userId, userId), inArray(persons.id, selected))).all()
  if (owned.length !== selected.length) throw new Error('包含不属于你的居民')
  const { config } = await resolveLlmConfig(db, env, { userId }, userReservation(db, userId, budgetFromEnv(env), 'scene'))
  if (env.ENVIRONMENT === 's02-e2e') config.provider = { fetch: s02SceneFixture }
  return completeContract(config, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ requestId: request.requestId, description: request.prompt, selectedResidents: owned }) },
  ], { maxTokens: 24000, requestId: request.requestId, contractVersion: CONTRACT,
    responseFormat: { type: 'json_object' }, thinking: { type: 'disabled' },
    parse: text => parseDraft(text, selected) })
}

export async function previewSceneOperations(env: Env, db: Db, userId: string, request: { requestId: string; instruction: string; document: SceneDocument; selectedPersonIds?: string[] }) {
  const { config } = await resolveLlmConfig(db, env, { userId }, userReservation(db, userId, budgetFromEnv(env), 'scene'))
  const system = `你是场景编辑助手。只返回 JSON：{"summary":"...","operations":[...],"warnings":[]}。只能从资产目录选 ID，只输出 SceneOperation。当前场景、资产和约束：\n${compactCatalogForPrompt(contemporaryTheme)}\n${JSON.stringify(request.document)}\n${request.selectedPersonIds ? `允许人物绑定：${request.selectedPersonIds.join(',')}` : '这是已运行世界，只能调整视觉布局/装饰，不能增删模拟地点或居民。'}`
  return completeContract(config, [
    { role: 'system', content: system }, { role: 'user', content: JSON.stringify({ requestId: request.requestId, instruction: request.instruction }) },
  ], { maxTokens: 4000, requestId: request.requestId, contractVersion: 'scene-edit/v1', parse: text => {
    const parsed = parseContractObject(text, 'scene-edit/v1')
    if (!Array.isArray(parsed.operations)) throw new Error('AI 修改缺少 operations')
    return { summary: String(parsed.summary ?? ''), operations: parsed.operations as SceneOperation[], warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String).slice(0, 8) : [] }
  } })
}
