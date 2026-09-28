export type AccessKind = 'anonymous' | 'user' | 'guest'

export interface AnonymousAccessContext {
  kind: 'anonymous'
}

export interface UserAccessContext {
  kind: 'user'
  userId: string
  username: string
  ownerId: string
}

export interface GuestAccessContext {
  kind: 'guest'
  sessionId: string
  ownerId: string
  worldId: string
  generation: number
  expiresAt: string
}

export type AccessContext = AnonymousAccessContext | UserAccessContext | GuestAccessContext

export interface AccessVariables {
  access: AccessContext
}

export class AccessCredentialError extends Error {
  constructor(readonly code: 'invalid' | 'expired' | 'replaced' | 'claimed', message: string, readonly status: 401 | 409) {
    super(message)
    this.name = 'AccessCredentialError'
  }
}
