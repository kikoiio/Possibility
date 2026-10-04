import { describe, expect, it } from 'vitest'
import type { GridPoint, LayoutState } from '../types'
import { FIXTURE_SCOPE } from '../fixtures'
import { MIST_MANOR_SCENE } from '../scene'
import {
  createInitialLayout,
  validateBuildingMove,
  validateLayout,
} from '../layout-validation'
import { createLayoutEditor } from '../editor'

const scene = MIST_MANOR_SCENE

/**
 * 测试用合法/非法目标（对照 scene.ts 手工核对）：
 * - GATEHOUSE_OK_A (10,4)：空地，入口 (11,6) 可达。
 * - GATEHOUSE_OK_B (13,9)、GATEHOUSE_OK_C (5,9)：依次多步移动用（入口分别为 (14,11)、(6,11)，均可达）。
 * - GREENHOUSE_OK (2,10)：仅当门房离开初始位 (3,10) 后合法（占地 x2–4×z10–11）。
 * - OUT_OF_BOUNDS (15,13)：2×2 占地越界。
 */
const GATEHOUSE_OK_A: GridPoint = { x: 10, z: 4 }
const GATEHOUSE_OK_B: GridPoint = { x: 13, z: 9 }
const GATEHOUSE_OK_C: GridPoint = { x: 5, z: 9 }
const GREENHOUSE_OK: GridPoint = { x: 2, z: 10 }
const OUT_OF_BOUNDS: GridPoint = { x: 15, z: 13 }

function baselineLayout(): LayoutState {
  return createInitialLayout(scene, FIXTURE_SCOPE)
}

function freshEditor(): ReturnType<typeof createLayoutEditor> {
  return createLayoutEditor(scene, baselineLayout())
}

function originOf(layout: LayoutState, buildingId: string): GridPoint {
  const p = layout.placements.find((pl) => pl.buildingId === buildingId)
  if (!p) throw new Error(`布局缺少建筑 ${buildingId}`)
  return p.origin
}

/** 应用一步合法移动并断言成功，返回应用后的布局。 */
function applyMove(
  editor: ReturnType<typeof createLayoutEditor>,
  buildingId: string,
  target: GridPoint,
): LayoutState {
  const validation = editor.preview(buildingId, target)
  expect(validation.valid).toBe(true)
  const result = editor.applyPreview()
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(originOf(result.layout, buildingId)).toEqual(target)
    return result.layout
  }
  throw new Error('unreachable')
}

/* -------------------------------------------------------------------------- */
/* T13：编辑预览与应用                                                          */
/* -------------------------------------------------------------------------- */

describe('T13 preview', () => {
  it('合法目标返回 valid 且布局不变', () => {
    const editor = freshEditor()
    const before = editor.getLayout()
    const validation = editor.preview('gatehouse', GATEHOUSE_OK_A)
    expect(validation.valid).toBe(true)
    expect(validation.reasons).toEqual([])
    expect(editor.getLayout()).toEqual(before)
    expect(originOf(editor.getLayout(), 'gatehouse')).toEqual({ x: 3, z: 10 })
  })

  it('非法目标返回 invalid 与原因，布局不变', () => {
    const editor = freshEditor()
    const before = editor.getLayout()
    const validation = editor.preview('gatehouse', OUT_OF_BOUNDS)
    expect(validation.valid).toBe(false)
    expect(validation.reasons.map((r) => r.code)).toContain('out_of_bounds')
    expect(editor.getLayout()).toEqual(before)
  })

  it('未知建筑返回 missing_building，非整数目标返回 invalid_asset', () => {
    const editor = freshEditor()
    const missing = editor.preview('nonexistent', GATEHOUSE_OK_A)
    expect(missing.valid).toBe(false)
    expect(missing.reasons.map((r) => r.code)).toContain('missing_building')
    const nonInt = editor.preview('gatehouse', { x: 1.5, z: 2 })
    expect(nonInt.valid).toBe(false)
    expect(nonInt.reasons.map((r) => r.code)).toContain('invalid_asset')
    // 两次非法预览均不改变布局。
    expect(originOf(editor.getLayout(), 'gatehouse')).toEqual({ x: 3, z: 10 })
  })

  it('新预览覆盖旧预览（后者为准）', () => {
    const editor = freshEditor()
    editor.preview('gatehouse', GATEHOUSE_OK_A)
    editor.preview('greenhouse', { x: 11, z: 5 })
    const result = editor.applyPreview()
    expect(result.ok).toBe(true)
    if (result.ok) {
      // 应用的是第二次预览：温室移动，门房留在初始位。
      expect(originOf(result.layout, 'greenhouse')).toEqual({ x: 11, z: 5 })
      expect(originOf(result.layout, 'gatehouse')).toEqual({ x: 3, z: 10 })
    }
  })
})

