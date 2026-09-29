import { STYLE_PRESETS, type StylePackRef } from '@possibility/voxel-contract'
import { loadPalette, type PaletteKeyframe, type RGB, type ThemePalette } from '../palette'
import { MIST_MANOR_PALETTE } from './mist-manor'

// ── 风格包预设数据(S3b 第 10 项,N3 色彩中枢纪律)─────────
// 预设 = ThemePalette 完整变体(运行时零合并);以 mist-manor 为基底经
// 确定性调色变换派生,所有色值收敛在本文件,引擎代码零散落字面量。

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const grayOf = (c: RGB) => (c[0] + c[1] + c[2]) / 3
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const clampRGB = (c: RGB): RGB => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])]

/** 暖橙 / 冷蓝的色偏目标(预设调色语义旋钮) */
const WARM_TINT: RGB = [0.95, 0.62, 0.38]
const COOL_TINT: RGB = [0.45, 0.55, 0.75]

interface PresetTune {
  /** -1..1:正朝暖橙偏移,负朝冷蓝偏移 */
  warmth?: number
  /** 饱和度乘性(相对灰心的偏移缩放) */
  saturation?: number
  exposure?: number
  bloomAdd?: number
  /** 雾密度系数乘性 */
  fogScale?: number
  /** 直射/太阳强度乘性 */
  sunScale?: number
  cloudAdd?: number
  vignetteAdd?: number
  /** 粒子密度倍率(默认 1) */
  particleDensity?: number
}

function tuneColor(c: RGB, tune: PresetTune): RGB {
  let out = c
  const w = tune.warmth ?? 0
  if (w !== 0) out = lerpRGB(out, w > 0 ? WARM_TINT : COOL_TINT, Math.min(0.5, Math.abs(w) * 0.5))
  const s = tune.saturation ?? 1
  if (s !== 1) {
    const g = grayOf(out)
    out = [g + (out[0] - g) * s, g + (out[1] - g) * s, g + (out[2] - g) * s]
  }
  return clampRGB(out)
}

function tuneKeyframe(kf: PaletteKeyframe, tune: PresetTune): PaletteKeyframe {
  const c = (col: RGB) => tuneColor(col, tune)
  return {
    ...kf,
    skyZenith: c(kf.skyZenith),
    skyHorizon: c(kf.skyHorizon),
    fogColor: c(kf.fogColor),
    skyTint: c(kf.skyTint),
    cloudTint: c(kf.cloudTint),
    sunColor: c(kf.sunColor),
    sunLightColor: c(kf.sunLightColor),
    waterShallow: c(kf.waterShallow),
    waterDeep: c(kf.waterDeep),
    waterFoam: c(kf.waterFoam),
    waterFog: c(kf.waterFog),
    exposure: kf.exposure + (tune.exposure ?? 0),
    bloomStrength: Math.max(0, kf.bloomStrength + (tune.bloomAdd ?? 0)),
    saturation: Math.max(0, kf.saturation * (tune.saturation ?? 1)),
    cloudCoverage: clamp01(kf.cloudCoverage + (tune.cloudAdd ?? 0)),
    sunIntensity: kf.sunIntensity * (tune.sunScale ?? 1),
    sunLightIntensity: kf.sunLightIntensity * (tune.sunScale ?? 1),
    vignette: clamp01(kf.vignette + (tune.vignetteAdd ?? 0)),
  }
}

function derivePalette(base: ThemePalette, name: string, tune: PresetTune): ThemePalette {
  return {
    ...base,
    name,
    keyframes: base.keyframes.map((kf) => tuneKeyframe(kf, tune)),
    fogDensityScale: base.fogDensityScale * (tune.fogScale ?? 1),
    ...(tune.particleDensity !== undefined ? { particleDensity: tune.particleDensity } : {}),
  }
}

export const STYLE_PRESET_DATA: Record<string, ThemePalette> = {
  // 明亮但不刺眼:保留草地层次,让云和水承担轻快感,避免正午死白。
  'bright-pastoral': derivePalette(MIST_MANOR_PALETTE, 'bright-pastoral', {
    warmth: 0.06, saturation: 1.08, exposure: 0.02, bloomAdd: 0.02, cloudAdd: 0.04,
    sunScale: 1.02, particleDensity: 1.1,
  }),
  // 暖调集中在高光与地平线,避免整张地图被染成橙色。
  'dusk-warm': derivePalette(MIST_MANOR_PALETTE, 'dusk-warm', {
    warmth: 0.34, saturation: 1.02, exposure: -0.03, bloomAdd: 0.03, sunScale: 1.03, cloudAdd: 0.02,
  }),
  // 雾谷用低饱和和中等雾量拉开纵深,保留地形与建筑轮廓。
  'misty-vale': derivePalette(MIST_MANOR_PALETTE, 'misty-vale', {
    warmth: -0.18, saturation: 0.86, fogScale: 1.35, sunScale: 0.82, cloudAdd: 0.12, vignetteAdd: 0.04,
    exposure: -0.01, particleDensity: 0.85,
  }),
}

// 加载时校验:契约注册的每个非默认预设都必须有数据,缺 id 即抛错(N3 单一事实源)
for (const meta of STYLE_PRESETS) {
  if (meta.id === 'default') continue
  if (!STYLE_PRESET_DATA[meta.id]) throw new Error(`missing style preset data: ${meta.id}`)
}

/** 按 style 引用解析调色数据;default/未知/缺省 → 主题基底(N1 等价) */
export function resolvePalette(theme: string, style?: StylePackRef): ThemePalette {
  if (style && style.preset !== 'default') {
    const preset = STYLE_PRESET_DATA[style.preset]
    if (preset) return preset
  }
  return loadPalette(theme)
}
