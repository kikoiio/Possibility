import { useEffect, useRef, useState } from 'react'
import type { ForkInitialAction, ForkScenario, ForkScenarioInput, HistoryRange, TimelineInfo } from '../../api/types'
import ScenarioCard from '../ScenarioCard'
import { planMomentCheck, toLocalInputValue } from './forkMoment'
import { formatWorldTime } from '../../lib/world-time'
import { forkFieldsError, timelineDisplayName } from '../../world/timeline-display'

interface Props {
  timelines: TimelineInfo[]
  currentTimelineId: string
  onSwitch: (timelineId: string) => Promise<boolean | void> | boolean | void
  onFork: (scenario: ForkScenarioInput, f1?: { expectedSourceVersion: number; initialAction: ForkInitialAction }) => Promise<boolean>
  /** 一句话预览（S2/F1）：LLM 起草五字段场景，不落库；S4/F6 可带已吸附的历史时刻 */
  onPreview: (whatIf: string, startTime?: string) => Promise<ForkScenario>
  onArchive: (timelineId: string) => void
  writeLocked?: boolean
  /** S1 分屏入口:活跃线 ≥2 时可点,否则置灰提示先分叉 */
  onSplitView?: () => void
  /** S4/F6:当前线的历史可回溯范围;undefined=尚未加载(时刻区不渲染),earliest=null=不支持历史分叉 */
  historyRange?: HistoryRange | null
  /** 分叉弹窗打开时触发(父级借此加载 historyRange) */
  onForkOpen?: () => void
  /** S4/F6:单点可重建性判定——返回吸附后的有效时刻;不可重建时抛错,消息即原因 */
  onCheckMoment?: (at: string) => Promise<string>
  forkPrefill?: { key: string; whatIf: string; simTime: string } | null
}

type ForkStep = 'input' | 'advanced' | 'confirm'

