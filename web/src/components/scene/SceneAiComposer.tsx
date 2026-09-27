export function SceneAiComposer({ value, onChange, onPreview, busy, error }: { value: string; onChange: (value: string) => void; onPreview: () => void; busy: boolean; error: string }) {
  return <div className="rounded-2xl border border-[#e1e4da] bg-white/90 p-3 shadow-sm">
    <label htmlFor="scene-edit" className="sr-only">描述你想调整的场景内容</label>
    <div className="flex items-end gap-2"><textarea id="scene-edit" value={value} onChange={event => onChange(event.target.value)} rows={2} placeholder="例如：把咖啡馆旁边的花草多一些" className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 text-[#34483c] outline-none placeholder:text-[#929b90]" /><button onClick={onPreview} disabled={busy || !value.trim()} className="rounded-full bg-[#315846] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{busy ? '整理方案…' : '预览调整'}</button></div>
    {error && <p role="alert" className="px-2 pt-1 text-xs text-red-700">{error}</p>}
  </div>
}
