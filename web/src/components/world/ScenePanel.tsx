import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, personaApi, sceneApi, worldsApi } from '../../api/client'
import type { Persona, PersonaMention, PersonaMessage, SceneEvent } from '../../api/types'

interface Props {
  worldId: string
  timelineId: string
  locations: { name: string; description: string }[]
  initialLocation?: string
  onClose: () => void
}

interface Msg {
  role: 'user' | 'person' | 'system'
  name: string
  text: string
}

interface PendingSceneRequest { id: string; content: string; location: string }
type ResolvedIntent = Awaited<ReturnType<typeof sceneApi.resolveIntent>>
interface PendingIntentProposal { text: string; result: ResolvedIntent }

function pendingStorageKey(worldId: string, timelineId: string, personId: string) {
  return `possibility:scene-pending:v1:${worldId}:${timelineId}:${personId}`
}

function readPendingSceneRequest(key: string): PendingSceneRequest | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PendingSceneRequest>
    return typeof value.id === 'string' && typeof value.content === 'string' && typeof value.location === 'string'
      ? { id: value.id, content: value.content, location: value.location }
      : null
  } catch { return null }
}

function savePendingSceneRequest(key: string, request: PendingSceneRequest) {
  try { sessionStorage.setItem(key, JSON.stringify(request)) } catch { /* Storage may be unavailable; server idempotency still applies in this tab. */ }
}

function clearPendingSceneRequest(key: string) {
  try { sessionStorage.removeItem(key) } catch { /* Ignore unavailable browser storage. */ }
}

function pendingIntentStorageKey(worldId: string, timelineId: string, personId: string) {
  return `possibility:scene-intent:v1:${worldId}:${timelineId}:${personId}`
}

function readPendingIntentProposal(key: string): PendingIntentProposal | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PendingIntentProposal>
    const result = value.result
    return typeof value.text === 'string' && !!result && result.status === 'proposal'
      && typeof result.requestId === 'string' && typeof result.expectedVersion === 'number' && !!result.proposal
      ? { text: value.text, result }
      : null
  } catch { return null }
}

function savePendingIntentProposal(key: string, value: PendingIntentProposal) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Proposal can be regenerated if browser storage is unavailable. */ }
}

function clearPendingIntentProposal(key: string) {
  try { sessionStorage.removeItem(key) } catch { /* Ignore unavailable browser storage. */ }
}

/**
 * 你在世界里：用户以登记过的在场身份来到某地点说话，
 * 在场的人物依次回应。这场相遇会写进世界史（事件流）与每个人的记忆。
 */
