import type { PaletteKeyframe, ThemePalette } from '../palette'

/**
 * mist-manor 主题调色数据(S1 色彩中枢唯一事实源)。
 * S1(v2) 数值重做:CoC 式风格化——饱和克制、暖阳光/冷阴影强对比、
 * 天空存在感激化、曝光回收。直射光全面加强、环境光让位(ambientScale 0.42),
 * 阴影区由冷色 split-tone 托住可读性。
 * keyframes 按 elevation 升序:-1 深夜 / -0.1 夜半晨昏交界 / 0.15 晨昏金色 / 0.5 日间 / 1 正午。
 */

const BLOCK_TINT: [number, number, number] = [1, 0.82, 0.55]

/** 旧 DEFAULT_BAKE_ENV（白昼基准面明暗） */
const DAY_FACE_SHADE = { px: 0.82, nx: 0.78, py: 1.0, ny: 0.5, pz: 0.86, nz: 0.72 }

const scaleShade = (s: typeof DAY_FACE_SHADE, k: number): typeof DAY_FACE_SHADE => ({
  px: s.px * k, nx: s.nx * k, py: s.py * k, ny: s.ny * k, pz: s.pz * k, nz: s.nz * k,
})

const keyframes: PaletteKeyframe[] = [
  {
    // 深夜(S1v2:月光加强勾冷阴影,天幕更深,星更亮)
    elevation: -1,
    sunLightColor: [1, 0.85, 0.6],
    sunLightIntensity: 0,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0.56,
    skyZenith: [0.015, 0.03, 0.1],
    skyHorizon: [0.06, 0.09, 0.2],
    fogColor: [0.06, 0.09, 0.2],
    // Keep enough baked moonlight in terrain-facing and shadowed voxel faces.
    skyTint: [0.98, 0.99, 1],
    blockTint: BLOCK_TINT,
    faceShade: scaleShade(DAY_FACE_SHADE, 0.92),
    skyLevel: 14,
    sunColor: [1, 0.85, 0.6],
    sunIntensity: 0,
    moonIntensity: 1.0,
    starIntensity: 1,
    cloudCoverage: 0.35,
    cloudTint: [0.09, 0.11, 0.18],
    exposure: 1.28,
    bloomStrength: 0.55,
    saturation: 0.92,
    shadowTint: [0.6, 0.7, 1.1],
    highTint: [1.02, 0.98, 0.92],
    vignette: 0.22,
    grain: 0.014,
    waterShallow: [0.07, 0.11, 0.22],
    waterDeep: [0.02, 0.05, 0.13],
    waterFoam: [0.38, 0.46, 0.62],
    waterFog: [0.03, 0.07, 0.14],
  },
  {
    // 夜半与晨昏交界(S1v2:地平线暖带加强,直射初起)
    elevation: -0.1,
    sunLightColor: [1, 0.7, 0.45],
    sunLightIntensity: 0.5,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0.18,
    skyZenith: [0.1, 0.09, 0.24],
    skyHorizon: [0.52, 0.3, 0.3],
    fogColor: [0.46, 0.29, 0.31],
    skyTint: [0.82, 0.8, 0.94],
    blockTint: BLOCK_TINT,
    faceShade: scaleShade(DAY_FACE_SHADE, 0.86),
    skyLevel: 14,
    sunColor: [1, 0.6, 0.35],
    sunIntensity: 0.4,
    moonIntensity: 0.5,
    starIntensity: 0.6,
    cloudCoverage: 0.38,
    cloudTint: [0.52, 0.34, 0.4],
    exposure: 1.0,
    bloomStrength: 0.45,
    saturation: 0.98,
    shadowTint: [0.64, 0.72, 1.08],
    highTint: [1.04, 0.96, 0.88],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.15, 0.17, 0.31],
    waterDeep: [0.07, 0.09, 0.2],
    waterFoam: [0.56, 0.5, 0.56],
    waterFog: [0.08, 0.1, 0.21],
  },
  {
    // 晨昏金色(S1v2:低角度暖直射加强,地平线橙带更纯,阴影偏紫)
    elevation: 0.15,
    sunLightColor: [1, 0.58, 0.32],
    sunLightIntensity: 1.4,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0.04,
    skyZenith: [0.3, 0.38, 0.72],
    skyHorizon: [0.95, 0.52, 0.3],
    fogColor: [0.9, 0.5, 0.32],
    skyTint: [1, 0.68, 0.45],
    blockTint: BLOCK_TINT,
    faceShade: { px: 0.75, nx: 0.72, py: 0.9, ny: 0.45, pz: 0.78, nz: 0.68 },
    skyLevel: 14,
    sunColor: [1, 0.55, 0.3],
    sunIntensity: 0.9,
    moonIntensity: 0.15,
    starIntensity: 0,
    cloudCoverage: 0.35,
    cloudTint: [1, 0.72, 0.5],
    exposure: 0.98,
    bloomStrength: 0.45,
    saturation: 1.04,
    shadowTint: [0.66, 0.7, 1.08],
    highTint: [1.08, 0.96, 0.84],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.31, 0.42, 0.55],
    waterDeep: [0.12, 0.22, 0.35],
    waterFoam: [0.86, 0.8, 0.75],
    waterFog: [0.12, 0.23, 0.3],
  },
  {
    // 日间(S1v2 R2:直射略回收防死白,天青浓郁,曝光回收)
    elevation: 0.5,
    sunLightColor: [1, 0.86, 0.66],
    sunLightIntensity: 1.85,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0,
    skyZenith: [0.18, 0.46, 0.9],
    skyHorizon: [0.5, 0.72, 0.93],
    fogColor: [0.5, 0.72, 0.93],
    skyTint: [1, 0.95, 0.87],
    blockTint: BLOCK_TINT,
    faceShade: { px: 0.8, nx: 0.76, py: 0.98, ny: 0.48, pz: 0.84, nz: 0.7 },
    skyLevel: 15,
    sunColor: [1, 0.9, 0.7],
    sunIntensity: 1.1,
    moonIntensity: 0,
    starIntensity: 0,
    cloudCoverage: 0.4,
    cloudTint: [0.98, 0.96, 0.93],
    exposure: 0.94,
    bloomStrength: 0.3,
    saturation: 1.02,
    shadowTint: [0.64, 0.74, 1.07],
    highTint: [1.02, 0.99, 0.9],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.22, 0.48, 0.68],
    waterDeep: [0.08, 0.28, 0.46],
    waterFoam: [0.9, 0.95, 0.98],
    waterFog: [0.08, 0.3, 0.4],
  },
  {
    // 正午(S1v2 R2:强暖直射略收 + 冷阴影,CoC 式清亮不死白)
    elevation: 1,
    sunLightColor: [1, 0.9, 0.7],
    sunLightIntensity: 2.15,
    moonLightColor: [0.6, 0.72, 1.0],
    moonLightIntensity: 0,
    skyZenith: [0.14, 0.4, 0.92],
    skyHorizon: [0.52, 0.74, 0.94],
    fogColor: [0.52, 0.74, 0.94],
    skyTint: [1, 0.97, 0.9],
    blockTint: BLOCK_TINT,
    faceShade: DAY_FACE_SHADE,
    skyLevel: 15,
    sunColor: [1, 0.92, 0.72],
    sunIntensity: 1.2,
    moonIntensity: 0,
    starIntensity: 0,
    cloudCoverage: 0.42,
    cloudTint: [1, 0.97, 0.9],
    exposure: 0.93,
    bloomStrength: 0.25,
    saturation: 1.03,
    shadowTint: [0.62, 0.72, 1.08],
    highTint: [1.02, 0.99, 0.9],
    vignette: 0.28,
    grain: 0.014,
    waterShallow: [0.24, 0.54, 0.74],
    waterDeep: [0.07, 0.28, 0.5],
    waterFoam: [0.92, 0.97, 1.0],
    waterFog: [0.08, 0.32, 0.42],
  },
]

