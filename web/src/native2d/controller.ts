/**
 * N2D1 T37–T40：样板控制器——读取协调、布局恢复与保存、选择与空间跟随、
 * 编辑与重置的业务逻辑汇合。
 *
 * 职责与约束（对应已批准 plan.md「样板页面与控制器」「模块交互」全部段落）：
 *
 * T37 读取协调：
 * - 管理 ReadState、请求序号与 AbortController：refresh/selectSource 取消
 *   进行中的读取（abort）并以递增序号过滤晚到结果；abort 与乱序响应都不
 *   覆盖新状态；dispose 后晚到响应一律忽略，不再更新状态或触碰视口。
 * - 成功 → ready（更新 lastGood 与注入时钟的 receivedAt）；失败 → 有旧数据
 *   转 stale（保留 lastGood + errorMessage），无旧数据转 error。AbortError
 *   不算失败。画面（presentation）与标签均来自同一 lastGood.scope；新范围
 *   确定（首次成功）前不调用 repository.load、不加载任何布局。
 *
 * T38 布局恢复与保存：
 * - 新 scope 确定后 repository.load(scope)：ready 恢复布局；none 建基线
 *   （createInitialLayout）；damaged/incompatible/error 暴露恢复选择状态
 *   （restore=pending，保留坏记录、不静默覆盖，内存中先放明确标记的基线
 *   布局，恢复选择未完成时阻止编辑与保存覆盖）。
 * - 同范围刷新只更新事实：不重载布局、不清撤销栈、不动预览。
 * - 应用/撤销成功后 repository.save；保存失败保留内存布局与撤销栈，暴露
 *   save=unsaved（可 retrySave 重试）。
 * - 来源切换（新 scope）：取消预览、清除旧选择/跟随、重建编辑器（旧会话
 *   撤销栈不带入新范围）。
 *
 * T39 选择与空间跟随：
 * - 组织居民/地点/建筑选择与外景—大厅切换；跟随已呈现居民：新读取后按
 *   新位置更新，目标进入大厅（或其他可呈现空间）时自动切换观察空间。
 * - 目标在未提供内景/未知地点：暂停视觉定位（viewport.setFollow(null)），
 *   保留跟随意图与真实地点提示；后续刷新可定位时自动恢复。
 * - 用户取消（toggleFollow 同一目标）或 free-pan 视口事件终止跟随意图。
 *   目标居民从新快照消失：清理无效选择与跟随并给出明确反馈，不保留假位置。
 * - 观察/跟随全程无任何写接口：控制器不暴露世界写入方法，选择/跟随/空间
 *   切换不触发 repository.save/reset。
 *
 * T40 编辑与重置：
 * - 编辑仅限外景且恢复选择已完成：预览（editor.preview）→ 视口
 *   setMovePreview；显式应用（editor.applyPreview 对当前布局重校验）成功
 *   → 更新表现 + 保存；非法/取消不写存储；undo 成功后保存恢复的布局。
 * - 重置先经确认流程（requestReset 暴露 pendingReset 的范围与影响信息），
 *   confirmReset 才调用 repository.reset(scope)；成功才恢复基线布局并清空
 *   撤销栈，失败保留当前状态；cancelReset 无任何变化。
 *
 * 控制器不导入 PixiJS/React；视口通过注入的 Native2dViewport 接口协作，
 * 测试使用假视口。控制器不拥有视口生命周期（dispose 不销毁视口）。
 */

import type {
  EditResult,
  GridPoint,
  LayoutEditor,
  LayoutRepository,
  LayoutState,
  MovePreview,
  Native2dViewport,
  ReadState,
  RestoreResult,
  SaveResult,
  SampleScope,
  SceneDefinition,
  ScenePresentation,
  Selection,
  SourceConfig,
  ViewportEvent,
  WorldReadModel,
  WorldResident,
  WorldSource,
} from './types'
import { createInitialLayout } from './layout-validation'
import { createLayoutEditor } from './editor'
import { buildPresentation, resolveResidentPlacement } from './presentation'
import { projectEnvironmentFacts } from '../scene/life/environment'
import { projectEnvironmentFor2d } from './projection'

