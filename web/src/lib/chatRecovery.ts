import type { ChatRequestState } from '../api/types'

export type ChatRecoveryDecision = {
  kind: 'completed' | 'pending' | 'terminal'
  refreshHistory: true
  requiresNewRequestId: boolean
  message: string | null
}

/**
 * 将服务端终态翻译成 UI 行为。此函数刻意不依赖 React/DOM，避免客户端
 * 通过“是否收到完整 SSE”猜测消息是否成功。
 */
export function decideChatRecovery(
  request: Pick<ChatRequestState, 'status' | 'errorCode'>,
): ChatRecoveryDecision {
  if (request.status === 'completed') {
    return { kind: 'completed', refreshHistory: true, requiresNewRequestId: false, message: null }
  }
  if (request.status === 'pending') {
    return {
      kind: 'pending',
      refreshHistory: true,
      requiresNewRequestId: false,
      message: '消息已送达，服务端仍在处理中；正在恢复状态，请勿重复发送。',
    }
  }
  if (request.status === 'cancelled') {
    return {
      kind: 'terminal',
      refreshHistory: true,
      requiresNewRequestId: true,
      message: '这次请求已取消。如需重试，请重新发送并使用新的请求 ID。',
    }
  }
  return {
    kind: 'terminal',
    refreshHistory: true,
    requiresNewRequestId: true,
    message: request.errorCode === 'worker_lost'
      ? '处理进程已中断，这次请求没有生成回复。请重新发送；重试会使用新的请求 ID。'
      : '这次请求失败且没有生成回复。请重新发送；重试会使用新的请求 ID。',
  }
}
