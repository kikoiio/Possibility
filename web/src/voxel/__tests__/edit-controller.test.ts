import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlockRegistry, createEmptyWorld, applyEdits } from '@possibility/voxel-contract'
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
