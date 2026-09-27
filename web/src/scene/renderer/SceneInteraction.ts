import type { Application, Container, FederatedPointerEvent, Sprite } from 'pixi.js'
import { screenToGrid } from '@possibility/scene-contract'
import type { GridPoint, SceneOperation, SceneViewport } from '@possibility/scene-contract'
import { clampZoom } from '../viewport/viewport'

export interface InteractionEvents {
  onSelect(id: string | null): void
  onMove(operation: SceneOperation): void
  onViewportChange(viewport: SceneViewport): void
  onInvalidDrop(reason: string): void
  onCanvasClick(position: GridPoint): void
  onCanvasStroke(cells: GridPoint[]): void
}
export interface InteractionOptions { editable: boolean; painting: boolean; size: { columns: number; rows: number }; viewport: SceneViewport }

export class SceneInteraction {
  private down: GridPoint | null = null
  private pointerOrigin: GridPoint | null = null
  private drag: { id: string; sprite: Sprite; start: GridPoint; pointer: GridPoint } | null = null
  private pointerStart: GridPoint | null = null
  private pointers = new Map<number, GridPoint>()
  private pinchDistance = 0
  private pinchZoom = 1
  private paintingCells: GridPoint[] = []
  private readonly disposers: (() => void)[] = []
  constructor(app: Application, private readonly world: Container, private readonly events: InteractionEvents, private options: InteractionOptions) {
    app.stage.eventMode = 'static'; app.stage.hitArea = app.screen
    const down = (event: FederatedPointerEvent) => this.pointerDown(event)
    const move = (event: FederatedPointerEvent) => this.pointerMove(event)
    const up = (event: FederatedPointerEvent) => this.pointerUp(event)
    const wheel = (event: WheelEvent) => { event.preventDefault(); this.world.scale.set(clampZoom(this.world.scale.x * Math.exp(-event.deltaY * .001))); this.events.onViewportChange({ center: { x: -this.world.x / 64, y: -this.world.y / 32 }, zoom: this.world.scale.x }) }
    app.stage.on('pointerdown', down); app.stage.on('globalpointermove', move); app.stage.on('pointerup', up); app.stage.on('pointerupoutside', up)
    app.canvas.addEventListener('wheel', wheel, { passive: false })
    this.disposers.push(() => { app.stage.off('pointerdown', down); app.stage.off('globalpointermove', move); app.stage.off('pointerup', up); app.stage.off('pointerupoutside', up); app.canvas.removeEventListener('wheel', wheel) })
  }
  setOptions(options: InteractionOptions): void { this.options = options }
  private local(event: FederatedPointerEvent): GridPoint { const p = this.world.toLocal(event.global); return screenToGrid(p, { width: 64, height: 32 }) }
  private cell(event: FederatedPointerEvent): GridPoint {
    const point = this.local(event)
    return { x: Math.max(0, Math.min(this.options.size.columns - 1, point.x + Math.floor(this.options.size.columns / 2))), y: Math.max(0, Math.min(this.options.size.rows - 1, point.y + Math.floor(this.options.size.rows / 2))) }
  }
  private pointerDown(event: FederatedPointerEvent): void {
    this.pointers.set(event.pointerId, { x: event.global.x, y: event.global.y })
    if (this.pointers.size === 2) { this.pinchDistance = this.distance(); this.pinchZoom = this.world.scale.x; this.down = null; this.pointerOrigin = null; this.paintingCells = []; this.drag = null; return }
    this.down = { x: event.global.x, y: event.global.y }; this.pointerOrigin = { ...this.down }; this.pointerStart = this.local(event)
    if (this.options.editable && this.options.painting) { this.paintingCells = [this.cell(event)]; return }
    const target = event.target as Sprite & { objectId?: string }
    const id = target?.objectId
    if (id) {
      this.events.onSelect(id)
      if (this.options.editable) {
        this.drag = { id, sprite: target, start: { x: target.x, y: target.y }, pointer: { ...this.pointerStart } }
        target.alpha = .72; target.scale.set(target.scale.x * 1.05, target.scale.y * 1.05)
      }
    } else if (!event.nativeEvent.shiftKey) this.events.onSelect(null)
  }
  private pointerMove(event: FederatedPointerEvent): void {
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x: event.global.x, y: event.global.y })
    if (this.pointers.size >= 2) {
      this.world.scale.set(clampZoom(this.pinchZoom * this.distance() / Math.max(1, this.pinchDistance)))
      this.events.onViewportChange({ center: { x: -this.world.x / 64, y: -this.world.y / 32 }, zoom: this.world.scale.x })
      return
    }
    if (!this.down) return
    const dx = event.global.x - this.down.x; const dy = event.global.y - this.down.y
    if (this.options.editable && this.options.painting) {
      const next = this.cell(event); const last = this.paintingCells.at(-1)
      if (!last) this.paintingCells.push(next)
      else if (next.x !== last.x || next.y !== last.y) {
        const steps = Math.max(Math.abs(next.x - last.x), Math.abs(next.y - last.y))
        for (let step = 1; step <= steps; step++) {
          const cell = { x: Math.round(last.x + (next.x - last.x) * step / steps), y: Math.round(last.y + (next.y - last.y) * step / steps) }
          const previous = this.paintingCells.at(-1)
          if (!previous || cell.x !== previous.x || cell.y !== previous.y) this.paintingCells.push(cell)
        }
      }
      this.down = { x: event.global.x, y: event.global.y }
      return
    }
    if (this.drag && this.options.editable) {
      this.drag.sprite.position.set(this.drag.start.x + dx, this.drag.start.y + dy)
      return
    }
    this.world.x += dx; this.world.y += dy; this.down = { x: event.global.x, y: event.global.y }
  }
  private pointerUp(event: FederatedPointerEvent): void {
    this.pointers.delete(event.pointerId)
    if (this.pointers.size) { this.pinchDistance = 0; this.pinchZoom = this.world.scale.x; this.down = null; return }
    this.pinchDistance = 0
    if (this.paintingCells.length) {
      const cells = [...this.paintingCells]
      const moved = this.pointerOrigin !== null && Math.hypot(event.global.x - this.pointerOrigin.x, event.global.y - this.pointerOrigin.y) > 5
      this.paintingCells = []
      if (cells.length > 1 || moved) this.events.onCanvasStroke(cells)
      else this.events.onCanvasClick(cells[0]!)
      this.down = null; this.pointerOrigin = null; this.pointerStart = null
      return
    }
    if (this.drag) {
      const current = this.local(event); const to = { x: current.x + Math.floor(this.options.size.columns / 2), y: current.y + Math.floor(this.options.size.rows / 2) }
      const moved = Math.abs(this.drag.sprite.x - this.drag.start.x) + Math.abs(this.drag.sprite.y - this.drag.start.y) > 5
      this.drag.sprite.alpha = 1; this.drag.sprite.scale.set(this.drag.sprite.scale.x / 1.05, this.drag.sprite.scale.y / 1.05)
      if (moved) this.events.onMove({ type: 'move_object', objectId: this.drag.id, to }); else this.drag.sprite.position.set(this.drag.start.x, this.drag.start.y)
      this.drag = null
    } else if (this.options.editable && this.pointerOrigin && Math.hypot(event.global.x - this.pointerOrigin.x, event.global.y - this.pointerOrigin.y) < 5) this.events.onCanvasClick(this.cell(event))
    this.down = null; this.pointerOrigin = null; this.pointerStart = null
    this.events.onViewportChange({ center: { x: -this.world.x / 64, y: -this.world.y / 32 }, zoom: this.world.scale.x })
  }
  private distance(): number { const [a, b] = [...this.pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 }
  dispose(): void { this.disposers.splice(0).forEach(dispose => dispose()); this.drag = null; this.pointers.clear(); this.paintingCells = [] }
}
