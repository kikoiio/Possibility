import { useMemo, useState, type ReactNode } from 'react'
import type {
  SceneIssue,
  SceneRepairChange,
  SceneRuleNote,
  SceneValidationReport,
  SceneValidationReportView,
} from '@possibility/voxel-contract'
import type { CompatibilityContinuation } from '../../scene/compatibility-store'

const PAGE_SIZE = 20
const RULE_NOTE_LIMIT = 64

interface Paged<T> { items: T[]; total: number; hasMore: boolean; countIsExact: boolean }

function issuesOf(report: SceneValidationReport | SceneValidationReportView | null | undefined): Paged<SceneIssue> | null {
  if (!report) return null
  const raw = report.issues
  if (Array.isArray(raw)) {
    return { items: raw, total: report.issueCount, hasMore: report.issueCount > raw.length, countIsExact: report.countIsExact }
  }
  return { items: raw.items, total: raw.total, hasMore: raw.hasMore, countIsExact: raw.countIsExact ?? report.countIsExact }
}

function notesOf(report: SceneValidationReport | SceneValidationReportView | null | undefined): { items: SceneRuleNote[]; total: number; hasMore: boolean } {
  const notes = report?.ruleNotes
  if (!notes) return { items: [], total: 0, hasMore: false }
  return { items: notes.items.slice(0, RULE_NOTE_LIMIT), total: notes.total, hasMore: notes.hasMore || notes.total > RULE_NOTE_LIMIT }
}

function useLocalPage<T>(items: T[]): { page: number; setPage: (page: number) => void; visible: T[]; pageCount: number } {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const bounded = Math.min(page, pageCount - 1)
  return { page: bounded, setPage, visible: items.slice(bounded * PAGE_SIZE, (bounded + 1) * PAGE_SIZE), pageCount }
}

const STATE_LABEL: Record<CompatibilityContinuation['state'], string> = {
  idle: '准备检查',
  checking: '正在检查场景…',
  diagnosed: '检查完成',
  building: '正在准备修复预览…',
  preview: '修复预览',
  submitting: '正在提交…',
  completed: '已完成',
  conflict: '依据已变化',
  unknown: '结果未知',
}

const ACTION_LABEL: Record<string, string> = {
  'sign-in': '请重新登录后再试',
  recheck: '请重新检查并预览',
  'review-repair': '请查看修复预览',
  'query-result': '请查询同一次请求的结果',
  'retry-same-request': '可以使用同一请求重试',
  return: '请返回后重试',
}

function purposeLabel(purpose: CompatibilityContinuation['purpose']): string {
  return purpose === 'restore-history' ? '恢复历史场景' : '修复当前场景'
}

function reportStatusLabel(status: SceneValidationReport['status']): string {
  return status === 'valid' ? '完整有效' : status === 'invalid' ? '发现阻断问题' : '检查未完成'
}

function changeKindLabel(kind: SceneRepairChange['kind']): string {
  switch (kind) {
    case 'move-asset': return '移动摆放'
    case 'remove-asset': return '移除摆放'
    case 'set-block': return '清理方块'
    case 'assign-placement-id': return '补齐摆放标识'
  }
}

function coordText(at: { x: number; y: number; z: number }): string {
  return `(${at.x}, ${at.y}, ${at.z})`
}

function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null
  return <div className="mt-2 flex items-center gap-2 text-xs text-[#748176]">
    <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} className="rounded-full border border-[#d4ded3] px-2 py-0.5 disabled:opacity-40">上一页</button>
    <span>{page + 1} / {pageCount}</span>
    <button type="button" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)} className="rounded-full border border-[#d4ded3] px-2 py-0.5 disabled:opacity-40">下一页</button>
  </div>
}

