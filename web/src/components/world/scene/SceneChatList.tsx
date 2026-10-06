import type { RefObject } from 'react'
import type { PersonaMention, PersonaMessage } from '../../../api/types'
import { formatWorldTime } from '../../../lib/world-time'

export interface SceneChatMessage {
  role: 'user' | 'person' | 'system'
  name: string
  text: string
}

export interface SceneChatListProps {
  listRef: RefObject<HTMLDivElement | null>
  notes: { messages: PersonaMessage[]; mentions: PersonaMention[] } | null
  timeZone?: string | null
  personaName: string
  messages: SceneChatMessage[]
  busy: boolean
}

export default function SceneChatList({
  listRef,
  notes,
  timeZone,
  personaName,
  messages,
  busy,
}: SceneChatListProps) {
  return (
    <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      {notes && (notes.messages.length > 0 || notes.mentions.length > 0) && (
        <section className="rounded-xl border border-ink-line/70 bg-sheet px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-ink-soft">自你上次离开后，世界没有忘记你</h3>
          {notes.messages.map((m) => (
            <div key={m.id} className="mb-2 last:mb-0">
              <p className="text-[11px] text-ink-faint">
                {m.fromName} 在{m.location ? ` ${m.location} ` : ''}给你留了话 · {formatWorldTime(m.simTime, timeZone)}
              </p>
              <p className="font-story mt-0.5 text-sm leading-relaxed text-ink">{m.content}</p>
            </div>
          ))}
          {notes.mentions.slice(0, 6).map((e) => (
            <p key={e.id} className="mt-1.5 text-xs leading-relaxed text-ink-faint">
              <span className="text-ink-soft">
                {e.actorName && !e.title.startsWith(e.actorName) ? `${e.actorName}：` : ''}
                {e.title}
              </span>
              {e.description ? `——${e.description.slice(0, 40)}` : ''}
            </p>
          ))}
        </section>
      )}
      {messages.length === 0 && (
        <p className="pt-16 text-center text-sm leading-relaxed text-ink-faint">
          以 {personaName} 的身份说点什么。
          <br />
          在场的人会听见，并记住这场相遇。
        </p>
      )}
      {messages.map((m, i) =>
        m.role === 'system' ? (
          <p key={i} className="text-center text-[11px] tracking-wide text-ink-faint">
            {m.text}
          </p>
        ) : (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[80%] ${m.role === 'user' ? 'text-right' : ''}`}>
              {m.role === 'person' && <p className="mb-0.5 text-[11px] text-ink-faint">{m.name}</p>}
              <p
                className={`font-story inline-block whitespace-pre-wrap rounded-xl px-3.5 py-2 text-left text-[15px] leading-relaxed ${
                  m.role === 'user' ? 'bg-ink text-paper' : 'bg-paper-deep text-ink'
                }`}
              >
                {m.text}
              </p>
            </div>
          </div>
        ),
      )}
      {busy && <p className="text-xs text-ink-faint">在场的人转过头来…</p>}
    </div>
  )
}
