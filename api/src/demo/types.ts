export interface DemoBaselineRecord {
  id: string
  worldId: string
  sceneVersion: number
  contentHash: string
  status: string
}

export interface GuestSessionResult {
  token?: string
  sessionId: string
  worldId: string
  timelineId: string
  generation: number
  expiresAt: string
  claimPending: boolean
}

export type ClaimResult =
  | { kind: 'claimed'; worldId: string; replayed: boolean }
  | { kind: 'already_claimed_elsewhere' }

export type ClaimOperationState = 'running' | 'failed' | 'succeeded'

export interface DemoClaimOperation {
  sandboxId: string
  requestId: string
  targetUserId: string
  epoch: number
  executionId: string | null
  executionNo: number
  state: ClaimOperationState
  leaseUntil: string | null
  candidateWorldId: string | null
  failureCode: string | null
  createdAt: string
  updatedAt: string
}

export interface ClaimExecution {
  sandboxId: string
  requestId: string
  targetUserId: string
  epoch: number
  executionId: string
  candidateWorldId: string
  leaseUntil: string
}

export interface ClaimSourceBinding {
  sessionId: string
  worldId: string
  generation: number
}

export interface ClaimRequest {
  requestId: string
  expectedEpoch: number
  expectedBinding: ClaimSourceBinding
}

export interface RecoverClaimRequest {
  requestId: string
  observedEpoch: number
  observedExecutionId: string | null
  expectedBinding: ClaimSourceBinding
}

export type ClaimStatus =
  | { kind: 'not-started'; epoch: number; safeToSwitch: false }
  | { kind: 'in-progress'; epoch: number; executionId?: string; recoveryAvailable: boolean; safeToSwitch: false }
  | { kind: 'retryable'; epoch: number; safeToSwitch: true }
  | { kind: 'claimed'; worldId: string; replayed: boolean }
  | { kind: 'conflict'; code: 'already_claimed_elsewhere' }
  | { kind: 'unavailable'; code: 'claim_unavailable' | 'source_changed' }
