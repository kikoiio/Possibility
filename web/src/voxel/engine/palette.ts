import type { BakeEnvironment } from './mesher'
import { MIST_MANOR_PALETTE } from './palettes/mist-manor'

export type RGB = [number, number, number]
export interface Vec3 { x: number; y: number; z: number }

/** 调色关键帧：每档太阳仰角一条，表内按 elevation 单调递增 */
export interface PaletteKeyframe {
  /** 太阳仰角 sin 值：-1 深夜 ~ 1 正午 */
  elevation: number
  skyZenith: RGB
  /** 地平线色（即雾色同源） */
  skyHorizon: RGB
  fogColor: RGB
  /** 天空光色温（烘顶点色） */
  skyTint: RGB
  /** 方块光色温 */
  blockTint: RGB
  /** 六向面明暗系数（替代运行时 sunDir 投影的基础值） */
  faceShade: { px: number; nx: number; py: number; ny: number; pz: number; nz: number }
  /** 天空光等级 0–15（取整前） */
  skyLevel: number
  sunColor: RGB
  sunIntensity: number
  moonIntensity: number
  starIntensity: number
  cloudCoverage: number
  cloudTint: RGB
  /** 日光直射(正午最强,夜间 0) */
  sunLightColor: RGB
  sunLightIntensity: number
  /** 月光直射(夜间弱冷色) */
  moonLightColor: RGB
  moonLightIntensity: number
  exposure: number
  bloomStrength: number
  saturation: number
  /** 冷暖分离：暗部 / 亮部染色 */
  shadowTint: RGB
  highTint: RGB
  vignette: number
  grain: number
}

/** 阴影品质配置（主题级，不进关键帧） */
export interface ShadowConfig {
  enabled: boolean
  mapSize: number
  /** 软件渲染后端降档 */
  softwareMapSize: number
  bias: number
  normalBias: number
  /** PCF 柔和半径 */
  radius: number
}

/** 主题调色数据模块出口 */
export interface ThemePalette {
  name: string
  /** 按 elevation 升序，至少 4 档 */
  keyframes: PaletteKeyframe[]
  /** AO 最大暗化幅度 0–1 */
  aoStrength: number
  /** 4 档遮蔽 → 亮度系数 */
  aoCurve: [number, number, number, number]
  /** 雾密度系数（对应旧 *0.018） */
  fogDensityScale: number
  /** 雨天压暗靠拢的灰 */
  weatherGray: RGB
  /** 环境光强度，标定「无直射=S1 观感」 */
  ambientLift: number
  shadow: ShadowConfig
}

