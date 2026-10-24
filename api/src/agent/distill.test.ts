import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../test/db'
import { users } from '../db/schema'
import { distillPerson } from './distill'

const NOW = '2026-10-01T00:00:00.000Z'
let closeFixture: (() => void) | undefined
afterEach(() => { closeFixture?.(); closeFixture = undefined })

describe('distillPerson provenance', () => {
  it('uses a deterministic provider and keeps explicit, inferred, and unknown content distinct', async () => {
    const fixture = createTestDb()
    closeFixture = fixture.close
    await fixture.db.insert(users).values({ id: 'u', username: 'u', passwordHash: 'x', createdAt: NOW })

    const output = JSON.stringify({
      name: '林清',
      model: {
        identity: [{ text: '住在杭州', provenance: 'known' }],
        behavior: [{ text: '遇事先列清单', provenance: 'inferred' }],
        skills: [{ text: '擅长修复旧书', provenance: 'unknown' }],
        unknowns: ['她不知道旧书是谁留下的'],
      },
      worldName: '旧书修复室',
      worldDescription: '一间日常工作室。',
      initialState: { location: '工作台', activity: '整理书页', mood: '专注', goal: '修复一本书' },
    })
    let providerCalls = 0
    let systemPrompt = ''
    const provider = {
      fetch: async (input: Request | string | URL) => {
        providerCalls++
        const request = input instanceof Request ? input : new Request(input)
        const body = await request.json() as { messages?: { role: string; content: string }[] }
        systemPrompt = body.messages?.find((message) => message.role === 'system')?.content ?? ''
        return Response.json({ choices: [{ message: { content: output } }] })
      },
    }
    fixture.env.LLM_PROVIDER = provider as unknown as NonNullable<typeof fixture.env.LLM_PROVIDER>

    const result = await distillPerson(fixture.env, fixture.db, 'u', '林清住在杭州。她不知道旧书是谁留下的。')

    expect(result.model.identity).toEqual([{ text: '住在杭州', provenance: 'known' }])
    expect(result.model.behavior).toEqual([{ text: '遇事先列清单', provenance: 'inferred' }])
    expect(result.model.skills).toEqual([{ text: '擅长修复旧书', provenance: 'inferred' }])
    expect(result.model.unknowns).toEqual(['她不知道旧书是谁留下的'])
    expect(systemPrompt).toContain('只有描述明确表达的模型内容才能标 "known"')
    expect(systemPrompt).toContain('来源不清楚或无法可靠判断时也选 "inferred"')
    expect(systemPrompt).toContain('独立 unknowns')
    expect(providerCalls).toBe(1)
  })
})
