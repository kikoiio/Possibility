/**
 * N2D1 T15–T17：范围键、本地布局存储记录、恢复与损坏识别、保存和重置故障。
 *
 * 职责与约束（对应已批准 plan.md「本地存储模块」「刷新恢复与重置」）：
 * - 存储键 = 独立前缀 + source/worldId/timelineId/sceneId 的无歧义组合
 *   （JSON 数组编码各段，任何含 `:`/`"`/`/` 的身份都不会串键）。
 *   sceneVersion 不进键，只放载荷，T16 恢复时严格核对以报告不兼容。
 * - 载荷 LocalLayoutRecord：formatVersion: 1、scope（含 sceneVersion）、
 *   完整 placements、savedAt（ISO 字符串）。不保存世界快照或撤销历史。
 * - load 逐层校验并分流：none / ready / damaged / incompatible / error；
 *   损坏、不兼容、读取异常一律保留原记录，load 绝不写存储，
 *   读取异常返回 error 而不是误报无存档。
 * - save/reset 捕获 storageProvider() 与 setItem/removeItem 异常：
 *   provider 获取失败 → storage_unavailable；配额满（name 或 code 识别）
 *   → quota_exceeded；其他 → storage_error。失败不伪报成功、不删除原值。
 * - 仓库不持有编辑器引用，不改变任何编辑器内存状态。
 *
 * 只导入 ./types 的类型与 layout-validation 的纯校验；不依赖渲染或读取。
 */

import type {
  BuildingPlacement,
  LayoutRepository,
  LayoutState,
  LocalLayoutRecord,
  RestoreResult,
  SampleScope,
  SaveResult,
  SceneDefinition,
  StorageFailure,
} from './types'
import { validateLayout } from './layout-validation'

/** 存储键独立前缀；版本变化时整体换前缀，旧键自然失效。 */
export const LAYOUT_STORAGE_KEY_PREFIX = 'possibility.native2d.layout.v1'

/**
 * 结构化最小 Storage 接口：DOM localStorage 可直接赋值，
 * 测试可用内存 Map stub。所有方法都可能抛错，由仓库捕获。
 */
export interface LayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 存储对象提供者：获取本身可能抛错（如隐私模式/被禁用）。 */
export type LayoutStorageProvider = () => LayoutStorage

/**
 * 范围 → 存储键。各段用 JSON 数组编码：字符串带引号并转义，
 * 任意分隔符/引号/斜杠组合产生的键都一一对应，不会串键。
 * sceneVersion 不参与键（放载荷，恢复时核对不兼容）。
 */
export function layoutStorageKey(scope: SampleScope): string {
  return (
    LAYOUT_STORAGE_KEY_PREFIX +
    ':' +
    JSON.stringify([scope.source, scope.worldId, scope.timelineId, scope.sceneId])
  )
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

/** 配额满识别：标准 name、旧 Firefox name、以及 DOMException code 22 / 1014。 */
function isQuotaExceeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  const code = (err as { code?: unknown }).code
  return code === 22 || code === 1014
}

function failure(reason: StorageFailure, err: unknown): SaveResult {
  return { ok: false, reason, message: describeError(err) }
}

type AcquireResult =
  | { readonly ok: true; readonly storage: LayoutStorage }
  | { readonly ok: false; readonly reason: StorageFailure; readonly message: string }

/** 获取存储对象；provider 抛错统一为 storage_unavailable。 */
function acquireStorage(provider: LayoutStorageProvider): AcquireResult {
  try {
    return { ok: true, storage: provider() }
  } catch (err) {
    return { ok: false, reason: 'storage_unavailable', message: describeError(err) }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SCOPE_FIELDS = ['source', 'worldId', 'timelineId', 'sceneId'] as const

/**
 * 载荷结构解析：只认批准字段的形状，不拒绝多余字段。
 * 返回 null 表示结构不符（damaged）；其余版本/范围核对由调用方分流。
 */
function parseRecordShape(
  raw: unknown,
): { scope: SampleScope; placements: BuildingPlacement[]; savedAt: string } | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.formatVersion !== 'number') return null

  const scopeRaw = raw.scope
  if (!isPlainObject(scopeRaw)) return null
  for (const field of SCOPE_FIELDS) {
    if (typeof scopeRaw[field] !== 'string') return null
  }
  if (typeof scopeRaw.sceneVersion !== 'number' || !Number.isFinite(scopeRaw.sceneVersion)) {
    return null
  }
  const scope: SampleScope = {
    source: scopeRaw.source as SampleScope['source'],
    worldId: scopeRaw.worldId as string,
    timelineId: scopeRaw.timelineId as string,
    sceneId: scopeRaw.sceneId as string,
    sceneVersion: scopeRaw.sceneVersion,
  }

  if (!Array.isArray(raw.placements)) return null
  const placements: BuildingPlacement[] = []
  for (const item of raw.placements) {
    if (!isPlainObject(item)) return null
    if (typeof item.buildingId !== 'string' || typeof item.spaceId !== 'string') return null
    const origin = item.origin
    if (!isPlainObject(origin)) return null
    if (typeof origin.x !== 'number' || typeof origin.z !== 'number') return null
    placements.push({
      buildingId: item.buildingId,
      spaceId: item.spaceId,
      origin: { x: origin.x, z: origin.z },
    })
  }

  if (typeof raw.savedAt !== 'string' || raw.savedAt.length === 0) return null

  return { scope, placements, savedAt: raw.savedAt }
}

