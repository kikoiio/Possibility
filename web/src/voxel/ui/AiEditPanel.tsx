import { useState } from 'react'
import type { EditOperation, SceneValidationReportView } from '@possibility/voxel-contract'
import { EditPlanRequestError, type EditPlan } from '../plan-edits'
import type { PreflightBasis } from '../bridge/edit-controller'

export interface AiEditPanelProps {
  /** 调用规划器（产品层接 api；开发页可 stub），返回通过服务端完整预检的操作与依据 */
  planEdits(intent: string): Promise<EditPlan>
  onPreview(ops: EditOperation[], basis: PreflightBasis | null): void
  onConfirm(): void
  onCancel(): void
  pending: boolean
  error: string | null
}

const KIND_STAGE: Record<string, string> = {
  compatibility: '场景兼容检查',
  conflict: '依据冲突',
  budget: '额度',
  permission: '权限',
  config: '模型配置',
  planning: '规划',
}

/** AI 对话编辑窗：输入意图 → 幽灵预览 → 确认应用 / 取消丢弃（F17, AC14） */
export default function AiEditPanel({ planEdits, onPreview, onConfirm, onCancel, pending, error }: AiEditPanelProps) {
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; nextStep?: string; retryable: boolean; stage?: string; report?: SceneValidationReportView } | null>(null)

  const submit = async () => {
    if (!intent.trim() || busy) return
    setBusy(true)
    try {
      // A1(W21):规划期间输入文字保留;失败只更新反馈,不清空意图
      const plan = await planEdits(intent.trim())
      setFailure(null)
      onPreview(plan.ops, plan.previewBasis)
    } catch (cause) {
      setFailure(cause instanceof EditPlanRequestError
        ? { message: cause.message, nextStep: cause.nextStep, retryable: cause.retryable, stage: KIND_STAGE[cause.kind], report: cause.report }
        : { message: 'AI 改造暂时失败，请稍后重试。', retryable: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-72 flex-col gap-2 rounded bg-black/60 p-3 text-xs text-zinc-200" data-testid="voxel-ai-edit">
      <div className="font-medium text-zinc-100">AI 改造</div>
      <textarea
        data-testid="voxel-ai-input"
        className="h-16 resize-none rounded bg-zinc-800 p-2 text-zinc-100 outline-none placeholder:text-zinc-500"
        placeholder="描述你想要的改动，如：在庭院里加一座石灯笼"
        value={intent}
        onChange={(e) => {
          setIntent(e.target.value)
          setFailure(null)
        }}
      />
      <button
        data-testid="voxel-ai-preview"
        className="rounded bg-sky-600 px-2 py-1.5 text-white disabled:opacity-50"
        disabled={busy || !intent.trim()}
        onClick={() => void submit()}
      >
        {busy ? '规划中…' : failure?.retryable ? '重试生成预览' : '生成预览'}
      </button>
      {(error || failure) && <div className="rounded bg-red-900/60 p-2 text-red-200" data-testid="voxel-ai-error" role="status">
        {failure?.stage && <span className="mr-1 rounded bg-red-800/80 px-1 py-0.5 text-[10px] text-red-100">{failure.stage}</span>}
        {error ?? failure?.message}
        {failure?.report?.issues.items.length ? <ul className="mt-2 list-disc space-y-1 pl-5" aria-label="改造方案诊断">
          {failure.report.issues.items.slice(0, 5).map(issue => <li key={issue.id}>
            {[issue.spaceId ? `空间 ${issue.spaceId}` : null, issue.at ? `(${issue.at.x}, ${issue.at.y}, ${issue.at.z})` : null].filter(Boolean).join(' · ')}
            {[issue.spaceId, issue.at].some(Boolean) ? '：' : ''}{issue.summary} 建议：{issue.suggestion}
          </li>)}
          {failure.report.issues.total > failure.report.issues.items.length && <li>其余 {failure.report.issues.total - failure.report.issues.items.length} 项诊断未展开。</li>}
        </ul> : null}
        {failure?.nextStep && <p className="mt-1 text-red-100/80">{failure.nextStep}</p>}
      </div>}
      {pending && (
        <div className="flex gap-1" data-testid="voxel-ai-pending">
          <button data-testid="voxel-ai-confirm" className="flex-1 rounded bg-emerald-600 px-2 py-1.5 text-white" onClick={onConfirm}>
            确认应用
          </button>
          <button data-testid="voxel-ai-cancel" className="flex-1 rounded bg-zinc-600 px-2 py-1.5" onClick={onCancel}>
            取消
          </button>
        </div>
      )}
    </div>
  )
}
