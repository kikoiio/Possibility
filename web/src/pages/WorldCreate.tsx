import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, worldsApi } from '../api/client'
import type { LocationDef, PersonListItem } from '../api/types'

type Step = 'describe' | 'edit' | 'persons'

/** Quick World 创建向导：一句话 → 骨架编辑 → 选人入驻（F2） */
export default function WorldCreate() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('describe')
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [locations, setLocations] = useState<LocationDef[]>([])
  const [persons, setPersons] = useState<PersonListItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch<{ persons: PersonListItem[] }>('/api/persons').then((d) => setPersons(d.persons)).catch(() => {})
  }, [])

  const genDraft = async () => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const draft = await worldsApi.draft(prompt.trim())
      setName(draft.name)
      setDescription(draft.description)
      setLocations(draft.locations)
      setStep('edit')
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  const locError = locations.length < 5 || locations.length > 8 ? '地点需要 5-8 个' : locations.some((l) => !l.name.trim()) ? '地点名不能为空' : ''

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await worldsApi.create({
        name: name.trim(),
        description: description.trim(),
        locations: locations.map((l) => ({ name: l.name.trim(), description: l.description.trim() })),
        personIds: [...selected],
      })
      navigate(`/worlds/${res.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-base font-semibold text-ink">创建世界</h1>
      <ol className="flex gap-2 text-xs text-ink-faint">
        <li className={step === 'describe' ? 'font-medium text-ink' : ''}>① 描述</li>
        <li className={step === 'edit' ? 'font-medium text-ink' : ''}>② 骨架</li>
        <li className={step === 'persons' ? 'font-medium text-ink' : ''}>③ 人物</li>
      </ol>

      {step === 'describe' && (
        <div className="space-y-3 rounded-2xl border border-ink-line bg-sheet p-5">
          <p className="text-sm text-ink-soft">用一句话描述你想要的世界：</p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="例如：一个海边小镇，住着几个各怀心事的普通人，日子安静但暗流涌动"
            className="w-full rounded-xl border border-ink-line px-3 py-2 text-sm text-ink-soft placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            onClick={() => void genDraft()}
            disabled={!prompt.trim() || busy}
            className="rounded-xl bg-ink px-5 py-2 text-sm text-white disabled:bg-ink-faint"
          >
            {busy ? '生成中（约一分钟）…' : '生成世界骨架'}
          </button>
        </div>
      )}

      {step === 'edit' && (
        <div className="space-y-3 rounded-2xl border border-ink-line bg-sheet p-5">
          <label className="block text-xs text-ink-faint">世界名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border border-ink-line px-3 py-2 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
          />
          <label className="block text-xs text-ink-faint">背景描述</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full rounded-xl border border-ink-line px-3 py-2 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <label className="text-xs text-ink-faint">地点（{locations.length}/8）</label>
            <button
              onClick={() => setLocations((ls) => [...ls, { name: '', description: '' }])}
              disabled={locations.length >= 8}
              className="text-xs text-woad-deep disabled:text-ink-faint"
            >
              ＋ 加地点
            </button>
          </div>
          <div className="space-y-2">
            {locations.map((loc, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <input
                    value={loc.name}
                    onChange={(e) => setLocations((ls) => ls.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    placeholder="地点名"
                    className="w-full rounded-lg border border-ink-line px-2.5 py-1.5 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
                  />
                  <input
                    value={loc.description}
                    onChange={(e) => setLocations((ls) => ls.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                    placeholder="一句话描述"
                    className="w-full rounded-lg border border-ink-line/60 px-2.5 py-1 text-xs text-ink-soft focus:border-ink-faint focus:outline-none"
                  />
                </div>
                <button
                  onClick={() => setLocations((ls) => ls.filter((_, j) => j !== i))}
                  disabled={locations.length <= 5}
                  className="mt-1.5 text-xs text-ink-faint hover:text-red-500 disabled:opacity-30"
                >
                  删
                </button>
              </div>
            ))}
          </div>
          {(locError || error) && <p className="text-xs text-red-600">{locError || error}</p>}
          <div className="flex gap-2">
            <button onClick={() => setStep('describe')} className="rounded-xl border border-ink-line px-4 py-2 text-sm text-ink-soft">
              上一步
            </button>
            <button
              onClick={() => setStep('persons')}
              disabled={!!locError || !name.trim() || !description.trim()}
              className="rounded-xl bg-ink px-5 py-2 text-sm text-white disabled:bg-ink-faint"
            >
              下一步：选人物
            </button>
          </div>
        </div>
      )}

      {step === 'persons' && (
        <div className="space-y-3 rounded-2xl border border-ink-line bg-sheet p-5">
          <p className="text-sm text-ink-soft">选择 1-6 个人物入住「{name}」（已选 {selected.size}）：</p>
          {persons.length === 0 && (
            <p className="text-xs text-ink-faint">
              你还没有人物。先到「人物」页创建，再回来建世界。
            </p>
          )}
          <ul className="space-y-1.5">
            {persons.map((p) => {
              const checked = selected.has(p.id)
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-ink-line px-3 py-2.5 hover:bg-paper-deep">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelected((s) => {
                          const next = new Set(s)
                          if (next.has(p.id)) next.delete(p.id)
                          else if (next.size < 6) next.add(p.id)
                          return next
                        })
                      }
                    />
                    <span className="text-sm text-ink">{p.name}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={() => setStep('edit')} className="rounded-xl border border-ink-line px-4 py-2 text-sm text-ink-soft">
              上一步
            </button>
            <button
              onClick={() => void submit()}
              disabled={selected.size < 1 || busy}
              className="rounded-xl bg-ink px-5 py-2 text-sm text-white disabled:bg-ink-faint"
            >
              {busy ? '创建中…' : `创建并启动世界`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
