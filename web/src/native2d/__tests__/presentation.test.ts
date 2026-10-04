import { describe, expect, it } from 'vitest'
import type { GridPoint, TimeOfDay, WorldReadModel } from '../types'
import {
  FIXTURE_LOCATION_NAMES,
  FIXTURE_PERSON_IDS,
  createFixtureReadModel,
} from '../fixtures'
import {
  EXTERIOR_SPACE_ID,
  HALL_SPACE_ID,
  LOCATION_KEYS,
  MIST_MANOR_SCENE,
} from '../scene'
import { RESIDENT_ASSET_IDS } from '../assets'
import { createInitialLayout } from '../layout-validation'
import { buildPresentation, resolveResidentPlacement } from '../presentation'
import { effectiveTimeZone, formatWorldTime } from '../../lib/world-time'

const scene = MIST_MANOR_SCENE
const dayWorld = createFixtureReadModel('mist-manor-day')
const layout = createInitialLayout(scene, dayWorld.scope)

function key(p: GridPoint): string {
  return `${p.x},${p.z}`
}

/** 某地点键对应的绑定站位（绝对格子）。 */
function slotsOf(locationKey: string): GridPoint[] {
  const binding = scene.locationBindings.find((b) => b.locationKey === locationKey)
  if (!binding) throw new Error(`测试缺少绑定 ${locationKey}`)
  const rep = binding.representation
  if (rep.kind === 'unrepresented') throw new Error(`绑定 ${locationKey} 无站位`)
  return rep.residentSlots.map((s) => ({ x: s.x, z: s.z }))
}

