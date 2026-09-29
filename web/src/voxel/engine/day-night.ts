import type * as THREE from 'three'
import type { BakeEnvironment } from './mesher'

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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

function toHex(c: [number, number, number]): number {
  return (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255)
}

const NIGHT_SKY: [number, number, number] = [0.05, 0.07, 0.16]
const DAY_SKY: [number, number, number] = [0.62, 0.79, 0.92]
const DUSK_SKY: [number, number, number] = [0.86, 0.55, 0.36]
const NIGHT_TINT: [number, number, number] = [0.4, 0.5, 0.78]
const DAY_TINT: [number, number, number] = [1, 1, 1]
const DUSK_TINT: [number, number, number] = [1, 0.66, 0.42]
const BLOCK_TINT: [number, number, number] = [1, 0.82, 0.55]

/** 时间 → 天空光 / 光向 / 色温 / 天色（纯函数，供单测）。t: 0=午夜 0.25=黎明 0.5=正午 0.75=黄昏 */
export function mapTimeOfDay(t: number): TimeOfDayMapping {
  const angle = (t - 0.25) * Math.PI * 2     // 太阳轨迹：黎明升起，黄昏落下
  const elevation = Math.sin(angle)           // 白天为正
  const daylight = Math.max(0, elevation)
  const duskiness = Math.max(0, 1 - Math.abs(elevation) * 3) * (elevation > -0.08 ? 1 : 0) // 晨昏带

  // 天空光：正午 15，深夜 4（月光）
  const skyLevel = Math.round(lerp(4, 15, Math.pow(daylight, 0.7)))

  // 色温：正午白 → 晨昏暖橙 → 夜冷蓝
  let tint = lerpColor(NIGHT_TINT, DAY_TINT, Math.pow(daylight, 0.5))
  tint = lerpColor(tint, DUSK_TINT, duskiness * 0.85)
  let sky = lerpColor(NIGHT_SKY, DAY_SKY, Math.pow(daylight, 0.6))
  sky = lerpColor(sky, DUSK_SKY, duskiness * 0.55)

  // 光向 → 面明暗：太阳方位随时间绕转，夜间均匀弱光
  const sunAz = angle                             // 方位角
  const sunDir = {
    x: Math.cos(sunAz) * Math.cos(elevation * 1.2),
    y: Math.max(0.15, Math.abs(elevation)),
    z: Math.sin(sunAz) * Math.cos(elevation * 1.2),
  }
  const shade = (nx: number, ny: number, nz: number) => {
    const dot = Math.max(0, nx * sunDir.x + ny * sunDir.y + nz * sunDir.z)
    return lerp(0.55, 1.0, dot) * lerp(0.55, 1, daylight)
  }
  const bakeEnv: BakeEnvironment = {
    faceShade: {
      px: shade(1, 0, 0), nx: shade(-1, 0, 0),
      py: shade(0, 1, 0), ny: 0.45 * lerp(0.7, 1, daylight),
      pz: shade(0, 0, 1), nz: shade(0, 0, -1),
    },
    skyTint: tint,
    blockTint: BLOCK_TINT,
  }
  return { skyLevel, bakeEnv, skyColor: toHex(sky), fogColor: toHex(sky) }
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