/** 跟随意图：following=视觉定位中；paused=目标暂不可呈现，保留意图与真实地点提示。 */
export interface FollowState {
  readonly personId: string
  readonly status: 'following' | 'paused'
  readonly reason: string | null
}

/** 本地布局恢复状态：pending=损坏/不兼容/读取失败待用户选择，坏记录保留。 */
export type RestoreState =
  | { readonly status: 'ok' }
  | {
      readonly status: 'pending'
      readonly kind: 'damaged' | 'incompatible' | 'error'
      readonly message: string
    }

/** 保存状态：unsaved=当前内存布局尚未写入存储，可重试。 */
export type SaveState =
  | { readonly status: 'clean' }
  | { readonly status: 'unsaved'; readonly message: string }

/** 重置确认流程的待确认信息：范围与影响面，供确认文案使用。 */
export interface PendingReset {
  readonly scope: SampleScope
  readonly affectedBuildings: number
  readonly hasStoredRecord: boolean
}

export interface SampleControllerState {
  readonly readState: ReadState
  readonly sourceConfig: SourceConfig | null
  readonly spaceId: string
  readonly presentation: ScenePresentation | null
  readonly layout: LayoutState | null
  readonly selection: Selection | null
  readonly follow: FollowState | null
  readonly restore: RestoreState
  readonly save: SaveState
  readonly moveMode: { readonly buildingId: string } | null
  readonly movePreview: MovePreview | null
  readonly canUndo: boolean
  readonly pendingReset: PendingReset | null
  readonly notice: string | null
}

export interface SampleControllerOptions {
  readonly scene: SceneDefinition
  readonly createSource: (config: SourceConfig) => WorldSource
  readonly repository: LayoutRepository
  readonly viewport?: Native2dViewport
  /** 注入时钟（ISO 字符串），用于 receivedAt；默认真实时钟。 */
  readonly now?: () => string
}

