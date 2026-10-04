/**
 * N2D1 T29：视口实例与生命周期。
 *
 * PixiJS 8 异步初始化、WebGL 偏好、DPR≤2、host 自适应；关闭自主 ticker，
 * 状态/相机/交互变化时合并请求重绘；实例专属 dispose 负责取消待绘帧并
 * 释放本实例拥有的资源。
 *
 * 本任务只交付实例骨架与相机状态容器：setPresentation/setSelection/
 * setFollow/setMovePreview 仅保存最新值并请求重绘，实际绘制由 T30+ 实现；
 * showOverview 提供最小实现，完整的平移/缩放边界由 T31 实现。
 */

import { Application, Container } from 'pixi.js'
import type { Camera } from './projection'
import { IDENTITY_CAMERA } from './projection'
import type {
  MovePreview,
  Native2dViewport,
  SceneDefinition,
  ScenePresentation,
  Selection,
  ViewportDiagnostics,
  ViewportEvent,
} from './types'

/** 像素密度上限（plan：DPR≤2）。 */
const MAX_RESOLUTION = 2

export interface Native2dViewportOptions {
  readonly onEvent: (event: ViewportEvent) => void
  readonly onDiagnostics?: (value: ViewportDiagnostics) => void
}

/** 视口内部可变状态（全部实例私有，不导出）。 */
interface ViewportState {
  camera: Camera
  presentation: ScenePresentation | null
  selection: Selection | null
  followPersonId: string | null
  movePreview: MovePreview | null
}

export async function createNative2dViewport(
  host: HTMLElement,
  scene: SceneDefinition,
  options: Native2dViewportOptions,
): Promise<Native2dViewport> {
  let disposed = false

  const app = new Application()
  await app.init({
    preference: 'webgl',
    resolution: Math.min(globalThis.devicePixelRatio ?? 1, MAX_RESOLUTION),
    autoDensity: true,
    resizeTo: host,
    backgroundAlpha: 0,
    antialias: true,
  })

  // 异步 init 完成时实例可能已被 dispose（页面已离开）：立即清理，不挂载。
  if (disposed) {
    app.destroy({ removeView: true }, { children: true })
    throw new Error('native2d 视口初始化完成前已卸载')
  }

  // 不做自主帧循环：只在显式请求时重绘。
  app.ticker.stop()
  host.appendChild(app.canvas)

  // 相机变换根容器：后续地面/物件图层都挂在这里（T30）。
  const world = new Container()
  app.stage.addChild(world)

  const state: ViewportState = {
    camera: IDENTITY_CAMERA,
    presentation: null,
    selection: null,
    followPersonId: null,
    movePreview: null,
  }

  /* ---------------------------- 合并请求重绘 ---------------------------- */

  let renderQueued = false
  let rafHandle: number | null = null

  const renderFrame = (): void => {
    renderQueued = false
    rafHandle = null
    if (disposed) return
    // T30 起在此按 state 重建/更新图层；骨架阶段仅渲染现有 stage。
    app.renderer.render(app.stage)
  }

  const requestRender = (): void => {
    if (disposed || renderQueued) return
    renderQueued = true
    rafHandle = globalThis.requestAnimationFrame(renderFrame)
  }

  /* ------------------------------ 对外接口 ------------------------------ */

  const applyCamera = (): void => {
    world.position.set(state.camera.pan.x, state.camera.pan.y)
    world.scale.set(state.camera.zoom)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (rafHandle !== null) {
      globalThis.cancelAnimationFrame(rafHandle)
      rafHandle = null
    }
    renderQueued = false
    // removeView 移除 canvas；children 释放本实例 stage 子节点。
    // PixiJS 的 resizeTo ResizeObserver 与事件监听随 destroy 一并注销。
    app.destroy({ removeView: true }, { children: true })
  }

  void scene
  void options

  return {
    setPresentation(value: ScenePresentation): void {
      state.presentation = value
      requestRender()
    },
    setSelection(value: Selection | null): void {
      state.selection = value
      requestRender()
    },
    setFollow(personId: string | null): void {
      state.followPersonId = personId
      requestRender()
    },
    setMovePreview(value: MovePreview | null): void {
      state.movePreview = value
      requestRender()
    },
    showOverview(): void {
      // T31 实现完整的全景计算（含图片 bounds 与缩放下限）；骨架仅复位相机。
      state.camera = IDENTITY_CAMERA
      applyCamera()
      requestRender()
    },
    dispose,
  }
}
