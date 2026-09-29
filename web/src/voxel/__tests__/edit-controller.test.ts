import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyEdits, clampTerrainParams, createBlockRegistry, createEmptyWorld, generateTerrainCells, getBlock,
  writeTerrainCells,
  type VoxelDocument,
} from '@possibility/voxel-contract'
import type { AtlasJson } from '../engine/atlas'
import { VoxelEngine } from '../engine'
import { EditController } from '../bridge/edit-controller'

const at = (x: number, y: number, z: number) => ({ x, y, z })

/** 无头引擎：不挂 canvas，仅加载注册表 + 假图集 + 文档 */
function headlessEngine() {
  const engine = new VoxelEngine()
  const registry = createBlockRegistry('mist-manor')
  engine.registry = registry
  const frames: AtlasJson['frames'] = {}
  let i = 0
  for (const block of registry.list()) {
    for (const name of [block.textures.top, block.textures.side, block.textures.bottom]) {
      if (name && !frames[name]) frames[name] = { x: (i++ % 8) * 32, y: 0, w: 32, h: 32 }
    }
  }
  engine.atlas.setTexture(new THREE.Texture(), { width: 256, height: 32, frames })
  const doc = createEmptyWorld({ width: 32, height: 16, depth: 32 }, 'mist-manor', 'test')
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    doc.sections['0,0,0'] ??= { palette: ['air'], indices: new Uint16Array(4096), nonAirCount: 0 }
    break
  }
  const grounded = applyEdits(doc, [{ kind: 'fill', from: at(0, 0, 0), to: at(31, 0, 31), block: 'grass' }]).document
  engine.loadDocument(grounded)
  return engine
}

describe('EditController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies legal edits and rebakes only affected sections', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine })
    const outcome = controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], false)
    expect(outcome.ok).toBe(true)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('stone')
    engine.dispose()
  })

  it('rejects edits on locked objects (AC15 雏形)', () => {
    const engine = headlessEngine()
    const placed = applyEdits(engine.world!.doc, [{ kind: 'place-object', objectType: 'stone-lantern', anchor: at(5, 1, 5), rotation: 0, objectId: 'lamp' }])
    engine.loadDocument({ ...placed.document, lockedObjectIds: ['lamp'] })
    const rejected: unknown[] = []
    const controller = new EditController({ engine, onRejected: (i) => rejected.push(i) })
    const dig = controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'air' }])
    expect(dig.ok).toBe(false)
    expect((dig as { issues: Array<{ code: string }> }).issues[0].code).toBe('locked-violation')
    const move = controller.applyOps([{ kind: 'move-object', objectId: 'lamp', anchor: at(8, 1, 8) }])
    expect(move.ok).toBe(false)
    const remove = controller.applyOps([{ kind: 'remove-object', objectId: 'lamp' }])
    expect(remove.ok).toBe(false)
    expect(rejected).toHaveLength(3)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('stone') // 未被改动
    engine.dispose()
  })

  it('rejects invalid edits (out of bounds / unknown block)', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine })
    expect(controller.applyOps([{ kind: 'set-block', at: at(40, 1, 1), block: 'stone' }]).ok).toBe(false)
    expect(controller.applyOps([{ kind: 'set-block', at: at(1, 1, 1), block: 'ectoplasm' }]).ok).toBe(false)
    engine.dispose()
  })

  it('honors the canEdit gate', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine, canEdit: () => false })
    const outcome = controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }])
    expect(outcome.ok).toBe(false)
    expect(engine.world!.getBlock(at(5, 1, 5))).toBe('air')
    engine.dispose()
  })

  it('debounces saves: 10 rapid edits merge into one save', () => {
    const engine = headlessEngine()
    const saved: string[] = []
    const controller = new EditController({ engine, save: (doc) => { saved.push(doc.id) }, saveDebounceMs: 500 })
    for (let i = 0; i < 10; i++) {
      controller.applyOps([{ kind: 'set-block', at: at(i + 2, 1, 2), block: 'stone' }], false)
    }
    vi.advanceTimersByTime(600)
    expect(saved).toHaveLength(1)
    expect(controller.saves).toBe(1)
    controller.dispose()
    engine.dispose()
  })

  it('flushSave persists immediately with the latest document', () => {
    const engine = headlessEngine()
    const saved: number[] = []
    const controller = new EditController({ engine, save: (doc) => { saved.push(Object.keys(doc.sections).length) } })
    controller.applyOps([{ kind: 'set-block', at: at(5, 1, 5), block: 'stone' }], false)
    controller.applyOps([{ kind: 'set-block', at: at(20, 1, 5), block: 'stone' }], false)
    controller.flushSave()
    expect(saved).toHaveLength(1)
    controller.flushSave() // 无 pending，不重复保存
    expect(saved).toHaveLength(1)
    engine.dispose()
  })
})

