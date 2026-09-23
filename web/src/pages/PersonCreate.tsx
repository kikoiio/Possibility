import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, ApiError } from '../api/client'
import type { DistillDraft } from '../api/types'
import PersonCard from '../components/PersonCard'

const EXAMPLE = '例如：林晚，32岁，在杭州开一家独立书店，是我大学时的学姐。说话温和但有自己的坚持……'

export default function PersonCreate() {
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState<DistillDraft | null>(null)
  const [manual, setManual] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  async function onDistill(e: FormEvent) {
    e.preventDefault()
    if (!description.trim() || busy) return
    setError('')
    setBusy(true)
    setManual(false)
    try {
      const result = await apiFetch<DistillDraft>('/api/persons/distill', {
        method: 'POST',
        body: JSON.stringify({ description: description.trim() }),
      })
      setDraft(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  function startManualDraft() {
    const blankKnown = () => [{ text: '', provenance: 'known' as const }]
    setError('')
    setManual(true)
    setDraft({
      name: '',
      model: {
        identity: blankKnown(),
        behavior: blankKnown(),
        speech: blankKnown(),
        skills: [],
        memories: [],
        relationships: [],
        boundaries: blankKnown(),
        unknowns: [''],
      },
      worldName: '',
      worldDescription: '',
      initialState: {
        location: '住所',
        activity: '整理思绪，准备开始新生活',
        mood: '平静',
        goal: '在这个世界里找到自己的位置',
      },
    })
  }

  async function onSave() {
    if (!draft || busy) return
    if (!draft.name.trim()) {
      setError('姓名不能为空')
      return
    }
    if (manual) {
      const missing = [
        ['身份与价值观', draft.model.identity],
        ['行为模式', draft.model.behavior],
        ['说话方式', draft.model.speech],
        ['边界', draft.model.boundaries],
      ].filter(([, items]) => !(items as typeof draft.model.identity).some((item) => item.text.trim()))
      if (missing.length) {
        setError(`请至少填写：${missing.map(([label]) => label).join('、')}`)
        return
      }
      if (!draft.model.unknowns.some((item) => item.trim())) {
        setError('请至少写下一项人物目前不知道的事')
        return
      }
    }
    setError('')
    setBusy(true)
    try {
      const res = await apiFetch<{ id: string }>('/api/persons', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      navigate(`/people/${res.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="mb-1 text-xl font-semibold text-ink">创建人物</h1>
      <p className="mb-4 text-sm text-ink-soft">What would you like to make possible?</p>

      {!draft && (
        <div className="space-y-3">
          <form onSubmit={onDistill} className="space-y-3">
            <textarea
              className="h-40 w-full rounded-xl border border-ink-faint p-3 text-base outline-none focus:border-ink-soft"
              placeholder={EXAMPLE}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={busy || !description.trim()}
              className="w-full rounded-xl bg-ink py-2.5 text-white disabled:opacity-50"
            >
              {busy ? '正在根据描述创建人物卡，可能需要一两分钟…' : '生成人物卡'}
            </button>
          </form>
          <button
            type="button"
            onClick={startManualDraft}
            disabled={busy}
            className="text-sm text-ink-soft underline underline-offset-2 disabled:text-ink-faint"
          >
            不调用生成服务，手动填写人物卡
          </button>
          <p className="text-xs text-ink-faint">手工创建时，请补充身份、行为、说话方式、边界，以及人物目前不知道的一件事。</p>
        </div>
      )}

      {draft && (
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            {manual ? '这张人物卡由你手动填写。' : '这是根据你的描述创建的人物卡。'}
            <span className="text-emerald-600">确知</span>来自创建者提供的信息，
            <span className="text-cinnabar">推断</span>是合理推测——都可以修改、删除或补充。
          </p>
          <PersonCard draft={draft} onChange={setDraft} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3 pb-8">
            <button
              onClick={() => {
                setDraft(null)
                setManual(false)
              }}
              disabled={busy}
              className="flex-1 rounded-xl border border-ink-faint py-2.5 text-ink-soft disabled:opacity-50"
            >
              重新描述
            </button>
            <button
              onClick={onSave}
              disabled={busy}
              className="flex-1 rounded-xl bg-ink py-2.5 text-white disabled:opacity-50"
            >
              {busy ? '保存中…' : manual ? '确认创建人物' : '确认创建这个 Version'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
