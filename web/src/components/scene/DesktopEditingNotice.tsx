export function DesktopEditingNotice({ onClose }: { onClose: () => void }) {
  return <div role="status" className="flex items-start justify-between gap-3 rounded-2xl border border-[#dfe5da] bg-white/95 px-4 py-3 text-sm text-[#596b5d] shadow"><p>完整的场景创造和编辑建议在桌面端完成。你仍可平移画面、查看地点与居民。</p><button aria-label="关闭提示" onClick={onClose} className="shrink-0 text-[#7d897e]">×</button></div>
}