describe('resolveResidentPlacement（T18）', () => {
  it('大厅居民定位到大厅空间，站位落在大厅绑定站位内', () => {
    const p = resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.muginoToru)
    expect(p.status).toBe('visible')
    expect(p.spaceId).toBe(HALL_SPACE_ID)
    expect(p.reason).toBeNull()
    expect(p.point).not.toBeNull()
    expect(slotsOf(LOCATION_KEYS.hall).map(key)).toContain(key(p.point as GridPoint))
  })

  it('同一地点按 personId 稳定排序分配站位', () => {
    // 大厅两人：person-mugino-toru 字典序小于 person-sayo，分别取第 1、2 个站位。
    const slots = slotsOf(LOCATION_KEYS.hall)
    const mugino = resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.muginoToru)
    const sayo = resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.sayo)
    expect(mugino.point).toEqual(slots[0])
    expect(sayo.point).toEqual(slots[1])
  })

  it('后山散步道居民定位到外景锚点区站位', () => {
    const p = resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.shirakawaRei)
    expect(p.status).toBe('visible')
    expect(p.spaceId).toBe(EXTERIOR_SPACE_ID)
    expect(slotsOf(LOCATION_KEYS.hillPath).map(key)).toContain(key(p.point as GridPoint))
  })

  it('未提供内景的地点（书房）保留真实归属并返回定位限制', () => {
    const p = resolveResidentPlacement(
      dayWorld,
      scene,
      layout,
      FIXTURE_PERSON_IDS.shirakawaSoichiro,
    )
    expect(p.status).toBe('unrepresented')
    expect(p.spaceId).toBeNull()
    expect(p.point).toBeNull()
    expect(p.reason).toContain(FIXTURE_LOCATION_NAMES.study)
  })

  it('未提供内景的门房小屋同样保留真实归属', () => {
    const p = resolveResidentPlacement(
      dayWorld,
      scene,
      layout,
      FIXTURE_PERSON_IDS.mitamuraChizuru,
    )
    expect(p.status).toBe('unrepresented')
    expect(p.point).toBeNull()
    expect(p.reason).toContain(FIXTURE_LOCATION_NAMES.gatehouse)
  })

  it('locationName 为 null 时返回 unknown，不虚构位置', () => {
    const p = resolveResidentPlacement(
      dayWorld,
      scene,
      layout,
      FIXTURE_PERSON_IDS.hiiragiKazunari,
    )
    expect(p.status).toBe('unknown')
    expect(p.spaceId).toBeNull()
    expect(p.point).toBeNull()
    expect(p.reason).toBeTruthy()
  })

  it('personId 不在当前快照时返回 unknown 与明确原因', () => {
    const refreshWorld = createFixtureReadModel('mist-manor-refresh')
    const p = resolveResidentPlacement(
      refreshWorld,
      scene,
      layout,
      FIXTURE_PERSON_IDS.hiiragiKazunari,
    )
    expect(p.status).toBe('unknown')
    expect(p.spaceId).toBeNull()
    expect(p.point).toBeNull()
    expect(p.reason).toBe('居民不在当前快照')
  })

  it('居民消失后其余居民按新快照重新定位（刷新用例）', () => {
    const refreshWorld = createFixtureReadModel('mist-manor-refresh')
    // 雾野透刷新后走到后山散步道。
    const mugino = resolveResidentPlacement(
      refreshWorld,
      scene,
      layout,
      FIXTURE_PERSON_IDS.muginoToru,
    )
    expect(mugino.status).toBe('visible')
    expect(mugino.spaceId).toBe(EXTERIOR_SPACE_ID)
    // 小夜刷新后在餐厅（未提供内景）。
    const sayo = resolveResidentPlacement(refreshWorld, scene, layout, FIXTURE_PERSON_IDS.sayo)
    expect(sayo.status).toBe('unrepresented')
    expect(sayo.reason).toContain(FIXTURE_LOCATION_NAMES.diningRoom)
  })

  it('站位不足时多余居民保留真实地点但无站位（overcrowded 用例）', () => {
    const crowded = createFixtureReadModel('mist-manor-overcrowded')
    const slots = slotsOf(LOCATION_KEYS.hall)
    const placements = crowded.residents.map((r) =>
      resolveResidentPlacement(crowded, scene, layout, r.personId),
    )
    const visible = placements.filter((p) => p.status === 'visible')
    const overflow = placements.filter((p) => p.status === 'unrepresented')
    // 大厅 4 个站位、6 名居民：前 4 名（按 personId 排序）可见，其余保留真实归属。
    expect(visible).toHaveLength(slots.length)
    expect(overflow).toHaveLength(crowded.residents.length - slots.length)
    const visibleIds = visible.map((p) => p.personId).sort()
    expect(visibleIds).toEqual(
      [...crowded.residents.map((r) => r.personId)].sort().slice(0, slots.length),
    )
    // 站位互不重复且全部属于大厅站位。
    const usedKeys = visible.map((p) => key(p.point as GridPoint))
    expect(new Set(usedKeys).size).toBe(usedKeys.length)
    for (const k of usedKeys) expect(slots.map(key)).toContain(k)
    for (const p of overflow) {
      expect(p.point).toBeNull()
      expect(p.spaceId).toBeNull()
      expect(p.reason).toContain(FIXTURE_LOCATION_NAMES.hall)
      expect(p.reason).toContain('站位不足')
    }
  })

  it('同输入定位稳定：重复调用与不同解析顺序结果一致', () => {
    const first = resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.muginoToru)
    // 先解析同地点其他居民，再解析目标，站位分配不变。
    resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.sayo)
    const second = resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.muginoToru)
    expect(second).toEqual(first)
    expect(resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.sayo)).toEqual(
      resolveResidentPlacement(dayWorld, scene, layout, FIXTURE_PERSON_IDS.sayo),
    )
  })

  it('移动建筑（layout 变化）不改变地点/personId 归属', () => {
    const movedLayout = {
      scope: layout.scope,
      placements: layout.placements.map((p) =>
        p.buildingId === 'main-house' ? { ...p, origin: { x: p.origin.x + 1, z: p.origin.z } } : p,
      ),
    }
    for (const resident of dayWorld.residents) {
      const before = resolveResidentPlacement(dayWorld, scene, layout, resident.personId)
      const after = resolveResidentPlacement(dayWorld, scene, movedLayout, resident.personId)
      expect(after).toEqual(before)
    }
  })

  it('地点无匹配 binding 时返回 unknown 并保留真实地点名', () => {
    const world = {
      ...dayWorld,
      residents: [
        {
          personId: 'person-stranger',
          name: '陌生人',
          locationName: '地窖',
          activity: '摸索前行',
        },
      ],
    }
    const p = resolveResidentPlacement(world, scene, layout, 'person-stranger')
    expect(p.status).toBe('unknown')
    expect(p.spaceId).toBeNull()
    expect(p.point).toBeNull()
    expect(p.reason).toContain('地窖')
  })

  it('不修改传入的世界、场景或布局数据', () => {
    const worldSnapshot = JSON.stringify(dayWorld)
    const sceneSnapshot = JSON.stringify(scene)
    const layoutSnapshot = JSON.stringify(layout)
    for (const resident of dayWorld.residents) {
      resolveResidentPlacement(dayWorld, scene, layout, resident.personId)
    }
    expect(JSON.stringify(dayWorld)).toBe(worldSnapshot)
    expect(JSON.stringify(scene)).toBe(sceneSnapshot)
    expect(JSON.stringify(layout)).toBe(layoutSnapshot)
  })
})

