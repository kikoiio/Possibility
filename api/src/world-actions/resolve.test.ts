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
    expect(resolveIntentOutput({ type: 'inform', recipientId: 'ada', topic: 'weather', content: '政府宣布全城撤离' }, context))
      .toMatchObject({ status: 'clarification', question: '传话内容必须摘自你刚才写下的话，请补充要告诉对方的原句。' })
  })

  it('explains unavailable destinations and offers only valid alternatives', () => {
    expect(resolveIntentOutput({ type: 'move', to: 'Secret Lab' }, context)).toEqual({
      status: 'clarification',
      question: '“Secret Lab”不是当前有效地点。当前可前往：Library。',
      alternatives: { locations: ['Library'], residents: [{ id: 'ada', name: 'Ada' }] },
    })
    expect(resolveIntentOutput({ type: 'move', to: 'Cafe' }, context))
      .toMatchObject({ status: 'clarification', question: '你已经在Cafe，请选择其他有效地点。' })
  })

  it('explains when the requested resident is absent and lists present residents', () => {
    expect(resolveIntentOutput({ type: 'inform', recipientId: 'not-here', topic: 'x', content: '暴雨开始了' }, context))
      .toMatchObject({
        status: 'clarification',
        question: '指定居民当前不在Cafe现场。当前可传话给：Ada。',
        alternatives: { residents: [{ id: 'ada', name: 'Ada' }] },
      })
  })

  it('does not invent alternatives when no destination or resident is available', () => {
    const emptyContext = { ...context, locations: ['Cafe'], residents: [] }
    expect(resolveIntentOutput({ type: 'move', to: 'Garden' }, emptyContext)).toEqual({
      status: 'clarification',
      question: '“Garden”不是当前有效地点，而且现在没有其他可前往地点。',
    })
    expect(resolveIntentOutput({ type: 'inform', recipientId: 'absent', topic: 'x', content: '暴雨开始了' }, emptyContext))
      .toMatchObject({ status: 'clarification', question: '当前Cafe没有可传话的居民。' })
  })

  it('clarifies ambiguous and out-of-bounds model outputs rather than creating capabilities', () => {
    expect(() => resolveIntentOutput({ type: 'environment', location: 'Cafe', condition: 'weather', value: 'storm' }, context))
      .toThrow()
    expect(() => resolveIntentOutput(null, context)).toThrow()
  })

  it('preserves explicit clarification or rejection and adds server-supplied alternatives', () => {
    expect(resolveIntentOutput({ type: 'clarify', question: '你要去哪里？' }, context))
      .toEqual({
        status: 'clarification', question: '你要去哪里？',
        alternatives: { locations: ['Library'], residents: [{ id: 'ada', name: 'Ada' }] },
      })
    expect(resolveIntentOutput({ type: 'reject', reason: '这个行动不在范围内' }, context))
      .toEqual({
        status: 'rejected', reason: '这个行动不在范围内',
        alternatives: { locations: ['Library'], residents: [{ id: 'ada', name: 'Ada' }] },
      })
  })
})
