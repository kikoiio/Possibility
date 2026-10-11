import type { GuestClaimFlow } from '../../guest/claim-flow'
import { useGuestClaim } from '../../guest/use-guest-claim'

export interface GuestClaimStatusPanelProps {
  flow: GuestClaimFlow
  onReturnGuest?: () => void
  onStartNew?: () => void
  onSwitchAccount?: () => void
}
// End of the shared claim status panel.
function copyForPhase(phase: ReturnType<GuestClaimFlow['getState']>['phase']): { title: string; detail: string } {
  switch (phase) {
    case 'saving': return { title: '正在保存访客副本', detail: '请保持页面打开。完成后会进入保存的世界。' }
    case 'unknown': case 'checking': return { title: '保存结果尚未确认', detail: '请先核实结果。确认前不会切换账号或创建替代副本。' }
    case 'retryable': return { title: '可以重试保存', detail: '原访客副本仍保留，点击重试才会再次提交。' }
    case 'conflict': return { title: '副本已保存到其他账号', detail: '当前账号无法读取保存结果。原访客凭证仍按安全规则保留。' }
    case 'unavailable': return { title: '原访客副本暂时不可用', detail: '请返回原副本或在确认不可恢复后开始新的体验。' }
    case 'storage-error': return { title: '无法保存恢复信息', detail: '浏览器存储不可用。请保留当前页面，修复存储后再继续。' }
    case 'completed': return { title: '访客副本已保存', detail: '保存结果已确认，可以进入保存的世界。' }
    case 'confirm-account': return { title: '确认保存目标账号', detail: '点击保存到此账号后才会提交认领。' }
    case 'needs-auth': return { title: '登录后保存副本', detail: '登录或注册成功后会继续保存当前访客副本。' }
  }
}
// End of the shared claim status panel.
/** Shared, intentionally small action surface for Login and recovery pages. */
export default function GuestClaimStatusPanel({ flow, onReturnGuest, onStartNew, onSwitchAccount }: GuestClaimStatusPanelProps) {
  const state = useGuestClaim(flow)
  const copy = copyForPhase(state.phase)
  const canSave = state.phase === 'confirm-account' || state.phase === 'retryable'
  const canVerify = state.phase === 'unknown' || state.phase === 'checking' || state.phase === 'saving'
  const canRecover = state.phase === 'unknown' || state.phase === 'checking'
  return (
    <section aria-live="polite" className="mt-4 rounded-lg border border-ink-line bg-paper p-4 text-sm text-ink-soft">
      <h2 className="font-medium text-ink">{copy.title}</h2>
      <p className="mt-1">{state.message ?? copy.detail}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {canSave && <button type="button" onClick={() => void flow.confirmAndSave()} className="rounded-lg bg-ink px-3 py-2 text-white">保存到此账号</button>}
        {canVerify && <button type="button" onClick={() => void flow.refreshStatus()} className="rounded-lg border border-ink-line px-3 py-2">核实结果</button>}
        {canRecover && <button type="button" onClick={() => void flow.recover()} className="rounded-lg border border-ink-line px-3 py-2">主动恢复</button>}
        {state.phase === 'retryable' && <button type="button" onClick={() => void flow.confirmAndSave()} className="rounded-lg bg-ink px-3 py-2 text-white">重试保存</button>}
        {state.phase === 'unknown' && onSwitchAccount && <button type="button" onClick={() => void flow.prepareAccountSwitch().then(ok => { if (ok) onSwitchAccount() })} className="rounded-lg border border-ink-line px-3 py-2">切换账号</button>}
        {onReturnGuest && <button type="button" onClick={onReturnGuest} className="rounded-lg border border-ink-line px-3 py-2">返回原访客副本</button>}
        {onStartNew && state.phase === 'unavailable' && <button type="button" onClick={onStartNew} className="rounded-lg border border-ink-line px-3 py-2">开始新体验</button>}
      </div>
    </section>
  )
}
// End of the shared claim status panel.
