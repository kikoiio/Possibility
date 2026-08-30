import { useState } from 'react'
import type { DialogueDetail } from '../../api/types'
import { personColor } from '../../lib/personColor'

interface LiveTurn {
  turnIndex: number
  personId: string
  utterance: string
  thought: string
  simTime: string
}

interface Props {
  detail: DialogueDetail | null
  liveTurns: LiveTurn[]
  names: Map<string, string>
}

/** 逐句对话：气泡 + 每句内心想法（折叠）；进行中的对话随流递增 */
export default function DialogueView({ detail, liveTurns, names }: Props) {
  const [showThoughts, setShowThoughts] = useState(false)

  // 合并：详情 turns + 流里尚未入库的新 turns（按 turnIndex 去重）
  const merged = new Map<
    number,
    { personId: string | null; personName: string; utterance: string; thought: string; simTime: string }
  >()
  for (const t of detail?.turns ?? []) {
    merged.set(t.turnIndex, { personId: null, personName: t.personName, utterance: t.utterance, thought: t.thought, simTime: t.simTime })
  }
  for (const t of liveTurns) {
    if (!merged.has(t.turnIndex)) {
      merged.set(t.turnIndex, {
        personId: t.personId,
        personName: names.get(t.personId) ?? '某人',
        utterance: t.utterance,
        thought: t.thought,
        simTime: t.simTime,
      })
    }
  }
  const turns = [...merged.entries()].sort((a, b) => a[0] - b[0])
  // 用名字在流里反查不到 id 时退回按名字着色（详情接口只有名字）
  const colorByName = new Map<string, string>()
  for (const t of liveTurns) colorByName.set(names.get(t.personId) ?? '', personColor(t.personId))

  return (
    <div className="mt-2 border-t border-woad/20 pt-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-ink-faint">
          {detail
            ? `${detail.dialogue.participants.map((p) => p.name).join(' 与 ')} · ${detail.dialogue.status === 'ongoing' ? '交谈中' : '已结束'}`
            : '加载中…'}
        </p>
        <button onClick={() => setShowThoughts((v) => !v)} className="text-[11px] text-woad hover:text-woad-deep">
          {showThoughts ? '收起想法' : '显示想法'}
        </button>
      </div>
      <ul className="mt-2 space-y-2.5">
        {turns.map(([idx, t]) => {
          const color = t.personId ? personColor(t.personId) : colorByName.get(t.personName) ?? '#46618c'
          return (
            <li key={idx} className="animate-fade-in-up">
              <p className="text-[11px] font-medium" style={{ color }}>
                {t.personName}
              </p>
              <p className="font-story mt-0.5 rounded-lg rounded-tl-none border border-ink-line bg-sheet px-3 py-1.5 text-sm leading-relaxed text-ink">
                {t.utterance}
              </p>
              {showThoughts && t.thought && (
                <p className="font-story mt-1 px-1 text-xs italic leading-relaxed text-ink-faint">（{t.thought}）</p>
              )}
            </li>
          )
        })}
        {turns.length === 0 && <li className="text-xs text-ink-faint">还没有发言。</li>}
      </ul>
    </div>
  )
}
