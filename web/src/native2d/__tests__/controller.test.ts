import { describe, expect, it } from 'vitest'
import type {
  LayoutRepository,
  LayoutState,
  Native2dViewport,
  RestoreResult,
  SampleScope,
  SaveResult,
  SourceConfig,
  WorldReadModel,
  WorldSource,
} from '../types'
import {
  FIXTURE_PERSON_IDS,
  FIXTURE_SCOPE,
  createFixtureReadModel,
} from '../fixtures'
import { MIST_MANOR_SCENE, EXTERIOR_SPACE_ID, HALL_SPACE_ID } from '../scene'
import { createSampleController, type SampleControllerState } from '../controller'

const scene = MIST_MANOR_SCENE
const DAY_CONFIG: SourceConfig = { kind: 'fixture', fixtureId: 'mist-manor-day' }
const REFRESH_CONFIG: SourceConfig = { kind: 'fixture', fixtureId: 'mist-manor-refresh' }

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

interface ViewportLog {
  presentations: Array<import('../types').ScenePresentation>
  selections: Array<unknown>
  follows: Array<string | null>
  previews: Array<unknown>
}

function fakeViewport(log: ViewportLog): Native2dViewport {
  return {
    setPresentation: (value) => log.presentations.push(value),
    setSelection: (value) => log.selections.push(value),
    setFollow: (value) => log.follows.push(value),
    setMovePreview: (value) => log.previews.push(value),
    showOverview: () => undefined,
    dispose: () => undefined,
  }
}

interface RepositoryHarness {
  repository: LayoutRepository
  loads: SampleScope[]
  saves: LayoutState[]
  resets: SampleScope[]
  nextLoad: RestoreResult
  nextSave: SaveResult
  nextReset: SaveResult
}

function repositoryHarness(): RepositoryHarness {
  const harness = {
    repository: undefined as unknown as LayoutRepository,
    loads: [] as SampleScope[],
    saves: [] as LayoutState[],
    resets: [] as SampleScope[],
    nextLoad: { status: 'none' } as RestoreResult,
    nextSave: { ok: true } as SaveResult,
    nextReset: { ok: true } as SaveResult,
  }
  harness.repository = {
    load: (scope: SampleScope) => {
      harness.loads.push(scope)
      return harness.nextLoad
    },
    save: (layout: LayoutState) => {
      harness.saves.push(layout)
      return harness.nextSave
    },
    reset: (scope: SampleScope) => {
      harness.resets.push(scope)
      return harness.nextReset
    },
  }
  return harness
}

function sourceFor(model: WorldReadModel): WorldSource {
  return { load: async (signal) => {
    if (signal.aborted) throw abortError()
    return model
  } }
}