export interface SampleController {
  getState(): SampleControllerState
  subscribe(listener: () => void): () => void
  selectSource(config: SourceConfig): void
  refresh(): void
  select(selection: Selection | null): void
  toggleFollow(personId: string): void
  enterHall(spaceId: string): void
  exitToExterior(): void
  handleViewportEvent(event: ViewportEvent): void
  startMove(buildingId: string): void
  previewMove(buildingId: string, target: GridPoint): void
  applyMove(): void
  cancelMove(): void
  undo(): void
  retrySave(): void
  resolveRestore(choice: 'baseline' | 'retry' | 'reset'): void
  requestReset(): void
  confirmReset(): void
  cancelReset(): void
  clearNotice(): void
  dispose(): void
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function sameScope(a: SampleScope, b: SampleScope): boolean {
  return (
    a.source === b.source &&
    a.worldId === b.worldId &&
    a.timelineId === b.timelineId &&
    a.sceneId === b.sceneId &&
    a.sceneVersion === b.sceneVersion
  )
}

export function createSampleController(options: SampleControllerOptions): SampleController {
  const { scene, createSource, repository } = options
  const viewport = options.viewport ?? null
  const now = options.now ?? (() => new Date().toISOString())

  let disposed = false
  let requestSeq = 0
  let inFlight: AbortController | null = null
  let source: WorldSource | null = null
  let editor: LayoutEditor | null = null
  let undoDepth = 0
  let hasStoredRecord = false
  let layoutRequestSeq = 0
  let saveRequestSeq = 0

  let state: SampleControllerState = {
    readState: { status: 'loading', lastGood: null, errorMessage: null, receivedAt: null },
    sourceConfig: null,
    spaceId: scene.defaultSpaceId,
    presentation: null,
    layout: null,
    selection: null,
    follow: null,
    restore: { status: 'ok' },
    save: { status: 'clean' },
    moveMode: null,
    movePreview: null,
    canUndo: false,
    pendingReset: null,
    notice: null,
  }

  const listeners = new Set<() => void>()

  function update(partial: Partial<SampleControllerState>): void {
    if (disposed) return
    state = { ...state, ...partial }
    for (const listener of listeners) listener()
  }

  /* ------------------------------------------------------------------------ */
  /* 表现与视口推送                                                             */
  /* ------------------------------------------------------------------------ */

  /** 以同一 lastGood + 当前布局 + 当前空间重建表现并推送视口。 */
  function rebuildPresentation(): ScenePresentation | null {
    const world = state.readState.lastGood
    const layout = state.layout
    if (!world || !layout) return null
    const environmentProjection = projectEnvironmentFacts((world.environment ?? []).map((fact) => ({
      factType: 'environment',
      value: { location: fact.locationName, condition: fact.condition, value: fact.value },
    })))
    const presentation: ScenePresentation = {
      ...buildPresentation(world, scene, layout, state.spaceId),
      environment: projectEnvironmentFor2d(environmentProjection),
    }
    viewport?.setPresentation(presentation)
    return presentation
  }

  /* ------------------------------------------------------------------------ */
  /* T37 读取协调                                                               */
  /* ------------------------------------------------------------------------ */

  function startRead(): void {
    if (disposed || !source) return
    // 取消进行中的读取并以序号过滤其晚到结果。
    inFlight?.abort()
    const id = ++requestSeq
    const controller = new AbortController()
    inFlight = controller

    const previous = state.readState
    const lastGood = previous.lastGood
    update({
      readState: {
        status: 'loading',
        lastGood,
        errorMessage: null,
        receivedAt:
          previous.status === 'ready' || previous.status === 'stale'
            ? previous.receivedAt
            : null,
      },
    })

    source.load(controller.signal).then(
      (model) => {
        if (disposed || id !== requestSeq) return
        inFlight = null
        applyReadSuccess(model)
      },
      (error) => {
        if (disposed || id !== requestSeq) return
        inFlight = null
        // abort 不是读取失败：状态已由发起取消的一方处理。
        if (isAbortError(error)) return
        applyReadFailure(describeError(error))
      },
    )
  }

  function applyReadSuccess(model: WorldReadModel): void {
    const previous = state.readState.lastGood
    const scopeChanged = !previous || !sameScope(previous.scope, model.scope)

    if (!scopeChanged) {
      // 同范围刷新：只更新事实——保留布局、撤销栈与编辑预览。
      update({
        readState: {
          status: 'ready',
          lastGood: model,
          errorMessage: null,
          receivedAt: now(),
        },
      })
      revalidateSelectionAndFollow(previous, model)
      const presentation = rebuildPresentation()
      update({ presentation })
      return
    }

    // 新范围确定：取消预览、清除旧选择/跟随、重建编辑器会话，再加载对应布局。
    editor?.cancelPreview()
    viewport?.setMovePreview(null)
    viewport?.setMoveMode?.(null)
    viewport?.setSelection(null)
    viewport?.setFollow(null)

    update({
      readState: {
        status: 'ready',
        lastGood: model,
        errorMessage: null,
        receivedAt: now(),
      },
      spaceId: scene.defaultSpaceId,
      selection: null,
      follow: null,
      moveMode: null,
      movePreview: null,
      pendingReset: null,
      save: { status: 'clean' },
      notice: null,
    })
    const layoutSeq = ++layoutRequestSeq
    void loadLayoutForScope(model.scope, layoutSeq).then(() => {
      if (disposed || layoutSeq !== layoutRequestSeq) return
      const presentation = rebuildPresentation()
      update({ presentation, canUndo: undoDepth > 0 })
    })
  }

  function applyReadFailure(message: string): void {
    const previous = state.readState
    if (previous.lastGood) {
      // 有旧数据：保留旧画面（标签仍来自 lastGood.scope），标记 stale。
      const receivedAt =
        previous.status === 'ready' || previous.status === 'stale' ? previous.receivedAt : now()
      update({
        readState: {
          status: 'stale',
          lastGood: previous.lastGood,
          errorMessage: message,
          receivedAt,
        },
        notice: `刷新失败：${message}`,
      })
    } else {
      update({
        readState: { status: 'error', lastGood: null, errorMessage: message, receivedAt: null },
        notice: `读取失败：${message}`,
      })
    }
  }

  /* ------------------------------------------------------------------------ */
  /* T38 布局恢复与保存                                                          */
  /* ------------------------------------------------------------------------ */

  async function loadLayoutForScope(scope: SampleScope, seq = ++layoutRequestSeq): Promise<void> {
    let result: RestoreResult
    try {
      result = await repository.load(scope)
    } catch (error) {
      result = { status: 'error', reason: 'storage_error', message: describeError(error) }
    }
    if (disposed || seq !== layoutRequestSeq) return
    let layout: LayoutState
    let restore: RestoreState
    switch (result.status) {
      case 'ready':
        layout = result.layout
        restore = { status: 'ok' }
        hasStoredRecord = true
        break
      case 'none':
        layout = createInitialLayout(scene, scope)
        restore = { status: 'ok' }
        hasStoredRecord = false
        break
      case 'damaged':
      case 'incompatible':
        // 保留坏记录：内存先放基线布局，恢复选择未完成前阻止编辑覆盖。
        layout = createInitialLayout(scene, scope)
        restore = { status: 'pending', kind: result.status, message: result.message }
        hasStoredRecord = true
        break
      case 'error':
        layout = createInitialLayout(scene, scope)
        restore = { status: 'pending', kind: 'error', message: result.message }
        hasStoredRecord = false
        break
    }
    editor = createLayoutEditor(scene, layout)
    undoDepth = 0
    update({ layout, restore, canUndo: false })
  }

  /** 应用/撤销成功后保存；失败保留内存布局与撤销栈，暴露未保存状态。 */
  function saveLayout(): void {
    const layout = state.layout
    if (!layout) return
    const seq = ++saveRequestSeq
    const complete = (result: SaveResult): void => {
      if (disposed || seq !== saveRequestSeq || state.layout !== layout || !state.readState.lastGood
        || !sameScope(state.readState.lastGood.scope, layout.scope)) return
      if (result.ok) {
        hasStoredRecord = true
        update({ save: { status: 'clean' } })
      } else {
        update({
          save: { status: 'unsaved', message: `布局尚未保存：${result.message}` },
          notice: `保存失败：${result.message}（内存布局与撤销记录保留，可重试保存）`,
        })
      }
    }
    try {
      const result = repository.save(layout)
      if (result instanceof Promise) void result.then(complete, error => complete({ ok: false, reason: 'storage_error', message: describeError(error) }))
      else complete(result)
    } catch (error) {
      complete({ ok: false, reason: 'storage_error', message: describeError(error) })
    }
  }

  /* ------------------------------------------------------------------------ */
  /* T39 选择、跟随与空间切换                                                     */
  /* ------------------------------------------------------------------------ */

  function followPauseReason(resident: WorldResident, placementReason: string | null): string {
    const where = resident.locationName ? `目标在「${resident.locationName}」` : '目标地点未知'
    return `${where}：${placementReason ?? '本期无法呈现'}（保留跟随意图，可定位时自动恢复）`
  }

  /**
   * 同范围刷新后重新解析选择与跟随：目标消失→清理并反馈；可呈现→（必要时
   * 自动切换空间）继续跟随；不可呈现→暂停视觉定位、保留意图与真实地点。
   */
  function revalidateSelectionAndFollow(
    oldWorld: WorldReadModel | null,
    world: WorldReadModel,
  ): void {
    const notices: string[] = []
    let selection = state.selection
    let follow = state.follow
    let spaceId = state.spaceId

    const selectedResident = selection?.kind === 'resident' ? selection : null
    if (
      selectedResident &&
      !world.residents.some((r) => r.personId === selectedResident.personId)
    ) {
      const name =
        oldWorld?.residents.find((r) => r.personId === selectedResident.personId)?.name ??
        selectedResident.personId
      selection = null
      viewport?.setSelection(null)
      notices.push(`所选居民「${name}」已不在最新快照中，选择已清除`)
    }

    if (follow) {
      const resident = world.residents.find((r) => r.personId === follow?.personId)
      if (!resident) {
        const name =
          oldWorld?.residents.find((r) => r.personId === follow?.personId)?.name ?? follow.personId
        follow = null
        viewport?.setFollow(null)
        notices.push(`跟随目标「${name}」已不在最新快照中，跟随结束`)
      } else if (state.layout) {
        const placement = resolveResidentPlacement(world, scene, state.layout, resident.personId)
        if (placement.status === 'visible' && placement.spaceId && placement.point) {
          follow = { personId: resident.personId, status: 'following', reason: null }
          if (placement.spaceId !== spaceId) {
            spaceId = placement.spaceId
            cancelMoveArtifacts()
          }
          viewport?.setFollow(resident.personId)
        } else {
          follow = {
            personId: resident.personId,
            status: 'paused',
            reason: followPauseReason(resident, placement.reason),
          }
          viewport?.setFollow(null)
        }
      }
    }

    update({
      selection,
      follow,
      spaceId,
      notice: notices.length > 0 ? notices.join('；') : state.notice,
    })
  }

  /** 进入室内等场景下取消编辑预览/模式（编辑仅限外景）。 */
  function cancelMoveArtifacts(): void {
    if (!state.moveMode && !state.movePreview) return
    editor?.cancelPreview()
    viewport?.setMovePreview(null)
    update({ moveMode: null, movePreview: null })
  }

  function switchSpace(spaceId: string): void {
    const space = scene.spaces.find((s) => s.id === spaceId)
    if (!space) return
    if (space.kind === 'interior') cancelMoveArtifacts()
    update({ spaceId })
    const presentation = rebuildPresentation()
    update({ presentation })
  }

  /** 编辑闸门：恢复选择完成 + 外景 + 数据就绪。 */
  function editingBlockReason(): string | null {
    if (!state.layout || !editor || !state.readState.lastGood) {
      return '世界数据尚未就绪，不能编辑建筑'
    }
    if (state.restore.status === 'pending') {
      return '本地布局恢复选择未完成，编辑与保存已被阻止（不会覆盖原有记录）'
    }
    const space = scene.spaces.find((s) => s.id === state.spaceId)
    if (!space || space.kind !== 'exterior') {
      return '室内不能编辑建筑，请返回外景'
    }
    return null
  }

  function blockWith(notice: string): void {
    update({ notice })
  }

  /* ------------------------------------------------------------------------ */
  /* 对外接口                                                                   */
  /* ------------------------------------------------------------------------ */

  return {
    getState(): SampleControllerState {
      return state
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    selectSource(config: SourceConfig): void {
      if (disposed) return
      source = createSource(config)
      update({ sourceConfig: config })
      startRead()
    },

    refresh(): void {
      if (disposed) return
      if (!source) {
        blockWith('尚未选择来源，无法刷新')
        return
      }
      startRead()
    },

    select(selection: Selection | null): void {
      if (disposed) return
      if (selection === null) {
        viewport?.setSelection(null)
        update({ selection: null })
        return
      }
      if (selection.kind === 'resident') {
        const world = state.readState.lastGood
        const resident = world?.residents.find((r) => r.personId === selection.personId)
        if (!resident) {
          blockWith('该居民不在当前快照中，无法选择')
          return
        }
      } else if (selection.kind === 'location') {
        if (!scene.locationBindings.some((b) => b.locationKey === selection.locationKey)) {
          blockWith('未知地点，无法选择')
          return
        }
      } else if (!scene.buildings.some((b) => b.id === selection.buildingId)) {
        blockWith('未知建筑，无法选择')
        return
      }
      viewport?.setSelection(selection)
      update({ selection })
    },

    toggleFollow(personId: string): void {
      if (disposed) return
      if (state.follow?.personId === personId) {
        viewport?.setFollow(null)
        update({ follow: null, notice: '已取消跟随' })
        return
      }
      const world = state.readState.lastGood
      const resident = world?.residents.find((r) => r.personId === personId)
      if (!world || !resident) {
        blockWith('该居民不在当前快照中，无法跟随')
        return
      }
      if (!state.layout) {
        blockWith('世界数据尚未就绪，无法跟随')
        return
      }
      const placement = resolveResidentPlacement(world, scene, state.layout, personId)
      if (placement.status === 'visible' && placement.spaceId && placement.point) {
        const follow: FollowState = { personId, status: 'following', reason: null }
        update({ follow, notice: null })
        if (placement.spaceId !== state.spaceId) {
          // 目标进入大厅等可呈现空间：自动切换观察空间。
          switchSpace(placement.spaceId)
        }
        viewport?.setFollow(personId)
      } else {
        const follow: FollowState = {
          personId,
          status: 'paused',
          reason: followPauseReason(resident, placement.reason),
        }
        viewport?.setFollow(null)
        update({ follow, notice: follow.reason })
      }
    },

    enterHall(spaceId: string): void {
      if (disposed) return
      const space = scene.spaces.find((s) => s.id === spaceId)
      if (!space || space.kind !== 'interior') {
        blockWith('目标空间不存在或不是室内空间')
        return
      }
      switchSpace(spaceId)
    },

    exitToExterior(): void {
      if (disposed) return
      switchSpace(scene.defaultSpaceId)
    },

    handleViewportEvent(event: ViewportEvent): void {
      if (disposed) return
      switch (event.type) {
        case 'select':
          this.select(event.selection)
          break
        case 'free-pan':
          if (state.follow) {
            viewport?.setFollow(null)
            update({ follow: null, notice: '已取消跟随，进入自由浏览' })
          }
          break
        case 'move-target':
          if (state.moveMode?.buildingId === event.buildingId) {
            this.previewMove(event.buildingId, event.target)
          }
          break
        case 'error':
          update({ notice: `视口报告错误：${event.message}（控制器状态保留，可重建视口）` })
          break
      }
    },

    startMove(buildingId: string): void {
      if (disposed) return
      const blocked = editingBlockReason()
      if (blocked) {
        blockWith(blocked)
        return
      }
      if (!state.layout?.placements.some((p) => p.buildingId === buildingId)) {
        blockWith('当前布局中不存在该建筑，无法移动')
        return
      }
      editor?.cancelPreview()
      viewport?.setMovePreview(null)
      viewport?.setMoveMode?.(buildingId)
      update({ moveMode: { buildingId }, movePreview: null, notice: null })
    },

    previewMove(buildingId: string, target: GridPoint): void {
      if (disposed) return
      const blocked = editingBlockReason()
      if (blocked) {
        blockWith(blocked)
        return
      }
      if (state.moveMode?.buildingId !== buildingId) {
        blockWith('请先选择建筑并进入移动模式')
        return
      }
      const validation = editor?.preview(buildingId, target)
      if (!validation) return
      const movePreview: MovePreview = { buildingId, target, validation }
      viewport?.setMovePreview(movePreview)
      update({ movePreview })
    },

    applyMove(): void {
      if (disposed) return
      const blocked = editingBlockReason()
      if (blocked) {
        blockWith(blocked)
        return
      }
      if (!state.movePreview) {
        blockWith('没有待应用的移动预览')
        return
      }
      const result: EditResult | undefined = editor?.applyPreview()
      if (!result) return
      if (!result.ok) {
        // 非法应用不写存储，保留预览供调整。
        update({ notice: result.message })
        return
      }
      viewport?.setMovePreview(null)
      viewport?.setMoveMode?.(null)
      update({ layout: result.layout, moveMode: null, movePreview: null, notice: null })
      undoDepth += 1
      update({ canUndo: true })
      saveLayout()
      const presentation = rebuildPresentation()
      update({ presentation })
    },

    cancelMove(): void {
      if (disposed) return
      editor?.cancelPreview()
      viewport?.setMovePreview(null)
      viewport?.setMoveMode?.(null)
      update({ moveMode: null, movePreview: null })
    },

    undo(): void {
      if (disposed) return
      const blocked = editingBlockReason()
      if (blocked) {
        blockWith(blocked)
        return
      }
      const result = editor?.undo()
      if (!result) return
      if (!result.ok) {
        update({ notice: result.message })
        return
      }
      undoDepth = Math.max(0, undoDepth - 1)
      update({ layout: result.layout, canUndo: undoDepth > 0, notice: null })
      saveLayout()
      const presentation = rebuildPresentation()
      update({ presentation })
    },

    retrySave(): void {
      if (disposed) return
      if (state.save.status !== 'unsaved') return
      if (state.restore.status === 'pending') {
        blockWith('本地布局恢复选择未完成，保存已被阻止')
        return
      }
      saveLayout()
    },

    resolveRestore(choice: 'baseline' | 'retry' | 'reset'): void {
      if (disposed) return
      if (state.restore.status !== 'pending') return
      const scope = state.readState.lastGood?.scope
      if (!scope) return

      if (choice === 'baseline') {
        // 明确选择使用基线布局：不覆盖盘上坏记录（下次保存才写入）。
        update({ restore: { status: 'ok' }, notice: null })
        return
      }
      if (choice === 'reset') {
        // 删除记录走统一确认流程。
        this.requestReset()
        return
      }
      // retry：重新读取存储（覆盖读取异常等可恢复故障）。
      const seq = ++layoutRequestSeq
      void Promise.resolve().then(() => repository.load(scope)).then(result => {
        if (disposed || seq !== layoutRequestSeq || !state.readState.lastGood
          || !sameScope(state.readState.lastGood.scope, scope)) return
        if (result.status === 'ready') {
        editor = createLayoutEditor(scene, result.layout)
        undoDepth = 0
        hasStoredRecord = true
        update({
          layout: result.layout,
          restore: { status: 'ok' },
          canUndo: false,
          notice: null,
        })
        const presentation = rebuildPresentation()
        update({ presentation })
        } else if (result.status === 'none') {
        const layout = createInitialLayout(scene, scope)
        editor = createLayoutEditor(scene, layout)
        undoDepth = 0
        // Server reset is a versioned baseline revision, so a head still exists.
        hasStoredRecord = true
        update({ layout, restore: { status: 'ok' }, canUndo: false, notice: null })
        const presentation = rebuildPresentation()
        update({ presentation })
        } else {
        update({
          restore: { status: 'pending', kind: result.status, message: result.message },
          notice: `重新读取布局仍失败：${result.message}`,
        })
        }
      }, error => {
        if (!disposed && seq === layoutRequestSeq) update({
          restore: { status: 'pending', kind: 'error', message: describeError(error) },
          notice: `重新读取布局失败：${describeError(error)}`,
        })
      })
    },

    requestReset(): void {
      if (disposed) return
      const scope = state.readState.lastGood?.scope
      if (!scope) {
        blockWith('世界数据尚未就绪，无法重置')
        return
      }
      update({
        pendingReset: {
          scope,
          affectedBuildings: state.layout?.placements.length ?? scene.buildings.length,
          hasStoredRecord,
        },
      })
    },

    confirmReset(): void {
      if (disposed) return
      const pending = state.pendingReset
      if (!pending) return
      const scope = pending.scope
      const seq = ++layoutRequestSeq
      const complete = (result: SaveResult): void => {
        if (disposed || seq !== layoutRequestSeq || !state.readState.lastGood
          || !sameScope(state.readState.lastGood.scope, scope)) return
        if (!result.ok) {
          // 清除失败：保留当前布局与记录。
          const preserved = scope.source === 'account' ? '服务端记录' : '本地记录'
          update({ pendingReset: null, notice: `重置失败：${result.message}（当前布局与${preserved}保持不变）` })
          return
        }
        // 成功后才恢复基线布局并清空撤销栈。
        const layout = createInitialLayout(scene, scope)
        editor = createLayoutEditor(scene, layout)
        undoDepth = 0
        hasStoredRecord = false
        viewport?.setMovePreview(null)
        viewport?.setMoveMode?.(null)
        update({
          layout,
          restore: { status: 'ok' },
          save: { status: 'clean' },
          moveMode: null,
          movePreview: null,
          canUndo: false,
          pendingReset: null,
          notice: '已恢复初始布局',
        })
        const presentation = rebuildPresentation()
        update({ presentation })
      }
      try {
        const result = repository.reset(scope)
        if (result instanceof Promise) void result.then(complete, error => complete({ ok: false, reason: 'storage_error', message: describeError(error) }))
        else complete(result)
      } catch (error) {
        complete({ ok: false, reason: 'storage_error', message: describeError(error) })
      }
    },

    cancelReset(): void {
      if (disposed) return
      update({ pendingReset: null })
    },

    clearNotice(): void {
      if (disposed) return
      update({ notice: null })
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      // 使读取与持久化操作中的晚到响应失效。
      layoutRequestSeq += 1
      saveRequestSeq += 1
      // 取消进行中读取；序号失效使晚到结果被过滤，卸载后不再更新状态。
      requestSeq += 1
      inFlight?.abort()
      inFlight = null
      viewport?.setMovePreview(null)
      viewport?.setMoveMode?.(null)
      listeners.clear()
    },
  }
}
