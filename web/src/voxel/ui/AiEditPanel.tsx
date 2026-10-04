import { useState } from 'react'
import type { EditOperation } from '@possibility/voxel-contract'
import { EditPlanRequestError } from '../plan-edits'

export interface AiEditPanelProps {
  /** 调用规划器（产品层接 api；开发页可 stub），返回通过校验的操作 */
  planEdits(intent: string): Promise<EditOperation[]>
  onPreview(ops: EditOperation[]): void
  onConfirm(): void
  onCancel(): void
  pending: boolean
  error: string | null
}

/** AI 对话编辑窗：输入意图 → 幽灵预览 → 确认应用 / 取消丢弃（F17, AC14） */
export default function AiEditPanel({ planEdits, onPreview, onConfirm, onCancel, pending, error }: AiEditPanelProps) {
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; nextStep?: string; retryable: boolean } | null>(null)

  const submit = async () => {
    if (!intent.trim() || busy) return
    setBusy(true)
    try {
      const ops = await planEdits(intent.trim())
      setFailure(null)
      onPreview(ops)
    } catch (cause) {
      setFailure(cause instanceof EditPlanRequestError
        ? { message: cause.message, nextStep: cause.nextStep, retryable: cause.retryable }
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
        {error ?? failure?.message}
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
