export type InformRecoveryStatus = 'committed' | 'not_found' | 'unknown'

export type InformRecoveryDecision =
  | { kind: 'committed'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'pending'; message: string }

/** Network failure never becomes a client-side claim that the message was not sent. */
export function decideInformRecovery(status: InformRecoveryStatus): InformRecoveryDecision {
  if (status === 'committed') return { kind: 'committed', message: '这条传话已经提交；已恢复同一条接收回执。' }
  if (status === 'not_found') return { kind: 'retryable', message: '当前没有查到已提交回执；请确认世界状态后再重新传话。' }
  return { kind: 'pending', message: '提交结果暂时无法确认；请稍后查询回执，不要重复点击。' }
}
