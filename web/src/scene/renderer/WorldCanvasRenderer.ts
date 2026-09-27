import { Application, Container } from 'pixi.js'
import type { SceneDocument, SceneLifeOverlay, SceneMode, ScenePreviewResult, SceneThemeManifest } from '@possibility/scene-contract'
import { AssetLoader } from './AssetLoader'
import { createSceneLayers, renderScene, type SceneLayers } from './SceneGraph'
import { SceneInteraction, type InteractionEvents } from './SceneInteraction'
import { animateSceneArrival } from './SceneAnimations'

export interface WorldCanvasEvents extends InteractionEvents {}
export interface SceneCamera { x: number; y: number; zoom: number }
export class WorldCanvasRenderer {
  private app: Application | null = null
  private initialized = false
  private disposed = false
  private world = new Container()
  private layers: SceneLayers | null = null
  private loader = new AssetLoader()
  private interaction: SceneInteraction | null = null
  private document: SceneDocument | null = null
  private catalog: SceneThemeManifest | null = null
  private overlay: SceneLifeOverlay | null = null
  private preview: ScenePreviewResult | null = null
  private selectedId: string | null = null
  private mode: SceneMode = 'life'
  private paintMode = false
  private userInteracted = false
  private cancelArrival = () => {}
  private readonly observer: ResizeObserver | null = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize(this.host?.clientWidth ?? 0, this.host?.clientHeight ?? 0))
  private host: HTMLElement | null = null
  constructor(private readonly events: WorldCanvasEvents, private readonly mobile = false) {}
  async mount(container: HTMLElement): Promise<void> {
    this.host = container
    const app = new Application()
    this.app = app
    await app.init({ background: '#dfe9df', antialias: false, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2), preference: 'webgl', resizeTo: container })
    this.initialized = true
    if (this.disposed) { app.destroy(true, { children: true }); this.app = null; return }
    this.app.canvas.className = 'world-scene-canvas'; this.app.canvas.setAttribute('aria-label', '可交互的世界场景画布'); container.appendChild(this.app.canvas)
    this.world = new Container(); this.world.sortableChildren = true; this.app.stage.addChild(this.world); this.layers = createSceneLayers(this.world)
    this.observer?.observe(container); this.resize(container.clientWidth, container.clientHeight)
    if (this.catalog) await this.setCatalog(this.catalog)
    this.connectInteraction()
  }
  async setCatalog(catalog: SceneThemeManifest): Promise<void> { this.catalog = catalog; await this.loader.load(catalog); if (this.host && !this.userInteracted) this.resize(this.host.clientWidth, this.host.clientHeight); this.draw() }
  setDocument(document: SceneDocument): void { this.cancelArrival(); this.document = document; this.syncInteractionOptions(); if (this.host && !this.userInteracted) this.resize(this.host.clientWidth, this.host.clientHeight); this.draw(); if (this.layers) this.cancelArrival = animateSceneArrival([this.layers.ground, this.layers.paths, this.layers.objects]) }
  setOverlay(overlay: SceneLifeOverlay | null): void { this.overlay = overlay; this.draw() }
  setMode(mode: SceneMode): void { this.mode = mode; this.syncInteractionOptions() }
  setPaintMode(painting: boolean): void { this.paintMode = painting; this.syncInteractionOptions() }
  setPreview(preview: ScenePreviewResult | null): void { this.preview = preview; this.draw() }
  setSelected(objectId: string | null): void { this.selectedId = objectId; this.draw() }
  setCamera(camera: SceneCamera): void { this.userInteracted = true; this.world.position.set(camera.x, camera.y); this.world.scale.set(camera.zoom) }
  focusObject(objectId: string): void {
    const sprite = this.layers?.objects.children.find(child => (child as unknown as { objectId?: string }).objectId === objectId)
    if (sprite && this.app) { this.world.x = this.app.screen.width / 2 - sprite.x * this.world.scale.x; this.world.y = this.app.screen.height / 2 - sprite.y * this.world.scale.y }
  }
  resize(width: number, height: number): void {
    if (!this.app || !this.initialized || !width || !height) return
    this.app.renderer.resize(width, height)
    if (!this.userInteracted) {
      const size = this.document?.size ?? { columns: 24, rows: 18 }
      const assets = this.catalog?.assets ?? []
      const maxSpriteWidth = Math.max(64, ...assets.map(asset => asset.footprint.width * 64))
      const maxSpriteHeight = Math.max(48, ...assets.map(asset => asset.footprint.height * 32))
      const projectedWidth = (size.columns + size.rows) * 32 + maxSpriteWidth
      const projectedHeight = (size.columns + size.rows) * 16 + maxSpriteHeight * 2
      const fit = Math.min(width / (projectedWidth + 32), height / (projectedHeight + 32), this.mobile ? .62 : 1)
      this.world.scale.set(Math.max(.25, fit))
    }
    this.world.position.set(width / 2, height / 2)
  }
  destroy(): void {
    this.disposed = true
    this.cancelArrival()
    this.observer?.disconnect(); this.interaction?.dispose(); this.interaction = null; this.loader.dispose()
    if (this.initialized) this.app?.destroy(true, { children: true })
    this.app = null; this.layers = null; this.host = null
  }
  private connectInteraction(): void {
    if (!this.app) return
    this.interaction?.dispose()
    this.interaction = new SceneInteraction(this.app, this.world, { ...this.events, onViewportChange: viewport => { this.userInteracted = true; this.events.onViewportChange({ ...viewport, center: { x: this.world.x, y: this.world.y } }) } }, { editable: this.mode === 'create' && !this.mobile, painting: this.paintMode, size: this.document?.size ?? { columns: 1, rows: 1 }, viewport: { center: { x: 0, y: 0 }, zoom: 1 } })
  }
  private syncInteractionOptions(): void { this.interaction?.setOptions({ editable: this.mode === 'create' && !this.mobile, painting: this.paintMode, size: this.document?.size ?? { columns: 1, rows: 1 }, viewport: { center: { x: 0, y: 0 }, zoom: this.world.scale.x } }) }
  private draw(): void { if (this.layers && this.loader && this.document && this.catalog) renderScene(this.layers, this.loader, this.document, this.catalog, this.overlay, this.preview, this.selectedId) }
}
