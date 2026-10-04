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
