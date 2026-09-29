import type { ClampRecord, StylePackRef } from './types'

// ── 风格包预设注册(S3b 第 10 项)────────────────
// 预设 id 的单一事实源:api 提示词与契约校验引用此处,
// 引擎侧关键帧数据(web engine/palettes/style-presets.ts)按 id 对应,缺 id 加载即抛错。

export interface StylePresetMeta { id: string; name: string }

export const STYLE_PRESETS: StylePresetMeta[] = [
  { id: 'default', name: '默认(雾影)' },
  { id: 'bright-pastoral', name: '明亮田园' },
  { id: 'dusk-warm', name: '黄昏暖调' },
  { id: 'misty-vale', name: '雾谷' },
]

export const DEFAULT_STYLE_PRESET = 'default'

/** 微调范围:fogDensity 乘性(±0.5 → ×[0.5,1.5]),exposure/saturation 加性 */
export const STYLE_TWEAK_RANGES = {
  fogDensity: 0.5,
  exposure: 0.3,
  saturation: 0.3,
} as const

const TWEAK_KEYS = ['fogDensity', 'exposure', 'saturation'] as const

/** AI 原始 style 字段 → 合法 StylePackRef + 夹取记录(夹取放行不拒绝,spec F5 哲学) */
export function clampStyleRef(raw: unknown): { style: StylePackRef; clamps: ClampRecord[] } {
  const clamps: ClampRecord[] = []
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  let preset = typeof src.preset === 'string' ? src.preset : DEFAULT_STYLE_PRESET
  if (!STYLE_PRESETS.some((p) => p.id === preset)) {
    clamps.push({ field: 'style.preset', from: preset, to: DEFAULT_STYLE_PRESET })
    preset = DEFAULT_STYLE_PRESET
  }

  const tweaksSrc = (typeof src.tweaks === 'object' && src.tweaks !== null ? src.tweaks : {}) as Record<string, unknown>
  const tweaks: NonNullable<StylePackRef['tweaks']> = {}
  for (const key of TWEAK_KEYS) {
    const v = tweaksSrc[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const lim = STYLE_TWEAK_RANGES[key]
    const clamped = Math.min(lim, Math.max(-lim, v))
    if (clamped !== v) clamps.push({ field: `style.tweaks.${key}`, from: v, to: clamped })
    tweaks[key] = clamped
  }

  const style: StylePackRef = { preset }
  if (Object.keys(tweaks).length > 0) style.tweaks = tweaks
  if (clamps.length > 0) style.clamps = clamps
  return { style, clamps }
}
