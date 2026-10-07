/**
 * N2D1 T29-T36：Pixi 2D 视口、相机、绘制与指针接入。
 *
 * 视口只消费 ScenePresentation，不修改世界事实或本地布局。绘制采用保留的
 * Pixi stage 与显式 RAF；输入由 input.ts 的纯状态机统一处理，诊断挂钩只读。
 */

import { Application, Assets, Container, Graphics, Sprite, Texture } from 'pixi.js'
import { createPointerInput, type PickTarget, type PointerInputController } from './input'
import { applyCamera, gridToProjected, IDENTITY_CAMERA, type Camera } from './projection'
import type { EnvironmentValue } from '../scene/life/environment'
import type {
  MovePreview,
  Native2dViewport,
  PresentedObject,
  SceneDefinition,
  ScenePresentation,
  Selection,
  ViewportDiagnostics,
  ViewportEvent,
} from './types'

const MAX_RESOLUTION = 2
const MIN_ZOOM = 0.15
const MAX_ZOOM = 3
const DEFAULT_BG = 0x0b1319
const COLORS: Record<string, number> = {
  ground: 0x263a3c,
  path: 0x60716b,
  shore: 0x3e6869,
  tree: 0x31514d,
  shrub: 0x56716a,
  'main-house': 0x78949a,
  greenhouse: 0x739a9a,
  gatehouse: 0x8a8881,
  'hall-floor': 0x6e7478,
  'hall-wall': 0x52616a,
  'hall-table': 0x927b62,
  'hall-chair': 0x9b866c,
  'hall-lamp': 0xd5ad70,
  'resident-a': 0xd5a58e,
  'resident-b': 0x89b6c7,
  'resident-c': 0xb9c47f,
}

type ProjectedBounds = { minX: number; minY: number; maxX: number; maxY: number }

function includeRect(bounds: ProjectedBounds, x: number, y: number, width: number, height: number): void {
  bounds.minX = Math.min(bounds.minX, x)
  bounds.minY = Math.min(bounds.minY, y)
  bounds.maxX = Math.max(bounds.maxX, x + width)
  bounds.maxY = Math.max(bounds.maxY, y + height)
}

export interface Native2dViewportOptions {
  readonly signal?: AbortSignal
  readonly onEvent: (event: ViewportEvent) => void
  readonly initialCamera?: Camera
  readonly onCameraChange?: (camera: Camera) => void
  readonly onDiagnostics?: (value: Native2dViewportDiagnostics) => void
}

export interface Native2dViewportDiagnostics extends ViewportDiagnostics {
  readonly environment: {
    readonly weather: EnvironmentValue | null
    readonly lighting: 'day' | 'dusk' | 'night' | null
    readonly access: Readonly<Record<string, 'open' | 'closed'>>
  }
  /** Items whose Pixi graphics were submitted in the latest render. */
  readonly environmentVisuals: readonly {
    readonly kind: 'weather' | 'lighting' | 'access'
    readonly value: EnvironmentValue
    readonly locationName?: string
  }[]
}

interface ViewportState {
  camera: Camera
  presentation: ScenePresentation | null
  selection: Selection | null
  followPersonId: string | null
  movePreview: MovePreview | null
}

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'resident' && b.kind === 'resident') return a.personId === b.personId
  if (a.kind === 'location' && b.kind === 'location') return a.locationKey === b.locationKey
  if (a.kind === 'building' && b.kind === 'building') return a.buildingId === b.buildingId
  return false
}

function depth(object: PresentedObject, scene: SceneDefinition): number {
  const asset = object.assetId ? scene.assetManifest[object.assetId] : null
  const anchor = asset?.sortAnchor ?? { x: 0, z: 0 }
  return object.origin.x + object.origin.z + anchor.x + anchor.z
}

function drawDiamond(graphics: Graphics, x: number, y: number, width = 64, height = 32, color = DEFAULT_BG, alpha = 1): void {
  graphics.poly([x, y, x + width / 2, y + height / 2, x, y + height, x - width / 2, y + height / 2]).fill({ color, alpha })
}

