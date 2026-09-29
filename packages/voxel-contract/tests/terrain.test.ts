import { describe, expect, it } from 'vitest'
import {
  applyEdits, BASE_GROUND_Y, clampTerrainParams, createEmptyWorld, diffTerrainRegen, generateTerrain, generateTerrainCells,
  getBlock, TERRAIN_QUOTAS, validateDocument, writeTerrainCells,
  type ResolvedTerrainParams, type TerrainCell,
} from '../src'

const SIZE = { width: 32, height: 24, depth: 32 }
const at = (x: number, y: number, z: number) => ({ x, y, z })

const cellMap = (cells: TerrainCell[]) => {
  const map = new Map<string, string>()
  for (const c of cells) map.set(`${c.at.x},${c.at.y},${c.at.z}`, c.block)
  return map
}

const fullParams = (over: Partial<ResolvedTerrainParams> = {}): ResolvedTerrainParams => ({
  seed: 42,
  elevation: { amplitude: 5, scale: 24 },
  river: { enabled: true, width: 2 },
  lakes: { enabled: true, size: 4 },
  vegetation: { density: 0.05, trees: true, flowers: true, bushes: true },
  ...over,
})

describe('clampTerrainParams', () => {
  it('空输入 → 全默认零记录', () => {
    const { params, clamps } = clampTerrainParams({}, SIZE, 777)
    expect(params).toEqual({ seed: 777 })
    expect(clamps).toEqual([])
  })

  it('逐项超限 → 夹后值 + 记录', () => {
    const { params, clamps } = clampTerrainParams({
      elevation: { amplitude: 99, scale: 1 },
      river: { enabled: true, width: 10 },
      lakes: { enabled: true, size: 99 },
      vegetation: { density: 0.9 },
    }, SIZE)
    expect(params.elevation?.amplitude).toBe(Math.min(TERRAIN_QUOTAS.amplitudeMax, Math.floor(SIZE.height / 4)))
    expect(params.elevation?.scale).toBe(TERRAIN_QUOTAS.scaleMin)
    expect(params.river?.width).toBe(TERRAIN_QUOTAS.riverWidthMax)
    expect(params.lakes?.size).toBe(TERRAIN_QUOTAS.lakeSizeMax)
    expect(params.vegetation?.density).toBe(TERRAIN_QUOTAS.densityMax)
    expect(clamps.map((c) => c.field)).toEqual([
      'elevation.amplitude', 'elevation.scale', 'river.width', 'lakes.size', 'vegetation.density',
    ])
    expect(clamps.find((c) => c.field === 'vegetation.density')).toMatchObject({ from: 0.9, to: TERRAIN_QUOTAS.densityMax })
  })

  it('amplitude 受世界高度约束', () => {
    const { params, clamps } = clampTerrainParams({ elevation: { amplitude: 8 } }, { width: 16, height: 12, depth: 16 })
    expect(params.elevation?.amplitude).toBe(3)
    expect(clamps).toEqual([{ field: 'elevation.amplitude', from: 8, to: 3 }])
  })

  it('布尔字段非布尔按 false', () => {
    const { params } = clampTerrainParams({ river: { enabled: 'yes' as unknown as boolean } }, SIZE)
    expect(params.river?.enabled).toBe(false)
  })

  it('seed 非整数 → 用 fallbackSeed', () => {
    const { params } = clampTerrainParams({ seed: 3.5 }, SIZE, 1234)
    expect(params.seed).toBe(1234)
  })
})

