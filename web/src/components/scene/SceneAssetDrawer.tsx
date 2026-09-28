import type { AssetCategory, SceneThemeManifest } from '@possibility/scene-contract'

const CATEGORY: { id: AssetCategory; label: string }[] = [{ id: 'terrain', label: '地面' }, { id: 'road', label: '道路' }, { id: 'water', label: '水面' }, { id: 'building', label: '建筑' }, { id: 'nature', label: '自然' }, { id: 'decoration', label: '装饰' }, { id: 'person', label: '居民' }]
export function SceneAssetDrawer({ catalog, onPlace, onClose }: { catalog: SceneThemeManifest; onPlace: (assetId: string) => void; onClose: () => void }) {
  return <aside aria-label="场景素材" className="flex max-h-[45vh] flex-col rounded-2xl border border-[#dfe4d9] bg-white/95 p-3 shadow-lg md:max-h-none md:w-56">
    <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-[#344a3c]">场景素材</h2><button aria-label="关闭素材" onClick={onClose} className="rounded-full px-2 py-1 text-[#788579] hover:bg-[#edf1e9]">×</button></div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">{CATEGORY.map(category => {
      const assets = catalog.assets.filter(asset => asset.category === category.id && asset.capabilities.placeable)
      return assets.length ? <section key={category.id}><h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#839086]">{category.label}</h3><div className="grid grid-cols-2 gap-1.5">{assets.map(asset => <button key={asset.id} onClick={() => onPlace(asset.id)} className="flex min-h-16 items-center gap-2 rounded-xl border border-[#ebeee8] px-2 py-2 text-left text-xs text-[#415447] hover:border-[#95ad98] hover:bg-[#f6f8f2]" title={`${asset.name} · ${asset.footprint.width}×${asset.footprint.height}`}><img src={asset.thumbnail} alt="" className="h-10 w-10 shrink-0 object-contain" loading="lazy"/><span>{asset.name}</span></button>)}</div></section> : null
    })}</div>
  </aside>
}
