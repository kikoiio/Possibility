/**
 * N2D1 原生 2D 样板正逆投影。
 *
 * 固定 2:1 投影，基础格子绘制尺寸为 64×32 逻辑像素：
 *   投影 x = (x - z) * 32
 *   投影 y = (x + z) * 16
 * 指针输入先移除相机平移/缩放，再逆投影。相机缩放只影响屏幕坐标，
 * 不改变布局格子；图片脚点允许小数格坐标，编辑吸附单独取整数目标。
 * 对应已批准 plan.md「渲染与相机模块」与 task.md T10。
 */

import type { GridPoint, PixelPoint } from './types'
import type {
  EnvironmentValue,
  TimelineEnvironmentProjection,
} from '../scene/life/environment'

/** 单格 2:1 投影的逻辑像素尺寸。 */
export const TILE_WIDTH = 64
export const TILE_HEIGHT = 32
const HALF_WIDTH = TILE_WIDTH / 2
const HALF_HEIGHT = TILE_HEIGHT / 2

/**
 * 相机变换：pan 为屏幕像素平移，zoom 为等比缩放。
 * 屏幕坐标 = 投影坐标 * zoom + pan。
 */
export interface Camera {
  readonly pan: PixelPoint
  readonly zoom: number
}

export const IDENTITY_CAMERA: Camera = {
  pan: { x: 0, y: 0 },
  zoom: 1,
}

/** 格子坐标转投影像素坐标（不含相机变换；图片脚点允许小数输入）。 */
export function gridToProjected(point: GridPoint): PixelPoint {
  return {
    x: (point.x - point.z) * HALF_WIDTH,
    y: (point.x + point.z) * HALF_HEIGHT,
  }
}

/** 投影像素坐标逆变换为格子坐标（不含相机变换；结果保留小数）。 */
export function projectedToGrid(point: PixelPoint): GridPoint {
  const half = point.x / HALF_WIDTH
  const sum = point.y / HALF_HEIGHT
  return {
    x: (sum + half) / 2,
    z: (sum - half) / 2,
  }
}

/** 应用相机平移/缩放，把投影像素坐标转为屏幕像素坐标。 */
export function applyCamera(point: PixelPoint, camera: Camera): PixelPoint {
  return {
    x: point.x * camera.zoom + camera.pan.x,
    y: point.y * camera.zoom + camera.pan.y,
  }
}

/** 移除相机平移/缩放，把屏幕像素坐标还原为投影像素坐标。 */
export function removeCamera(point: PixelPoint, camera: Camera): PixelPoint {
  return {
    x: (point.x - camera.pan.x) / camera.zoom,
    y: (point.y - camera.pan.y) / camera.zoom,
  }
}

/** 格子坐标经投影与相机变换得到屏幕像素坐标。 */
export function gridToScreen(point: GridPoint, camera: Camera): PixelPoint {
  return applyCamera(gridToProjected(point), camera)
}

/**
 * 屏幕像素坐标先移除相机变换，再逆投影为格子坐标。
 * 结果保留小数，用于图片脚点等允许亚格精度的场景。
 */
export function screenToGrid(point: PixelPoint, camera: Camera): GridPoint {
  return projectedToGrid(removeCamera(point, camera))
}

/**
 * 编辑吸附：把小数格子坐标取整为最近整数格目标。
 * 任何非有限输入或结果（NaN/Infinity，如零缩放相机逆变换产物）
 * 一律返回 null，保证非有限坐标不能进入编辑状态。
 */
export function snapToGrid(point: GridPoint): GridPoint | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return null
  const x = Math.round(point.x)
  const z = Math.round(point.z)
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null
  // 归一化 -0，避免编辑目标携带负零。
  return { x: x + 0, z: z + 0 }
}

/** 屏幕像素坐标直接吸附为整数编辑目标；非有限时返回 null。 */
export function snapScreenToGrid(point: PixelPoint, camera: Camera): GridPoint | null {
  return snapToGrid(screenToGrid(point, camera))
}

/**
 * 2D visual adapter for the shared finite environment projection. Rendering
 * receives canonical values and labels only; this function has no world-state
 * or persistence side effects.
 */
export interface Native2dEnvironmentPresentation {
  readonly weather: EnvironmentValue | null
  readonly lighting: Extract<EnvironmentValue, 'day' | 'dusk' | 'night'> | null
  readonly access: Readonly<Record<string, 'open' | 'closed'>>
}

export function projectEnvironmentFor2d(
  projection: TimelineEnvironmentProjection,
): Native2dEnvironmentPresentation {
  const access: Record<string, 'open' | 'closed'> = {}
  for (const [location, bucket] of Object.entries(projection.locations)) {
    const value = bucket.access?.value
    if (value === 'open' || value === 'closed') access[location] = value
  }
  return {
    weather: projection.world.weather?.value ?? null,
    lighting: projection.world.lighting?.value === 'day' || projection.world.lighting?.value === 'dusk' || projection.world.lighting?.value === 'night'
      ? projection.world.lighting.value : null,
    access,
  }
}
