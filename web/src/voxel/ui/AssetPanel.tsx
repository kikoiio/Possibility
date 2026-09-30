import type { AssetCategory, AssetManifest } from '@possibility/voxel-contract'

export interface AssetPanelProps {
  manifest: AssetManifest
  /** 拖拽或点击选中资产（点击 = 进入放置模式，放置后保持 armed 可连续放置，Esc 解除） */
  onPick(assetId: string): void
  armedAssetId: string | null
  /** 当前选中的已摆放资产 */
  selectedPlacement: { id: string; label: string } | null
  onRotateSelected(): void
  onRemoveSelected(): void
  onDeselect(): void
}

const CATEGORY_LABEL: Record<AssetCategory, string> = {
  vegetation: '植被',
  building: '建筑',
  decoration: '装饰',
}

/** S2b 资产面板(F1-F3):库内 GLB 资产的浏览/拖拽源 + 选中摆放的旋转/移除 */
export default function AssetPanel({ manifest, onPick, armedAssetId, selectedPlacement, onRotateSelected, onRemoveSelected, onDeselect }: AssetPanelProps) {
  const categories = (Object.keys(CATEGORY_LABEL) as AssetCategory[])
    .map((category) => ({
      category,
      items: Object.values(manifest.assets).filter((a) => a.category === category),
    }))
    .filter((group) => group.items.length > 0)

  return (
    <div className="flex w-52 flex-col gap-2 rounded bg-black/60 p-3 text-xs text-zinc-200" data-testid="voxel-asset-panel">
      <div className="font-medium text-zinc-100">资产库</div>
      <div className="text-zinc-400">拖到世界里放置；点世界里的资产可移动/旋转/移除</div>
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
        {categories.map((group) => (
          <div key={group.category} className="flex flex-col gap-1">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">{CATEGORY_LABEL[group.category]}</div>
            {group.items.map((asset) => (
              <div
                key={asset.id}
                data-testid={`voxel-asset-item-${asset.id}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-voxel-asset', asset.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => onPick(asset.id)}
                className={`flex cursor-grab items-center gap-2 rounded px-2 py-1.5 ${armedAssetId === asset.id ? 'bg-sky-600 text-white' : 'bg-zinc-700/70 hover:bg-zinc-600'}`}
              >
                <img src={asset.thumbnail} alt="" className="h-8 w-8 rounded object-cover" draggable={false} />
                <div>
                  <div>{asset.id}</div>
                  <div className="text-zinc-400">{asset.footprint[0]}×{asset.footprint[1]} · 高 {asset.height}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {selectedPlacement && (
        <div className="mt-1 flex flex-col gap-1 rounded border border-amber-500/50 p-2" data-testid="voxel-asset-actions">
          <div className="text-amber-200">已选中：{selectedPlacement.label}</div>
          <div className="text-zinc-400">拖动移到新位置；R 旋转 90°；Esc 取消</div>
          <div className="flex gap-1">
            <button data-testid="voxel-asset-rotate" className="flex-1 rounded bg-zinc-600 px-2 py-1" onClick={onRotateSelected}>
              旋转
            </button>
            <button data-testid="voxel-asset-remove" className="flex-1 rounded bg-red-700/80 px-2 py-1 text-white" onClick={onRemoveSelected}>
              移除
            </button>
            <button data-testid="voxel-asset-deselect" className="flex-1 rounded bg-zinc-600 px-2 py-1" onClick={onDeselect}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
