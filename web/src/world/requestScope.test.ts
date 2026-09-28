import { describe, expect, it } from 'vitest'
import { RequestScopeController } from './requestScope'

describe('request scope guard', () => {
  it('invalidates stale timeline responses and aborts their requests', () => {
    const scopes = new RequestScopeController({ worldId: 'world-a', timelineId: 'main', spaceId: 'exterior' })
    const pending = scopes.create('request-1')
    expect(scopes.accepts(pending.scope)).toBe(true)
    scopes.update({ worldId: 'world-a', timelineId: 'fork', spaceId: 'exterior' })
    expect(pending.controller.signal.aborted).toBe(true)
    expect(scopes.accepts(pending.scope)).toBe(false)
  })
  it('accepts current responses across unchanged context updates', () => {
    const scopes = new RequestScopeController({ worldId: 'world-a', timelineId: 'main', spaceId: 'exterior' })
    const pending = scopes.create('request-2')
    scopes.update({ worldId: 'world-a', timelineId: 'main', spaceId: 'exterior' })
    expect(scopes.accepts(pending.scope)).toBe(true)
  })
})
