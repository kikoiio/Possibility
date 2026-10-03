/**
 * S3 共享选中卡:多空间访客地图与单空间 owner 路径共用(F1 两路径同类型反馈)。
 * 纯展示组件;导览等副作用由调用方在自己的选中回调里处理。
 */
export interface MapSelectionCardProps {
  person: { id: string; name: string; location: string; activity: string } | null
  locationName: string | null
  locationDescription: string | null
  peopleHere: { id: string; name: string; activity: string }[]
  /** 无地点/居民绑定的普通物体标签 */
  fallbackLabel: string | null
  onClose(): void
  /** 居民卡 = 进入居民当前地点;地点卡 = 进入该地点 */
  onEnter(location: string): void
}

export default function MapSelectionCard({ person, locationName, locationDescription, peopleHere, fallbackLabel, onClose, onEnter }: MapSelectionCardProps) {
  return <section className="pointer-events-auto absolute right-3 top-24 z-20 w-[min(21rem,calc(100vw-1.5rem))] rounded-2xl border border-white/80 bg-[#f8faf6]/95 p-4 text-[#405246] shadow-xl backdrop-blur-md sm:right-5" data-testid="map-selection-card">
    <div className="flex items-start justify-between gap-2">
      <div>
        <p className="text-[10px] uppercase tracking-[.16em] text-[#7a897d]">{person ? '居民' : '地点'}</p>
        <h1 className="mt-0.5 font-story text-lg">{person?.name ?? locationName ?? fallbackLabel}</h1>
      </div>
      <button aria-label="关闭信息" onClick={onClose} className="rounded-full px-2 text-lg text-[#718075]">×</button>
    </div>
    {person && <>
      <p className="mt-2 text-xs text-[#68796d]">现在在{person.location} · {person.activity}</p>
      <div className="mt-4 flex gap-2">
        <button onClick={() => onEnter(person.location)} className="rounded-full bg-[#315641] px-3 py-2 text-xs text-white">以访客身份进入</button>
        <button onClick={onClose} className="rounded-full border border-[#ccd7cf] px-3 py-2 text-xs">继续观察</button>
      </div>
    </>}
    {locationName && <>
      <p className="mt-2 text-xs leading-relaxed text-[#68796d]">{locationDescription ?? '庄园中的一处空间。'}</p>
      <p className="mt-3 border-t border-[#dce3de] pt-3 text-xs">此刻在这里：{peopleHere.length ? peopleHere.map(item => `${item.name}（${item.activity}）`).join('、') : '暂时没有居民'}</p>
      <button onClick={() => onEnter(locationName)} className="mt-4 rounded-full bg-[#315641] px-4 py-2 text-xs text-white">进入此地点</button>
    </>}
  </section>
}
