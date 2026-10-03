import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt'
import type { AgentContextData } from './context'

const context = {
  person: { name: 'Ada' },
  model: { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] },
  world: { name: 'World', description: '', timeZone: 'America/Los_Angeles' },
  timeline: { simNow: '2026-01-01T00:30:00.000Z', parentTimelineId: null },
  state: { simTime: '2026-01-01T00:30:00.000Z', location: 'Cafe', activity: 'Reading', mood: 'Calm', goal: 'Rest' },
  memories: [], knownFacts: [], mode: 'chat',
} as unknown as AgentContextData

describe('system prompt world time', () => {
  it('renders the absolute simulation instant in the world zone with its zone label', () => {
    expect(buildSystemPrompt(context)).toContain('现在的时间：2025-12-31 16:30 (America/Los_Angeles)')
  })

  it('uses the timeline clock even when a resident state has not caught up', () => {
    const stale = { ...context, state: { ...context.state, simTime: '2025-01-01T00:00:00Z' } }
    expect(buildSystemPrompt(stale)).toContain('现在的时间：2025-12-31 16:30 (America/Los_Angeles)')
  })

  it('uses UTC for legacy worlds without a configured zone', () => {
    const legacy = { ...context, world: { ...context.world, timeZone: null } } as unknown as AgentContextData
    expect(buildSystemPrompt(legacy)).toContain('现在的时间：2026-01-01 00:30 (UTC)')
  })
})
