import { Link } from 'react-router-dom'

interface Props {
  worldId: string
  /** 源（被分叉的）时间线 id——分屏左侧 */
  sourceId: string
  /** 新分叉出的时间线 id——分屏右侧 */
  newId: string
  onDismiss: () => void
  name?: string
  whatIf?: string
  onCompare?: () => void
  refreshError?: string
  onRetry?: () => void
}

/**
 * 分叉成功横幅（S2/F6）：切到新线后的「并排看看」入口。
 * 点击深链进 S1 分屏（左源右新，对齐轴原点=分叉点）；
 * 可忽略、可关闭、不阻塞；窄屏（sm 以下）整体隐藏。
 */
export default function ForkCompareHint({ worldId, sourceId, newId, onDismiss, name, whatIf, onCompare, refreshError, onRetry }: Props) {
  const to = `/worlds/${encodeURIComponent(worldId)}?timeline=${encodeURIComponent(sourceId)}&mode=possibility&right=${encodeURIComponent(newId)}`
  return (
    <div
      data-testid="fork-compare-hint"
      className="hidden items-center justify-between gap-3 rounded-xl border border-woad/30 bg-woad-soft/60 px-4 py-2.5 sm:flex"
    >
      <div className="min-w-0 text-xs text-woad-deep"><p>分叉成功 · {name || whatIf || '这条线已经开始另一种可能'}</p>{whatIf && <p className="mt-1">假设：{whatIf}</p>}{refreshError && <p role="status" className="mt-1">{refreshError}</p>}{refreshError && onRetry && <button onClick={onRetry} className="mt-1 underline">重试刷新时间线</button>}</div>
      <div className="flex shrink-0 items-center gap-2">
        {onCompare ? <button data-testid="fork-compare-hint-go" disabled={!!refreshError} onClick={onCompare} className="rounded-lg bg-woad-deep px-3 py-1.5 text-xs text-white disabled:opacity-50">直接比较</button> : <Link
          to={to}
          data-testid="fork-compare-hint-go"
          className="rounded-lg bg-woad-deep px-3 py-1.5 text-xs text-white"
        >
          并排看看
        </Link>}
        <button
          type="button"
          aria-label="关闭提示"
          data-testid="fork-compare-hint-dismiss"
          onClick={onDismiss}
          className="px-1 text-woad-deep/60 hover:text-woad-deep"
        >
          ×
        </button>
      </div>
    </div>
  )
}
