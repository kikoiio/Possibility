import type { BlockType } from '../types'

// 雾影庄方块集：手绘纹理帧名约定为 `<block>-top|side|bottom`，
// 与 web/public/voxel-assets/mist-manor/atlas.json 帧表一一对应（T12 校验脚本保证）。
const b = (input: Omit<BlockType, 'textures'> & { textures?: Partial<BlockType['textures']> & Pick<BlockType['textures'], 'side'> }): BlockType => {
  const side = input.textures?.side ?? `${input.id}-side`
  return {
    ...input,
    textures: {
      top: input.textures?.top ?? `${input.id}-top`,
      side,
      ...(input.textures?.bottom ? { bottom: input.textures.bottom } : {}),
    },
  }
}

export const mistManorBlocks: BlockType[] = [
  // ── 地形 ──────────────────────────────
  b({ id: 'grass', name: '草地', category: 'terrain', solid: true, accumulatesSnow: true, textures: { side: 'grass-side', top: 'grass-top', bottom: 'dirt-bottom' } }),
  b({ id: 'dirt', name: '泥土', category: 'terrain', solid: true }),
  b({ id: 'stone', name: '山石', category: 'terrain', solid: true, accumulatesSnow: true }),
  b({ id: 'cobble', name: '石板路', category: 'terrain', solid: true, accumulatesSnow: true }),
  b({ id: 'gravel', name: '碎石', category: 'terrain', solid: true, accumulatesSnow: true }),
  // ── 结构 ──────────────────────────────
  b({ id: 'wood-plank', name: '木板', category: 'structural', solid: true }),
  b({ id: 'wood-log', name: '原木', category: 'structural', solid: true, textures: { top: 'wood-log-top', side: 'wood-log-side' } }),
  b({ id: 'plaster-wall', name: '土墙', category: 'structural', solid: true }),
  b({ id: 'roof-tile', name: '瓦', category: 'structural', solid: true, accumulatesSnow: true }),
  b({ id: 'paper-window', name: '纸窗', category: 'structural', solid: true, emitsLight: 12, textures: { top: 'paper-window-side', side: 'paper-window-side' } }),
  b({ id: 'glass', name: '玻璃', category: 'structural', solid: true, translucent: true }),
  b({ id: 'tatami', name: '榻榻米', category: 'structural', solid: true }),
  // ── 流体 ──────────────────────────────
  b({ id: 'water', name: '水', category: 'fluid', solid: false, translucent: true, textures: { top: 'water-top', side: 'water-side' } }),
  // ── 装饰 ──────────────────────────────
  b({ id: 'lantern', name: '石灯笼', category: 'decor', solid: true, emitsLight: 14 }),
  b({ id: 'leaves', name: '树叶', category: 'decor', solid: true, accumulatesSnow: true }),
  b({ id: 'wood-fence', name: '木栅栏', category: 'decor', solid: true }),
  b({ id: 'flower', name: '花', category: 'decor', solid: false, textures: { top: 'flower-top', side: 'flower-side' } }),
  b({ id: 'bush', name: '灌木', category: 'decor', solid: true, accumulatesSnow: true }),
  // ── 效果 ──────────────────────────────
  b({ id: 'snow-layer', name: '雪层', category: 'effect', solid: false, textures: { top: 'snow-top', side: 'snow-side' } }),
]
