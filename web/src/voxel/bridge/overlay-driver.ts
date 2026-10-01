import type { SceneLifeOverlay } from '@possibility/scene-contract'
import type { VoxelCoord } from '@possibility/voxel-contract'
import type { ResidentRenderState } from '../engine'

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
}

/** timeOfDay 标签 + simNow → 0..1 世界时间（t=0 午夜） */
export function mapSimTime(timeOfDay: SceneLifeOverlay['timeOfDay'], simNow: string): number {
  const date = new Date(simNow)
  if (!Number.isNaN(date.getTime())) {
    return (date.getUTCHours() + date.getUTCMinutes() / 60) / 24
  }
  return { dawn: 0.23, day: 0.5, dusk: 0.74, night: 0 }[timeOfDay]
}

/** overlay 天气字符串 → 引擎天气状态 */
export function mapWeather(weather: string | null): { rain?: number; snow?: number; fog?: number } {
  if (!weather) return {}
  const w = weather.toLowerCase()
  if (/雨|rain/.test(w)) return { rain: 1 }
  if (/雪|snow/.test(w)) return { snow: 1 }
  if (/雾|fog|mist/.test(w)) return { fog: 1 }
  return {}
}

/** overlay（时间/天气/居民活动）→ 引擎指令的翻译层（F11, F12 产品侧） */
export class OverlayDriver {
  private lastDestinations = new Map<string, string>()

  constructor(private opts: OverlayDriverOptions) {}

  apply(overlay: SceneLifeOverlay): void {
    this.opts.engine.setTimeOfDay(mapSimTime(overlay.timeOfDay, overlay.simNow))
    this.opts.engine.setWeather(mapWeather(overlay.weather))
    this.opts.engine.setSimNow(overlay.simNow)
    const states: ResidentRenderState[] = overlay.persons.map((person) => {
      const at = this.opts.resolveLocation(person.locationName) ?? this.opts.spawnFallback
      const key = `${at.x},${at.y},${at.z}`
      const first = !this.lastDestinations.has(person.personId)
      this.lastDestinations.set(person.personId, key)
      return {
        personId: person.personId,
        at,
        // 首次同步直接落在地点上；之后地点变化 → 寻路走过去
        destination: first ? null : at,
        activity: person.activity,
      }
    })
    // 离开世界的居民从引擎移除
    this.opts.engine.syncResidents(states)
  }
}
