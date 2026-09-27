export function ScenePreviewBar({ summary, warnings, onApply, onCancel, busy = false }: { summary: string; warnings: string[]; onApply: () => void; onCancel: () => void; busy?: boolean }) {
  return <section aria-label="场景调整预览" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#b7c8b6] bg-[#f4f8ee] px-4 py-3 shadow-sm">
    <div className="min-w-48 flex-1"><p className="text-sm font-medium text-[#2d4938]">{summary || '场景调整预览'}</p><p className="mt-1 text-xs text-[#687a68]">预览尚未保存；绿色轮廓标出将要改变的内容。</p>{warnings.map((warning, i) => <p key={i} className="mt-1 text-xs text-amber-800">{warning}</p>)}</div>
    <div className="flex gap-2"><button onClick={onCancel} disabled={busy} className="rounded-full border border-[#c8d2c4] px-4 py-2 text-xs text-[#526553]">取消</button><button onClick={onApply} disabled={busy} className="rounded-full bg-[#315846] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{busy ? '保存中…' : '应用调整'}</button></div>
  </section>
}
