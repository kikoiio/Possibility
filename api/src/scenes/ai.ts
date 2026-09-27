import type { SceneDocument, SceneOperation } from '@possibility/scene-contract'
import { compactCatalogForPrompt, validateScene, contemporaryTheme } from '@possibility/scene-contract'
import { and, eq, inArray } from 'drizzle-orm'
import { completeContract, configFromEnv } from '../llm/client'
import { parseContractObject, requireString } from '../llm/contracts'
import { budgetFromEnv } from '../engine/budget'
import { userReservation } from '../engine/guard'
import type { Db } from '../db/client'
import { persons } from '../db/schema'
import type { Env } from '../index'
import type { LocationDef } from '../agent/engine-context'

export interface SceneWorldDraft { name: string; description: string; locations: LocationDef[] }
export interface SceneDraftResult { world: SceneWorldDraft; scene: SceneDocument; explanation: string; warnings: string[] }
const CONTRACT = 'scene-draft/v1'
const SYSTEM = `你为 Possibility 创造可进入的生活场景。只返回 JSON 对象，不使用 Markdown。画面由可编辑固定素材组成，不能生成图片或描述经营系统。场景坐标是整数网格，大小最多 28x22；对象不能碰撞或越界。世界地点 5-8 个，每个地点对应一栋有语义绑定的建筑；选中居民都必须用 person 资产和其传入的稳定 ID。场景 schemaVersion=1，主题使用给定 ID。所有可用资产如下：\n${compactCatalogForPrompt(contemporaryTheme)}\n返回结构：{"world":{"name":"...","description":"...","locations":[{"name":"...","description":"..."}]},"scene":{"schemaVersion":1,"themeId":"contemporary-daily-life","size":{"columns":24,"rows":18},"version":0,"terrain":[],"paths":[],"objects":[{"id":"stable-scene-id","assetId":"...","position":{"x":0,"y":0},"binding":{"kind":"location","locationName":"..."}|{"kind":"person","personId":"..."}|null,"label":null,"purpose":null}],"lockedObjectIds":[],"lockedAreas":[]},"explanation":"...","warnings":[]}`

function parseDraft(content: string, selectedPersonIds: string[]): SceneDraftResult {
  const root = parseContractObject(content, CONTRACT)
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
  return { world, scene, explanation: String(root.explanation ?? '场景已就绪，可以继续调整。'), warnings: Array.isArray(root.warnings) ? root.warnings.map(String).slice(0, 8) : [] }
}

export async function createSceneDraft(env: Env, db: Db, userId: string, request: { requestId: string; prompt: string; personIds: string[] }): Promise<SceneDraftResult> {
  const selected = [...new Set(request.personIds)]
  if (selected.length < 1 || selected.length > 6) throw new Error('需要选择 1-6 位居民')
  const owned = await db.select({ id: persons.id, name: persons.name }).from(persons).where(and(eq(persons.userId, userId), inArray(persons.id, selected))).all()
  if (owned.length !== selected.length) throw new Error('包含不属于你的居民')
  const config = configFromEnv(env, userReservation(db, userId, budgetFromEnv(env), 'scene'))
  return completeContract(config, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ requestId: request.requestId, description: request.prompt, selectedResidents: owned }) },
  ], { maxTokens: 9000, requestId: request.requestId, contractVersion: CONTRACT, parse: text => parseDraft(text, selected) })
}

export async function previewSceneOperations(env: Env, db: Db, userId: string, request: { requestId: string; instruction: string; document: SceneDocument; selectedPersonIds?: string[] }) {
  const config = configFromEnv(env, userReservation(db, userId, budgetFromEnv(env), 'scene'))
  const system = `你是场景编辑助手。只返回 JSON：{"summary":"...","operations":[...],"warnings":[]}。只能从资产目录选 ID，只输出 SceneOperation。当前场景、资产和约束：\n${compactCatalogForPrompt(contemporaryTheme)}\n${JSON.stringify(request.document)}\n${request.selectedPersonIds ? `允许人物绑定：${request.selectedPersonIds.join(',')}` : '这是已运行世界，只能调整视觉布局/装饰，不能增删模拟地点或居民。'}`
  return completeContract(config, [
    { role: 'system', content: system }, { role: 'user', content: JSON.stringify({ requestId: request.requestId, instruction: request.instruction }) },
  ], { maxTokens: 4000, requestId: request.requestId, contractVersion: 'scene-edit/v1', parse: text => {
    const parsed = parseContractObject(text, 'scene-edit/v1')
    if (!Array.isArray(parsed.operations)) throw new Error('AI 修改缺少 operations')
    return { summary: String(parsed.summary ?? ''), operations: parsed.operations as SceneOperation[], warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String).slice(0, 8) : [] }
  } })
}
