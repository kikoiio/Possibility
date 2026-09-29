import type { BlockRegistry } from '@possibility/voxel-contract'

export interface BlockPaletteProps {
  registry: BlockRegistry
  selected: string
  onSelect(blockId: string): void
  tool: 'place' | 'dig'
  onToolChange(tool: 'place' | 'dig'): void
}

/** 方块调色板：类型选择 + 挖掘/放置模式（F16） */
export default function BlockPalette({ registry, selected, onSelect, tool, onToolChange }: BlockPaletteProps) {
  const categories = ['terrain', 'structural', 'decor', 'fluid', 'effect'] as const
  const label: Record<string, string> = { terrain: '地形', structural: '结构', decor: '装饰', fluid: '流体', effect: '效果' }
  return (
    <div className="flex w-52 flex-col gap-2 rounded bg-black/60 p-3 text-xs text-zinc-200" data-testid="voxel-block-palette">
      <div className="flex items-center justify-between">
        <span className="font-medium text-zinc-100">方块</span>
        <div className="flex gap-1">
          <button
            data-testid="voxel-block-tool-place"
            className={`rounded px-2 py-1 ${tool === 'place' ? 'bg-sky-600 text-white' : 'bg-zinc-700/70'}`}
            onClick={() => onToolChange('place')}
          >
            放置
          </button>
          <button
            data-testid="voxel-block-tool-dig"
            className={`rounded px-2 py-1 ${tool === 'dig' ? 'bg-red-700/80 text-white' : 'bg-zinc-700/70'}`}
            onClick={() => onToolChange('dig')}
          >
            挖掘
          </button>
        </div>
      </div>
      {categories.map((cat) => {
        const blocks = registry.list().filter((b) => b.category === cat)
        if (blocks.length === 0) return null
        return (
          <div key={cat}>
            <div className="mb-0.5 text-zinc-500">{label[cat]}</div>
            <div className="grid grid-cols-3 gap-1">
              {blocks.map((b) => (
                <button
                  key={b.id}
                  data-testid={`voxel-block-${b.id}`}
                  className={`rounded px-1 py-1.5 leading-tight ${selected === b.id ? 'bg-sky-600 text-white' : 'bg-zinc-700/70 hover:bg-zinc-600'}`}
                  onClick={() => onSelect(b.id)}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