function IssueList({ issues }: { issues: Paged<SceneIssue> }) {
  const { page, setPage, visible, pageCount } = useLocalPage(issues.items)
  return <div>
    <h3 className="text-sm font-medium text-[#3f5646]">阻断问题（{issues.countIsExact ? issues.total : `至少 ${issues.total}`} 条）</h3>
    {!visible.length
      ? <p className="mt-2 text-xs text-[#798579]">没有加载到问题明细。</p>
      : <ul className="mt-2 space-y-2">{visible.map(issue => <li key={issue.id} className="rounded-lg border border-[#e4e8df] bg-white px-3 py-2">
        <p className="text-xs text-[#3f5646]">{issue.summary}</p>
        <p className="mt-1 text-[11px] text-[#859085]">
          {[issue.spaceId ? `空间 ${issue.spaceId}` : null, issue.at ? coordText(issue.at) : null, issue.origin === 'existing' ? '既存问题' : issue.origin === 'edit' ? '本次编辑' : '本次修复'].filter(Boolean).join(' · ')}
        </p>
        {issue.suggestion && <p className="mt-1 text-[11px] text-[#6b7a6f]">{issue.suggestion}</p>}
      </li>)}</ul>}
    <Pager page={page} pageCount={pageCount} onPage={setPage} />
    {issues.hasMore && <p className="mt-2 text-[11px] text-[#859085]">还有未显示的问题；未展示全部不影响检查结论。</p>}
  </div>
}

function ChangeList({ changes }: { changes: Paged<SceneRepairChange> }) {
  const { page, setPage, visible, pageCount } = useLocalPage(changes.items)
  return <div>
    <h3 className="text-sm font-medium text-[#3f5646]">本次修复变化（{changes.total} 项）</h3>
    {!visible.length
      ? <p className="mt-2 text-xs text-[#798579]">没有几何变化。</p>
      : <ul className="mt-2 space-y-2">{visible.map(change => <li key={change.id} className="rounded-lg border border-[#e4e8df] bg-white px-3 py-2">
        <p className="text-xs text-[#3f5646]">{changeKindLabel(change.kind)} · {change.summary}</p>
        <p className="mt-1 text-[11px] text-[#859085]">
          空间 {change.spaceId}
          {change.kind === 'move-asset' ? ` · ${coordText(change.from)} → ${coordText(change.to)}` : ''}
          {change.kind === 'set-block' ? ` · ${coordText(change.at)}` : ''}
        </p>
      </li>)}</ul>}
    <Pager page={page} pageCount={pageCount} onPage={setPage} />
    {changes.hasMore && <p className="mt-2 text-[11px] text-[#859085]">还有未显示的变化；最终以确认时的完整复验为准。</p>}
  </div>
}

function RuleNoteList({ report }: { report: SceneValidationReport | SceneValidationReportView | null | undefined }) {
  const notes = notesOf(report)
  if (!notes.items.length) return null
  return <div>
    <h3 className="text-sm font-medium text-[#3f5646]">规则说明</h3>
    <ul className="mt-2 space-y-1">{notes.items.map((note, index) => <li key={`${note.code}-${note.objectId}-${index}`} className="text-[11px] text-[#6b7a6f]">
      {note.message}（空间 {note.spaceId} · {coordText(note.at)}）
    </li>)}</ul>
    {notes.hasMore && <p className="mt-1 text-[11px] text-[#859085]">规则说明仅显示前 {RULE_NOTE_LIMIT} 条，共 {notes.total} 条。</p>}
  </div>
}

function SpaceProgress({ report }: { report: SceneValidationReport | SceneValidationReportView | null | undefined }) {
  if (!report) return null
  return <p className="text-[11px] text-[#859085]">
    已检查空间：{report.checkedSpaceIds.length ? report.checkedSpaceIds.join('、') : '无'}
    {report.pendingSpaceIds.length > 0 ? `；待检查：${report.pendingSpaceIds.join('、')}` : '；全部空间已检查'}
    {report.status === 'incomplete' ? '。检查未完成，不能确认保存。' : ''}
  </p>
}

export interface SceneCompatibilityPanelProps {
  continuation: CompatibilityContinuation
  /** 现有编辑权限；无权限时不展示任何会产生副作用的按钮 */
  canEdit: boolean
  /** 修复前后只读预览（preview 状态时由调用方挂载，保持单一视口实例） */
  preview?: ReactNode
  onBuild?: () => void
  onConfirm?: () => void
  onRecheck?: () => void
  onQueryResult?: () => void
  onClose: () => void
}