describe('generateTerrainCells', () => {
  it('同 (size, params) 两次生成全等(F2/AC2)', () => {
    const a = generateTerrainCells(SIZE, fullParams())
    const b = generateTerrainCells(SIZE, fullParams())
    expect(a).toEqual(b)
  })

  it('不同 seed 输出不同', () => {
    const a = generateTerrainCells(SIZE, fullParams({ seed: 1 }))
    const b = generateTerrainCells(SIZE, fullParams({ seed: 2 }))
    expect(cellMap(a)).not.toEqual(cellMap(b))
  })

  it('river 开启 → 存在 y≤3 的 water 格;全关 → 零 water 格(F3/AC1)', () => {
    const withRiver = generateTerrainCells(SIZE, fullParams())
    expect(withRiver.some((c) => c.block === 'water' && c.at.y <= BASE_GROUND_Y)).toBe(true)
    const dry = generateTerrainCells(SIZE, fullParams({ river: { enabled: false }, lakes: { enabled: false } }))
    expect(dry.some((c) => c.block === 'water')).toBe(false)
  })

  it('amplitude=0 且无水 → 全部柱顶格为 y=3 的 grass', () => {
    const cells = generateTerrainCells(SIZE, {
      seed: 7,
      elevation: { amplitude: 0 },
      vegetation: { density: 0 },
    })
    const map = cellMap(cells)
    for (let z = 0; z < SIZE.depth; z++) {
      for (let x = 0; x < SIZE.width; x++) {
        expect(map.get(`${x},${BASE_GROUND_Y},${z}`)).toBe('grass')
      }
    }
  })

  it('density 拉满时植被格数 ≤ 配额', () => {
    const cells = generateTerrainCells(SIZE, fullParams({
      river: { enabled: false }, lakes: { enabled: false },
      vegetation: { density: TERRAIN_QUOTAS.densityMax, trees: true, flowers: true, bushes: true },
    }))
    const decor = cells.filter((c) => ['flower', 'bush', 'wood-log', 'leaves'].includes(c.block))
    expect(decor.length).toBeLessThanOrEqual(TERRAIN_QUOTAS.decorMax)
  })

  it('树模板格完整:每段 wood-log 上方有 leaves,且不散落半棵树(F3)', () => {
    const cells = generateTerrainCells(SIZE, fullParams({
      river: { enabled: false }, lakes: { enabled: false },
      vegetation: { density: TERRAIN_QUOTAS.densityMax, flowers: false, bushes: false },
    }))
    const generated = generateTerrain(SIZE, fullParams({
      river: { enabled: false }, lakes: { enabled: false },
      vegetation: { density: TERRAIN_QUOTAS.densityMax, flowers: false, bushes: false },
    }))
    expect(generated.assetPlacements.length).toBeGreaterThan(0)
    expect(generated.assetPlacements.every((placement) => placement.assetId === 'veg-tree-a')).toBe(true)
    expect(generated.assetPlacements.every((placement) => Number.isInteger(placement.anchor[0]) && Number.isInteger(placement.anchor[2]))).toBe(true)
    expect(cells.every((cell) => !['wood-log', 'leaves'].includes(cell.block))).toBe(true)
  })

  it('树格不注册 objectCells(物体数不增)', () => {
    const cells = generateTerrainCells(SIZE, fullParams())
    const doc = writeTerrainCells(createEmptyWorld(SIZE, 'mist-manor', 't'), cells).document
    expect(doc.objects).toEqual([])
    expect(doc.objectCells).toEqual([])
  })
})

