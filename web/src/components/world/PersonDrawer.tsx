import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PersonFocus } from '../../api/types'
import { memoriesApi } from '../../api/client'
import { AvatarChip } from '../../lib/personColor'
import { timelineHref } from '../../lib/timelineUrl'

interface PersonLiveState {
  simTime: string
  location: string
  activity: string
  mood: string
  goal: string
  currentDialogueId: string | null
}

interface Props {
  focus: PersonFocus | null
  loading: boolean
  liveState: PersonLiveState | null
  fallbackName: string
  personId?: string
  canChat: boolean
  canEditMemories: boolean
  timelineId: string
  expectedVersion: number
  defaultTab?: Tab
  onClose: () => void
  /** 记忆被校正/删除后通知父组件刷新 */
  onMemoriesChanged?: () => void
}

type Tab = 'thoughts' | 'schedule' | 'memories'

/** 人物抽屉：当前状态 + 想法流 / 今日日程 / 记忆（可审计：校正与删除，F12） */
export default function PersonDrawer({ focus, loading, liveState, fallbackName, personId, canChat, canEditMemories, timelineId, expectedVersion, defaultTab = 'thoughts', onClose, onMemoriesChanged }: Props) {
  const [tab, setTab] = useState<Tab>(defaultTab)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editError, setEditError] = useState('')
  const pendingCommands = useRef(new Map<string, string>())
  const name = focus?.person.name ?? fallbackName
  const state = liveState ?? focus?.state ?? null
  const id = focus?.person.id ?? personId ?? ''

  const commandId = (key: string) => {
    const existing = pendingCommands.current.get(key)
    if (existing) return existing
    const next = crypto.randomUUID()
    pendingCommands.current.set(key, next)
    return next
  }

  const startEdit = (memoryId: string, content: string) => {
    setEditError('')
    setEditingId(memoryId)
    setDraft(content)
  }

  const saveEdit = async (memory: PersonFocus['memories'][number]) => {
    if (!draft.trim() || busyId || !id) return
    const memoryId = memory.id
    setBusyId(memoryId)
    setEditError('')
    try {
      await memoriesApi.update(memoryId, { content: draft.trim(), personId: id, timelineId, expectedVersion,
        commandId: commandId(`correct:${memoryId}`), before: { type: memory.type, content: memory.content,
          importance: memory.importance, simTime: memory.simTime, createdAt: memory.createdAt, summarized: memory.summarized } })
      setEditingId(null)
      pendingCommands.current.delete(`correct:${memoryId}`)
      onMemoriesChanged?.()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusyId(null)
    }
  }

  const removeMemory = async (memory: PersonFocus['memories'][number]) => {
    if (busyId || !id) return
    const memoryId = memory.id
    setBusyId(memoryId)
    setEditError('')
    try {
      await memoriesApi.remove(memoryId, { personId: id, timelineId, expectedVersion,
        commandId: commandId(`forget:${memoryId}`), before: { type: memory.type, content: memory.content,
          importance: memory.importance, simTime: memory.simTime, createdAt: memory.createdAt, summarized: memory.summarized } })
      pendingCommands.current.delete(`forget:${memoryId}`)
      onMemoriesChanged?.()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <aside className="flex w-80 shrink-0 animate-slide-in-right flex-col border-l border-ink-line bg-sheet">
      <div className="flex items-center justify-between border-b border-ink-line/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {id && <AvatarChip personId={id} name={name} className="h-8 w-8 text-sm" />}
          <h3 className="font-story truncate text-base font-semibold text-ink">{name}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {canChat && id && <Link
            to={timelineHref(`/people/${encodeURIComponent(id)}`, timelineId)}
            className="text-xs text-ink-soft transition-colors hover:text-ink"
            aria-label={`与${name}普通聊天`}
          >
            普通聊天
          </Link>}
          <button onClick={onClose} className="text-xs text-ink-faint transition-colors hover:text-ink-soft">
            关闭
          </button>
        </div>
      </div>

      {/* 状态卡 */}
      <div className="border-b border-ink-line/60 px-4 py-3">
        {state ? (
          <dl className="grid grid-cols-[3.5rem_1fr] gap-y-1.5 text-xs">
            <dt className="text-ink-faint">地点</dt>
            <dd className="font-story text-ink-soft">{state.location}</dd>
            <dt className="text-ink-faint">活动</dt>
            <dd className="font-story text-ink-soft">{state.activity}</dd>
            <dt className="text-ink-faint">情绪</dt>
            <dd>
              <span className="font-story rounded-lg bg-paper-deep px-2 py-0.5 leading-relaxed text-ink-soft">{state.mood}</span>
            </dd>
            <dt className="text-ink-faint">目标</dt>
            <dd className="font-story text-ink-soft">{state.goal}</dd>
            {state.currentDialogueId && (
              <>
                <dt className="text-ink-faint">此刻</dt>
                <dd className="flex items-center gap-1.5 text-woad">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-woad" />
                  正在交谈
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-xs text-ink-faint">{loading ? '加载中…' : '暂无状态'}</p>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-ink-line/60 text-xs">
        {(
          [
            ['thoughts', '想法流'],
            ['schedule', '今日日程'],
            ['memories', '记忆'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 py-2 text-center transition-colors ${
              tab === key ? 'border-b-2 border-cinnabar font-medium text-ink' : 'text-ink-faint hover:text-ink-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && <p className="text-xs text-ink-faint">加载中…</p>}
        {!loading && tab === 'thoughts' && (
          <ul className="space-y-2.5">
            {(focus?.thoughts ?? []).map((t) => (
              <li key={t.id} className="font-story text-[13px] leading-relaxed text-ink-soft">
                <span className="mr-1 text-[11px] text-ink-faint/80">{t.simTime ? t.simTime.slice(5, 16).replace('T', ' ') : ''}</span>
                {t.content}
              </li>
            ))}
            {(focus?.thoughts ?? []).length === 0 && <p className="text-xs text-ink-faint">还没有想法。</p>}
          </ul>
        )}
        {!loading && tab === 'schedule' && (
          <ul className="space-y-1.5">
            {(focus?.schedule ?? []).map((it, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span className="shrink-0 text-ink-faint">
                  {it.start}-{it.end}
                </span>
                <span className="font-story text-ink-soft">
                  <span className="font-semibold">{it.location}</span> {it.activity}
                  {it.kind === 'sleep' && <span className="ml-1 text-ink-faint">（睡眠）</span>}
                </span>
              </li>
            ))}
            {!focus?.schedule && <p className="text-xs text-ink-faint">今日日程尚未生成。</p>}
          </ul>
        )}
        {!loading && tab === 'memories' && (
          <div className="space-y-2.5">
            {editError && <p className="text-xs text-red-600">{editError}</p>}
            <p className="text-[11px] leading-relaxed text-ink-faint">
              {canEditMemories
                ? '这是 TA 真正记住的事——校正会影响后续决策，删除后 TA 就会忘掉。'
                : '这里展示 TA 当前记得的事；观察与在场模式下只能查看。'}
            </p>
            {(focus?.memories ?? []).map((m) =>
              canEditMemories && editingId === m.id ? (
                <div key={m.id} className="space-y-1.5">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-ink-faint bg-paper px-2 py-1.5 font-story text-[13px] text-ink-soft outline-none focus:border-ink-soft"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => void saveEdit(m)}
                      disabled={busyId === m.id || !draft.trim()}
                      className="rounded bg-ink px-2.5 py-1 text-[11px] text-white disabled:opacity-50"
                    >
                      {busyId === m.id ? '保存中…' : '保存'}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded border border-ink-faint px-2.5 py-1 text-[11px] text-ink-soft"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="group flex items-start gap-1.5">
                  <p className="font-story min-w-0 flex-1 text-[13px] leading-relaxed text-ink-soft">
                    <span className="mr-1 rounded bg-paper-deep px-1.5 py-0.5 text-[10px] text-ink-faint">{m.type}</span>
                    {m.content}
                  </p>
                  {canEditMemories && !m.summarized && m.type !== 'summary' && <>
                    <button
                      onClick={() => startEdit(m.id, m.content)}
                      title="校正这条记忆"
                      className="shrink-0 text-[11px] text-ink-faint opacity-0 transition-opacity hover:text-ink-soft group-hover:opacity-100"
                    >
                      改
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm('删除后 TA 会立刻忘掉这件事，确定？')) void removeMemory(m)
                      }}
                      title="删除这条记忆"
                      className="shrink-0 text-[11px] text-ink-faint opacity-0 transition-opacity hover:text-cinnabar group-hover:opacity-100"
                    >
                      删
                    </button>
                  </>}
                </div>
              ),
            )}
            {(focus?.memories ?? []).length === 0 && <p className="text-xs text-ink-faint">还没有记忆。</p>}
          </div>
        )}
      </div>
    </aside>
  )
}
