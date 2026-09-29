import type { PaletteKeyframe, ThemePalette } from '../palette'

/**
 * mist-manor 主题调色数据（S1 色彩中枢唯一事实源）。
 * 数值基准：白昼档与升级前观感等价（旧 NIGHT_SKY/DAY_SKY/DUSK_SKY、三段 TINT、
 * DEFAULT_BAKE_ENV 迁移而来），新增字段（后处理 / 云 / 星月）取保守初值。
 * keyframes 按 elevation 升序：-1 深夜 / -0.1 夜半晨昏交界 / 0.15 晨昏金色 / 0.5 日间 / 1 正午。
 */

const BLOCK_TINT: [number, number, number] = [1, 0.82, 0.55]

/** 旧 DEFAULT_BAKE_ENV（白昼基准面明暗） */
const DAY_FACE_SHADE = { px: 0.82, nx: 0.78, py: 1.0, ny: 0.5, pz: 0.86, nz: 0.72 }

const scaleShade = (s: typeof DAY_FACE_SHADE, k: number): typeof DAY_FACE_SHADE => ({
  px: s.px * k, nx: s.nx * k, py: s.py * k, ny: s.ny * k, pz: s.pz * k, nz: s.nz * k,
})

const keyframes: PaletteKeyframe[] = [
  {
    // 深夜（旧 NIGHT_SKY / NIGHT_TINT；面明暗 ×0.6 压平方向差）
    elevation: -1,
    sunLightColor: [1, 0.85, 0.6],
    sunLightIntensity: 0,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0.3,
    skyZenith: [0.02, 0.03, 0.09],
    skyHorizon: [0.05, 0.07, 0.16],
    fogColor: [0.05, 0.07, 0.16],
    skyTint: [0.4, 0.5, 0.78],
    blockTint: BLOCK_TINT,
    faceShade: scaleShade(DAY_FACE_SHADE, 0.6),
    skyLevel: 4,
    sunColor: [1, 0.85, 0.6],
    sunIntensity: 0,
    moonIntensity: 1.0,
    starIntensity: 1,
    cloudCoverage: 0.3,
    cloudTint: [0.09, 0.11, 0.18],
    exposure: 1.05,
    bloomStrength: 0.5,
    saturation: 0.95,
    shadowTint: [0.72, 0.8, 1.05],
    highTint: [1.02, 0.98, 0.92],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.07, 0.11, 0.22],
    waterDeep: [0.02, 0.05, 0.13],
    waterFoam: [0.38, 0.46, 0.62],
    waterFog: [0.03, 0.07, 0.14],
  },
  {
    // 夜半与晨昏交界
    elevation: -0.1,
    sunLightColor: [1, 0.7, 0.45],
    sunLightIntensity: 0.15,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0.12,
    skyZenith: [0.1, 0.09, 0.22],
    skyHorizon: [0.45, 0.3, 0.32],
    fogColor: [0.42, 0.3, 0.32],
    skyTint: [0.55, 0.5, 0.7],
    blockTint: BLOCK_TINT,
    faceShade: scaleShade(DAY_FACE_SHADE, 0.7),
    skyLevel: 5,
    sunColor: [1, 0.6, 0.35],
    sunIntensity: 0.4,
    moonIntensity: 0.5,
    starIntensity: 0.6,
    cloudCoverage: 0.35,
    cloudTint: [0.5, 0.35, 0.4],
    exposure: 1.02,
    bloomStrength: 0.4,
    saturation: 1.0,
    shadowTint: [0.72, 0.8, 1.05],
    highTint: [1.04, 0.96, 0.88],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.15, 0.17, 0.31],
    waterDeep: [0.07, 0.09, 0.2],
    waterFoam: [0.56, 0.5, 0.56],
    waterFog: [0.08, 0.1, 0.21],
  },
  {
    // 晨昏金色（旧 DUSK_SKY / DUSK_TINT）
    elevation: 0.15,
    sunLightColor: [1, 0.6, 0.35],
    sunLightIntensity: 0.5,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0.04,
    skyZenith: [0.35, 0.45, 0.7],
    skyHorizon: [0.86, 0.55, 0.36],
    fogColor: [0.82, 0.55, 0.38],
    skyTint: [1, 0.72, 0.5],
    blockTint: BLOCK_TINT,
    faceShade: { px: 0.75, nx: 0.72, py: 0.9, ny: 0.45, pz: 0.78, nz: 0.68 },
    skyLevel: 9,
    sunColor: [1, 0.55, 0.3],
    sunIntensity: 0.9,
    moonIntensity: 0.15,
    starIntensity: 0,
    cloudCoverage: 0.3,
    cloudTint: [1, 0.75, 0.55],
    exposure: 1.0,
    bloomStrength: 0.35,
    saturation: 1.05,
    shadowTint: [0.74, 0.8, 1.04],
    highTint: [1.06, 0.98, 0.88],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.31, 0.42, 0.55],
    waterDeep: [0.12, 0.22, 0.35],
    waterFoam: [0.86, 0.8, 0.75],
    waterFog: [0.12, 0.23, 0.3],
  },
  {
    // 日间
    elevation: 0.5,
    sunLightColor: [1, 0.9, 0.75],
    sunLightIntensity: 1.1,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0,
    skyZenith: [0.3, 0.55, 0.85],
    skyHorizon: [0.62, 0.79, 0.92],
    fogColor: [0.62, 0.79, 0.92],
    skyTint: [0.98, 0.99, 1.0],
    blockTint: BLOCK_TINT,
    faceShade: { px: 0.8, nx: 0.76, py: 0.98, ny: 0.48, pz: 0.84, nz: 0.7 },
    skyLevel: 13,
    sunColor: [1, 0.9, 0.7],
    sunIntensity: 1.1,
    moonIntensity: 0,
    starIntensity: 0,
    cloudCoverage: 0.32,
    cloudTint: [0.98, 0.97, 0.95],
    exposure: 1.0,
    bloomStrength: 0.2,
    saturation: 1.05,
    shadowTint: [0.75, 0.82, 1.04],
    highTint: [1.06, 1.0, 0.9],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.25, 0.5, 0.66],
    waterDeep: [0.1, 0.3, 0.45],
    waterFoam: [0.9, 0.95, 0.98],
    waterFog: [0.08, 0.3, 0.4],
  },
  {
    // 正午（旧 DAY_SKY / DAY_TINT / DEFAULT_BAKE_ENV 原值）
    elevation: 1,
    sunLightColor: [1, 0.95, 0.85],
    sunLightIntensity: 1.3,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0,
    skyZenith: [0.25, 0.5, 0.9],
    skyHorizon: [0.62, 0.79, 0.92],
    fogColor: [0.62, 0.79, 0.92],
    skyTint: [1, 1, 1],
    blockTint: BLOCK_TINT,
    faceShade: DAY_FACE_SHADE,
    skyLevel: 15,
    sunColor: [1, 0.95, 0.8],
    sunIntensity: 1.2,
    moonIntensity: 0,
    starIntensity: 0,
    cloudCoverage: 0.35,
    cloudTint: [1, 0.98, 0.94],
    exposure: 1.0,
    bloomStrength: 0.15,
    saturation: 1.08,
    shadowTint: [0.76, 0.83, 1.04],
    highTint: [1.06, 1.0, 0.9],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.28, 0.56, 0.72],
    waterDeep: [0.1, 0.32, 0.5],
    waterFoam: [0.92, 0.97, 1.0],
    waterFog: [0.08, 0.32, 0.42],
  },
]

export const MIST_MANOR_PALETTE: ThemePalette = {
  name: 'mist-manor',
  keyframes,
  aoStrength: 0.5,
  aoCurve: [0.45, 0.65, 0.85, 1.0],
  fogDensityScale: 0.018,
  weatherGray: [0.541, 0.576, 0.62], // 0x8a939e
  ambientLift: Math.PI, // T7 标定:Lambert BRDF 1/π,环境光 π(阴影关闭时)观感 = S1;开启时按 shadow.ambientScale 压低给直射让位
  shadow: {
    enabled: true, mapSize: 2048, softwareMapSize: 1024, bias: -0.0002, normalBias: 0.6, radius: 4,
    // 阴影开启时环境光 ×0.58：受光面由直射光补足到≈S1,阴影面 0.58 → 对比≈40%,清晰可辨
    ambientScale: 0.58,
  },
}

/** 旧 DEFAULT_BAKE_ENV 的等价物：正午档关键帧（mesher 缺省烘焙环境） */
export const DEFAULT_BAKE_ENV = {
  faceShade: { ...DAY_FACE_SHADE },
  skyTint: [1, 1, 1] as [number, number, number],
  blockTint: BLOCK_TINT,
}
