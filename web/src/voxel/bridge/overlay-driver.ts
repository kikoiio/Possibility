import type { SceneLifeOverlay } from '@possibility/scene-contract'
import type { VoxelCoord } from '@possibility/voxel-contract'
import type { ResidentRenderState } from '../engine'
import type { TimelineEnvironmentProjection, EnvironmentValue } from '../../scene/life/environment'
import { wanderDestination, wanderSlot, wanderWorldDay } from './wander'

/** 引擎侧最小接口（便于单测替身） */
export interface OverlayEngineSink {
  setTimeOfDay(t: number): void
  setWeather(state: { rain?: number; snow?: number; fog?: number }): void
  syncResidents(states: ResidentRenderState[]): void
  /** S3b 事件披露:世界绝对时间透传(披露裁决的时间源) */
  setSimNow(iso: string): void
}

export interface OverlayDriverOptions {
  engine: OverlayEngineSink
  /** 地点名 → 体素坐标（默认从文档 locations → 物体 anchor 解析） */
  resolveLocation(locationName: string): VoxelCoord | null
  /** 居民出生点兜底（地点解析失败时） */
  spawnFallback: VoxelCoord
  /** S4 漫步:格坐标 → 可站立格(不可走 = null);缺省 = 不漫步 */
  resolveStandable?: (at: VoxelCoord) => VoxelCoord | null
  /** S4 漫步:reduced-motion 降级为静止(返回锚点本身) */
  reducedMotion?: () => boolean
}

/** timeOfDay 标签 + simNow → 0..1 世界时间（t=0 午夜） */
export function mapSimTime(timeOfDay: SceneLifeOverlay['timeOfDay'], simNow: string): number {
  const date = new Date(simNow)
  if (!Number.isNaN(date.getTime())) {
    return (date.getUTCHours() + date.getUTCMinutes() / 60) / 24
  }
  return { dawn: 0.23, day: 0.5, dusk: 0.74, night: 0 }[timeOfDay]
}

/** Finite weather value → engine weather state. */
export function mapEnvironmentWeather(weather: EnvironmentValue | null): { rain?: number; fog?: number } {
  if (weather === 'rain') return { rain: 1 }
  if (weather === 'fog') return { fog: 1 }
  return {}
}

/** Finite lighting value → engine clock phase. */
export function mapEnvironmentLighting(lighting: EnvironmentValue | null): number | null {
  if (lighting === 'day') return 0.5
  if (lighting === 'dusk') return 0.74
  if (lighting === 'night') return 0
  return null
}

/**
 * Shared projection → 3D visual inputs. No scene or simulation state is
 * changed here; callers only pass the returned values to the render engine.
 */
export function projectEnvironmentFor3d(projection: TimelineEnvironmentProjection): {
  weather: { rain?: number; fog?: number }
  lighting: EnvironmentValue | null
} {
  const weather = projection.world.weather?.value ?? null
  const lighting = projection.world.lighting?.value ?? null
  return { weather: mapEnvironmentWeather(weather), lighting }
}

/** Legacy overlay weather bridge. Scene overlays now carry finite labels. */
export function mapWeather(weather: string | null): { rain?: number; snow?: number; fog?: number } {
  if (!weather) return {}
  const w = weather.toLowerCase()
  if (/雨|rain/.test(w)) return { rain: 1 }
  if (/雪|snow/.test(w)) return { snow: 1 }
  if (/雾|fog|mist/.test(w)) return { fog: 1 }
  // Kept for old scene-contract snapshots; finite D3 projections never emit
  // snow and therefore never reach this compatibility branch.
  return {}
}

/** overlay（时间/天气/居民活动）→ 引擎指令的翻译层（F11, F12 产品侧） */
export class OverlayDriver {
  private lastDestinations = new Map<string, string>()

  constructor(private opts: OverlayDriverOptions) {}

  apply(overlay: SceneLifeOverlay): void {
    const lighting = mapEnvironmentLighting(overlay.lighting ?? null)
    this.opts.engine.setTimeOfDay(lighting ?? mapSimTime(overlay.timeOfDay, overlay.simNow))
    this.opts.engine.setWeather(mapWeather(overlay.weather))
    this.opts.engine.setSimNow(overlay.simNow)
    const worldDay = wanderWorldDay(overlay.simNow)
    const slot = wanderSlot(overlay.simNow)
    const states: ResidentRenderState[] = overlay.persons.map((person) => {
      const at = this.opts.resolveLocation(person.locationName) ?? this.opts.spawnFallback
      const key = `${at.x},${at.y},${at.z}`
      const first = !this.lastDestinations.has(person.personId)
      const locationChanged = this.lastDestinations.get(person.personId) !== key
      this.lastDestinations.set(person.personId, key)
      // S4 环境漫步:无日程驱动移动(地点未变)且非首次落位时,锚点邻域确定性漫步;
      // 日程切换(地点变化)仍由 life 引擎驱动,漫步让位;reduced-motion 静止
      // 首次同步直接落在地点上(destination=null);之后地点变化 → 寻路走过去(at)
      let destination: VoxelCoord | null = first ? null : at
      if (!first && !locationChanged && this.opts.resolveStandable && !this.opts.reducedMotion?.()) {
        const stand = this.opts.resolveStandable(wanderDestination(person.personId, worldDay, at, slot))
        if (stand && (stand.x !== at.x || stand.z !== at.z)) destination = stand
      }
      return {
        personId: person.personId,
        at,
        destination,
        activity: person.activity,
      }
    })
    // 离开世界的居民从引擎移除
    this.opts.engine.syncResidents(states)
  }
}
