export function SceneCreationPrompt({ value, onChange, onCreate, busy, error }: { value: string; onChange: (value: string) => void; onCreate: () => void; busy: boolean; error: string }) {
  return <section className="mx-auto w-full max-w-3xl rounded-[2rem] border border-[#e2e4d8] bg-[#fffdf7]/95 p-6 shadow-xl sm:p-8">
    <p className="text-xs font-semibold uppercase tracking-[.18em] text-[#799181]">先从一个地方开始</p>
    <h1 className="mt-2 font-story text-3xl text-[#283f35] sm:text-4xl">你想让这里是什么样？</h1>
    <p className="mt-3 max-w-2xl text-sm leading-6 text-[#68776c]">描述地点、建筑、自然环境和彼此的距离。AI 会从固定素材中搭出可以继续编辑的场景。</p>
    <textarea data-testid="scene-prompt" value={value} onChange={event => onChange(event.target.value)} rows={4} maxLength={1200} placeholder="一条沿着小河延伸的街道，街角有家咖啡馆，附近有几间住宅和一片可以散步的小公园……" className="mt-5 w-full resize-y rounded-2xl border border-[#d9dfd4] bg-white px-4 py-3 text-sm leading-6 text-[#33483d] outline-none transition focus:border-[#6d8f79] focus:ring-2 focus:ring-[#6d8f79]/20" />
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-[#89938a]">示例：海边旧车站旁的小街，路边有咖啡馆、花园和安静的住宅。</span><button data-testid="generate-scene" onClick={onCreate} disabled={busy || !value.trim()} className="rounded-full bg-[#274739] px-6 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-[#1f3a2d] disabled:cursor-not-allowed disabled:opacity-50">{busy ? '正在搭建场景…' : '开始创造'}</button></div>
    {busy && <div role="status" className="mt-5 flex items-center gap-3 text-sm text-[#547060]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#668b70]" />正在理解描述并安排地点、道路与居民。结果仍可继续修改。</div>}
  </section>
}