/** samplePalette 的输出：单一调色事实源 */
export interface ResolvedPalette {
  bakeEnv: BakeEnvironment
  /** 未取整，取整留给调用方 */
  skyLevel: number
  sky: {
    zenith: RGB
    horizon: RGB
    sunDir: Vec3
    sunColor: RGB
    sunIntensity: number
    moonDir: Vec3
    moonIntensity: number
    starIntensity: number
    cloudCoverage: number
    cloudTint: RGB
  }
  fog: { color: RGB; density: number }
  /** 直射光（日光/月光混合，已含天气 dim 压暗）；intensity≈0 时引擎关灯 */
  direct: { dir: Vec3; color: RGB; intensity: number }
  post: {
    exposure: number
    bloomStrength: number
    saturation: number
    shadowTint: RGB
    highTint: RGB
    vignette: number
    grain: number
  }
  /** 仅 bake 时用（数值同 ThemePalette.aoStrength） */
  aoStrength: number
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const lerpRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** 逐字段线性插值（faceShade 六向逐字段） */
export function lerpKeyframe(a: PaletteKeyframe, b: PaletteKeyframe, t: number): PaletteKeyframe {
  return {
    elevation: lerp(a.elevation, b.elevation, t),
    skyZenith: lerpRGB(a.skyZenith, b.skyZenith, t),
    skyHorizon: lerpRGB(a.skyHorizon, b.skyHorizon, t),
    fogColor: lerpRGB(a.fogColor, b.fogColor, t),
    skyTint: lerpRGB(a.skyTint, b.skyTint, t),
    blockTint: lerpRGB(a.blockTint, b.blockTint, t),
    faceShade: {
      px: lerp(a.faceShade.px, b.faceShade.px, t),
      nx: lerp(a.faceShade.nx, b.faceShade.nx, t),
      py: lerp(a.faceShade.py, b.faceShade.py, t),
      ny: lerp(a.faceShade.ny, b.faceShade.ny, t),
      pz: lerp(a.faceShade.pz, b.faceShade.pz, t),
      nz: lerp(a.faceShade.nz, b.faceShade.nz, t),
    },
    skyLevel: lerp(a.skyLevel, b.skyLevel, t),
    sunColor: lerpRGB(a.sunColor, b.sunColor, t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    moonIntensity: lerp(a.moonIntensity, b.moonIntensity, t),
    starIntensity: lerp(a.starIntensity, b.starIntensity, t),
    cloudCoverage: lerp(a.cloudCoverage, b.cloudCoverage, t),
    cloudTint: lerpRGB(a.cloudTint, b.cloudTint, t),
    sunLightColor: lerpRGB(a.sunLightColor, b.sunLightColor, t),
    sunLightIntensity: lerp(a.sunLightIntensity, b.sunLightIntensity, t),
    moonLightColor: lerpRGB(a.moonLightColor, b.moonLightColor, t),
    moonLightIntensity: lerp(a.moonLightIntensity, b.moonLightIntensity, t),
    exposure: lerp(a.exposure, b.exposure, t),
    bloomStrength: lerp(a.bloomStrength, b.bloomStrength, t),
    saturation: lerp(a.saturation, b.saturation, t),
    shadowTint: lerpRGB(a.shadowTint, b.shadowTint, t),
    highTint: lerpRGB(a.highTint, b.highTint, t),
    vignette: lerp(a.vignette, b.vignette, t),
    grain: lerp(a.grain, b.grain, t),
  }
}

/**
 * 时间 + 天气修饰 → ResolvedPalette。
 * t: 0=午夜 0.25=黎明 0.5=正午 0.75=黄昏；weather.dim/fogBoost ∈ 0–1。
 */
export function samplePalette(
  palette: ThemePalette,
  timeOfDay: number,
  weather: { dim: number; fogBoost: number },
): ResolvedPalette {
  const t = ((timeOfDay % 1) + 1) % 1
  const angle = (t - 0.25) * Math.PI * 2 // 太阳轨迹：黎明升起，黄昏落下
  const elevation = Math.sin(angle)
  const daylight = Math.max(0, elevation)

  // 关键帧区间定位（表按 elevation 升序；越界取端点）
  const frames = palette.keyframes
  let kf = frames[frames.length - 1]
  if (elevation <= frames[0].elevation) {
    kf = frames[0]
  } else if (elevation < frames[frames.length - 1].elevation) {
    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i], b = frames[i + 1]
      if (elevation >= a.elevation && elevation <= b.elevation) {
        kf = lerpKeyframe(a, b, (elevation - a.elevation) / (b.elevation - a.elevation))
        break
      }
    }
  }

  // 太阳 / 月亮方位（沿用旧 day-night 轨迹；天空用真实仰角，可为负）
  const sunAz = angle
  const horiz = Math.cos(elevation * 1.2)
  const sunDir: Vec3 = norm3({ x: Math.cos(sunAz) * horiz, y: elevation, z: Math.sin(sunAz) * horiz })
  const moonDir: Vec3 = { x: -sunDir.x, y: -sunDir.y, z: -sunDir.z }

