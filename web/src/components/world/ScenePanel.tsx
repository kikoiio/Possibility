import { useCallback, useEffect, useRef, useState } from 'react'
import { personaApi, sceneApi } from '../../api/client'
import type { Persona, PersonaMention, PersonaMessage, SceneEvent } from '../../api/types'

interface Props {
  worldId: string
  timelineId: string
  locations: { name: string; description: string }[]
  onClose: () => void
}

interface Msg {
  role: 'user' | 'person' | 'system'
  name: string
  text: string
}

/**
 * 你在世界里：用户以登记过的在场身份来到某地点说话，
 * 在场的人物依次回应。这场相遇会写进世界史（事件流）与每个人的记忆。
 */
export default function ScenePanel({ worldId, timelineId, locations, onClose }: Props) {
  const [persona, setPersona] = useState<Persona | null>(null)
  const [personaLoading, setPersonaLoading] = useState(true)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [location, setLocation] = useState('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<{ messages: PersonaMessage[]; mentions: PersonaMention[] } | null>(null)
  /** 各地点可交谈人数（清醒且空闲；null = 尚未载回） */
  const [board, setBoard] = useState<Record<string, number> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    personaApi
      .get(worldId)
      .then((d) => {
        setPersona(d.persona)
        if (d.persona) {
          setName(d.persona.name)
          setDescription(d.persona.description)
          // 世界记得你：未读留言 + 与你有关的动静（送达即标记已读）
          personaApi
            .messages(worldId)
            .then(setNotes)
            .catch(() => {})
          // 可交谈地点看板（人数随世界运转变化，进入面板时拉一次）
          sceneApi
            .board(worldId)
            .then((b) => setBoard(Object.fromEntries(b.board.map((x) => [x.location, x.count]))))
            .catch(() => {})
        }
      })
      .catch(() => setError('身份加载失败'))
      .finally(() => setPersonaLoading(false))
  }, [worldId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const handleSavePersona = async () => {
    setSaving(true)
    setError('')
    try {
      const d = await personaApi.upsert(worldId, { name: name.trim(), description: description.trim() })
      setPersona(d.persona)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSend = useCallback(async () => {
    const content = input.trim()
    if (!content || busy || !persona) return
    setInput('')
    setError('')
    setBusy(true)
    setMessages((prev) => [...prev, { role: 'user', name: persona.name, text: content }])
    try {
      await sceneApi.send(worldId, { timelineId, location: location || undefined, content }, (raw) => {
        const ev = raw as SceneEvent
        if (ev.type === 'scene_start') {
          setMessages((prev) => [...prev, { role: 'system', name: '', text: `在${ev.location}——${ev.participants.join('、')} 在场` }])
        } else if (ev.type === 'utterance') {
          setMessages((prev) => [...prev, { role: 'person', name: ev.name, text: ev.text }])
        } else if (ev.type === 'error') {
          setError(ev.message)
        }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '交谈失败')
    } finally {
      setBusy(false)
      // 人数随世界运转变化，每次交谈后刷新看板
      sceneApi
        .board(worldId)
        .then((b) => setBoard(Object.fromEntries(b.board.map((x) => [x.location, x.count]))))
        .catch(() => {})
    }
  }, [input, busy, persona, worldId, timelineId, location])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div
        className="flex h-[80vh] w-full max-w-xl flex-col rounded-2xl border border-ink-line bg-paper shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-line/60 px-5 py-3">
          <h2 className="font-story text-lg font-semibold text-ink">进入世界</h2>
          <button onClick={onClose} className="text-xs text-ink-faint transition-colors hover:text-ink-soft">
            关闭
          </button>
        </div>

        {error && <p className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-600">{error}</p>}

        {personaLoading ? (
          <p className="p-5 text-sm text-ink-faint">加载中…</p>
        ) : !persona ? (
          /* 首次：登记在场身份 */
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-6">
            <p className="text-sm leading-relaxed text-ink-soft">
              不再只是隔着玻璃观看——在世界中登记一个身份，走进去。 这里的人会真实地看见你、回应你、记住你；
              你说的话会写进世界史，出现在章节里。
            </p>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-faint">你在这里的名字</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={20}
                placeholder="例如：阿透"
                className="w-full rounded-lg border border-ink-line bg-sheet px-3 py-2 text-sm text-ink outline-none focus:border-ink-faint"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-faint">你以什么身份来到这里（他们会据此认识你）</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                rows={4}
                placeholder="例如：一位来泡汤的旅人，喜欢听故事，随身带着一台相机。"
                className="w-full rounded-lg border border-ink-line bg-sheet px-3 py-2 text-sm text-ink outline-none focus:border-ink-faint"
              />
            </label>
            <button
              onClick={handleSavePersona}
              disabled={saving || !name.trim() || !description.trim()}
              className="rounded-lg bg-ink px-4 py-2 text-xs text-white disabled:opacity-50"
            >
              {saving ? '落籍中…' : '落籍，进入世界'}
            </button>
          </div>
        ) : (
          <>
            {/* 已落籍：到场交谈 */}
            <div className="flex items-center gap-2 border-b border-ink-line/60 px-5 py-2.5">
              <span className="text-xs text-ink-faint">此刻你在</span>
              <select
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs text-ink-soft outline-none"
              >
                <option value="">人最多的地方</option>
                {locations.map((l) => {
                  const count = board?.[l.name]
                  return (
                    <option key={l.name} value={l.name} disabled={count === 0}>
                      {l.name}
                      {count != null ? (count > 0 ? `（${count} 人可交谈）` : '（都在忙或睡着）') : ''}
                    </option>
                  )
                })}
              </select>
              <span className="ml-auto text-xs text-ink-faint">
                你是 <span className="font-story text-ink-soft">{persona.name}</span>
              </span>
            </div>

            <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {notes && (notes.messages.length > 0 || notes.mentions.length > 0) && (
                <section className="rounded-xl border border-ink-line/70 bg-sheet px-4 py-3">
                  <h3 className="mb-2 text-xs font-medium text-ink-soft">自你上次离开后，世界没有忘记你</h3>
                  {notes.messages.map((m) => (
                    <div key={m.id} className="mb-2 last:mb-0">
                      <p className="text-[11px] text-ink-faint">
                        {m.fromName} 在{m.location ? ` ${m.location} ` : ''}给你留了话 · {m.simTime.slice(5, 16).replace('T', ' ')}
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
                  以 {persona.name} 的身份说点什么。
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

            <div className="flex items-end gap-2 border-t border-ink-line/60 px-4 py-3">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
                rows={2}
                placeholder="开口说话…（Enter 发送，Shift+Enter 换行）"
                className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-ink-line bg-sheet px-3 py-2 text-sm text-ink outline-none focus:border-ink-faint"
              />
              <button
                onClick={() => void handleSend()}
                disabled={busy || !input.trim()}
                className="rounded-lg bg-ink px-4 py-2 text-xs text-white disabled:opacity-50"
              >
                说
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
