/**
 * T12 雾影庄手绘图集生成器：逐材质 32×32 像素画（确定性种子，可复现），
 * 落盘 web/public/voxel-assets/mist-manor/atlas.{png,json}。
 * 用法：`node --import tsx scripts/generate-mist-manor-atlas.ts`
 * 帧名集合必须与 packages/voxel-contract/src/themes/mist-manor.ts 注册表一致
 * （由 scripts/validate-voxel-atlas.ts 强制校验）。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TILE = 32
const COLS = 8

type Rgb = [number, number, number]
type Painter = (px: (x: number, y: number, c: Rgb) => void, rand: () => number) => void

// ── 确定性随机（mulberry32，按帧名播种）─────────────
function seedFrom(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── 颜色工具 ─────────────────────────────────
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]
function speckle(px: (x: number, y: number, c: Rgb) => void, rand: () => number, base: Rgb, accents: Rgb[], density: number): void {
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    px(x, y, base)
    if (rand() < density) px(x, y, accents[Math.floor(rand() * accents.length)])
  }
}

// ── 各材质画法 ────────────────────────────────
const GREEN: Rgb = [96, 148, 72]
const DIRT: Rgb = [122, 88, 60]
const DIRT_DARK: Rgb = [96, 68, 46]

const painters: Record<string, Painter> = {
  'grass-top': (px, rand) => speckle(px, rand, GREEN, [[78, 128, 58], [116, 168, 88], [88, 140, 66]], 0.35),
  'grass-side': (px, rand) => {
    speckle(px, rand, DIRT, [DIRT_DARK, [140, 104, 72]], 0.3)
    for (let y = 0; y < 9; y++) for (let x = 0; x < TILE; x++) {
      px(x, y, rand() < 0.3 ? [78, 128, 58] : GREEN)
      // 草皮下缘垂下的草尖
      if (y === 8 && rand() < 0.4) px(x, 9 + Math.floor(rand() * 3), GREEN)
    }
  },
  'dirt-top': (px, rand) => speckle(px, rand, DIRT, [DIRT_DARK, [140, 104, 72], [110, 78, 52]], 0.4),
  'dirt-side': (px, rand) => speckle(px, rand, DIRT, [DIRT_DARK, [140, 104, 72]], 0.35),
  'dirt-bottom': (px, rand) => speckle(px, rand, DIRT_DARK, [[82, 58, 40], [110, 80, 55]], 0.35),
  'stone-top': (px, rand) => speckle(px, rand, [128, 130, 134], [[112, 114, 118], [146, 148, 152]], 0.3),
  'stone-side': (px, rand) => {
    speckle(px, rand, [124, 126, 130], [[108, 110, 114], [142, 144, 148]], 0.25)
    // 裂纹
    let x = 6, y = 0
    while (y < TILE) { px(x, y, [88, 90, 94]); if (rand() < 0.5) x += rand() < 0.5 ? 1 : -1; y++ }
  },
  'cobble-top': (px, rand) => {
    speckle(px, rand, [90, 92, 96], [[84, 86, 90]], 0.1)
    // 圆石：错位行排布
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
      const cx = col * 8 + (row % 2 ? 4 : 0) + 4, cy = row * 8 + 4
      const tone: Rgb = mix([150, 152, 156], [118, 120, 124], rand())
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy <= 9) px((cx + dx) % TILE, cy + dy, dy < 0 ? mix(tone, [255, 255, 255], 0.12) : tone)
      }
    }
  },
  'cobble-side': (px, rand) => painters['cobble-top'](px, rand),
  'gravel-top': (px, rand) => {
    speckle(px, rand, [110, 108, 104], [], 0)
    for (let i = 0; i < 90; i++) {
      const tones: Rgb[] = [[140, 138, 132], [96, 94, 90], [128, 120, 110], [160, 158, 150]]
      px(Math.floor(rand() * TILE), Math.floor(rand() * TILE), tones[Math.floor(rand() * tones.length)])
    }
  },
  'gravel-side': (px, rand) => painters['gravel-top'](px, rand),
  'wood-plank-top': (px, rand) => painters['wood-plank-side'](px, rand),
  'wood-plank-side': (px, rand) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const plank = Math.floor(y / 8)
      let c: Rgb = mix([146, 108, 66], [128, 92, 54], (plank % 2) * 0.5)
      if (rand() < 0.12) c = mix(c, [100, 72, 42], 0.6) // 木纹
      px(x, y, c)
    }
    for (let y = 7; y < TILE; y += 8) for (let x = 0; x < TILE; x++) px(x, y, [88, 62, 36]) // 板缝
  },
  'wood-log-top': (px) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const r = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5))
      px(x, y, Math.floor(r) % 2 === 0 ? [168, 132, 84] : [140, 106, 62])
    }
  },
  'wood-log-side': (px, rand) => {
    for (let x = 0; x < TILE; x++) {
      const stripe: Rgb = x % 5 < 2 ? [110, 80, 50] : [130, 98, 62]
      for (let y = 0; y < TILE; y++) px(x, y, rand() < 0.1 ? mix(stripe, [90, 64, 40], 0.7) : stripe)
    }
  },
  'plaster-wall-top': (px, rand) => speckle(px, rand, [214, 206, 190], [[200, 192, 176], [226, 219, 204]], 0.15),
  'plaster-wall-side': (px, rand) => {
    speckle(px, rand, [210, 202, 186], [[196, 188, 172], [222, 215, 200]], 0.15)
    for (let y = 0; y < 3; y++) for (let x = 0; x < TILE; x++) px(x, y, [120, 92, 58]) // 顶部木压条
  },
  'roof-tile-top': (px, rand) => painters['roof-tile-side'](px, rand),
  'roof-tile-side': (px, rand) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = Math.floor(y / 6)
      const inArc = (x + (row % 2) * 4) % 8 < 4
      let c: Rgb = inArc ? [84, 92, 108] : [68, 75, 90]
      if (y % 6 === 5) c = [52, 58, 72] // 瓦当阴影
      if (rand() < 0.06) c = mix(c, [255, 255, 255], 0.08)
      px(x, y, c)
    }
  },
  'paper-window-side': (px, rand) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      px(x, y, rand() < 0.08 ? [240, 224, 188] : [232, 216, 178]) // 暖光纸面
    }
    const lattice: Rgb = [104, 78, 48]
    for (let i = 0; i < TILE; i++) {
      for (const gy of [0, 10, 21, 31]) px(i, gy, lattice)
      for (const gx of [0, 10, 21, 31]) px(gx, i, lattice)
    }
  },
  'glass-top': (px) => painters['glass-side'](px, () => 1),
  'glass-side': (px) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) px(x, y, [188, 214, 226])
    for (let i = 6; i < 20; i++) { px(i, i - 4, [224, 240, 246]); px(i + 1, i - 4, [224, 240, 246]) } // 斜向高光
    for (let i = 0; i < TILE; i++) { px(i, 0, [150, 178, 192]); px(i, 31, [150, 178, 192]); px(0, i, [150, 178, 192]); px(31, i, [150, 178, 192]) }
  },
  'tatami-top': (px, rand) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const weave = (Math.floor(x / 2) + Math.floor(y / 8)) % 2 === 0
      let c: Rgb = weave ? [188, 178, 128] : [168, 158, 110]
      if (rand() < 0.08) c = mix(c, [140, 132, 92], 0.5)
      px(x, y, c)
    }
    for (let x = 0; x < TILE; x++) { px(x, 0, [88, 74, 48]); px(x, 31, [88, 74, 48]) } // 包边
  },
  'tatami-side': (px, rand) => speckle(px, rand, [150, 138, 96], [[134, 122, 82]], 0.2),
  'water-top': (px, rand) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const wave = Math.sin((x + y * 2) / 4) > 0.6
      px(x, y, wave ? [96, 150, 190] : [62, 116, 162])
      if (rand() < 0.03) px(x, y, [150, 196, 220])
    }
  },
  'water-side': (px, rand) => painters['water-top'](px, rand),
  'lantern-top': (px, rand) => speckle(px, rand, [150, 150, 148], [[132, 132, 130], [168, 168, 164]], 0.25),
  'lantern-side': (px, rand) => {
    speckle(px, rand, [148, 148, 146], [[130, 130, 128], [166, 166, 162]], 0.2)
    for (let y = 10; y < 22; y++) for (let x = 10; x < 22; x++) px(x, y, [250, 214, 140]) // 火袋透光
    for (let i = 10; i < 22; i++) { px(i, 10, [110, 108, 106]); px(i, 21, [110, 108, 106]); px(10, i, [110, 108, 106]); px(21, i, [110, 108, 106]) }
  },
  'leaves-top': (px, rand) => speckle(px, rand, [64, 104, 56], [[52, 88, 46], [82, 126, 70], [96, 140, 82]], 0.5),
  'leaves-side': (px, rand) => painters['leaves-top'](px, rand),
  'wood-fence-top': (px, rand) => speckle(px, rand, [134, 100, 62], [[116, 84, 50]], 0.2),
  'wood-fence-side': (px, rand) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) px(x, y, rand() < 0.1 ? [112, 82, 50] : [132, 98, 60])
    for (const ry of [7, 23]) for (let x = 0; x < TILE; x++) { px(x, ry, [96, 70, 42]); px(x, ry + 1, [96, 70, 42]) } // 横档
  },
  'flower-top': (px, rand) => {
    speckle(px, rand, [88, 132, 64], [[76, 118, 56]], 0.25)
    const petals: Rgb[] = [[214, 120, 130], [236, 200, 120], [200, 160, 220], [240, 240, 230]]
    for (let i = 0; i < 10; i++) {
      const cx = Math.floor(rand() * 28) + 2, cy = Math.floor(rand() * 28) + 2
      const c = petals[Math.floor(rand() * petals.length)]
      px(cx, cy, c); px(cx + 1, cy, c); px(cx, cy + 1, c); px(cx + 1, cy + 1, [250, 230, 160])
    }
  },
  'flower-side': (px, rand) => painters['flower-top'](px, rand),
  'bush-top': (px, rand) => speckle(px, rand, [74, 116, 60], [[60, 98, 50], [92, 136, 74]], 0.45),
  'bush-side': (px, rand) => painters['bush-top'](px, rand),
  'snow-top': (px, rand) => speckle(px, rand, [240, 244, 250], [[224, 232, 244], [252, 254, 255]], 0.2),
  'snow-side': (px, rand) => speckle(px, rand, [232, 238, 248], [[214, 224, 240]], 0.2),
}

// ── 最小 PNG 编码器（8-bit RGB，无滤波）──────────
function crc32(buf: Buffer): number {
  let c, table = (crc32 as unknown as { t?: number[] }).t
  if (!table) {
    table = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    ;(crc32 as unknown as { t?: number[] }).t = table
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = (table[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit, truecolor
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (1 + width * 3) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 主流程 ─────────────────────────────────
const names = Object.keys(painters).sort()
const rows = Math.ceil(names.length / COLS)
const width = COLS * TILE, height = rows * TILE
const rgb = new Uint8Array(width * height * 3)
const frames: Record<string, { x: number; y: number; w: number; h: number }> = {}

names.forEach((name, i) => {
  const ox = (i % COLS) * TILE, oy = Math.floor(i / COLS) * TILE
  const rand = mulberry32(seedFrom(name))
  painters[name]((x, y, c) => {
    const idx = ((oy + y) * width + (ox + x)) * 3
    rgb[idx] = c[0]; rgb[idx + 1] = c[1]; rgb[idx + 2] = c[2]
  }, rand)
  frames[name] = { x: ox, y: oy, w: TILE, h: TILE }
})

const outDir = resolve('web/public/voxel-assets/mist-manor')
mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'atlas.png'), encodePng(width, height, rgb))
writeFileSync(resolve(outDir, 'atlas.json'), JSON.stringify({ width, height, frames }, null, 2))
console.log(`[atlas] ${names.length} 帧 → ${outDir}/atlas.{png,json}（${width}×${height}）`)