function fixtureSource(config: SourceConfig): WorldSource {
  if (config.kind !== 'fixture') throw new Error('test source expects fixture')
  return sourceFor(createFixtureReadModel(config.fixtureId as Parameters<typeof createFixtureReadModel>[0]))
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function readyController(
  createSource: (config: SourceConfig) => WorldSource = fixtureSource,
  options: { readonly repository?: LayoutRepository; readonly viewport?: Native2dViewport } = {},
): Promise<ReturnType<typeof createSampleController>> {
  const controller = createSampleController({
    scene,
    createSource,
    repository: options.repository ?? repositoryHarness().repository,
    viewport: options.viewport,
  })
  controller.selectSource(DAY_CONFIG)
  await Promise.resolve()
  return controller
}

function originOf(state: SampleControllerState, buildingId: string) {
  const placement = state.layout?.placements.find((item) => item.buildingId === buildingId)
  if (!placement) throw new Error(`missing building ${buildingId}`)
  return placement.origin
}

describe('T37 读取协调', () => {
  it('同范围刷新把新的有限环境投影推入视口，不写入世界或布局', async () => {
    let model: WorldReadModel = {
      ...createFixtureReadModel('mist-manor-day'),
      environment: [{ id: 'fact-weather', locationName: null, condition: 'weather', value: 'rain', simTime: '2026-09-21T08:00:00.000Z', version: 1 }],
    }
    const repository = repositoryHarness()
    const log: ViewportLog = { presentations: [], selections: [], follows: [], previews: [] }
    const controller = createSampleController({
      scene,
      repository: repository.repository,
      viewport: fakeViewport(log),
      createSource: () => sourceFor(model),
    })
    controller.selectSource(DAY_CONFIG)
    await flush()
    expect(log.presentations[log.presentations.length - 1]?.environment).toMatchObject({ weather: 'rain' })

    model = {
      ...model,
      stateVersion: (model.stateVersion ?? 0) + 1,
      environment: [{ id: 'fact-weather', locationName: null, condition: 'weather', value: 'fog', simTime: '2026-09-21T08:01:00.000Z', version: 2 }],
    }
    controller.refresh()
    await flush()

    expect(log.presentations[log.presentations.length - 1]?.environment).toMatchObject({ weather: 'fog' })
    expect(repository.saves).toHaveLength(0)
    expect(repository.resets).toHaveLength(0)
    expect(repository.loads).toHaveLength(1)
    controller.dispose()
  })

  it('乱序结果只接受最新请求，旧响应不覆盖状态或布局范围', async () => {
    const first = deferred<WorldReadModel>()
    const second = deferred<WorldReadModel>()
    let call = 0
    const repository = repositoryHarness()
    const controller = createSampleController({
      scene,
      repository: repository.repository,
      createSource: () => ({
        load: () => (call++ === 0 ? first.promise : second.promise),
      }),
    })

    controller.selectSource(DAY_CONFIG)
    controller.refresh()
    second.resolve(createFixtureReadModel('mist-manor-night'))
    await Promise.resolve()
    expect(controller.getState().readState.lastGood?.scope.timelineId).toBe(FIXTURE_SCOPE.timelineId)
    expect(controller.getState().readState.status).toBe('ready')
    expect(repository.loads).toHaveLength(1)

    first.resolve(createFixtureReadModel('mist-manor-day'))
    await Promise.resolve()
    expect(controller.getState().readState.lastGood?.stateVersion).toBe(102)
    expect(repository.loads).toHaveLength(1)
  })

  it('失败时保留 lastGood 并标记 stale，无旧数据时为 error；AbortError 不报错', async () => {
    const pending = deferred<WorldReadModel>()
    const rejectNext: { current: ((error: unknown) => void) | null } = { current: null }
    let call = 0
    const controller = createSampleController({
      scene,
      repository: repositoryHarness().repository,
      createSource: () => ({
        load: (signal) => {
          const attempt = call++
          if (attempt === 0) return Promise.resolve(createFixtureReadModel('mist-manor-day'))
          if (attempt === 1) {
            return new Promise<WorldReadModel>((_, reject) => {
              rejectNext.current = reject
              signal.addEventListener('abort', () => reject(abortError()), { once: true })
            })
          }
          return pending.promise
        },
      }),
    })

    controller.selectSource(DAY_CONFIG)
    await flush()
    expect(controller.getState().readState.status).toBe('ready')

    controller.refresh()
    await flush()
    rejectNext.current?.(new Error('network down'))
    await flush()
    expect(controller.getState().readState.status).toBe('stale')
    expect(controller.getState().readState.lastGood?.stateVersion).toBe(101)
    expect(controller.getState().notice).toContain('network down')

    controller.refresh()
    controller.refresh()
    await Promise.resolve()
    expect(controller.getState().readState.status).toBe('loading')
    expect(controller.getState().readState.errorMessage).toBeNull()
    pending.resolve(createFixtureReadModel('mist-manor-day'))
  })

  it('dispose 后晚到响应不会触碰状态或视口', async () => {
    const pending = deferred<WorldReadModel>()
    const log: ViewportLog = { presentations: [], selections: [], follows: [], previews: [] }
    const controller = createSampleController({
      scene,
      repository: repositoryHarness().repository,
      viewport: fakeViewport(log),
      createSource: () => ({ load: () => pending.promise }),
    })
    controller.selectSource(DAY_CONFIG)
    controller.dispose()
    pending.resolve(createFixtureReadModel('mist-manor-day'))
    await Promise.resolve()
    expect(controller.getState().readState.status).toBe('loading')
    expect(log.presentations).toEqual([])
  })
})

describe('T38 布局恢复、保存与重置', () => {
  it('新范围加载对应布局，同范围刷新保留布局与撤销历史，来源切换清空它们', async () => {
    const repository = repositoryHarness()
    const controller = await readyController(fixtureSource, { repository: repository.repository })
    const initial = controller.getState().layout
    expect(initial).not.toBeNull()
    const beforeLoads = repository.loads.length

    controller.startMove('gatehouse')
    controller.previewMove('gatehouse', { x: 10, z: 4 })
    controller.applyMove()
    expect(controller.getState().canUndo).toBe(true)
    const moved = originOf(controller.getState(), 'gatehouse')

    controller.refresh()
    await Promise.resolve()
    expect(originOf(controller.getState(), 'gatehouse')).toEqual(moved)
    expect(controller.getState().canUndo).toBe(true)
    expect(repository.loads.length).toBe(beforeLoads)

    controller.selectSource({ kind: 'fixture', fixtureId: 'public-mist-manor-day' })
    await flush()
    expect(repository.loads.length).toBe(beforeLoads + 1)
    expect(controller.getState().canUndo).toBe(false)
    expect(controller.getState().movePreview).toBeNull()
    expect(controller.getState().selection).toBeNull()
    expect(controller.getState().follow).toBeNull()
  })

  it('损坏记录进入 pending 且阻止编辑，选择 baseline 后才允许保存', async () => {
    const repository = repositoryHarness()
    repository.nextLoad = { status: 'damaged', message: 'bad json' }
    const controller = await readyController(fixtureSource, { repository: repository.repository })

    controller.startMove('gatehouse')
    expect(controller.getState().moveMode).toBeNull()
    expect(controller.getState().notice).toContain('恢复选择')
    controller.applyMove()
    expect(repository.saves).toHaveLength(0)

    controller.resolveRestore('baseline')
    controller.startMove('gatehouse')
    controller.previewMove('gatehouse', { x: 10, z: 4 })
    controller.applyMove()
    expect(repository.saves).toHaveLength(1)
    expect(controller.getState().restore.status).toBe('ok')
  })

  it('保存失败保留布局和撤销能力，retrySave 成功后清除 unsaved', async () => {
    const repository = repositoryHarness()
    const controller = await readyController(fixtureSource, { repository: repository.repository })
    repository.nextSave = { ok: false, reason: 'quota_exceeded', message: 'full' }

    controller.startMove('gatehouse')
    controller.previewMove('gatehouse', { x: 10, z: 4 })
    controller.applyMove()
    expect(controller.getState().save.status).toBe('unsaved')
    expect(controller.getState().canUndo).toBe(true)
    expect(originOf(controller.getState(), 'gatehouse')).toEqual({ x: 10, z: 4 })

    repository.nextSave = { ok: true }
    controller.retrySave()
    expect(controller.getState().save.status).toBe('clean')
    expect(repository.saves).toHaveLength(2)
  })

  it('重置取消或失败不改变布局，成功后才恢复基线并清空历史', async () => {
    const repository = repositoryHarness()
    const controller = await readyController(fixtureSource, { repository: repository.repository })
    controller.startMove('gatehouse')
    controller.previewMove('gatehouse', { x: 10, z: 4 })
    controller.applyMove()
    const moved = controller.getState().layout

    controller.requestReset()
    controller.cancelReset()
    expect(controller.getState().layout).toEqual(moved)
    expect(repository.resets).toHaveLength(0)

    controller.requestReset()
    repository.nextReset = { ok: false, reason: 'storage_error', message: 'locked' }
    controller.confirmReset()
    expect(controller.getState().layout).toEqual(moved)
    expect(controller.getState().canUndo).toBe(true)

    controller.requestReset()
    repository.nextReset = { ok: true }
    controller.confirmReset()
    expect(originOf(controller.getState(), 'gatehouse')).toEqual({ x: 3, z: 10 })
    expect(controller.getState().canUndo).toBe(false)
  })
})

describe('T39 选择、空间与跟随', () => {
  it('可呈现大厅居民自动进入大厅，刷新后位置变化仍保持跟随', async () => {
    const log: ViewportLog = { presentations: [], selections: [], follows: [], previews: [] }
    const controller = await readyController(fixtureSource, { viewport: fakeViewport(log) })

    controller.toggleFollow(FIXTURE_PERSON_IDS.muginoToru)
    expect(controller.getState().follow?.status).toBe('following')
    expect(controller.getState().spaceId).toBe(HALL_SPACE_ID)
    expect(log.follows.at(-1)).toBe(FIXTURE_PERSON_IDS.muginoToru)

    controller.selectSource(REFRESH_CONFIG)
    await Promise.resolve()
    expect(controller.getState().follow?.personId).toBe(FIXTURE_PERSON_IDS.muginoToru)
    expect(controller.getState().follow?.status).toBe('following')
    expect(controller.getState().spaceId).toBe(EXTERIOR_SPACE_ID)
  })

  it('未呈现目标保留跟随意图并在自由浏览时取消，居民消失则清理选择', async () => {
    const controller = await readyController()
    controller.toggleFollow(FIXTURE_PERSON_IDS.shirakawaSoichiro)
    expect(controller.getState().follow?.status).toBe('paused')
    expect(controller.getState().follow?.reason).toContain('书房')

    controller.handleViewportEvent({ type: 'free-pan' })
    expect(controller.getState().follow).toBeNull()

    controller.select({ kind: 'resident', personId: FIXTURE_PERSON_IDS.hiiragiKazunari })
    expect(controller.getState().selection).not.toBeNull()
    controller.toggleFollow(FIXTURE_PERSON_IDS.hiiragiKazunari)
    expect(controller.getState().follow?.personId).toBe(FIXTURE_PERSON_IDS.hiiragiKazunari)
    controller.selectSource(REFRESH_CONFIG)
    await Promise.resolve()
    expect(controller.getState().selection).toBeNull()
    expect(controller.getState().follow).toBeNull()
    expect(controller.getState().notice).toContain('已不在最新快照')
  })

  it('选择、跟随、空间切换不写布局存储', async () => {
    const repository = repositoryHarness()
    const controller = await readyController(fixtureSource, { repository: repository.repository })
    controller.select({ kind: 'building', buildingId: 'main-house' })
    controller.enterHall(HALL_SPACE_ID)
    controller.exitToExterior()
    controller.toggleFollow(FIXTURE_PERSON_IDS.muginoToru)
    controller.toggleFollow(FIXTURE_PERSON_IDS.muginoToru)
    expect(repository.saves).toEqual([])
    expect(repository.resets).toEqual([])
  })
})

describe('T40 编辑与视口事件', () => {
  it('合法移动、撤销、取消以及室内编辑门禁按显式操作生效', async () => {
    const controller = await readyController()
    controller.startMove('gatehouse')
    controller.previewMove('gatehouse', { x: 10, z: 4 })
    expect(controller.getState().movePreview?.validation.valid).toBe(true)
    controller.cancelMove()
    expect(controller.getState().movePreview).toBeNull()
    expect(controller.getState().canUndo).toBe(false)

    controller.enterHall(HALL_SPACE_ID)
    controller.startMove('gatehouse')
    expect(controller.getState().notice).toContain('室内不能编辑')
    controller.exitToExterior()
    controller.startMove('gatehouse')
    controller.previewMove('gatehouse', { x: 10, z: 4 })
    controller.applyMove()
    expect(originOf(controller.getState(), 'gatehouse')).toEqual({ x: 10, z: 4 })
    controller.undo()
    expect(originOf(controller.getState(), 'gatehouse')).toEqual({ x: 3, z: 10 })
  })

  it('移动目标事件只在对应移动模式下产生预览，未知选择被拒绝', async () => {
    const controller = await readyController()
    controller.handleViewportEvent({ type: 'move-target', buildingId: 'gatehouse', target: { x: 10, z: 4 } })
    expect(controller.getState().movePreview).toBeNull()
    controller.startMove('gatehouse')
    controller.handleViewportEvent({ type: 'move-target', buildingId: 'gatehouse', target: { x: 10, z: 4 } })
    expect(controller.getState().movePreview?.buildingId).toBe('gatehouse')
    controller.select({ kind: 'building', buildingId: 'unknown' })
    expect(controller.getState().selection).toBeNull()
    expect(controller.getState().notice).toContain('未知建筑')
  })

  it('旧请求被取消时 AbortError 不会把新 loading 写成失败', async () => {
    const pending = deferred<WorldReadModel>()
    const controller = createSampleController({
      scene,
      repository: repositoryHarness().repository,
      createSource: () => ({ load: () => pending.promise }),
    })
    controller.selectSource(DAY_CONFIG)
    controller.refresh()
    await Promise.resolve()
    expect(controller.getState().readState.status).toBe('loading')
    pending.reject(abortError())
    await Promise.resolve()
    expect(controller.getState().readState.status).toBe('loading')
  })
})
