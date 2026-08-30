import { useState } from 'react'
import type { DialogueDetail, WorldEventItem } from '../../api/types'
import DialogueView from './DialogueView'
import { AvatarChip, personColor } from '../../lib/personColor'

interface LiveTurn {
  turnIndex: number
  personId: string
  utterance: string
  thought: string
  simTime: string
}

interface Props {
  events: WorldEventItem[]
  names: Map<string, string>
  turnsByDialogue: Record<string, LiveTurn[]>
  expandedDialogue: { id: string; detail: DialogueDetail | null } | null
  onToggleDialogue: (dialogueId: string) => void
}

function fmtDay(iso: string): string {
  return `${iso.slice(5, 7)} 月 ${iso.slice(8, 10)} 日`
}

function fmtTime(iso: string): string {
  return iso.slice(11, 16)
}

/** 事件流：日期分隔 + 人物头像色块 / 行动卡片 / 对话卡片（可展开逐句）/ 世界事件 / 系统 */
export default function WorldEventFeed({ events, names, turnsByDialogue, expandedDialogue, onToggleDialogue }: Props) {
  const sorted = [...events].sort((a, b) => a.simTime.localeCompare(b.simTime))
  const nodes: React.ReactNode[] = []
  let lastDay = ''

  sorted.forEach((ev) => {
    const day = ev.simTime.slice(0, 10)
    if (day !== lastDay) {
      lastDay = day
      nodes.push(
        <div key={`day-${day}`} className="flex items-center gap-3 px-1 py-2.5">
          <div className="h-px flex-1 bg-ink-line" />
          <span className="font-story text-xs tracking-widest text-ink-faint">{fmtDay(ev.simTime)}</span>
          <div className="h-px flex-1 bg-ink-line" />
        </div>,
      )
    }

    if (ev.kind === 'injected') {
      nodes.push(
        <div key={ev.id} className="animate-fade-in-up relative rounded-xl border border-cinnabar/40 bg-cinnabar-soft px-3 py-2.5 pl-12">
          <span className="absolute left-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-cinnabar text-[11px] text-white">世</span>
          <p className="text-[11px] text-cinnabar/80">{fmtTime(ev.simTime)} · 世界事件</p>
          <p className="font-story mt-0.5 text-sm font-semibold text-cinnabar-deep">{ev.title}</p>
          {ev.description && (
            <p className="font-story mt-0.5 text-[13px] leading-relaxed text-cinnabar-deep/80">{ev.description}</p>
          )}
        </div>,
      )
      return
    }

    if (ev.kind === 'dialogue' && ev.dialogueId) {
      const expanded = expandedDialogue?.id === ev.dialogueId
      const liveTurns = turnsByDialogue[ev.dialogueId] ?? []
      const preview =
        ev.dialoguePreview ?? liveTurns.slice(0, 2).map((t) => ({ personName: names.get(t.personId) ?? '某人', utterance: t.utterance }))
      const speakerId = ev.actorPersonId ?? liveTurns[0]?.personId ?? null
      nodes.push(
        <div key={ev.id} className="animate-fade-in-up relative rounded-xl border border-woad/30 bg-woad-soft/60 px-3 py-2.5 pl-12">
          {speakerId && <AvatarChip personId={speakerId} name={names.get(speakerId) ?? ''} className="absolute left-3 top-3 h-6 w-6 text-[11px]" />}
          {!speakerId && <span className="absolute left-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-woad text-[11px] text-white">言</span>}
          <button onClick={() => onToggleDialogue(ev.dialogueId!)} className="w-full text-left">
            <p className="text-[11px] text-woad/80">
              {fmtTime(ev.simTime)} · 对话 {expanded ? '▾' : '▸'}
            </p>
            <p className="font-story mt-0.5 text-sm font-semibold text-ink">{ev.title}</p>
            {!expanded &&
              preview.map((t, i) => (
                <p key={i} className="font-story mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">
                  {t.utterance}
                </p>
              ))}
          </button>
          {expanded && <DialogueView detail={expandedDialogue?.detail ?? null} liveTurns={liveTurns} names={names} />}
        </div>,
      )
      return
    }

    if (ev.kind === 'system') {
      nodes.push(
        <div key={ev.id} className="animate-fade-in-up px-3 py-1 text-center text-[11px] tracking-wide text-ink-faint">
          {fmtTime(ev.simTime)} · {ev.title}
        </div>,
      )
      return
    }

    nodes.push(<ActionEventCard key={ev.id} ev={ev} names={names} />)
  })

  return (
    <div className="space-y-2">
      <h2 className="px-1 font-story text-sm font-semibold tracking-widest text-ink-soft">事件流</h2>
      {sorted.length === 0 && (
        <p className="font-story rounded-xl border border-dashed border-ink-line bg-sheet p-8 text-center text-sm text-ink-faint">
          世界还静悄悄的。
        </p>
      )}
      {nodes}
    </div>
  )
}

/** 行动事件卡片：头像色块 + 标题 + 描述（长文折叠） */
function ActionEventCard({ ev, names }: { ev: WorldEventItem; names: Map<string, string> }) {
  const [expanded, setExpanded] = useState(false)
  const actorId = ev.actorPersonId
  const actorName = ev.actorName ?? (actorId ? names.get(actorId) : null) ?? null
  const color = actorId ? personColor(actorId) : '#a79c8c'
  const long = (ev.description ?? '').length > 84

  return (
    <article className="animate-fade-in-up relative rounded-xl border border-ink-line bg-sheet px-3 py-2.5 pl-12">
      {actorId && actorName ? (
        <AvatarChip personId={actorId} name={actorName} className="absolute left-3 top-3 h-6 w-6 text-[11px]" />
      ) : (
        <span className="absolute left-3 top-3 h-6 w-6 rounded-full bg-paper-deep" />
      )}
      <p className="text-[11px] text-ink-faint">
        {fmtTime(ev.simTime)}
        {actorName && (
          <span className="font-medium" style={{ color }}>
            {' '}
            · {actorName}
          </span>
        )}
      </p>
      <p className="font-story mt-0.5 text-sm font-semibold text-ink">{ev.title}</p>
      {ev.description && (
        <>
          <p className={`font-story mt-1 text-[13px] leading-relaxed text-ink-soft ${expanded ? '' : 'line-clamp-3'}`}>{ev.description}</p>
          {long && (
            <button onClick={() => setExpanded((v) => !v)} className="mt-0.5 text-[11px] text-ink-faint hover:text-ink-soft">
              {expanded ? '收起' : '展开全文'}
            </button>
          )}
        </>
      )}
    </article>
  )
}
