import type { BlockRegistry, BlockType } from './types'
import { mistManorBlocks } from './themes/mist-manor'

const themeBlocks: Record<string, BlockType[]> = {
  'mist-manor': mistManorBlocks,
}

/**
 * 创建方块注册表。传入主题 id 时自动注册该主题方块集（N6）；
 * 主题包也可以通过 register() 注入新方块而不改渲染核心。
 */
export function createBlockRegistry(theme?: string): BlockRegistry {
  const byId = new Map<string, BlockType>()
  const registry: BlockRegistry = {
    get(id) { return byId.get(id) },
    list() { return [...byId.values()] },
    register(type) {
      if (byId.has(type.id)) throw new Error(`block type already registered: ${type.id}`)
      byId.set(type.id, type)
    },
  }
  if (theme) {
    const blocks = themeBlocks[theme]
    if (!blocks) throw new Error(`unknown voxel theme: ${theme}`)
    for (const block of blocks) registry.register(block)
  }
  return registry
}

export function knownThemes(): string[] {
  return Object.keys(themeBlocks)
}
