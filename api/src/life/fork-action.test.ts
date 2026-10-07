import { describe, expect, it } from 'vitest'
import { prepareForkAction, forkSourceCandidates } from './fork-action'
import { visibleKnowledgeForPerson } from '../agent/knowledge'
import type { ForkActionContext } from './fork-action'
import { WorldStateError } from '../world-state/types'
import type { worldFacts } from '../db/schema'

type Fact = typeof worldFacts.$inferSelect
const fact = (input: Partial<Fact> & Pick<Fact, 'id' | 'timelineId' | 'factType' | 'visibility' | 'valueJson'>): Fact => ({
  id: input.id, timelineId: input.timelineId, factType: input.factType, visibility: input.visibility,
  valueJson: input.valueJson, subjectId: input.subjectId ?? 'subject', version: input.version ?? 1,
  simTime: input.simTime ?? '2026-01-01T00:00:00.000Z',
  cloneSourceFactId: null,
  sourceCommandId: input.sourceCommandId ?? `cmd:${input.id}`, supersedesId: input.supersedesId ?? null,
})

const baseContext = (sourceFacts: Fact[] = []): ForkActionContext => ({
  recipientIds: new Set(['ada', 'bo']), locationNames: new Set(['Library', 'Cafe']), sourceFacts,
  allowedTimelineIds: new Set(['main']), sourceTimelineId: 'main', forkPointVersion: 4,
})

describe('F1 fork action preparation', () => {
  it('accepts each supported location environment category with world visibility', () => {
    for (const condition of ['weather', 'lighting', 'access'] as const) {
      const prepared = prepareForkAction({ type: 'environment', location: 'Library', condition, value: '状态' }, baseContext())
      expect(prepared.plan).toMatchObject({ factType: 'environment', visibility: 'world',
        subjectId: `Library:${condition}`, value: { location: 'Library', condition, value: '状态' } })
    }
  })

  it('keeps unreferenced messages private and marked as rumor', () => {
    const prepared = prepareForkAction({ type: 'inform', recipientId: 'bo', topic: '信件', content: '信在路上' }, baseContext())
    expect(prepared.plan).toMatchObject({ factType: 'knowledge', visibility: 'private',
      value: { recipientId: 'bo', topic: '信件', content: '信在路上', certainty: 'rumor', sourceFactId: null } })
    expect(prepared.plan.eventDescription).not.toContain('信在路上')
    expect(prepared.action).toEqual({ type: 'inform', recipientId: 'bo', topic: '信件', content: '信在路上' })
  })

  it('inherits fact/rumor certainty only through a valid visible source chain', () => {
    const proven = fact({ id: 'f-weather', timelineId: 'main', factType: 'environment', visibility: 'world',
      valueJson: JSON.stringify({ location: 'Library', condition: 'weather', value: '晴朗' }) })
    const rumor = fact({ id: 'f-rumor', timelineId: 'main', factType: 'knowledge', visibility: 'private',
      valueJson: JSON.stringify({ recipientId: 'ada', topic: '传闻', content: '有人见过信', certainty: 'rumor', sourceFactId: null }) })
    const context = baseContext([proven, rumor])
    const factMessage = prepareForkAction({ type: 'inform', recipientId: 'bo', topic: '天气', content: '图书馆晴朗', sourceFactId: proven.id }, context)
    const rumorMessage = prepareForkAction({ type: 'inform', recipientId: 'bo', topic: '传闻', content: '有人见过信', sourceFactId: rumor.id }, context)
    expect(factMessage.plan.value.certainty).toBe('fact')
    expect(factMessage.sourceChain).toEqual([proven.id])
    expect(rumorMessage.plan.value.certainty).toBe('rumor')
    expect(rumorMessage.sourceChain).toEqual([rumor.id])
  })

  it('rejects unsupported or invalid targets, lengths, and non-inheritable evidence', () => {
    const context = baseContext([fact({ id: 'sibling', timelineId: 'branch-b', factType: 'environment', visibility: 'world',
      valueJson: JSON.stringify({ location: 'Library', condition: 'weather', value: '雾' }) })])
    const invalidActions = [
      { type: 'environment', location: 'Outside', condition: 'weather', value: 'rain' },
      { type: 'environment', location: 'Library', condition: 'arbitrary', value: 'rain' },
      { type: 'environment', location: 'Library', condition: 'weather', value: ' '.repeat(201) },
      { type: 'inform', recipientId: 'outsider', topic: 'secret', content: 'body' },
      { type: 'inform', recipientId: 'bo', topic: 't'.repeat(81), content: 'body' },
      { type: 'inform', recipientId: 'bo', topic: 'secret', content: 'c'.repeat(501) },
      { type: 'inform', recipientId: 'bo', topic: 'secret', content: 'body', sourceFactId: 'sibling' },
      { type: 'future_action', value: 'not supported' },
    ]
    for (const action of invalidActions) expect(() => prepareForkAction(action, context)).toThrow(WorldStateError)
  })

  it('only lists evidence with a complete visible provenance chain', () => {
    const facts = [
      fact({ id: 'ok', timelineId: 'main', factType: 'environment', visibility: 'world', valueJson: '{"condition":"weather","value":"clear"}' }),
      fact({ id: 'private-other', timelineId: 'main', factType: 'knowledge', visibility: 'private', valueJson: '{"recipientId":"ada","topic":"t","content":"x","certainty":"fact"}' }),
      fact({ id: 'wrong-line', timelineId: 'branch-b', factType: 'environment', visibility: 'world', valueJson: '{"condition":"weather","value":"clear"}' }),
    ]
    expect(forkSourceCandidates(facts, new Set(['main']), 'main', 4).map(candidate => candidate.id)).toEqual(['ok', 'private-other'])
  })

  it('projects environment facts to resident evidence using readable category names', () => {
    const prepared = prepareForkAction({ type: 'environment', location: 'Library', condition: 'lighting', value: '明亮' }, baseContext())
    const projected = visibleKnowledgeForPerson([{ id: 'lighting', timelineId: 'fork', simTime: '2026-01-01T00:00:00Z',
      version: 1, factType: prepared.plan.factType, visibility: prepared.plan.visibility, value: prepared.plan.value }], 'ada')
    expect(projected).toMatchObject([{ kind: 'environment', certainty: 'fact', text: 'Library的照明：明亮' }])
  })
})
