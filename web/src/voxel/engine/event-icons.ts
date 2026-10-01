import * as THREE from 'three'
import type { WorldEventType } from '@possibility/voxel-contract'

/**
 * S3b 事件披露(F4):程序化 canvas 图标图集。
 * 3 类型 × 2 态(活跃/留痕去饱和)= 6 格横排;模块级缓存,单次生成。
 * 图形全部垂直对称,gl_PointCoord 的 y 翻转不影响观感。
 */

export const ICON_CELL = 64
export const ICON_COLS = 6

export const EVENT_TYPE_ORDER: readonly WorldEventType[] = ['celebration', 'daily', 'turning']

/** 图集格索引:类型序 × 2 + 留痕位(纯函数,便于单测) */
export function iconCell(type: WorldEventType, trace: boolean): number {
  return EVENT_TYPE_ORDER.indexOf(type) * 2 + (trace ? 1 : 0)
}

/** 格子的类型色;留痕态统一去饱和灰 */
const TYPE_COLOR: Record<WorldEventType, string> = {
  celebration: '#f2b134',   // 暖金星形
  daily: '#4fae8e',         // 青绿圆点
  turning: '#8f6fc9',       // 紫菱形
}
const TRACE_COLOR = '#9a9a9a'

function drawShape(ctx: CanvasRenderingContext2D, type: WorldEventType, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  if (type === 'celebration') {
    // 五角星
    for (let i = 0; i < 10; i++) {
      const rad = (i % 2 === 0 ? r : r * 0.45)
      const a = -Math.PI / 2 + (i * Math.PI) / 5
      const x = cx + rad * Math.cos(a)
      const y = cy + rad * Math.sin(a)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
  } else if (type === 'daily') {
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
  } else {
    // 菱形
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx + r * 0.75, cy)
    ctx.lineTo(cx, cy + r)
    ctx.lineTo(cx - r * 0.75, cy)
  }
  ctx.closePath()
}

function drawCell(ctx: CanvasRenderingContext2D, cell: number): void {
  const type = EVENT_TYPE_ORDER[Math.floor(cell / 2)]
  const trace = cell % 2 === 1
  const cx = cell * ICON_CELL + ICON_CELL / 2
  const cy = ICON_CELL / 2
  const r = ICON_CELL * 0.3
  // 白边剪影 + 填充(远处可读性)
  ctx.lineWidth = ICON_CELL * 0.14
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.fillStyle = trace ? TRACE_COLOR : TYPE_COLOR[type]
  drawShape(ctx, type, cx, cy, r)
  ctx.fill()
  ctx.stroke()
}

let cached: THREE.CanvasTexture | null = null

/** 图集纹理(单次生成缓存;调用方持有引用,dispose 时置空缓存) */
export function buildEventIconAtlas(): THREE.CanvasTexture {
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = ICON_CELL * ICON_COLS
  canvas.height = ICON_CELL
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('event icon atlas: 2d context unavailable')
  for (let cell = 0; cell < ICON_COLS; cell++) drawCell(ctx, cell)
  const texture = new THREE.CanvasTexture(canvas)
  texture.flipY = false   // gl_PointCoord 自上而下,与 canvas 同向
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  cached = texture
  return texture
}

/** 测试/清理用:释放缓存纹理 */
export function disposeEventIconAtlas(): void {
  cached?.dispose()
  cached = null
}