export const MIST_MANOR_PALETTE: ThemePalette = {
  name: 'mist-manor',
  keyframes,
  aoStrength: 0.62, // S1v2:接触感加强(CoC 式落地感)
  aoCurve: [0.38, 0.58, 0.8, 1.0],
  fogDensityScale: 0.015,
  weatherGray: [0.541, 0.576, 0.62], // 0x8a939e
  ambientLift: Math.PI, // T7 标定:Lambert BRDF 1/π,环境光 π(阴影关闭时)观感 = S1;开启时按 shadow.ambientScale 压低给直射让位
  shadow: {
    enabled: true, mapSize: 2048, softwareMapSize: 1024, bias: -0.0002, normalBias: 0.6, radius: 4,
    // 阴影开启时环境光托底，保留方向阴影的同时避免雾夜主体沉入黑色。
    // 方位仰角封顶(长影),阴影面 0.34 → 明暗对比接近 CoC 式 1:3
    ambientScale: 0.96,
  },
}

/** 旧 DEFAULT_BAKE_ENV 的等价物：正午档关键帧（mesher 缺省烘焙环境） */
export const DEFAULT_BAKE_ENV = {
  faceShade: { ...DAY_FACE_SHADE },
  skyTint: [1, 1, 1] as [number, number, number],
  blockTint: BLOCK_TINT,
}