describe('EditController × S3b 地形重生成与风格包', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const TERRAIN_SIZE = { width: 32, height: 16, depth: 32 }

  function terrainEngine() {
    const engine = headlessEngine()
    const { params } = clampTerrainParams(
      { seed: 42, elevation: { amplitude: 4 }, river: { enabled: true }, vegetation: { density: 0.05 } },
      TERRAIN_SIZE,
    )
    const cells = generateTerrainCells(TERRAIN_SIZE, params)
    const doc = {
      ...writeTerrainCells(engine.world!.doc, cells).document,
      terrain: { params, clamps: [] },
    }
    engine.loadDocument(doc)
    return { engine, params }
  }

  const topY = (doc: VoxelDocument, x: number, z: number) => {
    for (let y = doc.size.height - 1; y >= 0; y--) {
      if (getBlock(doc, at(x, y, z)) !== 'air') return y
    }
    return 0
  }

  it('非参数化地形世界 → 拒绝并给 invalid-meta', () => {
    const engine = headlessEngine()
    const controller = new EditController({ engine })
    const outcome = controller.regenerateTerrain({ elevation: { amplitude: 2 } })
    expect(outcome.ok).toBe(false)
    expect(outcome.issues[0].code).toBe('invalid-meta')
    engine.dispose()
  })

  it('重生成替换地形层但物体格原样保留(F7)', () => {
    const { engine } = terrainEngine()
    const doc = engine.world!.doc
    const anchor = at(10, topY(doc, 10, 10) + 1, 10)
    const placed = applyEdits(doc, [
      { kind: 'place-object', objectType: 'stone-lantern', anchor, rotation: 0, objectId: 'lamp' },
    ]).document
    engine.loadDocument(placed)
    const lampCells = placed.objectCells.find((c) => c.objectId === 'lamp')!.cells
    const before = lampCells.map((c) => getBlock(engine.world!.doc, c))

    const controller = new EditController({ engine })
    const outcome = controller.regenerateTerrain({ seed: 42, elevation: { amplitude: 4 }, river: { enabled: false }, vegetation: { density: 0.05 } })
    expect(outcome.ok).toBe(true)
    expect(Array.isArray(outcome.issues)).toBe(true)
    // 物体记录与格子内容原样
    expect(engine.world!.doc.objectCells.find((c) => c.objectId === 'lamp')).toBeDefined()
    lampCells.forEach((c, i) => expect(getBlock(engine.world!.doc, c)).toBe(before[i]))
    // 元数据已更新
    expect(engine.world!.doc.terrain?.params.river?.enabled).toBe(false)
    engine.dispose()
  })

  it('手工挖掉的地形格在重生成时被覆盖(F7)', () => {
    const { engine } = terrainEngine()
    const doc = engine.world!.doc
    const victim = at(5, topY(doc, 5, 5), 5)
    const controller = new EditController({ engine })
    const dug = controller.applyOps([{ kind: 'set-block', at: victim, block: 'air' }], false)
    expect(dug.ok).toBe(true)
    expect(getBlock(engine.world!.doc, victim)).toBe('air')
    const outcome = controller.regenerateTerrain(engine.world!.doc.terrain!.params)
    expect(outcome.ok).toBe(true)
    expect(getBlock(engine.world!.doc, victim)).not.toBe('air')
    engine.dispose()
  })

  it('setStyle:夹取落文档、引擎即时生效、未知预设记录(F8/F9)', () => {
    const { engine } = terrainEngine()
    const controller = new EditController({ engine })
    const outcome = controller.setStyle({ preset: 'dusk-warm', tweaks: { exposure: 5 } })
    expect(outcome.ok).toBe(true)
    expect(engine.getStyle()?.preset).toBe('dusk-warm')
    expect(engine.getStyle()?.tweaks?.exposure).toBe(0.3)
    const docStyle = engine.world!.doc.style
    expect(docStyle?.preset).toBe('dusk-warm')
    expect(docStyle?.clamps).toEqual([{ field: 'style.tweaks.exposure', from: 5, to: 0.3 }])

    const unknown = controller.setStyle({ preset: 'cyberpunk' })
    expect(unknown.ok).toBe(true)
    expect(engine.world!.doc.style?.preset).toBe('default')
    expect(engine.world!.doc.style?.clamps).toEqual([{ field: 'style.preset', from: 'cyberpunk', to: 'default' }])
    engine.dispose()
  })
})
