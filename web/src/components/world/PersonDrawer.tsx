import { useState } from 'react'
import type { PersonFocus } from '../../api/types'
import { AvatarChip } from '../../lib/personColor'

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
  onClose: () => void
}

type Tab = 'thoughts' | 'schedule' | 'memories'

/** 人物抽屉：当前状态 + 想法流 / 今日日程 / 记忆摘要（世界内不可对话，F12） */
export default function PersonDrawer({ focus, loading, liveState, fallbackName, personId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('thoughts')
  const name = focus?.person.name ?? fallbackName
  const state = liveState ?? focus?.state ?? null
  const id = focus?.person.id ?? personId ?? ''

  return (
    <aside className="flex w-80 shrink-0 animate-slide-in-right flex-col border-l border-ink-line bg-sheet">
      <div className="flex items-center justify-between border-b border-ink-line/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {id && <AvatarChip personId={id} name={name} className="h-8 w-8 text-sm" />}
          <h3 className="font-story truncate text-base font-semibold text-ink">{name}</h3>
        </div>
        <button onClick={onClose} className="shrink-0 text-xs text-ink-faint transition-colors hover:text-ink-soft">
          关闭
        </button>
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
          <ul className="space-y-2.5">
            {(focus?.memories ?? []).map((m) => (
              <li key={m.id} className="font-story text-[13px] leading-relaxed text-ink-soft">
                <span className="mr-1 rounded bg-paper-deep px-1.5 py-0.5 text-[10px] text-ink-faint">{m.type}</span>
                {m.content}
              </li>
            ))}
            {(focus?.memories ?? []).length === 0 && <p className="text-xs text-ink-faint">还没有记忆。</p>}
          </ul>
        )}
      </div>
    </aside>
  )
}
