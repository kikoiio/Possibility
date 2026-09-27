import type { PublicUniverseEvidence } from '../../api/types'

export default function EvidenceNotice({ evidence }: { evidence: PublicUniverseEvidence }) {
  if (evidence.level === 'complete') return null
  const message = evidence.level === 'upgradeable'
    ? '这条宇宙的历史证据正在等待安全升级。当前内容可阅读和对照，但运行、交谈、分叉与修改暂不可用。'
    : evidence.level === 'incomplete'
      ? '这条宇宙的历史证据不完整，已只读保留。你仍可浏览和对照；为避免污染历史，运行、交谈、分叉与修改已关闭。'
      : '这条宇宙尚未完成历史证据检查，当前仅可读取。'
  return <div role="status" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
    <strong className="mr-1">只读保护</strong>{message}
  </div>
}
