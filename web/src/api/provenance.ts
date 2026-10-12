import { apiFetch } from './client'
import type { MessageReceipt, ProvenanceAttempt, ProvenanceSnapshot } from './types'

function params(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value))
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

export const provenanceApi = {
  receipt: (worldId: string, commandId: string, timelineId: string, residentId: string) =>
    apiFetch<{ status: 'committed'; receipt: MessageReceipt } | { status: 'not_found' }>(
      `/api/worlds/${encodeURIComponent(worldId)}/provenance/receipts/${encodeURIComponent(commandId)}${params({ timelineId, residentId })}`,
    ),
  receiptById: (worldId: string, receiptId: string, timelineId: string, residentId: string) =>
    apiFetch<{ status: 'committed'; receipt: MessageReceipt } | { status: 'not_found' }>(
      `/api/worlds/${encodeURIComponent(worldId)}/provenance/receipts/by-id/${encodeURIComponent(receiptId)}${params({ timelineId, residentId })}`,
    ),
  evidence: (worldId: string, input: { timelineId: string; residentId: string; topic?: string; receiptId?: string; fromSimTime?: string; cursor?: string; limit?: number }) =>
    apiFetch<ProvenanceSnapshot>(`/api/worlds/${encodeURIComponent(worldId)}/provenance/evidence${params(input)}`),
  retryAttempt: (conversationId: string, responseId: string, attemptId: string) =>
    apiFetch<ProvenanceAttempt>(`/api/conversations/${encodeURIComponent(conversationId)}/provenance/responses/${encodeURIComponent(responseId)}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId }),
    }),
  attempt: (conversationId: string, responseId: string, attemptId: string) =>
    apiFetch<ProvenanceAttempt>(`/api/conversations/${encodeURIComponent(conversationId)}/provenance/responses/${encodeURIComponent(responseId)}/attempts/${encodeURIComponent(attemptId)}`),
}