function drawPrimitive(
  graphics: Graphics,
  object: PresentedObject,
  scene: SceneDefinition,
  selected: boolean,
  alpha: number,
  access?: 'open' | 'closed',
): void {
  const asset = object.assetId ? scene.assetManifest[object.assetId] : null
  const color = COLORS[object.assetId ?? ''] ?? 0x8aa0a3
  const foot = gridToProjected(object.origin)
  const footprint = asset?.footprint ?? [{ x: 0, z: 0 }]
  const width = Math.max(1, footprint.reduce((max, cell) => Math.max(max, cell.x), 0) + 1) * 64
  const depthPx = Math.max(1, footprint.reduce((max, cell) => Math.max(max, cell.z), 0) + 1) * 32
  const radius = Math.max(10, Math.min(30, width / 5))
  if (object.kind === 'decoration' && object.assetId === 'ground') {
    drawDiamond(graphics, foot.x, foot.y, 64, 32, color, alpha)
  } else if (object.kind === 'location') {
    const markerColor = access === 'closed' ? 0xd77872 : access === 'open' ? 0x79c7a3 : 0xd5b779
    graphics.circle(foot.x, foot.y - 8, 8).fill({ color: markerColor, alpha })
    graphics.circle(foot.x, foot.y - 8, 12).stroke({ color: markerColor, width: 2, alpha: alpha * 0.85 })
    if (access === 'closed') {
      graphics.moveTo(foot.x - 4, foot.y - 12).lineTo(foot.x + 4, foot.y - 4).stroke({ color: 0x341d20, width: 2, alpha })
      graphics.moveTo(foot.x + 4, foot.y - 12).lineTo(foot.x - 4, foot.y - 4).stroke({ color: 0x341d20, width: 2, alpha })
    }
  } else if (object.kind === 'resident') {
    graphics.circle(foot.x, foot.y - 24, 10).fill({ color, alpha })
    graphics.roundRect(foot.x - 8, foot.y - 16, 16, 20, 4).fill({ color, alpha })
    if (selected) graphics.circle(foot.x, foot.y - 24, 15).stroke({ color: 0xf1d48c, width: 3, alpha })
  } else {
    const top = object.assetId === 'tree' || object.assetId === 'main-house' || object.assetId === 'greenhouse' || object.assetId === 'gatehouse'
      ? 64 + radius
      : 16
    drawDiamond(graphics, foot.x, foot.y - top, width, depthPx, color, alpha)
    graphics.rect(foot.x - width * 0.28, foot.y - top - 8, width * 0.56, Math.max(10, top * 0.48)).fill({ color: color + 0x202020, alpha: alpha * 0.9 })
    if (selected) graphics.poly([foot.x, foot.y - top - 10, foot.x + width / 2, foot.y - top + 6, foot.x, foot.y + 20, foot.x - width / 2, foot.y - top + 6]).stroke({ color: 0xf1d48c, width: 3, alpha })
  }
}

function visibleLayer(layer: { readonly visibleAt: readonly string[] }, timeOfDay: string): boolean {
  return layer.visibleAt.includes(timeOfDay) || layer.visibleAt.includes('unknown')
}

