import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { memories, persons, personStates, worldCommands, worldFacts, worldPersons, events } from '../../db/schema'
import { createWorldFixture, WORLD_TIME } from '../../test/world-fixture'
import { applyBeatOutput, normalizeBeatJson } from './beat'

const LOCS = ['大厅', '图书室']

describe('normalizeBeatJson（beat 输出校验）', () => {
  it('正常解析：事件/想法/记忆/下一地点', () => {
    const beat = normalizeBeatJson(
      {
        events: [{ title: '擦器械', description: '把出诊箱擦净', offsetMin: 10 }],
        thought: '心里放不下那桩旧事',
        memory: { content: '怜在查旧报', type: 'relationship', importance: 7 },
        nextLocation: '图书室',
        nextActivity: '翻旧报',
        mood: '凝重',
        goal: '弄清三十年前那页',
      },
      LOCS,
      60,
    )
    expect(beat.events).toEqual([{ title: '擦器械', description: '把出诊箱擦净', offsetMin: 10 }])
    expect(beat.thought).toBe('心里放不下那桩旧事')
    expect(beat.memory).toEqual({ content: '怜在查旧报', type: 'relationship', importance: 7 })
    expect(beat.nextLocation).toBe('图书室')
    expect(beat.mood).toBe('凝重')
  })

  it('offsetMin 钳制在节拍窗口内：负值归零、超出截断（回归：未来事件越过 simNow）', () => {
    const beat = normalizeBeatJson(
      {
        events: [
          { title: 'A', description: 'a', offsetMin: -5 },
          { title: 'B', description: 'b', offsetMin: 999 },
          { title: 'C', description: 'c', offsetMin: 30 },
        ],
        thought: 't',
      },
      LOCS,
      60,
    )
    expect(beat.events.map((e) => e.offsetMin)).toEqual([0, 60, 30])
  })

  it('非数字 offsetMin 视为 0', () => {
    const beat = normalizeBeatJson({ events: [{ title: 'A', description: 'a', offsetMin: '很快' }], thought: 't' }, LOCS, 60)
    expect(beat.events[0].offsetMin).toBe(0)
  })

  it('地点不在世界名单内则丢弃 nextLocation', () => {
    const beat = normalizeBeatJson({ events: [{ title: 'A', description: 'a' }], thought: 't', nextLocation: '月球' }, LOCS, 60)
    expect(beat.nextLocation).toBeNull()
  })

  it('事件为空或想法为空视为失败（抛错触发重试）', () => {
    expect(() => normalizeBeatJson({ events: [], thought: 't' }, LOCS, 60)).toThrow()
    expect(() => normalizeBeatJson({ events: [{ title: 'A', description: 'a' }], thought: '  ' }, LOCS, 60)).toThrow()
  })
})

describe('versioned beat application', () => {
  it('records an engine beat and its state, narrative and private memory exactly once', async () => {
    const fixture = await createWorldFixture()
    try {
      await fixture.db.insert(persons).values({ id: 'resident-a', userId: 'owner', name: 'A', modelJson: '{}', createdAt: WORLD_TIME })
      await fixture.db.insert(worldPersons).values({ worldId: 'home-world', personId: 'resident-a', joinedAt: WORLD_TIME })
      await fixture.db.insert(personStates).values({ personId: 'resident-a', timelineId: 'home-main', simTime: WORLD_TIME,
        location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Listen', updatedRealAt: WORLD_TIME })
      const beat = { events: [{ title: '读完一页', description: '窗外的雨声渐密。', offsetMin: 0 }],
        thought: '这里很安静。', memory: { type: 'relationship', content: '来访者提起了旧火车站。', importance: 7 },
        nextLocation: 'Library', nextActivity: 'Reading', mood: 'Thoughtful', goal: 'Find the old map' }
      const input = { worldId: 'home-world', timelineId: 'home-main', personId: 'resident-a', simNow: WORLD_TIME,
        windowStart: WORLD_TIME, beat, sourceKey: `beat:home-main:resident-a:${WORLD_TIME}` }
      await applyBeatOutput(fixture.db, input)
      await applyBeatOutput(fixture.db, input)
      expect((await fixture.db.select().from(personStates).where(eq(personStates.personId, 'resident-a')).get()))
        .toMatchObject({ location: 'Library', activity: 'Reading', mood: 'Thoughtful', lastBeatSimTime: input.simNow })
      const facts = await fixture.db.select().from(worldFacts).where(eq(worldFacts.timelineId, 'home-main')).all()
      expect(facts).toHaveLength(1)
      expect(facts[0].factType).toBe('location')
      expect(JSON.parse(facts[0].valueJson)).toMatchObject({ cause: 'beat', before: { location: 'Cafe' }, after: { location: 'Library' } })
      expect(await fixture.db.select().from(events).all()).toHaveLength(2)
      expect(await fixture.db.select().from(memories).all()).toHaveLength(2)
      expect(await fixture.db.select().from(worldCommands).all()).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })
})
