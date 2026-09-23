import { describe, expect, it } from 'vitest'
import { resolveIntentOutput } from './resolve'
import type { IntentContext } from './types'

const context: IntentContext = {
  text: '带我去图书馆，然后告诉 Ada 暴雨开始了。',
  currentLocation: 'Cafe',
  locations: ['Cafe', 'Library'],
  residents: [{ id: 'ada', name: 'Ada' }],
}

describe('bounded action intent resolution', () => {
  it('accepts a listed destination and requires confirmation', () => {
    expect(resolveIntentOutput({ type: 'move', to: 'Library' }, context)).toEqual({
      status: 'proposal', proposal: { type: 'move', to: 'Library' }, confirmationRequired: true,
    })
  })

  it('accepts only a co-located resident and a literal excerpt of the visitor message', () => {
    expect(resolveIntentOutput({ type: 'inform', recipientId: 'ada', topic: 'weather', content: '暴雨开始了' }, context))
      .toMatchObject({ status: 'proposal', confirmationRequired: true, proposal: { recipientName: 'Ada', content: '暴雨开始了' } })
    expect(resolveIntentOutput({ type: 'inform', recipientId: 'ada', topic: 'weather', content: '政府宣布全城撤离' }, context).status)
      .toBe('clarification')
  })

  it('clarifies ambiguous and out-of-bounds model outputs rather than creating capabilities', () => {
    expect(resolveIntentOutput({ type: 'move', to: 'Secret Lab' }, context).status).toBe('clarification')
    expect(resolveIntentOutput({ type: 'move', to: 'Cafe' }, context).status).toBe('clarification')
    expect(resolveIntentOutput({ type: 'inform', recipientId: 'not-here', topic: 'x', content: '暴雨开始了' }, context).status)
      .toBe('clarification')
    expect(resolveIntentOutput({ type: 'environment', location: 'Cafe', condition: 'weather', value: 'storm' }, context).status)
      .toBe('clarification')
    expect(resolveIntentOutput(null, context).status).toBe('clarification')
  })

  it('preserves explicit clarification or rejection from the resolver', () => {
    expect(resolveIntentOutput({ type: 'clarify', question: '你要去哪里？' }, context))
      .toEqual({ status: 'clarification', question: '你要去哪里？' })
    expect(resolveIntentOutput({ type: 'reject', reason: '这个行动不在范围内' }, context))
      .toEqual({ status: 'rejected', reason: '这个行动不在范围内' })
  })
})
