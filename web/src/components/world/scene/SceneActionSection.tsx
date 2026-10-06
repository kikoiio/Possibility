import type { Persona } from '../../../api/types'

export interface IntentProposalData {
  status: string
  requestId: string
  expectedVersion: number
  proposal?: {
    type: 'move' | 'inform'
    to?: string
    recipientId?: string
    recipientName?: string
    topic?: string
    content?: string
  }
  alternatives?: {
    locations: string[]
    residents: { id: string; name: string }[]
  }
}

export interface SceneActionSectionProps {
  persona: Persona
  location: string
  actionLocations: { name: string; description: string }[]
  peopleByLocation: Record<string, { id: string; name: string }[]>
  example: string | null
  actionBlocked: string | null

  // Inform state & handlers
  infoRecipient: string
  setInfoRecipient: (v: string) => void
  infoTopic: string
  setInfoTopic: (v: string) => void
  infoContent: string
  setInfoContent: (v: string) => void
  infoBusy: boolean
  infoNotice: string
  handleInform: () => Promise<void>

  // Intent state & handlers
  intentText: string
  onIntentTextChange: (text: string) => void
  intentBusy: boolean
  busy: boolean
  intentNeedsRetry: boolean
  intentRetryError: string
  intentProposal: IntentProposalData | null
  intentNotice: string
  intentLoginRequired: boolean
  handleResolveIntent: () => Promise<void>
  handleRefreshIntent: () => Promise<void>
  handleConfirmIntent: () => Promise<void>
  handleCancelIntent: () => void
}

export default function SceneActionSection({
  persona,
  location,
  actionLocations,
  peopleByLocation,
  example,
  actionBlocked,
  infoRecipient,
  setInfoRecipient,
  infoTopic,
  setInfoTopic,
  infoContent,
  setInfoContent,
  infoBusy,
  infoNotice,
  handleInform,
  intentText,
  onIntentTextChange,
  intentBusy,
  busy,
  intentNeedsRetry,
  intentRetryError,
  intentProposal,
  intentNotice,
  intentLoginRequired,
  handleResolveIntent,
  handleRefreshIntent,
  handleConfirmIntent,
  handleCancelIntent,
}: SceneActionSectionProps) {
  return (
    <>
      <details className="border-t border-ink-line/60 px-4 py-2">
        <summary className="cursor-pointer text-xs text-ink-soft">明确告诉现场某人一条消息</summary>
        <p className="mt-1 text-[11px] text-ink-faint">
          这是可追踪的当面传话；对方会记为传闻。普通聊天不会自动变成已证实事实。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            aria-label="消息接收者"
            value={infoRecipient}
            onChange={(e) => setInfoRecipient(e.target.value)}
            className="rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs"
          >
            <option value="">选择现场的人</option>
            {(peopleByLocation[location] ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            aria-label="消息主题"
            value={infoTopic}
            onChange={(e) => setInfoTopic(e.target.value)}
            placeholder="消息主题"
            maxLength={80}
            className="min-w-0 flex-1 rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs"
          />
          <input
            aria-label="消息内容"
            value={infoContent}
            onChange={(e) => setInfoContent(e.target.value)}
            placeholder="你要告诉 TA 什么"
            maxLength={500}
            className="min-w-0 flex-[2] rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs"
          />
          <button
            onClick={() => void handleInform()}
            disabled={
              infoBusy ||
              !persona.location ||
              persona.location !== location ||
              !infoRecipient ||
              !infoTopic.trim() ||
              !infoContent.trim()
            }
            className="rounded-lg bg-ink px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            告诉 TA
          </button>
        </div>
        {infoNotice && <p className="mt-2 text-xs text-ink-soft">{infoNotice}</p>}
      </details>

      <details className="max-h-[45vh] shrink-0 overflow-y-auto border-t border-ink-line/60 px-4 py-2">
        <summary className="cursor-pointer text-xs text-ink-soft">尝试一个行动</summary>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          可以前往当前有效地点，或告诉现场居民一条消息。系统会先生成提议，只有你确认后才会执行。普通聊天不会自动改变世界。
        </p>
        <p className="mt-1 text-[11px] text-ink-faint">
          当前有效地点：{actionLocations.length ? actionLocations.map((item) => item.name).join('、') : '暂无'}
        </p>
        {example ? (
          <p className="mt-1 text-[11px] text-ink-faint">示例：{example}</p>
        ) : (
          <p className="mt-1 text-[11px] text-ink-faint">
            暂时没有可用的行动示例。请进入其他有效地点，或等待现场出现可交谈的居民后刷新。
          </p>
        )}
        {actionBlocked && (
          <p role="status" className="mt-2 text-xs leading-relaxed text-ink-soft">
            {actionBlocked}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            aria-label="行动描述"
            value={intentText}
            disabled={intentBusy}
            onChange={(e) => onIntentTextChange(e.target.value)}
            maxLength={1000}
            placeholder={example ?? '描述你想去的地点或要告诉现场居民的消息'}
            className="min-w-0 flex-[1_1_12rem] rounded-lg border border-ink-line bg-sheet px-2 py-1 text-xs"
          />
          <button
            onClick={() => void handleResolveIntent()}
            disabled={intentBusy || busy || !!actionBlocked || !!intentRetryError || !intentText.trim()}
            className="rounded-lg bg-ink px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {intentBusy && !intentProposal ? '整理中…' : intentNeedsRetry ? '重新生成提议' : '生成提议'}
          </button>
          {(intentNeedsRetry || actionBlocked || intentRetryError) && (
            <button
              onClick={() => void handleRefreshIntent()}
              disabled={intentBusy}
              className="rounded-lg border border-ink-line px-3 py-1 text-xs text-ink-soft disabled:opacity-50"
            >
              刷新行动状态
            </button>
          )}
        </div>
        {intentRetryError && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {intentRetryError}
          </p>
        )}
        {intentProposal?.status === 'proposal' && intentProposal.proposal && (
          <div className="mt-2 rounded-lg border border-ink-line bg-sheet p-3 text-xs">
            <p className="text-ink-soft">提议（世界状态 v{intentProposal.expectedVersion}）</p>
            <p className="mt-1 text-ink">
              {intentProposal.proposal.type === 'move'
                ? `前往${intentProposal.proposal.to}`
                : `告诉${intentProposal.proposal.recipientName}：「${intentProposal.proposal.content}」`}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void handleConfirmIntent()}
                disabled={intentBusy || !!actionBlocked}
                className="rounded-lg bg-ink px-3 py-1 text-white disabled:opacity-50"
              >
                {intentBusy ? '提交中…' : '确认执行'}
              </button>
              <button
                onClick={handleCancelIntent}
                disabled={intentBusy}
                className="rounded-lg border border-ink-line px-3 py-1 text-ink-soft"
              >
                取消
              </button>
            </div>
          </div>
        )}
        {intentNotice && (
          <p role="status" className="mt-2 text-xs leading-relaxed text-ink-soft">
            {intentNotice}
          </p>
        )}
        {intentLoginRequired && (
          <a href="/login" target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-ink underline">
            在新标签页重新登录
          </a>
        )}
        {intentProposal?.alternatives && (
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            {intentProposal.alternatives.locations.length > 0 && (
              <>当前可前往：{intentProposal.alternatives.locations.join('、')}。 </>
            )}
            {intentProposal.alternatives.residents.length > 0 && (
              <>当前可传话给：{intentProposal.alternatives.residents.map((person) => person.name).join('、')}。</>
            )}
          </p>
        )}
      </details>
    </>
  )
}