/** 场景兼容诊断与修复预览面板（只读展示；所有副作用都经回调交给会话层）。 */
export function SceneCompatibilityPanel({ continuation, canEdit, preview, onBuild, onConfirm, onRecheck, onQueryResult, onClose }: SceneCompatibilityPanelProps) {
  const { state, inspection, draft, failure, receipt, message } = continuation
  const busy = state === 'checking' || state === 'building' || state === 'submitting'
  const report = draft?.report ?? inspection?.report ?? failure?.report ?? null
  const issues = useMemo(() => issuesOf(report), [report])
  const changes = useMemo<Paged<SceneRepairChange> | null>(() => draft ? {
    items: draft.changes.items, total: draft.changes.total, hasMore: draft.changes.hasMore, countIsExact: true,
  } : null, [draft])

  return <div className="fixed inset-0 z-40 grid place-items-center bg-[#26382c]/25 p-4" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="场景兼容检查" className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-[#dfe4d9] bg-[#fffefa] p-5 shadow-xl" onClick={event => event.stopPropagation()}>
      <header className="flex items-center justify-between">
        <h2 className="font-story text-lg text-[#31483a]">{purposeLabel(continuation.purpose)}</h2>
        <button type="button" aria-label="关闭兼容检查" onClick={onClose} className="rounded-full px-3 py-1 text-[#748176]">关闭</button>
      </header>

      <p role="status" aria-live="polite" className="mt-2 text-sm text-[#496153]">{STATE_LABEL[state]}{busy ? ' 请稍候，重复点击不会启动第二份工作。' : ''}</p>
      {continuation.target?.kind === 'history' && <p className="mt-1 text-[11px] text-[#859085]">目标：历史版本 v{continuation.target.version}。确认只会新增一个当前版本，原历史保持不变。</p>}
      {continuation.source && <p className="mt-1 text-[11px] text-[#859085]">来源版本：v{continuation.source.version}</p>}

      {message && <p role="alert" className="mt-3 rounded-lg bg-[#f6f1e6] px-3 py-2 text-sm text-[#7a6844]">{message}</p>}
      {failure && <div role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2">
        <p className="text-sm text-red-700">{failure.message}</p>
        <p className="mt-1 text-[11px] text-red-600">{ACTION_LABEL[failure.action] ?? '请返回后重试'}。你的输入与目标已保留。</p>
      </div>}

      {report && <div className="mt-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-[#3f5646]">检查结果：{reportStatusLabel(report.status)}</h3>
          <SpaceProgress report={report} />
        </div>
        {issues && issues.total > 0 && <IssueList issues={issues} />}
        <RuleNoteList report={report} />
      </div>}

      {changes && <div className="mt-4"><ChangeList changes={changes} /></div>}

      {preview && <div className="mt-4 min-h-[280px]">{preview}</div>}

      {state === 'completed' && receipt && <div className="mt-4 rounded-lg bg-[#eef4ec] px-3 py-2">
        <p className="text-sm text-[#3f5646]">已保存为新版本 v{receipt.version}（{receipt.outcome === 'restored-history' ? '历史恢复' : '场景修复'}）。</p>
        <p className="mt-1 text-[11px] text-[#859085]">来源 v{receipt.source.version} · 规则 {receipt.rulesVersion}</p>
      </div>}

      <footer className="mt-5 flex flex-wrap items-center gap-2">
        {state === 'diagnosed' && inspection?.canCreateRepairDraft && canEdit &&
          <button type="button" disabled={busy} onClick={onBuild} className="rounded-full bg-[#496153] px-4 py-2 text-sm text-white disabled:opacity-40">构建修复预览</button>}
        {state === 'preview' && draft?.canConfirm && canEdit &&
          <button type="button" disabled={busy} onClick={onConfirm} className="rounded-full bg-[#496153] px-4 py-2 text-sm text-white disabled:opacity-40">确认保存为新版本</button>}
        {state === 'conflict' &&
          <button type="button" disabled={busy} onClick={onRecheck} className="rounded-full bg-[#496153] px-4 py-2 text-sm text-white disabled:opacity-40">重新检查</button>}
        {state === 'unknown' &&
          <button type="button" disabled={busy} onClick={onQueryResult} className="rounded-full bg-[#496153] px-4 py-2 text-sm text-white disabled:opacity-40">查询提交结果</button>}
        {!canEdit && (state === 'diagnosed' || state === 'preview') &&
          <p className="text-xs text-[#859085]">当前身份只能查看诊断，不能提交修复。</p>}
        <p className="w-full text-[11px] text-[#859085]">未确认前不会改动场景；关闭或取消都不会产生新版本。确认前服务端会再次完整检查。</p>
      </footer>
    </section>
  </div>
}
