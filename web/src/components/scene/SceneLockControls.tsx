export function SceneLockControls({ locked, onToggle }: { locked: boolean; onToggle: () => void }) {
  return <button aria-pressed={locked} onClick={onToggle} className={`rounded-full border px-3 py-2 text-xs shadow-sm ${locked ? 'border-[#8c9b83] bg-[#eaf0e3] text-[#45583f]' : 'border-[#e0e4db] bg-white/85 text-[#657267]'}`}>{locked ? '🔒 已保护' : '◇ 保护对象'}</button>
}