describe('T13 applyPreview', () => {
  it('无预览返回 no_preview', () => {
    const editor = freshEditor()
    const result = editor.applyPreview()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no_preview')
      expect(result.validation).toBeNull()
    }
  })

  it('非法预览不能应用：invalid_move 且布局不变', () => {
    const editor = freshEditor()
    const before = editor.getLayout()
    editor.preview('gatehouse', OUT_OF_BOUNDS)
    const result = editor.applyPreview()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_move')
      expect(result.validation).not.toBeNull()
      expect(result.validation?.valid).toBe(false)
    }
    expect(editor.getLayout()).toEqual(before)
  })

  it('合法预览应用成功：布局更新、预览清除、记录 from/to 差量', () => {
    const editor = freshEditor()
    const layout = applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    expect(validateLayout(scene, layout).valid).toBe(true)
    // 预览已清除：再次应用 → no_preview。
    const again = editor.applyPreview()
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe('no_preview')
    // MoveCommand 记录了 from/to：撤销恢复到应用前位置。
    const undo = editor.undo()
    expect(undo.ok).toBe(true)
    if (undo.ok) expect(originOf(undo.layout, 'gatehouse')).toEqual({ x: 3, z: 10 })
  })

  it('应用针对当前布局重新校验，不信任预览时的旧结果', () => {
    const editor = freshEditor()
    // 1) 门房移走，腾出初始位占地。
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    // 2) 温室预览到门房旧位置：当前合法。
    const previewValidation = editor.preview('greenhouse', GREENHOUSE_OK)
    expect(previewValidation.valid).toBe(true)
    // 3) 撤销门房移动 → 门房回到 (3,10)，预览语义已改变（预览保留，不随撤销清除）。
    const undo = editor.undo()
    expect(undo.ok).toBe(true)
    // 4) 应用时必须重新校验：温室目标与门房占地冲突 → invalid_move，布局不变。
    const result = editor.applyPreview()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_move')
      expect(result.validation?.valid).toBe(false)
      expect(result.validation?.reasons.map((r) => r.code)).toContain('collision')
    }
    expect(originOf(editor.getLayout(), 'greenhouse')).toEqual({ x: 11, z: 2 })
    expect(originOf(editor.getLayout(), 'gatehouse')).toEqual({ x: 3, z: 10 })
  })

  it('与 validateBuildingMove 对当前布局的直接校验结果一致', () => {
    const editor = freshEditor()
    const viaEditor = editor.preview('gatehouse', GATEHOUSE_OK_A)
    const direct = validateBuildingMove(scene, editor.getLayout(), 'gatehouse', GATEHOUSE_OK_A)
    expect(viaEditor).toEqual(direct)
  })

  it('预览后布局发生变化但目标仍合法时，重新校验并应用候选', () => {
    const editor = freshEditor()
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_B)
    expect(editor.preview('greenhouse', { x: 11, z: 3 }).valid).toBe(true)

    // 撤销门房移动改变了布局；温室候选与恢复后的门房仍不冲突。
    expect(editor.undo().ok).toBe(true)
    expect(originOf(editor.getLayout(), 'gatehouse')).toEqual({ x: 3, z: 10 })
    const result = editor.applyPreview()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(originOf(result.layout, 'greenhouse')).toEqual({ x: 11, z: 3 })
      expect(validateLayout(scene, result.layout).valid).toBe(true)
    }
  })
})

describe('T13 cancelPreview 与 getLayout', () => {
  it('取消保持原布局，取消后无预览可应用', () => {
    const editor = freshEditor()
    const before = editor.getLayout()
    editor.preview('gatehouse', GATEHOUSE_OK_A)
    editor.cancelPreview()
    expect(editor.getLayout()).toEqual(before)
    const result = editor.applyPreview()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_preview')
  })

  it('getLayout 每次返回深拷贝：调用方篡改不影响内部状态', () => {
    const editor = freshEditor()
    const leaked = editor.getLayout()
    const mutable = leaked.placements[0].origin as { x: number; z: number }
    mutable.x = 99
    mutable.z = 99
    expect(originOf(editor.getLayout(), 'main-house')).toEqual({ x: 3, z: 2 })
  })

  it('applyPreview 返回的布局同样是拷贝：篡改返回值不影响编辑器', () => {
    const editor = freshEditor()
    editor.preview('gatehouse', GATEHOUSE_OK_A)
    const result = editor.applyPreview()
    expect(result.ok).toBe(true)
    if (result.ok) {
      const mutable = result.layout.placements.find((p) => p.buildingId === 'gatehouse')
        ?.origin as { x: number; z: number }
      mutable.x = 0
      mutable.z = 0
    }
    expect(originOf(editor.getLayout(), 'gatehouse')).toEqual(GATEHOUSE_OK_A)
  })

  it('编辑器不修改传入的初始布局对象', () => {
    const input = baselineLayout()
    const snapshot = JSON.parse(JSON.stringify(input)) as LayoutState
    const editor = createLayoutEditor(scene, input)
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    editor.undo()
    expect(input).toEqual(snapshot)
  })
})

