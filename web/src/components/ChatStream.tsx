import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, postSSE } from '../api/client'
import type { Message, PersonState } from '../api/types'

interface ChatStreamProps {
  conversationId: string
  /** 打开时先跑懒惰追赶（T18）；分叉对话可关 */
  withCatchup?: boolean
  onStateChange?: (state: PersonState) => void
}

interface LocalNote {
  id: string
  kind: 'memory' | 'error'
  text: string
}

/** 对话流：历史 + 流式回复 + 追赶摘要（F6/F7/F8） */
export default function ChatStream({ conversationId, withCatchup = true, onStateChange }: ChatStreamProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [notes, setNotes] = useState<LocalNote[]>([])
  const [streaming, setStreaming] = useState('')
  const [phase, setPhase] = useState<'loading' | 'catchup' | 'ready'>('loading')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const streamedRef = useRef('')

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming, notes, phase])

  const pushNote = useCallback((kind: LocalNote['kind'], text: string) => {
    setNotes((ns) => [...ns, { id: crypto.randomUUID(), kind, text }])
  }, [])

  // 打开对话：先追赶（T18），再载历史
  useEffect(() => {
    let cancelled = false
    setMessages([])
    setNotes([])
    setStreaming('')
    setPhase(withCatchup ? 'catchup' : 'loading')

    const load = async () => {
      if (withCatchup) {
        await postSSE(`/api/conversations/${conversationId}/catchup`, {}, (ev) => {
          if (cancelled) return
          if (ev.type === 'text') {
            streamedRef.current += ev.delta
            setStreaming(streamedRef.current)
          } else if (ev.type === 'state') {
            onStateChange?.(ev.state)
          } else if (ev.type === 'error') {
            pushNote('error', ev.message)
          }
        })
        streamedRef.current = ''
        setStreaming('')
      }
      if (cancelled) return
      const res = await apiFetch<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages`)
      if (cancelled) return
      setMessages(res.messages)
      setPhase('ready')
    }
    load().catch(() => {
      if (!cancelled) {
        pushNote('error', '加载对话失败')
        setPhase('ready')
      }
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, withCatchup]) // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    const content = input.trim()
    if (!content || sending) return
    setInput('')
    setSending(true)
    setNotes([])
    const localUser: Message = {
      id: `local-${crypto.randomUUID()}`,
      conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    setMessages((ms) => [...ms, localUser])
    streamedRef.current = ''
    try {
      await postSSE(`/api/conversations/${conversationId}/messages`, { content }, (ev) => {
        if (ev.type === 'text') {
          streamedRef.current += ev.delta
          setStreaming(streamedRef.current)
        } else if (ev.type === 'state') {
          onStateChange?.(ev.state)
        } else if (ev.type === 'memory') {
          pushNote('memory', `已记住：${ev.content}`)
        } else if (ev.type === 'error') {
          pushNote('error', ev.message)
        }
      })
    } catch {
      pushNote('error', '发送失败，请重试')
    } finally {
      const full = streamedRef.current
      streamedRef.current = ''
      setStreaming('')
      if (full.trim()) {
        setMessages((ms) => [
          ...ms,
          {
            id: `local-${crypto.randomUUID()}`,
            conversationId,
            role: 'person',
            content: full,
            createdAt: new Date().toISOString(),
          },
        ])
      }
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {phase === 'catchup' && (
          <p className="text-center text-xs text-ink-faint">正在了解 TA 这段时间……</p>
        )}
        {messages.map((m) =>
          m.role === 'system_note' ? (
            <div key={m.id} className="mx-auto max-w-md rounded-xl bg-paper-deep px-4 py-2 text-center text-xs text-ink-soft">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                  m.role === 'user' ? 'bg-ink text-white' : 'border border-ink-line bg-sheet text-ink'
                }`}
              >
                {m.content}
              </div>
            </div>
          ),
        )}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl border border-ink-line bg-sheet px-4 py-2 text-sm leading-relaxed text-ink">
              {streaming}
              <span className="animate-pulse">▍</span>
            </div>
          </div>
        )}
        {notes.map((n) => (
          <p key={n.id} className={`text-center text-xs ${n.kind === 'error' ? 'text-red-500' : 'text-ink-faint'}`}>
            {n.text}
          </p>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-ink-line bg-sheet p-3">
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-xl border border-ink-faint px-3 py-2 text-base outline-none focus:border-ink-soft"
            placeholder={phase === 'ready' ? '说点什么…' : '请稍候…'}
            value={input}
            disabled={phase !== 'ready' || sending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
            }}
          />
          <button
            onClick={send}
            disabled={phase !== 'ready' || sending || !input.trim()}
            className="shrink-0 rounded-xl bg-ink px-5 text-white disabled:opacity-50"
          >
            {sending ? '…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
