/**
 * N2D1 T07–T09：只读世界来源。
 *
 * createWorldSource(config, scene, options?) 按 SourceConfig 分两支：
 * - fixture 分支（T07）：直接消费 T04 fixtures 的固定快照工厂，每次 load 返回
 *   全新对象；不发起任何网络请求，不读凭证或编辑状态；校验固定快照的
 *   sceneId/sceneVersion 与传入场景一致。
 * - public 分支（T08/T09）：独立 fetch 封装（不调用共享 apiFetch），只发 GET、
 *   credentials: 'omit'。显式 worldId 时直接 GET /api/public/worlds/:id；
 *   未配置时先 GET /api/public/demo 发现，并校验目标是雾影庄
 *   （名字含「雾影庄」或显式配置的 worldId 匹配），不适配时明确报错。
 *   首次成功读取后固定 worldId/timelineId，后续刷新以 ?timelineId= 携带同一
 *   时间线；响应时间线与已固定值不匹配时明确失败。发现或首次读取失败不会
 *   错误固定范围，可安全重试。不创建访客 session、不调用模型接口、不轮询。
 *
 * 中止约定：signal 已中止或 fetch 被中止时抛出 name === 'AbortError' 的错误，
 * 既不当成读取失败（中文错误信息），也不报告成功。
 *
 * 居民提取：locationBoard 覆盖全部居民当前状态（API 由同一 personStates 生成
 * locationBoard 与 location currentFacts，二者同源）；以 locationBoard 为准，
 * activity 为空串时保留为 null，不虚构姓名、地点或活动。
 */

import { effectiveTimeZone } from '../lib/world-time'
import { createAccountSessionAdapter } from './session-adapter'
import { FIXTURE_IDS, createFixtureReadModel, type FixtureId } from './fixtures'
import type {
  SampleScope,
  SceneDefinition,
  SourceConfig,
  WorldLocation,
  WorldReadModel,
  WorldResident,
  WorldSource,
} from './types'

/** 可选注入：测试用 stub fetch 与 baseUrl；SourceConfig 契约不变。 */
export interface WorldSourceOptions {
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
}

const MIST_MANOR_NAME = '雾影庄'
const DEMO_PATH = '/api/public/demo'
const WORLDS_PATH = '/api/public/worlds'

export function createWorldSource(
  config: SourceConfig,
  scene: SceneDefinition,
  options?: WorldSourceOptions,
): WorldSource {
  if (config.kind === 'fixture') {
    return createFixtureSource(config.fixtureId, scene)
  }
  if (config.kind === 'account') return createAccountSessionAdapter(scene, config.worldId, config.timelineId)
  return createPublicSource(config, scene, options)
}

/* -------------------------------------------------------------------------- */
/* 中止                                                                        */
/* -------------------------------------------------------------------------- */

