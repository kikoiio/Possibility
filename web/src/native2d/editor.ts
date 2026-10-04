/**
 * N2D1 T13+T14：本地布局编辑器——编辑预览、应用前重校验与逐步撤销。
 *
 * 纯内存状态机，不调用数据读取、视口或存储：
 * - createLayoutEditor(scene, layout)：以传入布局的深拷贝为当前布局，
 *   持有待应用预览（MovePreview）与会话内 MoveCommand 撤销栈。
 * - preview(buildingId, target)：对当前布局调用 validateBuildingMove，
 *   无论合法与否都保存预览并返回 validation；非法预览不改变布局，
 *   新的 preview 覆盖旧预览。
 * - applyPreview()：无预览 → no_preview；有预览时对当前布局**重新**
 *   validateBuildingMove（不信任预览时的旧结果——预览之后布局可能经
 *   应用/撤销发生变化），非法 → invalid_move 且布局不变；合法 →
 *   不可变更新布局、记录 MoveCommand（from/to 差量）、清除预览。
 * - cancelPreview()：仅清除预览，布局与撤销栈不变。
 * - undo()：弹出最近 MoveCommand，将该建筑原点恢复为 from；无历史 →
 *   nothing_to_undo。撤销恢复的是此前合法状态，不重复校验；
 *   撤销不影响待应用预览（apply 时总会重新校验，语义安全）。
 * - getLayout()：每次返回深拷贝，调用方篡改返回值不影响内部状态。
 *
 * 编辑器只接触场景定义与布局（placements），无任何世界数据入口；
 * MoveCommand 只含 buildingId/from/to，不复制世界快照。
 * 只导入 ./types 的类型与 ./layout-validation 的纯校验函数。
 */

import type {
  EditResult,
  GridPoint,
  LayoutEditor,
  LayoutState,
  MoveCommand,
  MovePreview,
  MoveValidation,
  SceneDefinition,
} from './types'
import { validateBuildingMove } from './layout-validation'

function copyPoint(p: GridPoint): GridPoint {
  return { x: p.x, z: p.z }
}

/** 深拷贝布局：scope 为不可变契约对象可共享引用，placements 全部新建。 */
function copyLayout(layout: LayoutState): LayoutState {
  return {
    scope: layout.scope,
    placements: layout.placements.map((p) => ({
      buildingId: p.buildingId,
      spaceId: p.spaceId,
      origin: copyPoint(p.origin),
    })),
  }
}

function editFailure(
  reason: 'no_preview' | 'nothing_to_undo' | 'invalid_move',
  message: string,
  validation: MoveValidation | null,
): EditResult {
  return { ok: false, reason, message, validation }
}

/**
 * 创建布局编辑器。传入布局被深拷贝为内部当前布局，
 * 之后对编辑器的任何操作都不会修改传入对象；新实例撤销栈为空。
 */
export function createLayoutEditor(scene: SceneDefinition, layout: LayoutState): LayoutEditor {
  let current: LayoutState = copyLayout(layout)
  let pending: MovePreview | null = null
  const history: MoveCommand[] = []

  /** 不可变地把 buildingId 的原点替换为 target（缺失时按校验语义追加）。 */
  function withMoved(buildingId: string, spaceId: string, target: GridPoint): LayoutState {
    let replaced = false
    const placements = current.placements.map((p) => {
      if (p.buildingId !== buildingId) return { ...p, origin: copyPoint(p.origin) }
      replaced = true
      return { buildingId, spaceId, origin: copyPoint(target) }
    })
    if (!replaced) {
      placements.push({ buildingId, spaceId, origin: copyPoint(target) })
    }
    return { scope: current.scope, placements }
  }

  return {
    preview(buildingId: string, target: GridPoint): MoveValidation {
      const validation = validateBuildingMove(scene, current, buildingId, target)
      pending = { buildingId, target: copyPoint(target), validation }
      return validation
    },

    applyPreview(): EditResult {
      if (!pending) {
        return editFailure('no_preview', '没有待应用的移动预览', null)
      }
      // 不信任预览时的校验结果：针对当前布局重新校验。
      const { buildingId, target } = pending
      const validation = validateBuildingMove(scene, current, buildingId, target)
      if (!validation.valid) {
        return editFailure(
          'invalid_move',
          `建筑 ${buildingId} 移动到 (${target.x},${target.z}) 在当前布局下不合法`,
          validation,
        )
      }
      const building = scene.buildings.find((b) => b.id === buildingId)
      const existing = current.placements.find((p) => p.buildingId === buildingId)
      const command: MoveCommand = {
        buildingId,
        // 完整布局下 existing 必存在；缺失时 from 退化为 target（撤销为原位 no-op）。
        from: existing ? copyPoint(existing.origin) : copyPoint(target),
        to: copyPoint(target),
      }
      current = withMoved(buildingId, existing?.spaceId ?? building?.spaceId ?? '', target)
      history.push(command)
      pending = null
      return { ok: true, layout: copyLayout(current) }
    },

    cancelPreview(): void {
      pending = null
    },

    undo(): EditResult {
      const command = history.pop()
      if (!command) {
        return editFailure('nothing_to_undo', '没有可撤销的移动', null)
      }
      const building = scene.buildings.find((b) => b.id === command.buildingId)
      current = withMoved(command.buildingId, building?.spaceId ?? '', command.from)
      return { ok: true, layout: copyLayout(current) }
    },

    getLayout(): LayoutState {
      return copyLayout(current)
    },
  }
}