/* -------------------------------------------------------------------------- */
/* T14：逐步撤销                                                                */
/* -------------------------------------------------------------------------- */

describe('T14 undo', () => {
  it('无历史返回 nothing_to_undo', () => {
    const editor = freshEditor()
    const result = editor.undo()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('nothing_to_undo')
      expect(result.validation).toBeNull()
    }
  })

  it('单次移动后撤销恢复原位置，布局仍合法', () => {
    const editor = freshEditor()
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    const result = editor.undo()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(originOf(result.layout, 'gatehouse')).toEqual({ x: 3, z: 10 })
      expect(validateLayout(scene, result.layout).valid).toBe(true)
    }
    expect(originOf(editor.getLayout(), 'gatehouse')).toEqual({ x: 3, z: 10 })
    // 栈已空。
    const empty = editor.undo()
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('nothing_to_undo')
  })

  it('不同建筑交替移动：按相反顺序逐次恢复', () => {
    const editor = freshEditor()
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    applyMove(editor, 'greenhouse', GREENHOUSE_OK)

    const first = editor.undo()
    expect(first.ok).toBe(true)
    if (first.ok) {
      // 最近命令先撤：温室回到初始位，门房仍在目标位。
      expect(originOf(first.layout, 'greenhouse')).toEqual({ x: 11, z: 2 })
      expect(originOf(first.layout, 'gatehouse')).toEqual(GATEHOUSE_OK_A)
      expect(validateLayout(scene, first.layout).valid).toBe(true)
    }

    const second = editor.undo()
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(originOf(second.layout, 'gatehouse')).toEqual({ x: 3, z: 10 })
      expect(second.layout).toEqual(baselineLayout())
      expect(validateLayout(scene, second.layout).valid).toBe(true)
    }

    const third = editor.undo()
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.reason).toBe('nothing_to_undo')
  })

  it('同一建筑连续多次移动：逐步反向恢复每一站', () => {
    const editor = freshEditor()
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_B)
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_C)

    const stops: GridPoint[] = [GATEHOUSE_OK_B, GATEHOUSE_OK_A, { x: 3, z: 10 }]
    for (const stop of stops) {
      const result = editor.undo()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(originOf(result.layout, 'gatehouse')).toEqual(stop)
        expect(validateLayout(scene, result.layout).valid).toBe(true)
      }
    }
    const empty = editor.undo()
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toBe('nothing_to_undo')
  })

  it('撤销后可重新编辑：从恢复位置再次移动', () => {
    const editor = freshEditor()
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    editor.undo()
    const layout = applyMove(editor, 'gatehouse', GATEHOUSE_OK_C)
    expect(originOf(layout, 'gatehouse')).toEqual(GATEHOUSE_OK_C)
    // 撤销栈只含最新命令：一次撤销回到初始位。
    const undo = editor.undo()
    expect(undo.ok).toBe(true)
    if (undo.ok) expect(originOf(undo.layout, 'gatehouse')).toEqual({ x: 3, z: 10 })
  })

  it('布局只含 scope 与 placements：编辑器无世界数据入口', () => {
    const editor = freshEditor()
    applyMove(editor, 'gatehouse', GATEHOUSE_OK_A)
    const layout = editor.getLayout()
    expect(Object.keys(layout).sort()).toEqual(['placements', 'scope'])
    for (const p of layout.placements) {
      expect(Object.keys(p).sort()).toEqual(['buildingId', 'origin', 'spaceId'])
    }
    // 撤销结果同样只含布局位置，不携带世界快照。
    const undo = editor.undo()
    expect(undo.ok).toBe(true)
    if (undo.ok) expect(Object.keys(undo.layout).sort()).toEqual(['placements', 'scope'])
  })

  it('重新 createLayoutEditor 不继承旧撤销栈（新实例空栈）', () => {
    const first = freshEditor()
    const moved = applyMove(first, 'gatehouse', GATEHOUSE_OK_A)
    const second = createLayoutEditor(scene, moved)
    expect(second.getLayout()).toEqual(moved)
    const result = second.undo()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('nothing_to_undo')
    // 旧实例的栈不受影响，仍可撤销。
    const undo = first.undo()
    expect(undo.ok).toBe(true)
    if (undo.ok) expect(originOf(undo.layout, 'gatehouse')).toEqual({ x: 3, z: 10 })
  })
})