export default function ScenePanel({ worldId, timelineId, locations, initialLocation = '', onClose }: Props) {
  const [persona, setPersona] = useState<Persona | null>(null)
  const [personaLoading, setPersonaLoading] = useState(true)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [location, setLocation] = useState(initialLocation)
  const [moving, setMoving] = useState(false)
  const [dialogueId, setDialogueId] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const pendingRef = useRef<{id: string; content: string; location: string} | null>(null)
  const sceneAbortRef = useRef<AbortController | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<{ messages: PersonaMessage[]; mentions: PersonaMention[] } | null>(null)
  /** 各地点可交谈人数（清醒且空闲；null = 尚未载回） */
  const [board, setBoard] = useState<Record<string, number> | null>(null)
  const [peopleByLocation, setPeopleByLocation] = useState<Record<string, { id: string; name: string }[]>>({})
  const [infoRecipient, setInfoRecipient] = useState('')
  const [infoTopic, setInfoTopic] = useState('')
  const [infoContent, setInfoContent] = useState('')
  const [infoBusy, setInfoBusy] = useState(false)
  const [infoNotice, setInfoNotice] = useState('')
  const [intentText, setIntentText] = useState('')
  const [intentBusy, setIntentBusy] = useState(false)
  const [intentNotice, setIntentNotice] = useState('')
  const [intentProposal, setIntentProposal] = useState<ResolvedIntent | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    personaApi
      .get(worldId, timelineId)
      .then((d) => {
        if (!active) return
        setPersona(d.persona)
        if (d.persona) {
          setName(d.persona.name)
          setDescription(d.persona.description)
          setLocation(d.persona.location ?? (initialLocation || locations[0]?.name || ''))
          const pendingIntent = readPendingIntentProposal(pendingIntentStorageKey(worldId, timelineId, d.persona.id))
          if (pendingIntent) {
            setIntentProposal(pendingIntent.result)
            setIntentText(pendingIntent.text)
            setIntentNotice('已恢复尚未确认的行动提议；确认前会再次检查世界版本。')
          }
          // 世界记得你：未读留言 + 与你有关的动静（送达即标记已读）
          personaApi
            .messages(worldId, timelineId)
            .then(n => { if (active) setNotes(n) })
            .catch(() => { if (active) setError('口信暂时加载失败，请重新打开。') })
          // 可交谈地点看板（人数随世界运转变化，进入面板时拉一次）
          sceneApi
            .board(worldId, timelineId)
            .then((b) => { if (active) { setBoard(Object.fromEntries(b.board.map((x) => [x.location, x.count]))); setPeopleByLocation(Object.fromEntries(b.board.map(x => [x.location, x.people]))) } })
            .catch(() => {})
        }
      })
      .catch(() => { if (active) setError('身份加载失败') })
      .finally(() => { if (active) setPersonaLoading(false) })
    return () => { active = false }
  }, [worldId, timelineId])

  useEffect(() => {
    if (!persona) { setHistoryLoading(false); return }
    let active = true
    setHistoryLoading(true)
    setDialogueId(null)
    setMessages([])
    sceneApi.history(worldId, timelineId, location || undefined).then(h => {
      if (!active) return
      setDialogueId(h.dialogueId)
      setMessages(h.turns.map(t => ({role: t.personId === persona.id ? 'user' : 'person', name: t.name, text: t.utterance})))
    }).catch(() => { if (active) setError('历史交谈加载失败，请重新打开后再发送，避免丢失上下文。') })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [worldId, timelineId, location, persona?.id])

  useEffect(() => {
    if (!persona || !location || persona.location !== location) return
    const key = pendingStorageKey(worldId, timelineId, persona.id)
    const pending = readPendingSceneRequest(key)
    if (!pending || pending.location !== location) return
    pendingRef.current = pending
    setInput(value => value || pending.content)
    setBusy(true)
    setError('正在确认上一次交谈的提交状态…')
    let active = true
    let timer = 0
    let attempts = 0
    const check = async () => {
      let status: 'missing' | 'pending' | 'completed' | 'failed'
      try {
        const result = await sceneApi.requestStatus(worldId, timelineId, pending.id)
        status = result.status
        if (status === 'pending' && result.recoverable) {
          status = (await sceneApi.recoverRequest(worldId, timelineId, pending.id)).status
        }
      } catch {
        if (active) { setBusy(false); setError('暂时无法确认上一次交谈；再次发送会复用同一请求编号。') }
        return
      }
      if (!active) return
      if (status === 'completed') {
        clearPendingSceneRequest(key)
        pendingRef.current = null
        setInput(value => value === pending.content ? '' : value)
        setBusy(false)
        setError('上一次交谈已写入世界，记录已恢复。')
        sceneApi.history(worldId, timelineId, location).then(h => {
          if (!active) return
          setDialogueId(h.dialogueId)
          setMessages(h.turns.map(t => ({ role: t.personId === persona.id ? 'user' : 'person', name: t.name, text: t.utterance })))
        }).catch(() => {})
        return
      }
      if (status === 'failed') {
        const retry = { ...pending, id: crypto.randomUUID() }
        pendingRef.current = retry
        savePendingSceneRequest(key, retry)
        setBusy(false)
        setError('上一次尝试未写入世界；可以重新发送。')
        return
      }
      if (status === 'missing') {
        setBusy(false)
        setError('上一次请求尚未到达世界；可以安全重试。')
        return
      }
      attempts++
      if (attempts >= 20) {
        setBusy(false)
        setError('上一次交谈仍在处理中；再次发送会安全复用同一请求编号。')
        return
      }
      timer = window.setTimeout(() => { void check() }, 1500)
    }
    void check()
    return () => { active = false; window.clearTimeout(timer) }
  }, [worldId, timelineId, location, persona?.id, persona?.location])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const handleSavePersona = async () => {
    setSaving(true)
    setError('')
    try {
      const d = await personaApi.upsert(worldId, { name: name.trim(), description: description.trim() })
      setPersona({ ...d.persona, location: null })
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    sceneAbortRef.current?.abort()
    onClose()
  }

  const handlePosition = async () => {
    if (!persona || !location || moving) return
    setMoving(true)
    setError('')
    try {
      const state = await worldsApi.state(worldId, timelineId)
      await sceneApi.position(worldId, { timelineId, location, commandId: crypto.randomUUID(), expectedVersion: state.version })
      setPersona({ ...persona, location })
      setMessages([])
      setDialogueId(null)
    } catch (e) {
      const recovered = await personaApi.get(worldId, timelineId).catch(() => null)
      if (recovered?.persona?.location === location) setPersona(recovered.persona)
      else setError(e instanceof Error ? e.message : '到场失败，请刷新后重试')
    } finally {
      setMoving(false)
    }
  }

  const handleInform = async () => {
    if (!persona?.location || persona.location !== location || !infoRecipient || !infoTopic.trim() || !infoContent.trim() || infoBusy) return
    setInfoBusy(true); setInfoNotice('')
    try {
      const state = await worldsApi.state(worldId, timelineId)
      const result = await sceneApi.inform(worldId, { timelineId, recipientId: infoRecipient,
        topic: infoTopic.trim(), content: infoContent.trim(), commandId: crypto.randomUUID(), expectedVersion: state.version })
      setInfoNotice(`对方已听到这条消息（v${result.version}）；它仍是传闻，不会自动变成世界事实。`)
      setInfoContent('')
    } catch (e) { setInfoNotice(e instanceof Error ? e.message : '传递失败') }
    finally { setInfoBusy(false) }
  }

  const handleResolveIntent = async () => {
    const content = intentText.trim()
    if (!persona?.location || persona.location !== location || !content || intentBusy || busy) return
    setIntentBusy(true)
    setIntentNotice('')
    setIntentProposal(null)
    try {
      const result = await sceneApi.resolveIntent(worldId, { timelineId, content, requestId: crypto.randomUUID() })
      setIntentProposal(result)
      const key = pendingIntentStorageKey(worldId, timelineId, persona.id)
      if (result.status === 'proposal') savePendingIntentProposal(key, { text: content, result })
      else clearPendingIntentProposal(key)
      if (result.status === 'clarification') setIntentNotice(result.question ?? '请再说具体一些。')
      else if (result.status === 'rejected') setIntentNotice(result.reason ?? '这个行动不在当前范围内。')
    } catch (e) {
      setIntentNotice(e instanceof Error ? e.message : '暂时无法解析行动；世界状态未改变。')
    } finally { setIntentBusy(false) }
  }

  const handleConfirmIntent = async () => {
    const result = intentProposal
    const proposal = result?.proposal
    if (!result || result.status !== 'proposal' || !proposal || intentBusy || !persona?.location || persona.location !== location) return
    setIntentBusy(true)
    setIntentNotice('')
    const storageKey = pendingIntentStorageKey(worldId, timelineId, persona.id)
    try {
      // A confirmed action may have committed just before a lost response. Resolve that
      // uncertainty by command ID before checking the now-advanced world version.
      try {
        const prior = await worldsApi.commandStatus(worldId, result.requestId)
        if (prior.timelineId === timelineId && prior.resultVersion === result.expectedVersion + 1) {
          if (proposal.type === 'move') {
            setLocation(proposal.to)
            setPersona({ ...persona, location: proposal.to })
            setMessages([])
            setDialogueId(null)
          }
          clearPendingIntentProposal(storageKey)
          setIntentProposal(null)
          setIntentNotice(proposal.type === 'move'
            ? `这项行动此前已提交；已恢复到${proposal.to}。`
            : `这项行动此前已提交；${proposal.recipientName}已收到这条传闻。`)
          return
        }
        throw new Error('命令编号与当前行动不匹配。')
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e
      }
      const state = await worldsApi.state(worldId, timelineId)
      if (state.version !== result.expectedVersion) {
        clearPendingIntentProposal(storageKey)
        setIntentProposal(null)
        setIntentNotice('提议后世界状态已经变化，请重新描述并生成提议。')
        return
      }
      if (proposal.type === 'move') {
        await sceneApi.position(worldId, { timelineId, location: proposal.to, commandId: result.requestId, expectedVersion: result.expectedVersion })
        setLocation(proposal.to)
        setPersona({ ...persona, location: proposal.to })
        setMessages([])
        setDialogueId(null)
        setIntentNotice(`已确认并前往${proposal.to}。`)
      } else {
        const committed = await sceneApi.inform(worldId, { timelineId, recipientId: proposal.recipientId,
          topic: proposal.topic, content: proposal.content, commandId: result.requestId, expectedVersion: result.expectedVersion })
        setIntentNotice(`已确认并告诉${proposal.recipientName}（v${committed.version}）；这仍是一条传闻。`)
      }
      clearPendingIntentProposal(storageKey)
      setIntentProposal(null)
      setIntentText('')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        clearPendingIntentProposal(storageKey)
        setIntentProposal(null)
        setIntentNotice('世界状态已变化，这项提议未执行；请重新描述并生成提议。')
      } else {
        // Keep the same command/request ID so a retry can recover the committed result.
        setIntentNotice('暂时无法确认提交结果；提议已保留，再次确认会先查询是否已提交。')
      }
    } finally { setIntentBusy(false) }
  }

  const handleSend = useCallback(async () => {
    const content = input.trim()
    if (!content || busy || historyLoading || !persona || !persona.location || persona.location !== location) return
    setInput('')
    setError('')
    setBusy(true)
    const retry = pendingRef.current?.content === content && pendingRef.current.location === location
    const request = retry ? pendingRef.current! : {id: crypto.randomUUID(), content, location}
    const controller = new AbortController()
    sceneAbortRef.current = controller
    pendingRef.current = request
    const storageKey = pendingStorageKey(worldId, timelineId, persona.id)
    savePendingSceneRequest(storageKey, request)
    if (!retry) setMessages((prev) => [...prev, { role: 'user', name: persona.name, text: content }])
    let failed = false
    let receivedDone = false
    let transportError = ''
    try {
      try {
        await sceneApi.send(worldId, { timelineId, location: location || undefined, content, dialogueId: dialogueId ?? undefined, requestId: request.id }, (raw) => {
          const ev = raw as SceneEvent
          if (ev.type === 'scene_start') {
            setDialogueId(ev.dialogueId)
            setMessages((prev) => [...prev, { role: 'system', name: '', text: `在${ev.location}——${ev.participants.join('、')} 在场` }])
          } else if (ev.type === 'utterance') {
            setMessages((prev) => [...prev, { role: 'person', name: ev.name, text: ev.text }])
          } else if (ev.type === 'error') {
            failed = true
            setError(ev.message)
          } else if (ev.type === 'done') {
            receivedDone = true
          }
        }, controller.signal)
      } catch (e) {
        transportError = e instanceof Error ? e.message : '交谈失败'
      }
      if (!failed && receivedDone) {
        pendingRef.current = null
        clearPendingSceneRequest(storageKey)
      } else {
        const status = await sceneApi.requestStatus(worldId, timelineId, request.id).then(async result => {
          if (result.status === 'pending' && result.recoverable) {
            return (await sceneApi.recoverRequest(worldId, timelineId, request.id)).status
          }
          return result.status
        }).catch(() => null)
        if (status === 'completed') {
          pendingRef.current = null
          clearPendingSceneRequest(storageKey)
          if (failed || transportError) setError('交谈已提交，连接中断前的记录已从世界恢复。')
        } else if (status === 'failed') {
          const retryRequest = { ...request, id: crypto.randomUUID() }
          pendingRef.current = retryRequest
          savePendingSceneRequest(storageKey, retryRequest)
          setInput(content)
          setError('上一次尝试未写入世界；可以重新发送。')
        } else {
          setInput(content)
          setError(status === 'pending'
            ? '交谈仍在处理中；再次发送会复用同一请求编号。'
            : transportError || '结果尚未确认；再次发送会复用同一请求编号。')
        }
      }
    } finally {
      if (sceneAbortRef.current === controller) sceneAbortRef.current = null
      setBusy(false)
      // 人数随世界运转变化，每次交谈后刷新看板
      sceneApi
        .board(worldId, timelineId)
        .then((b) => { setBoard(Object.fromEntries(b.board.map((x) => [x.location, x.count]))); setPeopleByLocation(Object.fromEntries(b.board.map(x => [x.location, x.people]))) })
        .catch(() => {})
      // 服务器是历史的唯一来源：重试重放不会在界面留下重复气泡。
      sceneApi.history(worldId, timelineId, location || undefined).then(h => {
        setDialogueId(h.dialogueId)
        setMessages(h.turns.map(t => ({role: t.personId === persona.id ? 'user' : 'person', name: t.name, text: t.utterance})))
      }).catch(() => {})
      personaApi.messages(worldId, timelineId).then(setNotes).catch(() => {})
    }
  }, [input, busy, historyLoading, persona, worldId, timelineId, location, dialogueId])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-4" onClick={handleClose}>
      <div
        className="flex h-[80vh] w-full max-w-xl flex-col rounded-2xl border border-ink-line bg-paper shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-line/60 px-5 py-3">
          <h2 className="font-story text-lg font-semibold text-ink">进入世界</h2>
          <button onClick={handleClose} className="text-xs text-ink-faint transition-colors hover:text-ink-soft">
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
              <span className="text-xs text-ink-faint">{persona.location ? `你在 ${persona.location} · 前往` : '选择进入地点'}</span>
              <select
                value={location}
                disabled={busy || moving}
                onChange={(e) => setLocation(e.target.value)}
                className="rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs text-ink-soft outline-none"
              >
                <option value="" disabled>选择地点</option>
                {locations.map((l) => {
                  const count = board?.[l.name]
                  return (
                    <option key={l.name} value={l.name}>
                      {l.name}
                      {count != null ? (count > 0 ? `（${count} 人可交谈）` : '（都在忙或睡着）') : ''}
                    </option>
                  )
                })}
              </select>
              {persona.location !== location && <button onClick={() => void handlePosition()} disabled={moving || !location} className="rounded-lg bg-ink px-3 py-1 text-xs text-white disabled:opacity-50">{moving ? '到场中…' : persona.location ? '移动' : '进入'}</button>}
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

            <details className="border-t border-ink-line/60 px-4 py-2"><summary className="cursor-pointer text-xs text-ink-soft">明确告诉现场某人一条消息</summary><p className="mt-1 text-[11px] text-ink-faint">这是可追踪的当面传话；对方会记为传闻。普通聊天不会自动变成已证实事实。</p><div className="mt-2 flex flex-wrap gap-2"><select aria-label="消息接收者" value={infoRecipient} onChange={e => setInfoRecipient(e.target.value)} className="rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs"><option value="">选择现场的人</option>{(peopleByLocation[location] ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input aria-label="消息主题" value={infoTopic} onChange={e => setInfoTopic(e.target.value)} placeholder="消息主题" maxLength={80} className="min-w-0 flex-1 rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs" /><input aria-label="消息内容" value={infoContent} onChange={e => setInfoContent(e.target.value)} placeholder="你要告诉 TA 什么" maxLength={500} className="min-w-0 flex-[2] rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs" /><button onClick={() => void handleInform()} disabled={infoBusy || !persona.location || persona.location !== location || !infoRecipient || !infoTopic.trim() || !infoContent.trim()} className="rounded-lg bg-ink px-3 py-1 text-xs text-white disabled:opacity-50">告诉 TA</button></div>{infoNotice && <p className="mt-2 text-xs text-ink-soft">{infoNotice}</p>}</details>
            <details className="border-t border-ink-line/60 px-4 py-2"><summary className="cursor-pointer text-xs text-ink-soft">尝试一个行动</summary><p className="mt-1 text-[11px] text-ink-faint">先把自然语言整理成有限提议；只有你确认后才会执行。普通聊天不会自动改变世界。</p><div className="mt-2 flex gap-2"><input aria-label="行动描述" value={intentText} onChange={e => { setIntentText(e.target.value); setIntentProposal(null); setIntentNotice(''); if (persona) clearPendingIntentProposal(pendingIntentStorageKey(worldId, timelineId, persona.id)) }} maxLength={1000} placeholder="例如：带我去图书馆，或告诉 Ada 暴雨开始了" className="min-w-0 flex-1 rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs" /><button onClick={() => void handleResolveIntent()} disabled={intentBusy || busy || !persona.location || persona.location !== location || !intentText.trim()} className="rounded-lg bg-ink px-3 py-1 text-xs text-white disabled:opacity-50">{intentBusy && !intentProposal ? '整理中…' : '生成提议'}</button></div>{intentProposal?.status === 'proposal' && intentProposal.proposal && <div className="mt-2 rounded-lg border border-ink-line bg-sheet p-3 text-xs"><p className="text-ink-soft">提议（世界状态 v{intentProposal.expectedVersion}）</p><p className="mt-1 text-ink">{intentProposal.proposal.type === 'move' ? `前往${intentProposal.proposal.to}` : `告诉${intentProposal.proposal.recipientName}：「${intentProposal.proposal.content}」`}</p><div className="mt-2 flex gap-2"><button onClick={() => void handleConfirmIntent()} disabled={intentBusy} className="rounded-lg bg-ink px-3 py-1 text-white disabled:opacity-50">{intentBusy ? '提交中…' : '确认执行'}</button><button onClick={() => { if (persona) clearPendingIntentProposal(pendingIntentStorageKey(worldId, timelineId, persona.id)); setIntentProposal(null); setIntentNotice('已取消提议。') }} disabled={intentBusy} className="rounded-lg border border-ink-line px-3 py-1 text-ink-soft">取消</button></div></div>}{intentNotice && <p className="mt-2 text-xs text-ink-soft">{intentNotice}</p>}</details>
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
                disabled={busy || !input.trim() || !persona.location || persona.location !== location}
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
