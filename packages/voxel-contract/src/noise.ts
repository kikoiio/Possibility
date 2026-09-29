// ── 确定性噪声与随机基元(S3b, N4)──────────────
// 全程整数哈希 + 浮点四则,禁用 Math.sin/cos 等三角函数:
// 三角函数精度跨 JS 引擎不保证一致,会破坏跨端逐位确定性(AC11)。

/** mulberry32 种子化 PRNG,返回 0–1 浮点序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 整数格点哈希 → [0,1)。全位运算,跨引擎逐位一致 */
export function hash2i(seed: number, xi: number, yi: number): number {
  let h = Math.imul(xi, 0x27d4eb2d) ^ Math.imul(yi, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10) // 五次曲线 6t⁵-15t⁴+10t³
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** 值噪声:四角哈希 + 五次曲线双线性插值,返回 [-1,1] */
export function valueNoise2D(seed: number, x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = fade(x - xi)
  const v = fade(y - yi)
  const a = hash2i(seed, xi, yi)
  const b = hash2i(seed, xi + 1, yi)
  const c = hash2i(seed, xi, yi + 1)
  const d = hash2i(seed, xi + 1, yi + 1)
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1
}

/** 分形叠加:逐倍频程减半振幅、加倍频率,归一化到 [-1,1] */
export function fbm2D(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D((seed + i * 1013) | 0, x * freq, y * freq)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return norm > 0 ? sum / norm : 0
}
