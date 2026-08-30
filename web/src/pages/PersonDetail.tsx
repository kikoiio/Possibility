import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch, ApiError } from '../api/client'
import type { DistillDraft, PersonDetail as Detail, PersonState, TimelineDetail } from '../api/types'
import StateBar from '../components/StateBar'
import ChatStream from '../components/ChatStream'
import PersonCard from '../components/PersonCard'

type Tab = 'chat' | 'card' | 'timelines'

export default function PersonDetail() {
  const { id } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const timelineId = searchParams.get('timeline') // null = 主线

  const [detail, setDetail] = useState<Detail | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [state, setState] = useState<PersonState | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  const [error, setError] = useState('')

  const [cardDraft, setCardDraft] = useState<DistillDraft | null>(null)
  const [cardEditing, setCardEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setError('')
    setConversationId(null)
    try {
      const d = await apiFetch<Detail>(`/api/persons/${id}`)
      setDetail(d)
      const convo = await apiFetch<{ id: string }>(`/api/persons/${id}/conversations`, {
        method: 'POST',
        body: JSON.stringify({ timelineId: timelineId ?? null }),
      })
      setConversationId(convo.id)
      if (timelineId) {
        const t = await apiFetch<TimelineDetail>(`/api/timelines/${timelineId}`)
        setState(t.state)
      } else {
        setState(d.state)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败')
    }
  }, [id, timelineId])

  useEffect(() => {
    load()
  }, [load])

  function startEditCard() {
    if (!detail) return
    setCardDraft({
      name: detail.person.name,
      model: detail.person.model,
      worldName: detail.world?.name ?? '',
      worldDescription: detail.world?.description ?? '',
      initialState: state ?? { location: '', activity: '', mood: '', goal: '' },
    })
    setCardEditing(true)
  }

  async function saveCard() {
    if (!cardDraft || !id || saving) return
    setSaving(true)
    try {
      await apiFetch(`/api/persons/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: cardDraft.name, model: cardDraft.model }),
      })
      setCardEditing(false)
      await load()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (error && !detail) {
    return <div className="p-8 text-center text-sm text-red-600">{error}</div>
  }
  if (!detail) {
    return <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>
  }

  const mainTimeline = detail.timelines.find((t) => t.parentTimelineId === null)
  const currentTimeline = timelineId
    ? detail.timelines.find((t) => t.id === timelineId)
    : mainTimeline

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="border-b border-ink-line bg-sheet px-4 py-3">
        <div className="flex items-center gap-3">
          <Link to="/people" className="text-ink-faint hover:text-ink" aria-label="返回">
            ←
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-ink">{detail.person.name}</h1>
            <p className="truncate text-xs text-ink-soft">
              {detail.world?.name}
              {currentTimeline?.parentTimelineId && (
                <span className="ml-2 rounded-full bg-woad-soft px-2 py-0.5 text-woad-deep">
                  What-if：{currentTimeline.forkScenario?.whatIf ?? '分叉'}
                </span>
              )}
            </p>
          </div>
        </div>
        {state && (
          <div className="mt-2">
            <StateBar state={state} />
          </div>
        )}
      </div>

      {/* 标签页 */}
      <div className="flex border-b border-ink-line bg-sheet text-sm">
        {(
          [
            ['chat', '打电话'],
            ['card', '人物卡'],
            ['timelines', '时间线'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 py-2.5 text-center ${
              tab === key ? 'border-b-2 border-ink font-medium text-ink' : 'text-ink-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="bg-red-50 px-4 py-2 text-center text-xs text-red-600">{error}</p>}

      {/* 内容区 */}
      {tab === 'chat' &&
        (conversationId ? (
          <ChatStream
            key={conversationId}
            conversationId={conversationId}
            withCatchup
            onStateChange={setState}
          />
        ) : (
          <div className="p-8 text-center text-sm text-ink-faint">准备通话…</div>
        ))}

      {tab === 'card' && (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {cardEditing && cardDraft ? (
            <div className="space-y-4 pb-6">
              <PersonCard draft={cardDraft} onChange={setCardDraft} />
              <div className="flex gap-3">
                <button
                  onClick={() => setCardEditing(false)}
                  className="flex-1 rounded-xl border border-ink-faint py-2.5 text-ink-soft"
                >
                  取消
                </button>
                <button
                  onClick={saveCard}
                  disabled={saving}
                  className="flex-1 rounded-xl bg-ink py-2.5 text-white disabled:opacity-50"
                >
                  {saving ? '保存中…' : '保存修改'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 pb-6">
              <PersonCard
                draft={{
                  name: detail.person.name,
                  model: detail.person.model,
                  worldName: detail.world?.name ?? '',
                  worldDescription: detail.world?.description ?? '',
                  initialState: state ?? { location: '', activity: '', mood: '', goal: '' },
                }}
              />
              <button
                onClick={startEditCard}
                className="w-full rounded-xl border border-ink-faint py-2.5 text-ink-soft"
              >
                校正人物卡
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'timelines' && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 pb-6">
          {mainTimeline && (
            <button
              onClick={() => navigate(`/timelines/${mainTimeline.id}`)}
              className="w-full rounded-xl border border-dashed border-ink-faint bg-sheet p-4 text-left text-sm text-ink-soft"
            >
              ＋ 创建一个 What-if 分叉…
            </button>
          )}
          {detail.timelines.map((t) => (
            <div key={t.id} className="rounded-xl border border-ink-line bg-sheet p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  {t.parentTimelineId === null ? (
                    <span className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft">主线</span>
                  ) : (
                    <span className="rounded-full bg-woad-soft px-2 py-0.5 text-xs text-woad-deep">What-if</span>
                  )}
                  <p className="mt-1 truncate text-sm text-ink">
                    {t.parentTimelineId === null ? '现实这条线' : t.forkScenario?.whatIf}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-faint">时间：{t.simNow.slice(0, 16).replace('T', ' ')}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Link to={`/timelines/${t.id}`} className="text-xs text-ink-soft underline">
                    事件流
                  </Link>
                  <button
                    onClick={() => {
                      setSearchParams(t.parentTimelineId === null ? {} : { timeline: t.id })
                      setTab('chat')
                    }}
                    className="text-xs text-ink-soft underline"
                  >
                    打电话
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
