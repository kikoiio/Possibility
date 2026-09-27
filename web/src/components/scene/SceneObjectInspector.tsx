import type { SceneDocument } from '@possibility/scene-contract'
import type { SceneThemeManifest } from '@possibility/scene-contract'

export function SceneObjectInspector({ scene, selectedId, catalog }: { scene: SceneDocument; selectedId: string | null; catalog: SceneThemeManifest }) {
  const object = scene.objects.find(item => item.id === selectedId)
  if (!object) return <aside aria-label="对象信息" className="rounded-2xl border border-[#e3e6dc] bg-white/90 px-4 py-3 text-xs text-[#788579]">选择一个地点或居民，查看它在这个世界里的信息。</aside>
  const asset = catalog.assets.find(item => item.id === object.assetId)
  const binding = object.binding?.kind === 'location' ? `地点 · ${object.binding.locationName}` : object.binding?.kind === 'person' ? '居民' : '场景装饰'
  return <aside aria-label="对象信息" className="rounded-2xl border border-[#e3e6dc] bg-white/95 p-4 shadow-sm"><p className="text-[11px] uppercase tracking-wide text-[#879286]">{binding}</p><h2 className="mt-1 text-sm font-semibold text-[#344a3c]">{object.label || asset?.name || object.id}</h2>{object.purpose && <p className="mt-1 text-xs text-[#718075]">{object.purpose}</p>}<p className="mt-2 text-xs text-[#879286]">画布位置 {object.position.x + 1}, {object.position.y + 1}</p></aside>
}