export async function createNative2dViewport(
  host: HTMLElement,
  scene: SceneDefinition,
  options: Native2dViewportOptions,
): Promise<Native2dViewport> {
  if (options.signal?.aborted) throw new DOMException('视口初始化已取消', 'AbortError')
  let disposed = false
  const app = new Application()
  await app.init({
    preference: 'webgl',
    resolution: Math.min(globalThis.devicePixelRatio ?? 1, MAX_RESOLUTION),
    autoDensity: true,
    resizeTo: host,
    backgroundAlpha: 0,
    antialias: true,
    autoStart: false,
  })
  if (options.signal?.aborted) {
    app.destroy({ removeView: true }, { children: true })
    throw new DOMException('视口初始化完成前已卸载', 'AbortError')
  }

  app.ticker.stop()
  host.appendChild(app.canvas)
  host.style.touchAction = 'none'
  const world = new Container()
  world.sortableChildren = true
  app.stage.addChild(world)
  const environmentLayer = new Container()
  environmentLayer.label = 'environment-overlays'
  environmentLayer.eventMode = 'none'
  app.stage.addChild(environmentLayer)
  const state: ViewportState = {
    camera: IDENTITY_CAMERA,
    presentation: null,
    selection: null,
    followPersonId: null,
    movePreview: null,
  }
  let renderQueued = false
  let rafHandle: number | null = null
  let drawCount = 0
  let lastRenderMs = 0
  let latestBounds: ViewportDiagnostics['objectBounds'] = {}
  let latestEnvironmentVisuals: Native2dViewportDiagnostics['environmentVisuals'] = []
  let input: PointerInputController | null = null
  let activeMoveBuildingId: string | null = null
  const textureCache = new Map<string, Texture>()
  const textureLoads = new Set<string>()
  const textureErrors = new Set<string>()

  const requestTexture = (url: string): Texture | null => {
    const cached = textureCache.get(url)
    if (cached) return cached
    if (!textureLoads.has(url) && !textureErrors.has(url)) {
      textureLoads.add(url)
      void Assets.load(url).then(
        (texture) => {
          textureLoads.delete(url)
          textureErrors.delete(url)
          if (disposed) return
          textureCache.set(url, texture)
          requestRender()
        },
        () => {
          textureLoads.delete(url)
          if (disposed || textureErrors.has(url)) return
          textureErrors.add(url)
          options.onEvent({ type: 'error', message: `素材加载失败：${url}` })
        },
      )
    }
    return null
  }

  const space = (): SceneDefinition['spaces'][number] =>
    scene.spaces.find((item) => item.id === state.presentation?.spaceId) ?? scene.spaces[0]

  const sceneBounds = (): ProjectedBounds => {
    const current = space()
    const bounds: ProjectedBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (let x = 0; x < current.bounds.width; x += 1) {
      for (let z = 0; z < current.bounds.depth; z += 1) {
        const foot = gridToProjected({ x, z })
        includeRect(bounds, foot.x - 32, foot.y, 64, 32)
      }
    }
    const presentation = state.presentation
    if (presentation) {
      for (const object of presentation.objects) {
        const asset = object.assetId ? scene.assetManifest[object.assetId] : null
        const foot = gridToProjected(object.origin)
        const layers = asset?.layers.filter((layer) => visibleLayer(layer, presentation.timeOfDay)) ?? []
        if (layers.length === 0) {
          includeRect(bounds, foot.x - 32, foot.y - 48, 64, 48)
          continue
        }
        for (const layer of layers) {
          includeRect(bounds, foot.x - layer.anchorPx.x, foot.y - layer.anchorPx.y, layer.pixelWidth, layer.pixelHeight)
        }
      }
    }
    return Number.isFinite(bounds.minX) ? bounds : { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  }

  const fitOverview = (): Camera => {
    const current = space()
    const bounds = sceneBounds()
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    const sceneWidth = Math.max(1, bounds.maxX - bounds.minX)
    const sceneHeight = Math.max(1, bounds.maxY - bounds.minY)
    const padding = Math.min(current.overview.paddingPx, width * 0.08)
    const zoom = Math.max(MIN_ZOOM, Math.min(current.overview.maxZoom, (width - padding * 2) / sceneWidth, (height - padding * 2) / sceneHeight))
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerY = (bounds.minY + bounds.maxY) / 2
    return { zoom, pan: { x: width / 2 - centerX * zoom, y: height / 2 - centerY * zoom } }
  }

  const clampCamera = (camera: Camera): Camera => {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom))
    const current = space()
    const bounds = sceneBounds()
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    const padding = current.overview.paddingPx
    const minX = Math.min(padding - bounds.minX * zoom, width / 2 - (bounds.maxX - bounds.minX + padding * 2) * zoom / 2)
    const maxX = Math.max(width - padding - bounds.maxX * zoom, width / 2 + padding * zoom)
    const minY = Math.min(padding - bounds.minY * zoom, height / 2 - (bounds.maxY - bounds.minY + padding * 2) * zoom / 2)
    const maxY = Math.max(height - padding - bounds.maxY * zoom, height / 2 + padding * zoom)
    const panX = Math.min(maxX, Math.max(minX, camera.pan.x))
    const panY = Math.min(maxY, Math.max(minY, camera.pan.y))
    return { zoom, pan: { x: Number.isFinite(panX) ? panX : width / 2, y: Number.isFinite(panY) ? panY : height / 2 } }
  }

  const applyFollowCamera = (): void => {
    const personId = state.followPersonId
    const placement = state.presentation?.residentPlacements.find((item) => item.personId === personId)
    if (!personId || !placement?.point || placement.spaceId !== state.presentation?.spaceId) return
    const focus = gridToProjected(placement.point)
    const zoom = Math.max(state.camera.zoom, 1)
    state.camera = clampCamera({ zoom, pan: { x: host.clientWidth / 2 - focus.x * zoom, y: host.clientHeight / 2 - focus.y * zoom } })
  }

  const applyCameraState = (): void => {
    state.camera = clampCamera(state.camera)
    world.position.set(state.camera.pan.x, state.camera.pan.y)
    world.scale.set(state.camera.zoom)
  }

  const createBounds = (): ViewportDiagnostics['objectBounds'] => {
    const result: Record<string, { x: number; y: number; width: number; height: number }> = {}
    const presentation = state.presentation
    if (!presentation) return result
    for (const object of presentation.objects) {
      const asset = object.assetId ? scene.assetManifest[object.assetId] : null
      const foot = gridToProjected(object.origin)
      const layers = asset?.layers.filter((layer) => visibleLayer(layer, presentation.timeOfDay)) ?? []
      const bounds: ProjectedBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      for (const layer of layers) {
        includeRect(bounds, foot.x - layer.anchorPx.x, foot.y - layer.anchorPx.y, layer.pixelWidth, layer.pixelHeight)
      }
      if (!Number.isFinite(bounds.minX)) includeRect(bounds, foot.x - 32, foot.y - 48, 64, 48)
      const topLeft = applyCamera({ x: bounds.minX, y: bounds.minY }, state.camera)
      const bottomRight = applyCamera({ x: bounds.maxX, y: bounds.maxY }, state.camera)
      result[object.id] = { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y }
    }
    return result
  }

  const rebuild = (): void => {
    world.removeChildren().forEach((child) => child.destroy({ children: true }))
    environmentLayer.removeChildren().forEach((child) => child.destroy({ children: true }))
    const presentation = state.presentation
    const environmentVisuals: Native2dViewportDiagnostics['environmentVisuals'][number][] = []
    if (!presentation) {
      latestEnvironmentVisuals = environmentVisuals
      return
    }
    const current = space()
    const ground = new Graphics()
    ground.label = 'ground-backdrop'
    ground.zIndex = Number.MIN_SAFE_INTEGER
    for (let x = 0; x < current.bounds.width; x += 1) {
      for (let z = 0; z < current.bounds.depth; z += 1) drawDiamond(ground, gridToProjected({ x, z }).x, gridToProjected({ x, z }).y, 64, 32, COLORS.ground, 1)
    }
    world.addChild(ground)
    const objects = [...presentation.objects].sort((a, b) => depth(a, scene) - depth(b, scene))
    const focus = objects.find((object) => object.kind === 'resident' && (
      sameSelection(state.selection, object.selection) || object.id === `resident:${state.followPersonId}`
    ))
    const focusFoot = focus ? gridToProjected(focus.origin) : null
    for (const object of objects) {
      const selected = sameSelection(state.selection, object.selection) || (state.followPersonId !== null && object.id === `resident:${state.followPersonId}`)
      const locationKey = object.selection?.kind === 'location' ? object.selection.locationKey : null
      const presentedLocation = object.kind === 'location' && locationKey
        ? presentation.locations.find((location) => location.locationKey === locationKey)
        : undefined
      const access = presentedLocation?.name ? presentation.environment?.access[presentedLocation.name] : undefined
      const asset = object.assetId ? scene.assetManifest[object.assetId] : null
      const visibleLayers = asset?.layers.filter((layer) => visibleLayer(layer, presentation.timeOfDay)) ?? []
      const loadedLayers = visibleLayers.map((layer) => ({ layer, texture: requestTexture(layer.url) }))
      if (!loadedLayers.some(({ layer, texture }) => layer.role === 'base' && texture)) {
        const graphic = new Graphics()
        graphic.zIndex = depth(object, scene) * 10
        if (object.kind === 'location') graphic.label = access ? `access:${presentedLocation?.name}:${access}` : `location:${presentedLocation?.name ?? object.id}`
        drawPrimitive(graphic, object, scene, selected, 1, access)
        world.addChild(graphic)
        if (object.kind === 'location' && presentedLocation && access) {
          environmentVisuals.push({ kind: 'access', locationName: presentedLocation.name, value: access })
        }
      }
      if (asset) {
        const projected = gridToProjected(object.origin)
        for (const { layer, texture } of loadedLayers) {
          if (texture) {
            const sprite = new Sprite(texture)
            sprite.label = `${object.id}:${layer.role}`
            sprite.position.set(projected.x, projected.y)
            sprite.anchor.set(layer.anchorPx.x / layer.pixelWidth, layer.anchorPx.y / layer.pixelHeight)
            sprite.zIndex = depth(object, scene) * 10 + layer.sortOffset
            const coversFocus = focus && focusFoot && layer.role === 'occluder'
              && sprite.zIndex > depth(focus, scene) * 10
              && projected.x - layer.anchorPx.x < focusFoot.x + 20
              && projected.x - layer.anchorPx.x + layer.pixelWidth > focusFoot.x - 20
              && projected.y - layer.anchorPx.y < focusFoot.y + 16
              && projected.y - layer.anchorPx.y + layer.pixelHeight > focusFoot.y - 40
            sprite.alpha = layer.role === 'occluder' && (selected || coversFocus) ? 0.35 : 1
            world.addChild(sprite)
          }
        }
      }
      if (selected) {
        const highlight = new Graphics()
        const foot = gridToProjected(object.origin)
        highlight.label = `${object.id}:highlight`
        highlight.zIndex = Number.MAX_SAFE_INTEGER
        if (object.kind === 'resident') {
          highlight.roundRect(foot.x - 23, foot.y - 43, 46, 61, 12).stroke({ color: 0xf1d48c, width: 2.5 })
        } else {
          highlight.circle(foot.x, foot.y, 16).stroke({ color: 0xf1d48c, width: 3 })
        }
        world.addChild(highlight)
      }
    }
    if (state.movePreview) {
      const preview = scene.buildings.find((building) => building.id === state.movePreview?.buildingId)
      if (preview) {
        const asset = scene.assetManifest[preview.assetId]
        const candidate = new Container()
        candidate.label = 'move-candidate'
        candidate.zIndex = Number.MAX_SAFE_INTEGER - 2
        const p = gridToProjected(state.movePreview.target)
        for (const layer of asset.layers.filter((item) => visibleLayer(item, presentation.timeOfDay))) {
          const texture = requestTexture(layer.url)
          if (!texture) continue
          const sprite = new Sprite(texture)
          sprite.position.set(p.x, p.y)
          sprite.anchor.set(layer.anchorPx.x / layer.pixelWidth, layer.anchorPx.y / layer.pixelHeight)
          sprite.alpha = 0.5
          candidate.addChild(sprite)
        }
        world.addChild(candidate)
        const marker = new Graphics()
        marker.label = 'move-preview'
        marker.zIndex = Number.MAX_SAFE_INTEGER - 1
        const color = state.movePreview.validation.valid ? 0x79c7a3 : 0xd77872
        for (const cell of asset.footprint) {
          const point = gridToProjected({ x: state.movePreview.target.x + cell.x, z: state.movePreview.target.z + cell.z })
          drawDiamond(marker, point.x, point.y, 64, 32, color, 0.25)
          marker.stroke({ color, width: 2 })
        }
        const conflicts = new Graphics()
        conflicts.label = 'move-conflicts'
        conflicts.zIndex = Number.MAX_SAFE_INTEGER - 1
        for (const cell of state.movePreview.validation.conflictCells) {
          const point = gridToProjected(cell)
          drawDiamond(conflicts, point.x, point.y, 64, 32, 0xd77872, 0.45)
          conflicts.stroke({ color: 0xf2b8a8, width: 3 })
        }
        world.addChild(marker)
        world.addChild(conflicts)
      }
    }
    const environment = presentation.environment
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    if (environment?.weather) {
      const weather = new Graphics()
      weather.label = `environment:weather:${environment.weather}`
      if (environment.weather === 'rain') {
        weather.rect(0, 0, width, height).fill({ color: 0x19374c, alpha: 0.055 })
        const spacing = 46
        for (let x = -height; x < width + height; x += spacing) {
          weather.moveTo(x, 0).lineTo(x + height * 0.32, height).stroke({ color: 0x9dc7df, width: 1, alpha: 0.34 })
        }
      } else if (environment.weather === 'fog') {
        weather.rect(0, 0, width, height).fill({ color: 0xb5c9c8, alpha: 0.13 })
        for (let row = 0; row < 3; row += 1) {
          weather.rect(0, height * (0.24 + row * 0.22), width, Math.max(14, height * 0.055))
            .fill({ color: 0xd8e2df, alpha: 0.12 })
        }
      } else {
        weather.circle(width - 34, 34, 11).fill({ color: 0xf2d48d, alpha: 0.82 })
        weather.circle(width - 34, 34, 16).stroke({ color: 0xf2d48d, width: 2, alpha: 0.34 })
      }
      environmentLayer.addChild(weather)
      environmentVisuals.push({ kind: 'weather', value: environment.weather })
    }
    if (environment?.lighting) {
      const lighting = new Graphics()
      lighting.label = `environment:lighting:${environment.lighting}`
      const color = environment.lighting === 'night' ? 0x101b3b : environment.lighting === 'dusk' ? 0xc66b4c : 0xf2cf83
      const alpha = environment.lighting === 'night' ? 0.18 : environment.lighting === 'dusk' ? 0.095 : 0.035
      lighting.rect(0, 0, width, height).fill({ color, alpha })
      environmentLayer.addChild(lighting)
      environmentVisuals.push({ kind: 'lighting', value: environment.lighting })
    }
    latestBounds = createBounds()
    latestEnvironmentVisuals = environmentVisuals
  }

  const renderFrame = (): void => {
    renderQueued = false
    rafHandle = null
    if (disposed) return
    const startedAt = globalThis.performance?.now?.() ?? Date.now()
    applyCameraState()
    rebuild()
    app.renderer.render(app.stage)
    lastRenderMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt
    drawCount += 1
    const environment = state.presentation?.environment
    options.onDiagnostics?.({
      width: host.clientWidth,
      height: host.clientHeight,
      resolution: app.renderer.resolution,
      renderer: app.renderer.constructor.name,
      drawCount,
      lastRenderMs,
      objectBounds: latestBounds,
      environment: {
        weather: environment?.weather ?? null,
        lighting: environment?.lighting ?? null,
        access: environment?.access ?? {},
      },
      environmentVisuals: latestEnvironmentVisuals,
    })
  }

  const requestRender = (): void => {
    if (disposed || renderQueued) return
    renderQueued = true
    rafHandle = globalThis.requestAnimationFrame(renderFrame)
  }

  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (disposed) return
    app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight))
    state.camera = clampCamera(state.camera)
    applyFollowCamera()
    requestRender()
  })
  resizeObserver?.observe(host)

  const pickTargets = (): readonly PickTarget[] =>
    state.presentation?.objects.filter((object): object is PresentedObject & { selection: Selection } => object.selection !== null).map((object) => ({ id: object.id, selection: object.selection, origin: object.origin, assetId: object.assetId ?? 'resident-a' })) ?? []

  input = createPointerInput({
    element: host,
    getCamera: () => state.camera,
    getPickTargets: pickTargets,
    getAssetDefinition: (assetId) => scene.assetManifest[assetId] ?? null,
    isMoveMode: () => activeMoveBuildingId !== null,
    getMoveBuildingId: () => activeMoveBuildingId,
    onEvent: options.onEvent,
    onPan: (delta) => {
      state.camera = clampCamera({ zoom: state.camera.zoom, pan: { x: state.camera.pan.x + delta.x, y: state.camera.pan.y + delta.y } })
      options.onCameraChange?.(state.camera)
      requestRender()
    },
    onZoom: (factor, center) => {
      const oldZoom = state.camera.zoom
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor))
      const worldPoint = { x: (center.x - state.camera.pan.x) / oldZoom, y: (center.y - state.camera.pan.y) / oldZoom }
      state.camera = clampCamera({ zoom, pan: { x: center.x - worldPoint.x * zoom, y: center.y - worldPoint.y * zoom } })
      options.onCameraChange?.(state.camera)
      requestRender()
    },
  })
  input.attach()
  state.camera = options.initialCamera ? clampCamera(options.initialCamera) : fitOverview()
  applyFollowCamera()
  applyCameraState()
  requestRender()

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    input?.detach()
    input = null
    resizeObserver?.disconnect()
    if (rafHandle !== null) globalThis.cancelAnimationFrame(rafHandle)
    rafHandle = null
    renderQueued = false
    world.removeChildren().forEach((child) => child.destroy({ children: true }))
    app.destroy({ removeView: true }, { children: true })
  }

  return {
    getCamera(): Camera { return { pan: { ...state.camera.pan }, zoom: state.camera.zoom } },
    setCamera(value: Camera): void {
      state.camera = clampCamera(value)
      applyCameraState()
      requestRender()
      options.onCameraChange?.(state.camera)
    },
    setPresentation(value: ScenePresentation): void {
      state.presentation = value
      state.camera = fitOverview()
      applyFollowCamera()
      requestRender()
    },
    setSelection(value: Selection | null): void {
      state.selection = value
      requestRender()
    },
    setFollow(personId: string | null): void {
      state.followPersonId = personId
      applyFollowCamera()
      requestRender()
    },
    setMovePreview(value: MovePreview | null): void {
      state.movePreview = value
      requestRender()
    },
    setMoveMode(buildingId: string | null): void {
      activeMoveBuildingId = buildingId
      requestRender()
    },
    showOverview(): void {
      state.camera = fitOverview()
      requestRender()
    },
    retryAssets(): void {
      textureErrors.clear()
      requestRender()
    },
    dispose,
  }
}