/** 以白昼快照为底，覆盖指定字段构造自定义世界。 */
function worldWith(overrides: Partial<WorldReadModel>): WorldReadModel {
  return { ...createFixtureReadModel('mist-manor-day'), ...overrides }
}

function exteriorSpace() {
  const space = scene.spaces.find((s) => s.id === EXTERIOR_SPACE_ID)
  if (!space) throw new Error('测试场景缺少外景空间')
  return space
}

function hallSpace() {
  const space = scene.spaces.find((s) => s.id === HALL_SPACE_ID)
  if (!space) throw new Error('测试场景缺少大厅空间')
  return space
}

/** 从 formatWorldTime 文本解析小时（同一 simNow 的文本基准）。 */
function hourFromText(simNow: string | null, timeZone: string): number | null {
  const text = formatWorldTime(simNow, timeZone)
  const match = text.match(/(\d{2}):(\d{2}) \(/)
  return match ? Number(match[1]) : null
}

/** 与实现一致的相位区间（测试独立重述规格边界）。 */
function expectedPhase(hour: number): TimeOfDay {
  if (hour >= 20 || hour < 6) return 'night'
  if (hour < 9) return 'dawn'
  if (hour < 17) return 'day'
  return 'dusk'
}

describe('buildPresentation（T19）', () => {
  it('外景对象集合：三栋建筑 + 全部外景静态物件 + 后山地点标记 + 外景可见居民', () => {
    const presentation = buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    const buildings = presentation.objects.filter((o) => o.kind === 'building')
    const decorations = presentation.objects.filter((o) => o.kind === 'decoration')
    const locations = presentation.objects.filter((o) => o.kind === 'location')
    const residents = presentation.objects.filter((o) => o.kind === 'resident')
    expect(buildings.map((b) => b.id).sort()).toEqual([
      'building:gatehouse',
      'building:greenhouse',
      'building:main-house',
    ])
    expect(decorations).toHaveLength(exteriorSpace().staticObjects.length)
    expect(locations.map((l) => l.id)).toEqual([`location:${LOCATION_KEYS.hillPath}`])
    // 白昼快照外景可见居民：仅后山散步道的白川怜。
    expect(residents.map((r) => r.id)).toEqual([`resident:${FIXTURE_PERSON_IDS.shirakawaRei}`])
  })

  it('大厅对象集合：无建筑，含大厅静态物件、大厅地点标记与大厅居民', () => {
    const presentation = buildPresentation(dayWorld, scene, layout, HALL_SPACE_ID)
    expect(presentation.objects.filter((o) => o.kind === 'building')).toHaveLength(0)
    expect(presentation.objects.filter((o) => o.kind === 'decoration')).toHaveLength(
      hallSpace().staticObjects.length,
    )
    expect(
      presentation.objects.filter((o) => o.kind === 'location').map((l) => l.id),
    ).toEqual([`location:${LOCATION_KEYS.hall}`])
    // 大厅居民只在大厅呈现：雾野透、小夜（按 personId 排序）。
    const residentIds = presentation.objects
      .filter((o) => o.kind === 'resident')
      .map((r) => r.id)
    expect(residentIds).toEqual([
      `resident:${FIXTURE_PERSON_IDS.muginoToru}`,
      `resident:${FIXTURE_PERSON_IDS.sayo}`,
    ])
  })

  it('建筑对象原点取自布局 placements，素材取自建筑定义', () => {
    const presentation = buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    const mainHouse = presentation.objects.find((o) => o.id === 'building:main-house')
    expect(mainHouse?.origin).toEqual({ x: 3, z: 2 })
    expect(mainHouse?.assetId).toBe('main-house')
  })

  it('selection 映射：resident/building/location 各自可辨识，decoration 为 null', () => {
    const exterior = buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    const building = exterior.objects.find((o) => o.kind === 'building')
    const decoration = exterior.objects.find((o) => o.kind === 'decoration')
    const location = exterior.objects.find((o) => o.kind === 'location')
    const resident = exterior.objects.find((o) => o.kind === 'resident')
    expect(building?.selection).toEqual({ kind: 'building', buildingId: 'main-house' })
    expect(decoration?.selection).toBeNull()
    expect(location?.selection).toEqual({
      kind: 'location',
      locationKey: LOCATION_KEYS.hillPath,
    })
    expect(resident?.selection).toEqual({
      kind: 'resident',
      personId: FIXTURE_PERSON_IDS.shirakawaRei,
    })
  })

  it('居民素材按 personId 排序取模稳定分配（resident-a/b/c）', () => {
    const hall = buildPresentation(dayWorld, scene, layout, HALL_SPACE_ID)
    const residents = hall.objects.filter((o) => o.kind === 'resident')
    for (const r of residents) {
      expect(RESIDENT_ASSET_IDS).toContain(r.assetId)
    }
    // 白昼快照按 personId 排序：hiiragi(0→a)、mitamura(1→b)、mugino(2→c)、
    // sayo(3→a)、shirakawa-rei(4→b)、shirakawa-soichiro(5→c)。
    expect(residents.find((r) => r.id === `resident:${FIXTURE_PERSON_IDS.muginoToru}`)?.assetId).toBe(
      'resident-c',
    )
    expect(residents.find((r) => r.id === `resident:${FIXTURE_PERSON_IDS.sayo}`)?.assetId).toBe(
      'resident-a',
    )
    const exterior = buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    expect(
      exterior.objects.find((o) => o.id === `resident:${FIXTURE_PERSON_IDS.shirakawaRei}`)
        ?.assetId,
    ).toBe('resident-b')
    // 同输入同结果。
    expect(buildPresentation(dayWorld, scene, layout, HALL_SPACE_ID).objects).toEqual(hall.objects)
  })

  it('PresentedLocation 覆盖全部地点并携带 binding 对应的表现类型', () => {
    const presentation = buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    expect(presentation.locations).toHaveLength(dayWorld.locations.length)
    const byName = new Map(presentation.locations.map((l) => [l.name, l]))
    expect(byName.get(FIXTURE_LOCATION_NAMES.hall)?.representation).toBe('interior')
    expect(byName.get(FIXTURE_LOCATION_NAMES.study)?.representation).toBe('unrepresented')
    expect(byName.get(FIXTURE_LOCATION_NAMES.diningRoom)?.representation).toBe('unrepresented')
    expect(byName.get(FIXTURE_LOCATION_NAMES.library)?.representation).toBe('unrepresented')
    expect(byName.get(FIXTURE_LOCATION_NAMES.greenhouse)?.representation).toBe('unrepresented')
    expect(byName.get(FIXTURE_LOCATION_NAMES.gatehouse)?.representation).toBe('unrepresented')
    expect(byName.get(FIXTURE_LOCATION_NAMES.backHillTrail)?.representation).toBe('outdoor')
    // 名称/描述来自世界 locations；residentIds 按 personId 排序。
    const hall = byName.get(FIXTURE_LOCATION_NAMES.hall)
    expect(hall?.locationKey).toBe(LOCATION_KEYS.hall)
    expect(hall?.description).toBe(dayWorld.locations[0].description)
    expect(hall?.residentIds).toEqual(
      [FIXTURE_PERSON_IDS.muginoToru, FIXTURE_PERSON_IDS.sayo].sort(),
    )
    // 未提供内景的地点保留在场信息（不挪走居民）。
    expect(byName.get(FIXTURE_LOCATION_NAMES.study)?.residentIds).toEqual([
      FIXTURE_PERSON_IDS.shirakawaSoichiro,
    ])
  })

  it('世界里有但 binding 缺失的地点 → representation unknown、locationKey 为 null', () => {
    const world = worldWith({
      locations: [
        ...createFixtureReadModel('mist-manor-day').locations,
        { name: '地窖', description: '堆放旧物的地下室。' },
      ],
    })
    const presentation = buildPresentation(world, scene, layout, EXTERIOR_SPACE_ID)
    const cellar = presentation.locations.find((l) => l.name === '地窖')
    expect(cellar?.representation).toBe('unknown')
    expect(cellar?.locationKey).toBeNull()
    expect(cellar?.description).toBe('堆放旧物的地下室。')
  })

  it('timeOfDay 边界小时：5:59/6:00/8:59/9:00/16:59/17:00/19:59/20:00（UTC）', () => {
    const cases: Array<[string, TimeOfDay]> = [
      ['2026-01-15T05:59:00.000Z', 'night'],
      ['2026-01-15T06:00:00.000Z', 'dawn'],
      ['2026-01-15T08:59:00.000Z', 'dawn'],
      ['2026-01-15T09:00:00.000Z', 'day'],
      ['2026-01-15T16:59:00.000Z', 'day'],
      ['2026-01-15T17:00:00.000Z', 'dusk'],
      ['2026-01-15T19:59:00.000Z', 'dusk'],
      ['2026-01-15T20:00:00.000Z', 'night'],
    ]
    for (const [simNow, expected] of cases) {
      const world = worldWith({ simNow, timeZone: 'UTC' })
      const presentation = buildPresentation(world, scene, layout, EXTERIOR_SPACE_ID)
      expect(presentation.timeOfDay).toBe(expected)
    }
  })

  it('跨时区输入：同一 simNow 按世界时区取小时，可落在不同相位', () => {
    // UTC 16:30 = 东京次日 01:30：UTC 为昼，Asia/Tokyo 为夜。
    const simNow = '2026-01-15T16:30:00.000Z'
    const utc = buildPresentation(worldWith({ simNow, timeZone: 'UTC' }), scene, layout, EXTERIOR_SPACE_ID)
    const tokyo = buildPresentation(
      worldWith({ simNow, timeZone: 'Asia/Tokyo' }),
      scene,
      layout,
      EXTERIOR_SPACE_ID,
    )
    expect(utc.timeOfDay).toBe('day')
    expect(tokyo.timeOfDay).toBe('night')
    // 白昼 fixture：04:00Z = 东京 13:00 → 昼。
    expect(buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID).timeOfDay).toBe('day')
  })

  it('跨日输入：世界时区日期翻转时相位仍按世界时区小时推导', () => {
    // UTC 23:30 = 东京次日 08:30 → 黎明（跨日后的小时 8）。
    const world = worldWith({ simNow: '2026-01-15T23:30:00.000Z', timeZone: 'Asia/Tokyo' })
    const presentation = buildPresentation(world, scene, layout, EXTERIOR_SPACE_ID)
    expect(presentation.timeOfDay).toBe('dawn')
    // 文本同日历已翻到下一天，确认确实跨日。
    expect(formatWorldTime(world.simNow, world.timeZone)).toContain('2026-01-16 08:30')
  })

  it('未知时间：simNow 为 null 或非法字符串时 timeOfDay 为 unknown', () => {
    const unknownFixture = createFixtureReadModel('mist-manor-unknown-time')
    expect(
      buildPresentation(unknownFixture, scene, layout, EXTERIOR_SPACE_ID).timeOfDay,
    ).toBe('unknown')
    expect(
      buildPresentation(
        worldWith({ simNow: 'not-a-date' }),
        scene,
        layout,
        EXTERIOR_SPACE_ID,
      ).timeOfDay,
    ).toBe('unknown')
    expect(
      buildPresentation(worldWith({ simNow: '' }), scene, layout, EXTERIOR_SPACE_ID).timeOfDay,
    ).toBe('unknown')
  })

  it('同一 simNow 的文本（formatWorldTime）与光照相位一致', () => {
    const samples: Array<[string, string]> = [
      ['2026-01-15T04:00:00.000Z', 'Asia/Tokyo'],
      ['2026-01-15T16:30:00.000Z', 'Asia/Tokyo'],
      ['2026-01-15T23:30:00.000Z', 'Asia/Tokyo'],
      ['2026-01-15T08:59:00.000Z', 'UTC'],
      ['2026-01-15T17:00:00.000Z', 'UTC'],
      ['2026-01-15T20:00:00.000Z', 'UTC'],
    ]
    for (const [simNow, timeZone] of samples) {
      const world = worldWith({ simNow, timeZone })
      const presentation = buildPresentation(world, scene, layout, EXTERIOR_SPACE_ID)
      const hour = hourFromText(simNow, timeZone)
      expect(hour).not.toBeNull()
      expect(presentation.timeOfDay).toBe(expectedPhase(hour as number))
      // 呈现时区与文本时区归一一致。
      expect(presentation.timeZone).toBe(effectiveTimeZone(timeZone))
      expect(formatWorldTime(simNow, presentation.timeZone)).toBe(
        formatWorldTime(simNow, timeZone),
      )
    }
  })

  it('scope/spaceId/simNow/residents 原样透出，活动文本不加工', () => {
    const presentation = buildPresentation(dayWorld, scene, layout, HALL_SPACE_ID)
    expect(presentation.scope).toBe(dayWorld.scope)
    expect(presentation.spaceId).toBe(HALL_SPACE_ID)
    expect(presentation.simNow).toBe(dayWorld.simNow)
    expect(presentation.residents).toEqual(dayWorld.residents)
    // 活动文本仅如实呈现（含 null 活动）。
    const hiiragi = presentation.residents.find(
      (r) => r.personId === FIXTURE_PERSON_IDS.hiiragiKazunari,
    )
    expect(hiiragi?.activity).toBeNull()
    const mugino = presentation.residents.find(
      (r) => r.personId === FIXTURE_PERSON_IDS.muginoToru,
    )
    expect(mugino?.activity).toBe('在暖炉边翻看侦探笔记')
  })

  it('residentPlacements 覆盖快照全部居民（含不可见与未知）', () => {
    const presentation = buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    expect(presentation.residentPlacements.map((p) => p.personId)).toEqual(
      dayWorld.residents.map((r) => r.personId),
    )
    const unknown = presentation.residentPlacements.find(
      (p) => p.personId === FIXTURE_PERSON_IDS.hiiragiKazunari,
    )
    expect(unknown?.status).toBe('unknown')
    const unrepresented = presentation.residentPlacements.find(
      (p) => p.personId === FIXTURE_PERSON_IDS.shirakawaSoichiro,
    )
    expect(unrepresented?.status).toBe('unrepresented')
  })

  it('空间切换只改变对象集合，居民归属与地点列表不变', () => {
    const exterior = buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    const hall = buildPresentation(dayWorld, scene, layout, HALL_SPACE_ID)
    expect(exterior.residentPlacements).toEqual(hall.residentPlacements)
    expect(exterior.locations).toEqual(hall.locations)
    expect(exterior.timeOfDay).toBe(hall.timeOfDay)
    expect(exterior.objects).not.toEqual(hall.objects)
  })

  it('未知空间明确抛错；不修改任何输入', () => {
    expect(() => buildPresentation(dayWorld, scene, layout, 'no-such-space')).toThrow()
    const worldSnapshot = JSON.stringify(dayWorld)
    const sceneSnapshot = JSON.stringify(scene)
    const layoutSnapshot = JSON.stringify(layout)
    buildPresentation(dayWorld, scene, layout, EXTERIOR_SPACE_ID)
    buildPresentation(dayWorld, scene, layout, HALL_SPACE_ID)
    expect(JSON.stringify(dayWorld)).toBe(worldSnapshot)
    expect(JSON.stringify(scene)).toBe(sceneSnapshot)
    expect(JSON.stringify(layout)).toBe(layoutSnapshot)
  })
})