/**
 * 仓库返回类型：满足 types.ts 冻结的 LayoutRepository 契约，
 * save 额外接受可选 savedAt（ISO 字符串，默认 new Date().toISOString()），
 * 供调用方/测试注入确定时钟；不改变 LayoutRepository 既有签名兼容性。
 */
export interface ClockedLayoutRepository extends LayoutRepository {
  load(scope: SampleScope): RestoreResult
  save(layout: LayoutState, savedAt?: string): SaveResult
}

/**
 * 创建范围布局仓库。
 * @param scene 场景定义（恢复时用于完整布局合法性校验）
 * @param storageProvider 存储对象提供者，获取本身可能抛错
 */
export function createLayoutRepository(
  scene: SceneDefinition,
  storageProvider: LayoutStorageProvider,
): ClockedLayoutRepository {
  return {
    load(scope: SampleScope): RestoreResult {
      const acquired = acquireStorage(storageProvider)
      if (!acquired.ok) {
        return { status: 'error', reason: acquired.reason, message: acquired.message }
      }
      const storage = acquired.storage
      const key = layoutStorageKey(scope)

      let rawText: string | null
      try {
        rawText = storage.getItem(key)
      } catch (err) {
        return { status: 'error', reason: 'storage_error', message: describeError(err) }
      }
      if (rawText === null || rawText === undefined) return { status: 'none' }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawText)
      } catch {
        return { status: 'damaged', message: '布局记录不是有效 JSON，无法解析' }
      }

      // 结构不符 → damaged；结构合法但 formatVersion 不匹配 → incompatible。
      if (!isPlainObject(parsed)) {
        return { status: 'damaged', message: '布局记录结构不符：不是对象' }
      }
      if (typeof parsed.formatVersion === 'number' && parsed.formatVersion !== 1) {
        return {
          status: 'incompatible',
          message: `布局记录格式版本 ${String(parsed.formatVersion)} 与当前支持的 1 不匹配`,
        }
      }
      const record = parseRecordShape(parsed)
      if (!record) {
        return { status: 'damaged', message: '布局记录结构不符：缺少必要字段或字段类型错误' }
      }

      // scope 各段（含 sceneVersion）与请求逐一核对，不一致 → incompatible。
      for (const field of SCOPE_FIELDS) {
        if (record.scope[field] !== scope[field]) {
          return {
            status: 'incompatible',
            message: `布局记录的范围 ${field}=${record.scope[field]} 与当前范围 ${scope[field]} 不一致`,
          }
        }
      }
      if (record.scope.sceneVersion !== scope.sceneVersion) {
        return {
          status: 'incompatible',
          message: `布局记录的场景版本 ${String(record.scope.sceneVersion)} 与当前场景版本 ${String(scope.sceneVersion)} 不匹配`,
        }
      }

      // 完整布局合法性校验（结构/占地/连通），非法 → damaged。
      const layout: LayoutState = { scope, placements: record.placements }
      const validation = validateLayout(scene, layout)
      if (!validation.valid) {
        const summary = validation.reasons.map((r) => r.message).join('；')
        return { status: 'damaged', message: `布局记录未通过合法性校验：${summary}` }
      }

      return { status: 'ready', layout }
    },

    save(layout: LayoutState, savedAt: string = new Date().toISOString()): SaveResult {
      const acquired = acquireStorage(storageProvider)
      if (!acquired.ok) return { ok: false, reason: acquired.reason, message: acquired.message }
      const storage = acquired.storage

      const record: LocalLayoutRecord = {
        formatVersion: 1,
        scope: layout.scope,
        placements: layout.placements,
        savedAt,
      }
      let serialized: string
      try {
        serialized = JSON.stringify(record)
      } catch (err) {
        return failure('storage_error', err)
      }
      try {
        storage.setItem(layoutStorageKey(layout.scope), serialized)
      } catch (err) {
        return failure(isQuotaExceeded(err) ? 'quota_exceeded' : 'storage_error', err)
      }
      return { ok: true }
    },

    reset(scope: SampleScope): SaveResult {
      const acquired = acquireStorage(storageProvider)
      if (!acquired.ok) return { ok: false, reason: acquired.reason, message: acquired.message }
      const storage = acquired.storage
      try {
        storage.removeItem(layoutStorageKey(scope))
      } catch (err) {
        return failure('storage_error', err)
      }
      return { ok: true }
    },
  }
}
