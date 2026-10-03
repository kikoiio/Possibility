import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch, ApiError } from '../api/client'
import type { DistillDraft, PersonDetail as Detail, PersonState, PublicUniverseEvidence, TimelineDetail } from '../api/types'
import StateBar from '../components/StateBar'
import ChatStream from '../components/ChatStream'
import PersonCard from '../components/PersonCard'
import { timelineHref } from '../lib/timelineUrl'
import { timelineDisplayName, timelineOptionLabel } from '../world/timeline-display'
import EvidenceNotice from '../components/world/EvidenceNotice'
import { formatWorldTime } from '../lib/world-time'

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
  const [evidence, setEvidence] = useState<PublicUniverseEvidence | null>(null)

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
      const selected = timelineId ?? d.timelines.find(t => t.parentTimelineId === null)?.id
      if (selected) {
        const t = await apiFetch<TimelineDetail>(`/api/timelines/${selected}`)
        setState(t.state)
        setEvidence(t.evidence)
        if (t.evidence.level === 'complete') {
          const convo = await apiFetch<{ id: string }>(`/api/persons/${id}/conversations`, {
            method: 'POST', body: JSON.stringify({ timelineId: selected }),
          })
          setConversationId(convo.id)
        }
      } else {
        setState(d.state); setEvidence(null)
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
  const returnTimelineId = currentTimeline?.id ?? timelineId
  const returnHref = detail.world && returnTimelineId
    ? timelineHref(`/worlds/${encodeURIComponent(detail.world.id)}`, returnTimelineId)
    : '/people'
  const noWorldReason = '需要先为 TA 创造生活的地方。'

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="border-b border-ink-line bg-sheet px-4 py-3">
        <div className="flex items-center gap-3">
          {detail.world ? (
            <Link to={returnHref} className="text-ink-faint hover:text-ink" aria-label="返回世界">
              ←
            </Link>
          ) : (
            <button type="button" disabled title={noWorldReason} aria-label={`返回世界不可用。${noWorldReason}`} className="cursor-not-allowed text-ink-faint opacity-40">
              ←
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-ink">{detail.person.name}</h1>
            <p className="truncate text-xs text-ink-soft">
              {detail.world?.name}
              {currentTimeline?.parentTimelineId && (
                <span className="ml-2 rounded-full bg-woad-soft px-2 py-0.5 text-woad-deep">
                  What-if：{timelineOptionLabel(currentTimeline)}
                </span>
              )}
            </p>
          </div>
        </div>
        {!detail.world ? (
          <div className="mt-3 rounded-lg border border-ink-line bg-paper px-3 py-3">
            <p className="text-sm font-medium text-ink">TA 还没有生活的地方</p>
            <p className="mt-1 text-xs text-ink-soft">为 TA 创造一个世界，之后即可开始交谈和探索 What-if。</p>
            <Link to={`/worlds/new?person=${encodeURIComponent(detail.person.id)}`} className="mt-3 inline-flex rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white">
              为 TA 创造地方
            </Link>
          </div>
        ) : state && (
          <div className="mt-2">
            <StateBar state={state} timeZone={detail.world?.timeZone} />
          </div>
        )}
        {evidence && <EvidenceNotice evidence={evidence} />}
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
            disabled={key === 'chat' && !detail.world}
            title={key === 'chat' && !detail.world ? noWorldReason : undefined}
            className={`flex-1 py-2.5 text-center ${
              tab === key ? 'border-b-2 border-ink font-medium text-ink' : 'text-ink-soft'
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="bg-red-50 px-4 py-2 text-center text-xs text-red-600">{error}</p>}

      {/* 内容区 */}
      {tab === 'chat' && (!detail.world
        ? <div className="p-8 text-center text-sm text-ink-faint">{noWorldReason}创建地方后即可打电话。</div>
        : evidence?.level !== 'complete'
        ? <div className="p-8 text-center text-sm text-ink-faint">当前时间线的历史证据尚未完整，暂不能发起交谈。</div>
        : (conversationId ? (
          <ChatStream
            key={conversationId}
            conversationId={conversationId}
            withCatchup
            onStateChange={setState}
          />
        ) : (
          <div className="p-8 text-center text-sm text-ink-faint">准备通话…</div>
        )))}

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
                disabled={evidence?.level !== 'complete'}
                className="w-full rounded-xl border border-ink-faint py-2.5 text-ink-soft disabled:opacity-40"
              >
                校正人物卡
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'timelines' && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 pb-6">
          {detail.world && mainTimeline ? (
            <button
              onClick={() => navigate(`/worlds/${detail.world!.id}?timeline=${mainTimeline.id}`)}
              className="w-full rounded-xl border border-dashed border-ink-faint bg-sheet p-4 text-left text-sm text-ink-soft"
            >
              ＋ 创建一个 What-if 分叉…
            </button>
          ) : !detail.world ? (
            <div>
              <button type="button" disabled title={noWorldReason} className="w-full cursor-not-allowed rounded-xl border border-dashed border-ink-faint bg-sheet p-4 text-left text-sm text-ink-soft opacity-50">
                ＋ 创建一个 What-if 分叉…
              </button>
              <p className="mt-1 text-xs text-ink-faint">{noWorldReason}</p>
            </div>
          ) : null}
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
                    {timelineDisplayName(t)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-faint">{t.forkScenario?.whatIf && `假设：${t.forkScenario.whatIf} · `}时间：{formatWorldTime(t.simNow, t.timeZone)}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {detail.world ? (
                    <Link to={`/worlds/${detail.world.id}?timeline=${t.id}`} className="text-xs text-ink-soft underline">
                      世界地图
                    </Link>
                  ) : (
                    <>
                      <button type="button" disabled title={noWorldReason} className="cursor-not-allowed text-xs text-ink-soft underline opacity-40">
                        世界地图
                      </button>
                      <p className="max-w-32 text-right text-xs text-ink-faint">{noWorldReason}</p>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={!detail.world}
                    onClick={() => {
                      setSearchParams(t.parentTimelineId === null ? {} : { timeline: t.id })
                      setTab('chat')
                    }}
                    title={!detail.world ? noWorldReason : undefined}
                    className="text-xs text-ink-soft underline disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    打电话
                  </button>
                  {!detail.world && <p className="max-w-32 text-right text-xs text-ink-faint">{noWorldReason}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
