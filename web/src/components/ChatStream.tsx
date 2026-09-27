import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, chatApi, postSSE } from '../api/client'
import type { Message, PersonState } from '../api/types'
import { decideChatRecovery } from '../lib/chatRecovery'

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

interface PendingRecovery {
  requestId: string
  /** 仅当前标签页保留，用于终态失败后恢复输入框；不会写入浏览器存储。 */
  content: string | null
}

function pendingRequestKey(conversationId: string): string {
  return `possibility:chat-request:${conversationId}`
}

function readPendingRequest(conversationId: string): string | null {
  try {
    return localStorage.getItem(pendingRequestKey(conversationId))
  } catch {
    return null
  }
}

function rememberPendingRequest(conversationId: string, requestId: string): void {
  try {
    localStorage.setItem(pendingRequestKey(conversationId), requestId)
  } catch {
    // 无持久存储时，本标签页仍可通过局部状态完成恢复。
  }
}

function forgetPendingRequest(conversationId: string, requestId: string): void {
  try {
    if (localStorage.getItem(pendingRequestKey(conversationId)) === requestId) {
      localStorage.removeItem(pendingRequestKey(conversationId))
    }
  } catch {
    // 同上；请求状态的真实来源始终是服务端。
  }
}

/** 对话流：历史 + 流式回复 + 追赶摘要（F6/F7/F8） */
export default function ChatStream({ conversationId, withCatchup = true, onStateChange }: ChatStreamProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [notes, setNotes] = useState<LocalNote[]>([])
  const [streaming, setStreaming] = useState('')
  const [phase, setPhase] = useState<'loading' | 'catchup' | 'ready'>('loading')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [pendingRecovery, setPendingRecovery] = useState<PendingRecovery | null>(null)
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
    setPendingRecovery(null)
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
      const res = await chatApi.history(conversationId)
      if (cancelled) return
      setMessages(res.messages)
      let pendingRequestId = readPendingRequest(conversationId)
      if (!pendingRequestId) {
        // localStorage is profile-scoped; discover a durable pending request from the owner-scoped API.
        const pending = await chatApi.pendingRequests(conversationId)
        if (cancelled) return
        pendingRequestId = pending.requests[0]?.requestId ?? null
        if (pendingRequestId) rememberPendingRequest(conversationId, pendingRequestId)
      }
      if (pendingRequestId) {
        try {
          const request = await chatApi.requestStatus(conversationId, pendingRequestId)
          if (cancelled) return
          const decision = decideChatRecovery(request)
          if (decision.kind === 'pending') {
            setPendingRecovery({ requestId: pendingRequestId, content: null })
          } else {
            forgetPendingRequest(conversationId, pendingRequestId)
            if (decision.message) pushNote('error', decision.message)
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            forgetPendingRequest(conversationId, pendingRequestId)
          } else if (!cancelled) {
            pushNote('error', '暂时无法查询上一次聊天请求；请稍后刷新确认，不要重复发送。')
          }
        }
      }
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

  // SSE 已断开但请求仍 pending 时，使用同一 request ID 查询/回收，绝不重发模型请求。
  useEffect(() => {
    if (!pendingRecovery) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const check = async () => {
      try {
        const request = await chatApi.recoverRequest(conversationId, pendingRecovery.requestId)
        if (cancelled) return
        const decision = decideChatRecovery(request)
        const saved = await chatApi.history(conversationId)
        if (cancelled) return
        setMessages(saved.messages)
        if (decision.kind === 'pending') {
          timer = setTimeout(check, 3_000)
          return
        }
        forgetPendingRequest(conversationId, pendingRecovery.requestId)
        setPendingRecovery(null)
        if (decision.requiresNewRequestId && pendingRecovery.content) setInput(pendingRecovery.content)
        if (decision.message) pushNote('error', decision.message)
      } catch {
        if (!cancelled) timer = setTimeout(check, 3_000)
      }
    }

    timer = setTimeout(check, 3_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [conversationId, pendingRecovery, pushNote])

  async function send() {
    const content = input.trim()
    if (!content || sending) return
    setInput('')
    setSending(true)
    setNotes([])
    const requestId = crypto.randomUUID()
    rememberPendingRequest(conversationId, requestId)
    const localUser: Message = {
      id: `local-${crypto.randomUUID()}`,
      conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    setMessages((ms) => [...ms, localUser])
    streamedRef.current = ''
    let streamError: unknown = null
    try {
      await chatApi.send(conversationId, content, requestId, (ev) => {
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
    } catch (error) {
      streamError = error
    } finally {
      streamedRef.current = ''
      setStreaming('')
      try {
        const request = await chatApi.requestStatus(conversationId, requestId)
        const decision = decideChatRecovery(request)
        if (decision.kind === 'pending') {
          setPendingRecovery({ requestId, content })
        } else {
          forgetPendingRequest(conversationId, requestId)
          if (decision.requiresNewRequestId) setInput(content)
          if (decision.message) pushNote('error', decision.message)
          else if (streamError) pushNote('memory', '连接曾中断，但服务端回复已经完整保存。')
        }
        const saved = await chatApi.history(conversationId)
        setMessages(saved.messages)
      } catch (statusError) {
        if (streamError instanceof ApiError && statusError instanceof ApiError && statusError.status === 404) {
          forgetPendingRequest(conversationId, requestId)
          setInput(content)
          setMessages((ms) => ms.filter((m) => m.id !== localUser.id))
          pushNote('error', streamError.message)
        } else {
          pushNote('error', '无法核对发送结果；已保留请求 ID，请刷新页面确认后再继续，不要立即重发。')
        }
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
        {pendingRecovery && (
          <p role="status" className="text-center text-xs text-ink-faint">
            检测到一条尚未完成的消息，正在查询服务端状态；请勿重复发送。
          </p>
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
            placeholder={pendingRecovery ? '正在恢复上一条消息…' : phase === 'ready' ? '说点什么…' : '请稍候…'}
            value={input}
            disabled={phase !== 'ready' || sending || !!pendingRecovery}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
            }}
          />
          <button
            onClick={send}
            disabled={phase !== 'ready' || sending || !!pendingRecovery || !input.trim()}
            className="shrink-0 rounded-xl bg-ink px-5 text-white disabled:opacity-50"
          >
            {sending || pendingRecovery ? '…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
