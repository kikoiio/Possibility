import type { SceneMode } from '@possibility/scene-contract'

const MODES: { id: SceneMode; label: string; note: string }[] = [
  { id: 'create', label: '创造', note: '用语言与拖动调整这里' },
  { id: 'life', label: '生活', note: '观察居民的日常' },
  { id: 'possibility', label: '可能', note: '看看另一种发展' },
]
export function WorldModeSwitcher({ mode, onChange, editable = true }: { mode: SceneMode; onChange: (mode: SceneMode) => void; editable?: boolean }) {
  return <div role="tablist" aria-label="画布模式" className="inline-flex rounded-full border border-[#d8ded4] bg-white/80 p-1 shadow-sm">
    {MODES.map(item => <button key={item.id} role="tab" aria-selected={mode === item.id} title={item.note} disabled={!editable && item.id === 'create'} onClick={() => onChange(item.id)} className={`rounded-full px-4 py-2 text-sm transition ${mode === item.id ? 'bg-[#274739] text-white shadow' : 'text-[#496055] hover:bg-[#edf1e9]'} disabled:opacity-40`}>{item.label}</button>)}
  </div>
}
