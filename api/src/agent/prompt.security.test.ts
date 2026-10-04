import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt'
import { buildSchedulePrompt } from './engine-prompt'
import { residentTimeline } from './resident-context'
import type { AgentContextData } from './context'
import type { EngineContext } from './engine-context'
import type { timelines } from '../db/schema'

const scenarioCanary = 'creator-only-canary-4fa91'
const residentPrivateCanary = 'ada-private-canary-28c14'
const rawTimeline = {
  id: 'fork', worldId: 'world', parentTimelineId: 'main', simNow: '2026-10-04T08:00:00.000Z',
  forkScenarioJson: JSON.stringify({ whatIf: scenarioCanary }), createdAt: '2026-10-04T07:00:00.000Z',
  status: 'active', ancestorIdsJson: '[]', lastRealTickAt: null, forkSnapshotJson: null,
} as typeof timelines.$inferSelect

const model = { identity: [], behavior: [], speech: [], skills: [], memories: [], relationships: [], boundaries: [], unknowns: [] }
const state = { personId: 'ada', timelineId: 'fork', simTime: rawTimeline.simNow, location: 'Cafe', activity: 'Waiting',
  mood: 'Calm', goal: 'Listen', updatedRealAt: rawTimeline.simNow, currentDialogueId: null, lastBeatSimTime: null }
const world = { id: 'world', userId: 'owner', name: 'Town', description: '', locationsJson: '[]', status: 'running',
  pauseReason: null, isDemo: false, callsToday: 0, callsDay: null, llmConfigJson: null, lastUserActivityAt: null,
  timeZone: 'UTC', createdAt: rawTimeline.simNow }
const evidence = [{ sourceId: 'turn-1', sourceIds: ['turn-1'], timelineId: 'fork', simTime: rawTimeline.simNow,
  version: null, recipientPersonId: 'ada', certainty: 'fact' as const, kind: 'utterance' as const,
  content: 'Bo说过：「桥明天可能会开放」' }]

describe('resident prompt security boundary', () => {
  it('projects constructor timeline data away before rendering chat or engine prompts', () => {
    const timeline = residentTimeline(rawTimeline)
    expect(JSON.stringify(timeline)).not.toContain(scenarioCanary)

    const chat = buildSystemPrompt({
      person: { name: 'Ada' }, model, world, timeline, mainTimelineId: 'main', isMain: false,
      memories: [], knownFacts: [{ kind: 'knowledge', text: `letter: ${residentPrivateCanary}`,
        sourceFactId: 'private-fact', certainty: 'fact' }], evidence, state, mode: 'chat',
    } as unknown as AgentContextData)
    const chatBo = buildSystemPrompt({
      person: { name: 'Bo' }, model, world, timeline, mainTimelineId: 'main', isMain: false,
      memories: [], knownFacts: [], evidence: [], state: { ...state, personId: 'bo' }, mode: 'chat',
    } as unknown as AgentContextData)
    const engine = buildSchedulePrompt({
      snapshot: { world, locations: [], timeline, persons: [], models: new Map(), states: new Map(),
        schedules: new Map(), worldDate: rawTimeline.simNow.slice(0, 10) },
      person: { id: 'ada', name: 'Ada' }, model, state, others: [], memories: [], knownFacts: [
        { kind: 'knowledge', text: `letter: ${residentPrivateCanary}`, sourceFactId: 'private-fact', certainty: 'fact' },
      ],
      evidence, unperceivedEvents: [], sameLocationAwake: [], scheduleItems: null,
    } as unknown as EngineContext)
    const engineBo = buildSchedulePrompt({
      snapshot: { world, locations: [], timeline, persons: [], models: new Map(), states: new Map(),
        schedules: new Map(), worldDate: rawTimeline.simNow.slice(0, 10) },
      person: { id: 'bo', name: 'Bo' }, model, state: { ...state, personId: 'bo' }, others: [], memories: [], knownFacts: [],
      evidence: [], unperceivedEvents: [], sameLocationAwake: [], scheduleItems: null,
    } as unknown as EngineContext)

    expect(chat).not.toContain(scenarioCanary)
    expect(engine.system).not.toContain(scenarioCanary)
    expect(chat).toContain(residentPrivateCanary)
    expect(engine.system).toContain(residentPrivateCanary)
    expect(chatBo).not.toContain(residentPrivateCanary)
    expect(engineBo.system).not.toContain(residentPrivateCanary)
    expect(chat).toContain('what-if 分叉时间线')
    expect(engine.system).toContain('what-if 分叉时间线')
    expect(chat).toContain('桥明天可能会开放')
    expect(engine.system).toContain('桥明天可能会开放')
    expect(chat).toContain('不证明话中内容属实')
    expect(engine.system).toContain('不证明话中内容属实')
  })
})