/** 时间线切换器：列表 + Fork 入口（一句话预览 → 确认卡；高级=两字段手写）+ 归档 */
export default function TimelineSwitcher({ timelines, currentTimelineId, onSwitch, onFork, onPreview, onArchive, writeLocked = false, onSplitView, historyRange, onForkOpen, onCheckMoment, forkPrefill }: Props) {
  const [open, setOpen] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const [step, setStep] = useState<ForkStep>('input')
  const [whatIf, setWhatIf] = useState('')
  const [name, setName] = useState('')
  const [changedVariable, setChangedVariable] = useState('')
  const [scenario, setScenario] = useState<ForkScenario | null>(null)
  const [initialAction, setInitialAction] = useState<ForkInitialAction | null>(null)
  const [forkError, setForkError] = useState('')
  const [forking, setForking] = useState(false)
  const forkPending = useRef(false)
  const [switchError, setSwitchError] = useState('')
  const [switchTarget, setSwitchTarget] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const switchTimeline = async (id: string) => {
    if (switching) return
    setSwitchTarget(id); setSwitching(true); setSwitchError('')
    try {
      if (await onSwitch(id) === false) throw new Error('切换暂未完成，请重试；当前时间线已保留。')
      setOpen(false)
    } catch (e) { setSwitchError(e instanceof Error ? e.message : '切换失败，请重试；当前时间线已保留。') }
    finally { setSwitching(false) }
  }
  // S4/F6 时刻选择:默认当前时刻;custom=过去时刻,失焦/提交前经 checkMoment 吸附
  const [momentMode, setMomentMode] = useState<'current' | 'custom'>('current')
  const [momentInput, setMomentInput] = useState('')
  const [momentDirty, setMomentDirty] = useState(false)
  const [effectiveMoment, setEffectiveMoment] = useState<string | null>(null)
  const [momentError, setMomentError] = useState('')
  const [momentChecking, setMomentChecking] = useState(false)
  useEffect(() => {
    if (!forkPrefill) return
    resetFork()
    setWhatIf(forkPrefill.whatIf)
    setMomentMode('custom')
    setMomentInput(toLocalInputValue(forkPrefill.simTime))
    setMomentDirty(true)
    setForkOpen(true)
    onForkOpen?.()
  }, [forkPrefill?.key])
  const active = timelines.filter((t) => t.status === 'active')
  const current = timelines.find((t) => t.id === currentTimelineId)
  const depth = (id: string): number => {
    let n = 0
    let parent = timelines.find(t => t.id === id)?.parentTimelineId
    while (parent && n < timelines.length) { n++; parent = timelines.find(t => t.id === parent)?.parentTimelineId ?? null }
    return n
  }
  const ordered: TimelineInfo[] = []
  const seen = new Set<string>()
  const visit = (parentId: string | null) => {
    for (const t of timelines.filter(x => x.parentTimelineId === parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (seen.has(t.id)) continue
      seen.add(t.id); ordered.push(t); visit(t.id)
    }
  }
  visit(null)
  for (const t of timelines) if (!seen.has(t.id)) ordered.push(t)

  const resetFork = () => {
    setStep('input')
    setScenario(null)
    setInitialAction(null)
    setForkError('')
    setMomentMode('current')
    setMomentInput('')
    setMomentDirty(false)
    setEffectiveMoment(null)
    setMomentError('')
  }

  /** 校验当前所选时刻:返回吸附后的有效时刻(当前时刻=null);不可重建时抛出带原因的错误 */
  const checkMomentNow = async (): Promise<string | null> => {
    if (momentMode === 'current') return null
    const plan = planMomentCheck(momentInput, historyRange ?? null)
    if (plan.kind === 'current') {
      setEffectiveMoment(null); setMomentError(''); setMomentDirty(false)
      return null
    }
    if (plan.kind === 'invalid' || !onCheckMoment) {
      const reason = plan.kind === 'invalid' ? plan.reason : '这条时间线没有可回溯的历史，只能从当前时刻分叉。'
      setEffectiveMoment(null); setMomentError(reason); setMomentDirty(false)
      throw new Error(reason)
    }
    setMomentChecking(true)
    try {
      const effective = await onCheckMoment(plan.at)
      setEffectiveMoment(effective); setMomentError(''); setMomentDirty(false)
      return effective
    } catch (e) {
      const reason = e instanceof Error ? e.message : '该时刻无法完整重建'
      setEffectiveMoment(null); setMomentError(reason); setMomentDirty(false)
      throw e instanceof Error ? e : new Error(reason)
    } finally {
      setMomentChecking(false)
    }
  }

  /** 提交前解析 startTime:当前时刻=undefined;过去时刻必须已成功吸附,否则抛出原因 */
  const resolveStartTime = async (): Promise<string | undefined> => {
    if (momentMode !== 'custom') return undefined
    if (!momentDirty) {
      if (effectiveMoment) return effectiveMoment
      if (momentError) throw new Error(momentError)
    }
    return (await checkMomentNow()) ?? undefined
  }

  const preview = async () => {
    if (forkPending.current) return
    const text = whatIf.trim()
    if (!text) {
      setForkError('先用一句话说说这条线要探索什么可能。')
      return
    }
    setForkError('')
    forkPending.current = true
    setForking(true)
    try {
      const startTime = await resolveStartTime()
      const draft = await onPreview(text, startTime)
      setScenario({ ...draft, name: draft.name || text.slice(0, 80) })
      setInitialAction(draft.actionProposal ?? null)
      setStep('confirm')
    } catch (e) {
      setForkError(e instanceof Error ? e.message : '场景生成失败，请重试')
    } finally {
      forkPending.current = false
      setForking(false)
    }
  }

  const forkDirect = async () => {
    if (forkPending.current) return
    const input: ForkScenarioInput = { name: name.trim(), whatIf: whatIf.trim(), changedVariable: changedVariable.trim() }
    const invalid = forkFieldsError(input)
    if (invalid) {
      setForkError(invalid)
      return
    }
    setForkError('')
    forkPending.current = true
    setForking(true)
    try {
      const startTime = await resolveStartTime()
      if (startTime) input.startTime = startTime
      if (await onFork(input)) { setForkOpen(false); resetFork() }
      else setForkError('创建未完成，输入已保留，请重试。')
    } catch (e) {
      setForkError(e instanceof Error ? e.message : '该时刻无法完整重建')
    } finally {
      forkPending.current = false
      setForking(false)
    }
  }

  const forkConfirmed = async () => {
    if (!scenario || forkPending.current) return
    const invalid = forkFieldsError(scenario)
    if (invalid) { setForkError(invalid); return }
    if (!initialAction || !Number.isSafeInteger(scenario.sourceVersion)) {
      setForkError('当前设定无法映射为受支持的初始动作，请返回修改 what-if 后重新预览。')
      return
    }
    if (initialAction.type === 'inform') {
      if (!initialAction.recipientId || !initialAction.topic.trim() || initialAction.topic.trim().length > 80
        || !initialAction.content.trim() || initialAction.content.trim().length > 500) {
        setForkError('请补全接收居民、主题和消息内容（主题 ≤80 字，内容 ≤500 字）。')
        return
      }
      if (initialAction.sourceFactId && !scenario.sourceCandidates?.some(candidate => candidate.id === initialAction.sourceFactId)) {
        setForkError('所选来源已不在当前预览的合格证据中，请重新预览。')
        return
      }
    } else if (!initialAction.location || !scenario.actionTargets?.locations.includes(initialAction.location)
      || !initialAction.value.trim() || initialAction.value.trim().length > 200) {
      setForkError('请从世界地点中选择目标地点，并填写不超过 200 字的环境状态。')
      return
    }
    setForkError('')
    forkPending.current = true
    setForking(true)
    try {
      const input: ForkScenarioInput = {
        name: scenario.name!.trim(),
        whatIf: scenario.whatIf.trim(),
        changedVariable: scenario.changedVariable.trim(),
        participants: scenario.participants,
        invariants: scenario.invariants,
        // 预览返回的 startTime 已是服务端吸附后的有效时刻(现时刻=simNow,透传不改变行为)
        startTime: scenario.startTime,
      }
      if (await onFork(input, { expectedSourceVersion: scenario.sourceVersion!, initialAction })) { setForkOpen(false); resetFork() }
      else setForkError('创建未完成，输入已保留，请重试。')
    } catch (e) {
      setForkError(e instanceof Error ? e.message : '创建失败，输入已保留，请重试。')
    } finally {
      forkPending.current = false
      setForking(false)
    }
  }

  // S4/F6 时刻选择区:范围未加载(undefined)时不渲染;input/advanced 两步共用
  const momentSection = historyRange !== undefined && step !== 'confirm' && (
    <div className="mt-3" data-testid="fork-moment">
      <span className="block text-xs text-ink-soft">从哪个时刻分叉？</span>
      <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-soft">
        <input
          type="radio"
          name="fork-moment"
          checked={momentMode === 'current'}
          onChange={() => { setMomentMode('current'); setMomentError('') }}
          data-testid="fork-moment-current"
        />
        当前时刻（{formatWorldTime(historyRange?.simNow ?? current?.simNow, current?.timeZone)}）
      </label>
      {historyRange?.earliest ? (
        <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-soft">
          <input
            type="radio"
            name="fork-moment"
            checked={momentMode === 'custom'}
            onChange={() => setMomentMode('custom')}
            data-testid="fork-moment-custom"
          />
          过去的某个时刻
        </label>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">这条线还没有可回溯的历史，只能从当前时刻分叉。</p>
      )}
      {momentMode === 'custom' && historyRange?.earliest && (
        <div className="mt-1.5">
          <input
            type="datetime-local"
            value={momentInput}
            step={0.001}
            min={toLocalInputValue(historyRange.earliest)}
            max={toLocalInputValue(historyRange.simNow)}
            onChange={(event) => { setMomentInput(event.target.value); setMomentDirty(true); setEffectiveMoment(null); setMomentError('') }}
            onBlur={() => { if (momentDirty) void checkMomentNow().catch(() => { /* 原因已展示在 momentError */ }) }}
            disabled={forking || momentChecking}
            data-testid="fork-moment-input"
            className="w-full rounded-lg border border-ink-line px-3 py-1.5 text-xs text-ink-soft focus:border-ink-faint focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-ink-faint">
            可回溯 {formatWorldTime(historyRange.earliest, current?.timeZone)} ～ {formatWorldTime(historyRange.simNow, current?.timeZone)}
          </p>
          {momentChecking && <p className="mt-1 text-[11px] text-ink-faint">正在校验这个时刻…</p>}
          {!momentChecking && effectiveMoment && !momentError && (
            <p className="mt-1 text-[11px] text-woad-deep" data-testid="fork-moment-effective">将从 {formatWorldTime(effectiveMoment, current?.timeZone)} 分叉</p>
          )}
          {momentError && <p role="alert" className="mt-1 text-[11px] text-red-600" data-testid="fork-moment-error">{momentError}</p>}
        </div>
      )}
    </div>
  )

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep"
      >
        {current ? timelineDisplayName(current) : '主宇宙'} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-ink-line bg-sheet p-2 shadow-lg">
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {ordered.map((t) => (
              <li key={t.id}>
                <div
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                    t.id === currentTimelineId ? 'bg-paper-deep font-medium text-ink' : 'text-ink-soft hover:bg-paper-deep'
                  }`}
                >
                  <button
                    disabled={switching}
                    aria-pressed={t.id === switchTarget}
                    className="min-w-0 flex-1 text-left"
                    style={{ paddingLeft: `${depth(t.id) * 12}px` }}
                    onClick={() => void switchTimeline(t.id)}
                  >
                    <span className={`mr-1 rounded-full px-1.5 py-0.5 ${t.parentTimelineId === null ? 'bg-paper-deep text-ink-soft' : 'bg-woad-soft text-woad-deep'}`}>
                      {t.parentTimelineId === null ? '主宇宙' : `↳ ${timelineDisplayName(t)}`}
                    </span>
                    <span className="text-ink-faint">{formatWorldTime(t.simNow, t.timeZone)}</span>
                    {t.status === 'archived' && <span className="ml-1 text-ink-faint">（已归档）</span>}
                    {t.parentTimelineId && <span className="block pt-1 text-[10px] text-ink-faint">源自 {timelines.find(source => source.id === t.parentTimelineId) ? timelineDisplayName(timelines.find(source => source.id === t.parentTimelineId)!) : '来源时间线'} · {t.forkScenario?.whatIf ?? '未记录假设'}</span>}
                  </button>
                  {t.status === 'active' && active.length > 1 && (
                    <button
                      onClick={() => {
                        onArchive(t.id)
                        setOpen(false)
                      }}
                      className="shrink-0 text-ink-faint hover:text-red-500"
                      title="归档这条时间线"
                    >
                      归档
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-ink-faint">当前时间和居民数量属于所选时间线，切换后可能变化；不同时间线未必处于同一时刻。</p>
          {switchError && <p role="alert" className="mt-2 text-xs text-red-600">{switchError}<button onClick={() => switchTarget && void switchTimeline(switchTarget)} className="ml-1 underline">重试切换</button></p>}
          <div className="mt-2 space-y-1 border-t border-ink-line/60 pt-2">
            {onSplitView && (
              <button
                onClick={() => {
                  if (active.length < 2) return
                  onSplitView()
                  setOpen(false)
                }}
                disabled={active.length < 2}
                data-testid="split-view-entry"
                className="w-full rounded-lg border border-ink-line px-3 py-1.5 text-xs text-ink-soft hover:bg-paper-deep disabled:text-ink-faint disabled:hover:bg-transparent"
              >
                {active.length < 2 ? '分屏比较（先创造一条平行宇宙）' : '分屏比较两条时间线'}
              </button>
            )}
            <button
              onClick={() => {
                setOpen(false)
                resetFork()
                setForkOpen(true)
                onForkOpen?.()
              }}
              disabled={writeLocked || active.length >= 3}
              data-testid="fork-entry"
              className="w-full rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:bg-ink-faint"
            >
              {writeLocked ? '历史证据只读，暂不能分叉' : active.length >= 3 ? '活跃宇宙已满（先归档一条）' : '从当前时刻创造平行宇宙'}
            </button>
          </div>
        </div>
      )}
      {forkOpen && (
        <div role="dialog" aria-modal="true" aria-label="创建平行宇宙" className="absolute right-0 top-10 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-ink-line bg-sheet p-4 shadow-xl">
          <h2 className="text-sm font-semibold text-ink">创建平行宇宙</h2>
          {step !== 'confirm' && (
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">从选定时刻复制世界。说一个「如果」，我们先起草场景设定，你确认后才分叉，源宇宙不会被改写。</p>
          )}
          {momentSection}

          {step === 'input' && (
            <>
              <label className="mt-3 block text-xs text-ink-soft" htmlFor="fork-what-if">这条线要探索什么可能？</label>
              <textarea
                id="fork-what-if"
                value={whatIf}
                onChange={(event) => setWhatIf(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="例如：如果那封信在暴雨前送达，会发生什么？"
                className="mt-1 w-full rounded-lg border border-ink-line px-3 py-2 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
              />
              {forkError && <p role="alert" className="mt-2 text-xs text-red-600">{forkError}</p>}
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => { setForkError(''); setStep('advanced') }}
                  className="text-xs text-ink-faint underline hover:text-ink-soft"
                >
                  高级：手动设定条件
                </button>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setForkOpen(false)} disabled={forking} className="rounded-lg border border-ink-line px-3 py-1.5 text-xs text-ink-soft disabled:opacity-50">取消</button>
                  <button type="button" onClick={() => void preview()} disabled={forking} data-testid="fork-preview-submit" className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-50">{forking ? '正在起草场景…' : '生成场景设定'}</button>
                </div>
              </div>
            </>
          )}

          {step === 'advanced' && (
            <>
              <label className="mt-3 block text-xs text-ink-soft" htmlFor="fork-name-advanced">分支名称</label>
              <input id="fork-name-advanced" value={name} onChange={event => setName(event.target.value)} maxLength={80} className="mt-1 w-full rounded-lg border border-ink-line px-3 py-2 text-sm text-ink-soft" />
              <label className="mt-3 block text-xs text-ink-soft" htmlFor="fork-what-if-advanced">这条线要探索什么可能？</label>
              <textarea
                id="fork-what-if-advanced"
                value={whatIf}
                onChange={(event) => setWhatIf(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="例如：如果那封信在暴雨前送达，会发生什么？"
                className="mt-1 w-full rounded-lg border border-ink-line px-3 py-2 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
              />
              <label className="mt-3 block text-xs text-ink-soft" htmlFor="fork-changed-variable">准备改变的条件（只写一项）</label>
              <input
                id="fork-changed-variable"
                value={changedVariable}
                onChange={(event) => setChangedVariable(event.target.value)}
                maxLength={200}
                placeholder="例如：匿名信是否送达"
                className="mt-1 w-full rounded-lg border border-ink-line px-3 py-2 text-sm text-ink-soft focus:border-ink-faint focus:outline-none"
              />
              {forkError && <p role="alert" className="mt-2 text-xs text-red-600">{forkError}</p>}
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => { setForkError(''); setStep('input') }}
                  className="text-xs text-ink-faint underline hover:text-ink-soft"
                >
                  返回一句话模式
                </button>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setForkOpen(false)} disabled={forking} className="rounded-lg border border-ink-line px-3 py-1.5 text-xs text-ink-soft disabled:opacity-50">取消</button>
                  <button type="button" onClick={() => void forkDirect()} disabled={forking} className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-50">{forking ? '创建中…' : '记录条件并分叉'}</button>
                </div>
              </div>
            </>
          )}

          {step === 'confirm' && scenario && (
            <>
              <div className="mt-3">
                <ScenarioCard scenario={scenario} timeZone={current?.timeZone} onChange={setScenario} />
              </div>
              <section className="mt-3 rounded-lg border border-ink-line p-3" data-testid="fork-initial-action">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-ink-soft" htmlFor="fork-action-type">子线起点动作</label>
                  {initialAction && (
                    <select
                      id="fork-action-type"
                      value={initialAction.type}
                      onChange={event => setInitialAction(event.target.value === 'inform'
                        ? { type: 'inform', recipientId: '', topic: '', content: '' }
                        : { type: 'environment', location: '', condition: 'weather', value: '' })}
                      disabled={forking}
                      className="rounded border border-ink-line px-2 py-1 text-xs text-ink-soft"
                    >
                      <option value="inform">向居民传递消息</option>
                      <option value="environment">改变地点环境</option>
                    </select>
                  )}
                </div>
                {!initialAction ? (
                  <p role="alert" className="mt-2 text-xs text-red-600" data-testid="fork-action-unsupported">
                    当前 what-if 无法映射到支持的初始动作，请返回修改设定后重新预览。
                  </p>
                ) : initialAction.type === 'inform' ? (
                  <div className="mt-2 space-y-2">
                    <label className="block text-[11px] text-ink-faint" htmlFor="fork-action-recipient">接收居民</label>
                    <select id="fork-action-recipient" value={initialAction.recipientId}
                      onChange={event => setInitialAction({ ...initialAction, recipientId: event.target.value })}
                      disabled={forking} className="w-full rounded border border-ink-line px-2 py-1.5 text-xs text-ink-soft">
                      <option value="">选择居民</option>
                      {scenario.actionTargets?.residents.map(resident => <option key={resident.id} value={resident.id}>{resident.name}</option>)}
                    </select>
                    <label className="block text-[11px] text-ink-faint" htmlFor="fork-action-topic">消息主题</label>
                    <input id="fork-action-topic" value={initialAction.topic} maxLength={80}
                      onChange={event => setInitialAction({ ...initialAction, topic: event.target.value })}
                      disabled={forking} className="w-full rounded border border-ink-line px-2 py-1.5 text-xs text-ink-soft" />
                    <label className="block text-[11px] text-ink-faint" htmlFor="fork-action-content">消息内容</label>
                    <textarea id="fork-action-content" value={initialAction.content} maxLength={500} rows={3}
                      onChange={event => setInitialAction({ ...initialAction, content: event.target.value })}
                      disabled={forking} className="w-full rounded border border-ink-line px-2 py-1.5 text-xs text-ink-soft" />
                    <label className="block text-[11px] text-ink-faint" htmlFor="fork-action-source">消息来源</label>
                    <select id="fork-action-source" value={initialAction.sourceFactId ?? ''}
                      onChange={event => setInitialAction({ ...initialAction, sourceFactId: event.target.value || undefined })}
                      disabled={forking} className="w-full rounded border border-ink-line px-2 py-1.5 text-xs text-ink-soft">
                      <option value="">无来源（作为传闻）</option>
                      {scenario.sourceCandidates?.map(candidate => <option key={candidate.id} value={candidate.id}>
                        {candidate.label} · {candidate.certainty === 'fact' ? '事实' : '传闻'} · {formatWorldTime(candidate.simTime, current?.timeZone)}
                      </option>)}
                    </select>
                    <p className="text-[10px] text-ink-faint">引用来源会继承其事实/传闻级别；不选来源时消息按传闻记录。</p>
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    <label className="block text-[11px] text-ink-faint" htmlFor="fork-action-location">地点</label>
                    <select id="fork-action-location" value={initialAction.location}
                      onChange={event => setInitialAction({ ...initialAction, location: event.target.value })}
                      disabled={forking} className="w-full rounded border border-ink-line px-2 py-1.5 text-xs text-ink-soft">
                      <option value="">选择地点</option>
                      {scenario.actionTargets?.locations.map(location => <option key={location} value={location}>{location}</option>)}
                    </select>
                    <label className="block text-[11px] text-ink-faint" htmlFor="fork-action-condition">状态类别</label>
                    <select id="fork-action-condition" value={initialAction.condition}
                      onChange={event => setInitialAction({ ...initialAction, condition: event.target.value as 'weather' | 'lighting' | 'access' })}
                      disabled={forking} className="w-full rounded border border-ink-line px-2 py-1.5 text-xs text-ink-soft">
                      <option value="weather">天气</option><option value="lighting">照明</option><option value="access">通行</option>
                    </select>
                    <label className="block text-[11px] text-ink-faint" htmlFor="fork-action-value">目标状态（≤200 字）</label>
                    <input id="fork-action-value" value={initialAction.value} maxLength={200}
                      onChange={event => setInitialAction({ ...initialAction, value: event.target.value })}
                      disabled={forking} className="w-full rounded border border-ink-line px-2 py-1.5 text-xs text-ink-soft" />
                    <p className="text-[10px] text-ink-faint">会写入子线世界事实和事件；首版不联动图形、导航或物理规则。</p>
                  </div>
                )}
              </section>
              {forkError && <p role="alert" className="mt-2 text-xs text-red-600">{forkError}</p>}
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => { setForkError(''); setScenario(null); setStep('input') }}
                  disabled={forking}
                  className="text-xs text-ink-faint underline hover:text-ink-soft disabled:opacity-50"
                >
                  返回重写
                </button>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setForkOpen(false)} disabled={forking} className="rounded-lg border border-ink-line px-3 py-1.5 text-xs text-ink-soft disabled:opacity-50">取消</button>
                  <button type="button" onClick={() => void forkConfirmed()} disabled={forking || !initialAction} data-testid="fork-confirm" className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-50">{forking ? '创建中…' : '确认动作并创建分支'}</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
