export type ClaimErrorKind = 'auth' | 'unknown' | 'temporary' | 'conflict' | 'unavailable'

export function claimErrorCopy(kind: ClaimErrorKind): { code: string; message: string } {
  switch (kind) {
    case 'auth': return { code: 'authentication_required', message: '请重新登录后继续保存。' }
    case 'unknown': return { code: 'claim_unconfirmed', message: '保存结果尚未确认，请先核实结果。' }
    case 'conflict': return { code: 'already_claimed_elsewhere', message: '这份访客副本已由其他账号保存。' }
    case 'unavailable': return { code: 'claim_unavailable', message: '原访客副本暂时无法恢复。' }
    default: return { code: 'claim_failed', message: '演示世界暂时无法保存，请稍后重试。' }
  }
}
