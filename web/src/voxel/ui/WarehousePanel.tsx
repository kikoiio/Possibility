import { listObjectTemplates } from '@possibility/voxel-contract'

export interface WarehousePanelProps {
  /** 拖拽或点击选中模板（点击 = 进入放置模式） */
  onPick(objectType: string): void
  armedType: string | null
  /** 当前选中待移动/移除的物体 */
  selectedObject: { id: string; label: string } | null
  onRemoveSelected(): void
  onDeselect(): void
}

/** 物体仓库面板：拖拽源 + 选中物体的移动/移除（F15） */
export default function WarehousePanel({ onPick, armedType, selectedObject, onRemoveSelected, onDeselect }: WarehousePanelProps) {
  return (
    <div className="flex w-52 flex-col gap-2 rounded bg-black/60 p-3 text-xs text-zinc-200" data-testid="voxel-warehouse">
      <div className="font-medium text-zinc-100">物体仓库</div>
      <div className="text-zinc-400">拖到世界里放置；点世界里的物体可移动/移除</div>
      <div className="flex flex-col gap-1">
        {listObjectTemplates().map((t) => (
          <div
            key={t.objectType}
            data-testid={`voxel-warehouse-item-${t.objectType}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-voxel-object', t.objectType)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => onPick(t.objectType)}
            className={`cursor-grab rounded px-2 py-1.5 ${armedType === t.objectType ? 'bg-sky-600 text-white' : 'bg-zinc-700/70 hover:bg-zinc-600'}`}
          >
            {t.name}
            <span className="ml-1 text-zinc-400">{t.cells.length} 格</span>
          </div>
        ))}
      </div>
      {selectedObject && (
        <div className="mt-1 flex flex-col gap-1 rounded border border-amber-500/50 p-2" data-testid="voxel-object-actions">
          <div className="text-amber-200">已选中：{selectedObject.label}</div>
          <div className="text-zinc-400">点击空地移动到此</div>
          <div className="flex gap-1">
            <button data-testid="voxel-object-remove" className="flex-1 rounded bg-red-700/80 px-2 py-1 text-white" onClick={onRemoveSelected}>
              移除
            </button>
            <button data-testid="voxel-object-deselect" className="flex-1 rounded bg-zinc-600 px-2 py-1" onClick={onDeselect}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