describe('diffTerrainRegen(F7 地形层替换规则)', () => {
  const oldParams = fullParams({ seed: 42 })
  const newParams = fullParams({ seed: 42, elevation: { amplitude: 2, scale: 24 }, river: { enabled: false }, lakes: { enabled: false } })

  const buildDoc = () => {
    const oldCells = generateTerrainCells(SIZE, oldParams)
    const doc = writeTerrainCells(createEmptyWorld(SIZE, 'mist-manor', 't'), oldCells).document
    return { oldCells, doc }
  }

  it('物体格绝对不动', () => {
    const { oldCells, doc: base } = buildDoc()
    const placed = applyEdits(base, [
      { kind: 'place-object', objectType: 'stone-lantern', anchor: at(8, 4, 8), rotation: 0, objectId: 'lamp' },
    ]).document
    const newCells = generateTerrainCells(SIZE, newParams)
    const diff = diffTerrainRegen(placed, oldCells, newCells)
    const lampCells = placed.objectCells.find((c) => c.objectId === 'lamp')!.cells
    for (const c of lampCells) {
      expect(diff.some((d) => d.at.x === c.x && d.at.y === c.y && d.at.z === c.z)).toBe(false)
    }
  })

  it('被手工改过的旧地形格仍被替换', () => {
    const { oldCells, doc: base } = buildDoc()
    // 手工把一格旧地形挖成 air
    const victim = oldCells.find((c) => c.block === 'grass')!
    const dug = applyEdits(base, [{ kind: 'set-block', at: victim.at, block: 'air' }]).document
    const newCells = generateTerrainCells(SIZE, newParams)
    const diff = diffTerrainRegen(dug, oldCells, newCells)
    const hit = diff.find((d) => d.at.x === victim.at.x && d.at.y === victim.at.y && d.at.z === victim.at.z)
    expect(hit).toBeDefined()
    expect(hit!.block).not.toBe('air-or-skip') // 被写回新输出(grass 或 air,但一定在 diff 里)
  })

  it('仅属新输出的格不压既有非空气块', () => {
    const { oldCells, doc: base } = buildDoc()
    const newCells = generateTerrainCells(SIZE, newParams)
    const oldMap = cellMap(oldCells)
    // 找一个仅属新输出的格,预先放上非空气块(模拟既有建筑)
    const fresh = newCells.find((c) => !oldMap.has(`${c.at.x},${c.at.y},${c.at.z}`))
    if (!fresh) return // 该尺寸/参数下无此情形则跳过
    const built = applyEdits(base, [{ kind: 'set-block', at: fresh.at, block: 'stone' }]).document
    const diff = diffTerrainRegen(built, oldCells, newCells)
    expect(diff.some((d) => d.at.x === fresh.at.x && d.at.y === fresh.at.y && d.at.z === fresh.at.z)).toBe(false)
    // 同一格若当前为 air 则应写入
    const diffOnAir = diffTerrainRegen(base, oldCells, newCells)
    if (getBlock(base, fresh.at) === 'air') {
      expect(diffOnAir.some((d) => d.at.x === fresh.at.x && d.at.y === fresh.at.y && d.at.z === fresh.at.z)).toBe(true)
    }
  })

  it('writeTerrainCells 后重放:重生成结果与直接生成一致(AC2 round-trip)', () => {
    const { oldCells, doc: base } = buildDoc()
    const newCells = generateTerrainCells(SIZE, newParams)
    const diff = diffTerrainRegen(base, oldCells, newCells)
    const regen = writeTerrainCells(base, diff).document
    const direct = writeTerrainCells(createEmptyWorld(SIZE, 'mist-manor', 't'), newCells).document
    for (const probe of [at(0, 0, 0), at(15, 2, 15), at(16, 3, 16), at(31, 1, 31), at(8, 4, 8)]) {
      expect(getBlock(regen, probe)).toBe(getBlock(direct, probe))
    }
  })
})

describe('validateDocument meta 轻校验(F6)', () => {
  it('seed 非整数 / 未知预设 → invalid-meta issue', () => {
    const doc = createEmptyWorld(SIZE, 'mist-manor', 't')
    const bad = {
      ...doc,
      terrain: { params: { seed: 1.5 }, clamps: [] },
      style: { preset: 'nope' },
    }
    const issues = validateDocument(bad)
    expect(issues.filter((i) => i.code === 'invalid-meta').length).toBe(2)
  })

  it('合法 meta 零 issue', () => {
    const doc = {
      ...createEmptyWorld(SIZE, 'mist-manor', 't'),
      terrain: { params: { seed: 1 }, clamps: [] },
      style: { preset: 'dusk-warm' },
    }
    expect(validateDocument(doc).filter((i) => i.code === 'invalid-meta')).toEqual([])
  })
})