  // 面明暗：关键帧基础值 × 轻微方位角调制（保持晨昏东西向差异，投影主导权仍在数据）
  const sunHLen = Math.hypot(sunDir.x, sunDir.z) || 1
  const sunH = { x: sunDir.x / sunHLen, z: sunDir.z / sunHLen }
  const azMod = (dx: number, dz: number) =>
    1 + 0.18 * daylight * (dx * sunH.x + dz * sunH.z)
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  const faceShade = {
    px: clamp01(kf.faceShade.px * azMod(1, 0)),
    nx: clamp01(kf.faceShade.nx * azMod(-1, 0)),
    py: kf.faceShade.py,
    ny: kf.faceShade.ny,
    pz: clamp01(kf.faceShade.pz * azMod(0, 1)),
    nz: clamp01(kf.faceShade.nz * azMod(0, -1)),
  }

  // 天气叠加：dim 压暗并向 weatherGray 靠拢；fogBoost 加雾密度与云量
  const dim = Math.min(1, Math.max(0, weather.dim))
  const fogBoost = Math.min(1, Math.max(0, weather.fogBoost))
  const dimColor = (c: RGB): RGB => {
    const darkened: RGB = [c[0] * (1 - dim * 0.7), c[1] * (1 - dim * 0.7), c[2] * (1 - dim * 0.7)]
    return lerpRGB(darkened, palette.weatherGray, dim * 0.6)
  }
  const fogColor = lerpRGB(
    [kf.fogColor[0] * (1 - dim * 0.5), kf.fogColor[1] * (1 - dim * 0.5), kf.fogColor[2] * (1 - dim * 0.5)],
    palette.weatherGray,
    dim,
  )
  const cloudCoverage = Math.min(1, kf.cloudCoverage + dim * 0.35 + fogBoost * 0.25)

  // 直射光：日光/月光按昼夜混合；换向经天顶弧线过渡（bend），避免黄昏影子翻转；
  // 混合点落在两侧强度低谷；天气 dim 压暗直射
  const dayFactor = smoothstep(-0.05, 0.15, elevation)
  const bend = 4 * dayFactor * (1 - dayFactor) * 0.5
  const directDir = norm3({
    x: lerp(moonDir.x, sunDir.x, dayFactor),
    y: lerp(moonDir.y, sunDir.y, dayFactor) + bend,
    z: lerp(moonDir.z, sunDir.z, dayFactor),
  })
  const direct: ResolvedPalette['direct'] = {
    dir: directDir,
    color: lerpRGB(kf.moonLightColor, kf.sunLightColor, dayFactor),
    intensity: lerp(kf.moonLightIntensity, kf.sunLightIntensity, dayFactor) * (1 - dim * 0.8),
  }

  return {
    bakeEnv: { faceShade, skyTint: kf.skyTint, blockTint: kf.blockTint },
    skyLevel: kf.skyLevel,
    sky: {
      zenith: dimColor(kf.skyZenith),
      horizon: dimColor(kf.skyHorizon),
      sunDir,
      sunColor: kf.sunColor,
      sunIntensity: kf.sunIntensity * (1 - dim),
      moonDir,
      moonIntensity: kf.moonIntensity * (1 - dim * 0.5),
      starIntensity: kf.starIntensity * (1 - dim),
      cloudCoverage,
      cloudTint: dimColor(kf.cloudTint),
    },
    fog: { color: fogColor, density: (fogBoost + dim * 0.5) * palette.fogDensityScale },
    direct,
    post: {
      exposure: kf.exposure,
      bloomStrength: kf.bloomStrength,
      saturation: kf.saturation,
      shadowTint: kf.shadowTint,
      highTint: kf.highTint,
      vignette: kf.vignette,
      grain: kf.grain,
    },
    aoStrength: palette.aoStrength,
  }
}

function norm3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

const PALETTES: Record<string, ThemePalette> = {
  'mist-manor': MIST_MANOR_PALETTE,
}

/** 按主题名取调色数据模块；未知主题抛错 */
export function loadPalette(theme: string): ThemePalette {
  const palette = PALETTES[theme]
  if (!palette) throw new Error(`unknown voxel palette theme: ${theme}`)
  return palette
}
