import type * as THREE from 'three'
import type { BakeEnvironment } from './mesher'
import { loadPalette, samplePalette, type RGB, type ThemePalette } from './palette'

export interface DayNightSink {
  /** 天空光等级变化（0–15 整数） */
  setSkyLevel(level: number): void
  /** 烘焙环境变化（方向明暗 + 色温），触发重烘焙 */
  setBakeEnv(env: BakeEnvironment): void
  /** 渲染环境（天色 / 雾色） */
  setBaseEnvironment(env: { skyColor: THREE.ColorRepresentation; fogColor: THREE.ColorRepresentation }): void
}

export interface TimeOfDayMapping {
  skyLevel: number
  bakeEnv: BakeEnvironment
  skyColor: number
  fogColor: number
}

function toHex(c: RGB): number {
  return (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255)
}

// 调色数据构造期加载一次（S1 单主题；多主题由引擎 loadAssets 路径负责）
let cachedPalette: ThemePalette | null = null
function palette(): ThemePalette {
  return (cachedPalette ??= loadPalette('mist-manor'))
}

/** 时间 → 天空光 / 光向 / 色温 / 天色（纯函数薄封装，供单测）。t: 0=午夜 0.25=黎明 0.5=正午 0.75=黄昏 */
export function mapTimeOfDay(t: number): TimeOfDayMapping {
  const clamped = ((t % 1) + 1) % 1
  const resolved = samplePalette(palette(), clamped, { dim: 0, fogBoost: 0 })
  return {
    skyLevel: Math.round(resolved.skyLevel),
    bakeEnv: resolved.bakeEnv,
    skyColor: toHex(resolved.sky.horizon),
    fogColor: toHex(resolved.fog.color),
  }
}

/**
 * 昼夜循环：把世界时间映射为光照 / 天色并驱动引擎。
 * 时间量化为 96 步/天，步进时才重烘焙，避免逐帧全量重建。
 */
export class DayNightCycle {
  private currentStep = -1

  constructor(private sink: DayNightSink, private stepsPerDay = 96) {}

  setTimeOfDay(t: 0 | number): void {
    const clamped = ((t % 1) + 1) % 1
    const step = Math.round(clamped * this.stepsPerDay)
    if (step === this.currentStep) return
    this.currentStep = step
    const mapped = mapTimeOfDay(clamped)
    this.sink.setSkyLevel(mapped.skyLevel)
    this.sink.setBakeEnv(mapped.bakeEnv)
    this.sink.setBaseEnvironment({ skyColor: mapped.skyColor, fogColor: mapped.fogColor })
  }
}
