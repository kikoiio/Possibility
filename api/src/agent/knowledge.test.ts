import { describe, expect, it } from 'vitest'
import type { worldFacts } from '../db/schema'
import { validateKnowledgeChain, visibleKnowledgeForPerson } from './knowledge'

type Fact = typeof worldFacts.$inferSelect

function fact(id: string, factType: string, value: Record<string, unknown>, overrides: Partial<Fact> = {}): Fact {
  return {
    id,
    timelineId: 'main',
    version: 1,
    simTime: '2026-09-21T08:00:00.000Z',
    factType,
    subjectId: 'subject',
    valueJson: JSON.stringify(value),
    sourceCommandId: `command:${id}`,
    visibility: factType === 'knowledge' ? 'private' : 'world',
    supersedesId: null,
    ...overrides,
  }
}

describe('knowledge provenance validation', () => {
  it('allows a direct rumor but not a source-free fact claim', () => {
    const rumor = { recipientId: 'ada', topic: 'key', content: 'Maybe outside', certainty: 'rumor' as const, sourceFactId: null }
    expect(validateKnowledgeChain(rumor, [])).toMatchObject({ ok: true, certainty: 'rumor' })
    expect(validateKnowledgeChain({ ...rumor, certainty: 'fact' }, [])).toEqual({ ok: false, reasonCode: 'certainty_upgrade' })
  })

  it('preserves fact certainty from a visible world fact', () => {
    const source = fact('weather', 'environment', { condition: 'weather', value: 'rain' })
    expect(validateKnowledgeChain({ recipientId: 'ada', topic: 'weather', content: 'It rains',
      certainty: 'fact', sourceFactId: source.id }, [source])).toMatchObject({ ok: true, sourceChain: ['weather'] })
  })

  it('keeps a rumor a rumor across multiple relays', () => {
    const first = fact('first', 'knowledge', { recipientId: 'ada', topic: 'key', content: 'Maybe outside',
      certainty: 'rumor', sourceFactId: null })
    const second = fact('second', 'knowledge', { recipientId: 'bo', topic: 'key', content: 'Ada heard it may be outside',
      certainty: 'rumor', sourceFactId: 'first' }, { version: 2 })
    expect(validateKnowledgeChain({ recipientId: 'cy', topic: 'key', content: 'Bo repeated the rumor',
      certainty: 'rumor', sourceFactId: 'second' }, [first, second])).toMatchObject({
      ok: true, certainty: 'rumor', sourceChain: ['second', 'first'],
    })
    expect(validateKnowledgeChain({ recipientId: 'cy', topic: 'key', content: 'Claimed as fact',
      certainty: 'fact', sourceFactId: 'second' }, [first, second])).toEqual({ ok: false, reasonCode: 'certainty_upgrade' })
  })

  it('rejects cycles, broken chains, and facts from a non-visible timeline', () => {
    const first = fact('first', 'knowledge', { recipientId: 'ada', topic: 'loop', content: 'A',
      certainty: 'rumor', sourceFactId: 'second' })
    const second = fact('second', 'knowledge', { recipientId: 'bo', topic: 'loop', content: 'B',
      certainty: 'rumor', sourceFactId: 'first' }, { version: 2 })
    const assertion = { recipientId: 'cy', topic: 'loop', content: 'C', certainty: 'rumor' as const, sourceFactId: 'first' }
    expect(validateKnowledgeChain(assertion, [first, second])).toEqual({ ok: false, reasonCode: 'source_cycle' })
    expect(validateKnowledgeChain({ ...assertion, sourceFactId: 'missing' }, [first, second]))
      .toEqual({ ok: false, reasonCode: 'source_missing' })
    expect(validateKnowledgeChain(assertion, [{ ...first, timelineId: 'foreign', valueJson: JSON.stringify({
      recipientId: 'ada', topic: 'loop', content: 'A', certainty: 'rumor', sourceFactId: null,
    }) }], { allowedTimelineIds: new Set(['main']) }))
      .toEqual({ ok: false, reasonCode: 'source_timeline_forbidden' })
  })

  it('exposes private knowledge only to its recipient and world facts to everyone', () => {
    const canary = 'private-canary-731'
    const views = [
      { id: 'weather', factType: 'environment', visibility: 'world',
        value: { location: 'Cafe', condition: 'weather', value: 'rain' } },
      { id: 'ada-secret', factType: 'knowledge', visibility: 'private',
        value: { recipientId: 'ada', topic: 'secret', content: canary, certainty: 'rumor' } },
      { id: 'bad-public-secret', factType: 'knowledge', visibility: 'world',
        value: { recipientId: 'ada', topic: 'bad', content: 'must-not-render', certainty: 'fact' } },
    ]
    expect(JSON.stringify(visibleKnowledgeForPerson(views, 'ada'))).toContain(canary)
    expect(JSON.stringify(visibleKnowledgeForPerson(views, 'bo'))).not.toContain(canary)
    expect(JSON.stringify(visibleKnowledgeForPerson(views, 'ada'))).not.toContain('must-not-render')
    expect(visibleKnowledgeForPerson(views, 'bo')).toContainEqual(expect.objectContaining({
      sourceFactId: 'weather', certainty: 'fact',
    }))
  })

  it('rejects a private non-knowledge record as a provenance source', () => {
    const privateMemory = fact('private-memory', 'memory_maintenance', { content: 'secret' }, {
      visibility: 'private',
    })
    expect(validateKnowledgeChain({ recipientId: 'ada', topic: 'secret', content: 'secret', certainty: 'fact',
      sourceFactId: privateMemory.id }, [privateMemory])).toEqual({ ok: false, reasonCode: 'source_visibility_forbidden' })
  })
})