function abortError(): Error {
  const error = new Error('读取已取消')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

/* -------------------------------------------------------------------------- */
/* T07 固定来源                                                                */
/* -------------------------------------------------------------------------- */

function createFixtureSource(fixtureId: string, scene: SceneDefinition): WorldSource {
  if (!(FIXTURE_IDS as readonly string[]).includes(fixtureId)) {
    throw new Error(`未知的固定快照：${fixtureId}`)
  }
  const id = fixtureId as FixtureId
  return {
    async load(signal: AbortSignal): Promise<WorldReadModel> {
      throwIfAborted(signal)
      // fixtures 工厂每次构造全新对象与数组，不复用可被外部修改的快照。
      const model = createFixtureReadModel(id)
      if (model.scope.sceneId !== scene.id || model.scope.sceneVersion !== scene.version) {
        throw new Error(
          `固定快照场景 ${model.scope.sceneId}@${model.scope.sceneVersion} 与场景 ${scene.id}@${scene.version} 不一致`,
        )
      }
      throwIfAborted(signal)
      return model
    },
  }
}

/* -------------------------------------------------------------------------- */
/* T08/T09 公开来源                                                            */
/* -------------------------------------------------------------------------- */

interface ValidatedLocationDef {
  readonly name: string
  readonly description: string
}

interface ValidatedBoardPerson {
  readonly id: string
  readonly name: string
  readonly activity: string
}

interface ValidatedSnapshot {
  readonly world: {
    readonly id: string
    readonly name: string
    readonly locations: readonly ValidatedLocationDef[]
    readonly timeZone: string | null
  }
  readonly currentTimelineId: string
  readonly simNow: string | null
  readonly timeZone: string | null
  readonly stateVersion: number | null
  readonly locationBoard: readonly {
    readonly location: string
    readonly persons: readonly ValidatedBoardPerson[]
  }[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function malformed(detail: string): Error {
  return new Error(`雾影庄公开数据结构不完整：${detail}`)
}

/** 校验关键响应结构（world.id/timelines/currentTimelineId/locationBoard 存在且类型正确）。 */
function validateSnapshot(body: unknown): ValidatedSnapshot {
  const root = asRecord(body)
  if (!root) throw malformed('响应不是对象')
  const world = asRecord(root.world)
  if (!world || typeof world.id !== 'string' || !world.id) throw malformed('world.id 缺失')
  if (typeof world.name !== 'string') throw malformed('world.name 缺失')
  if (!Array.isArray(root.timelines)) throw malformed('timelines 缺失')
  if (typeof root.currentTimelineId !== 'string' || !root.currentTimelineId) {
    throw malformed('currentTimelineId 缺失')
  }
  if (!Array.isArray(root.locationBoard)) throw malformed('locationBoard 缺失')

  const rawLocations = Array.isArray(world.locations) ? world.locations : null
  if (!rawLocations) throw malformed('world.locations 缺失')
  const locations: ValidatedLocationDef[] = rawLocations.map((item) => {
    const record = asRecord(item)
    if (!record || typeof record.name !== 'string' || typeof record.description !== 'string') {
      throw malformed('world.locations 条目类型不正确')
    }
    return { name: record.name, description: record.description }
  })

  const locationBoard = (root.locationBoard as unknown[]).map((entry) => {
    const record = asRecord(entry)
    if (!record || typeof record.location !== 'string' || !Array.isArray(record.persons)) {
      throw malformed('locationBoard 条目类型不正确')
    }
    const persons: ValidatedBoardPerson[] = (record.persons as unknown[]).map((person) => {
      const p = asRecord(person)
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') {
        throw malformed('locationBoard 居民类型不正确')
      }
      return { id: p.id, name: p.name, activity: typeof p.activity === 'string' ? p.activity : '' }
    })
    return { location: record.location, persons }
  })

  if (root.simNow !== undefined && root.simNow !== null && typeof root.simNow !== 'string') {
    throw malformed('simNow 类型不正确')
  }
  if (
    root.stateVersion !== undefined &&
    root.stateVersion !== null &&
    typeof root.stateVersion !== 'number'
  ) {
    throw malformed('stateVersion 类型不正确')
  }

  return {
    world: {
      id: world.id,
      name: world.name,
      locations,
      timeZone: optionalString(world.timeZone),
    },
    currentTimelineId: root.currentTimelineId,
    simNow: optionalString(root.simNow),
    timeZone: optionalString(root.timeZone),
    stateVersion: typeof root.stateVersion === 'number' ? root.stateVersion : null,
    locationBoard,
  }
}

function adaptSnapshot(snapshot: ValidatedSnapshot, scene: SceneDefinition): WorldReadModel {
  const scope: SampleScope = {
    source: 'public',
    worldId: snapshot.world.id,
    timelineId: snapshot.currentTimelineId,
    sceneId: scene.id,
    sceneVersion: scene.version,
  }
  const locations: WorldLocation[] = snapshot.world.locations.map((location) => ({
    name: location.name,
    description: location.description,
  }))
  const residents: WorldResident[] = []
  for (const entry of snapshot.locationBoard) {
    for (const person of entry.persons) {
      residents.push({
        personId: person.id,
        name: person.name,
        locationName: entry.location,
        activity: person.activity.trim() ? person.activity : null,
      })
    }
  }
  return {
    scope,
    worldName: snapshot.world.name,
    simNow: snapshot.simNow,
    timeZone: effectiveTimeZone(snapshot.timeZone ?? snapshot.world.timeZone),
    stateVersion: snapshot.stateVersion,
    locations,
    residents,
  }
}

function createPublicSource(
  config: { readonly worldId?: string; readonly timelineId?: string },
  scene: SceneDefinition,
  options?: WorldSourceOptions,
): WorldSource {
  const fetchImpl: typeof fetch =
    options?.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const baseUrl = options?.baseUrl ?? ''

  // 固定范围：仅首次成功后才确定 timelineId；worldId 来自显式配置或通过
  // 雾影庄校验的发现结果。发现/首次读取失败时不会被错误固定。
  let pinnedWorldId: string | null = config.worldId ?? null
  let pinnedTimelineId: string | null = config.timelineId ?? null

  async function getJson(signal: AbortSignal, url: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetchImpl(url, { method: 'GET', credentials: 'omit', signal })
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError()
      throw new Error('无法连接雾影庄公开数据（网络错误）')
    }
    throwIfAborted(signal)
    if (!response.ok) {
      throw new Error(`读取雾影庄公开数据失败（HTTP ${response.status}）`)
    }
    try {
      return await response.json()
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError()
      throw new Error('雾影庄公开数据不是有效的 JSON')
    }
  }

  /** 目标必须是雾影庄：名字含「雾影庄」，或与显式配置的 worldId 匹配。 */
  function assertMistManor(name: string, worldId: string): void {
    if (config.worldId && worldId === config.worldId) return
    if (!name.includes(MIST_MANOR_NAME)) {
      throw new Error(`发现的演示世界「${name}」不是雾影庄，请显式配置公开 worldId`)
    }
  }

  async function load(signal: AbortSignal): Promise<WorldReadModel> {
    throwIfAborted(signal)

    if (!pinnedWorldId) {
      const demoBody = await getJson(signal, `${baseUrl}${DEMO_PATH}`)
      const demo = asRecord(demoBody)
      if (!demo || typeof demo.id !== 'string' || !demo.id || typeof demo.name !== 'string') {
        throw malformed('演示世界发现响应缺少 id/name')
      }
      assertMistManor(demo.name, demo.id)
      pinnedWorldId = demo.id
    }

    const query = pinnedTimelineId ? `?timelineId=${encodeURIComponent(pinnedTimelineId)}` : ''
    const url = `${baseUrl}${WORLDS_PATH}/${encodeURIComponent(pinnedWorldId)}${query}`
    const snapshot = validateSnapshot(await getJson(signal, url))

    if (snapshot.world.id !== pinnedWorldId) {
      throw new Error('雾影庄公开快照身份与请求的世界不一致')
    }
    assertMistManor(snapshot.world.name, snapshot.world.id)

    if (pinnedTimelineId && snapshot.currentTimelineId !== pinnedTimelineId) {
      throw new Error(
        `雾影庄时间线已变化（期望 ${pinnedTimelineId}，实际 ${snapshot.currentTimelineId}），本次刷新未应用`,
      )
    }
    pinnedTimelineId = snapshot.currentTimelineId

    throwIfAborted(signal)
    return adaptSnapshot(snapshot, scene)
  }

  return { load }
}
