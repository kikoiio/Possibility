import { describe, expect, it } from 'vitest'
import type { worldCommands, worldFacts } from '../db/schema'
import { WORLD_TIME } from '../test/world-fixture'
import { createRootProjectionBaseline } from './model'
import { reduceProjection, serializeProjection, type ReplayInput } from './projector'

type Command = typeof worldCommands.$inferSelect
type Fact = typeof worldFacts.$inferSelect

function history(type: string, payload: unknown, version = 1): { command: Command; fact: Fact } {
  const command: Command = {
    id: `command-${version}`,
    worldId: 'world',
    timelineId: 'timeline',
    actorKind: 'owner',
    actorId: 'owner',
    type,
    payloadJson: JSON.stringify(payload),
    expectedVersion: version - 1,
    resultVersion: version,
    tickLeaseToken: null,
    createdAt: WORLD_TIME,
  }
  const fact: Fact = {
    id: `fact-${version}`,
    timelineId: 'timeline',
    version,
    simTime: WORLD_TIME,
    factType: 'test',
    subjectId: 'test',
    valueJson: '{}',
    sourceCommandId: command.id,
    visibility: 'world',
    supersedesId: null,
  }
  return { command, fact }
}

function input(overrides: Partial<ReplayInput> = {}): ReplayInput {
  return {
    worldId: 'world',
    timelineId: 'timeline',
    baseline: createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, []),
    commands: [],
    facts: [],
    throughVersion: 0,
    ...overrides,
  }
}

describe('pure projection reducer skeleton', () => {
  it('requires a complete immutable baseline', () => {
    expect(reduceProjection(input({ baseline: null }))).toMatchObject({
      ok: false,
      projection: null,
      diagnostics: [{ kind: 'missing', domain: 'history', reasonCode: 'baseline_missing' }],
    })
    const partial = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [])
    partial.completeDomains = partial.completeDomains.filter(domain => domain !== 'knowledge')
    expect(reduceProjection(input({ baseline: partial })).diagnostics).toContainEqual(expect.objectContaining({
      kind: 'missing', domain: 'knowledge', reasonCode: 'baseline_domain_missing',
    }))
  })

  it('normalizes the same baseline to byte-stable output without reading a database', () => {
    const stateA = { personId: 'a', timelineId: 'source', simTime: WORLD_TIME, location: 'Cafe', activity: 'Read',
      mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME, currentDialogueId: null, lastBeatSimTime: null }
    const stateB = { ...stateA, personId: 'b', location: 'Park' }
    const left = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [stateB, stateA])
    const right = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [stateA, stateB])
    const first = reduceProjection(input({ baseline: left }))
    const second = reduceProjection(input({ baseline: right }))
    expect(first).toMatchObject({ ok: true, diagnostics: [] })
    expect(first.projection?.states.map(state => state.personId)).toEqual(['a', 'b'])
    expect(first.projection?.states.every(state => state.timelineId === 'timeline')).toBe(true)
    expect(serializeProjection(first.projection!)).toBe(serializeProjection(second.projection!))
  })

  it('preserves a pre-existing root schedule only when it is part of the immutable baseline', () => {
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [])
    baseline.rows.schedules = [{ personId: 'ada', timelineId: 'source', worldDate: '2026-09-21',
      itemsJson: '[{"start":"08:00","end":"09:00","location":"Cafe","activity":"Reading"}]',
      generatedAt: WORLD_TIME }]
    const result = reduceProjection(input({ baseline }))
    expect(result).toMatchObject({ ok: true, diagnostics: [] })
    expect(result.projection?.schedules).toEqual([expect.objectContaining({
      personId: 'ada', timelineId: 'timeline', worldDate: '2026-09-21',
    })])
  })

  it('rejects non-contiguous versions and wrong timeline ownership', () => {
    const { command, fact } = history('move', { type: 'move', personId: 'a', to: 'Park' }, 2)
    command.timelineId = 'other'
    const result = reduceProjection(input({ commands: [command], facts: [fact], throughVersion: 1 }))
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'wrong_version', reasonCode: 'command_version_gap' }),
      expect.objectContaining({ kind: 'wrong_timeline', reasonCode: 'command_scope_mismatch' }),
    ]))
  })

  it('rejects an unknown action instead of silently skipping it', () => {
    const { command, fact } = history('future_action', { type: 'future_action' })
    const result = reduceProjection(input({ commands: [command], facts: [fact], throughVersion: 1 }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'unsupported', commandId: command.id, version: 1, reasonCode: 'action_type_unknown',
    }))
  })

  it('replays clock and resident state transitions from commands', () => {
    const initial = { personId: 'a', timelineId: 'timeline', simTime: WORLD_TIME, location: 'Cafe', activity: 'Read',
      mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME, currentDialogueId: null, lastBeatSimTime: null }
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [initial])
    const nextHour = '2026-09-21T09:00:00.000Z'
    const later = '2026-09-21T10:00:00.000Z'
    const steps = [
      history('clock_advance', { type: 'clock_advance', from: WORLD_TIME, to: nextHour, observedAt: WORLD_TIME }, 1),
      history('move', { type: 'move', personId: 'a', to: 'Park' }, 2),
      history('resident_state', { type: 'resident_state', personId: 'a', cause: 'beat', windowStart: nextHour,
        patch: { location: 'Park', mood: 'Curious' }, advanceTo: later, events: [], memories: [] }, 3),
      history('simulation_checkpoint', { type: 'simulation_checkpoint', personId: 'a', lastBeatSimTime: later }, 4),
    ]
    Object.assign(steps[0].fact, { factType: 'clock', subjectId: 'timeline', simTime: nextHour })
    Object.assign(steps[1].fact, { factType: 'location', subjectId: 'a', simTime: nextHour })
    Object.assign(steps[2].fact, { factType: 'resident_state', subjectId: 'a', simTime: later })
    Object.assign(steps[3].fact, { factType: 'resident_state', subjectId: 'a', simTime: later })
    const result = reduceProjection(input({ baseline, commands: steps.map(step => step.command),
      facts: steps.map(step => step.fact), throughVersion: steps.length }))
    expect(result.diagnostics).toEqual([])
    expect(result.projection).toMatchObject({ simTime: later, states: [expect.objectContaining({
      personId: 'a', location: 'Park', mood: 'Curious', simTime: later, lastBeatSimTime: later,
    })] })
  })

  it('reports two different locations recorded for one person at the same instant', () => {
    const initial = { personId: 'a', timelineId: 'timeline', simTime: WORLD_TIME, location: 'Cafe', activity: 'Read',
      mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME, currentDialogueId: null, lastBeatSimTime: null }
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [initial])
    const first = history('move', { type: 'move', personId: 'a', to: 'Park' }, 1)
    const second = history('move', { type: 'move', personId: 'a', to: 'Library' }, 2)
    for (const step of [first, second]) Object.assign(step.fact, { factType: 'location', subjectId: 'a' })
    const result = reduceProjection(input({ baseline, commands: [first.command, second.command],
      facts: [first.fact, second.fact], throughVersion: 2 }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'mismatch', domain: 'states', recordId: 'a', reasonCode: 'conflicting_location_at_same_time',
    }))
  })

  it('rebuilds schedules and deterministic resident story events', () => {
    const initial = { personId: 'a', timelineId: 'timeline', simTime: WORLD_TIME, location: 'Cafe', activity: 'Read',
      mood: 'Calm', goal: 'Learn', updatedRealAt: WORLD_TIME, currentDialogueId: null, lastBeatSimTime: null }
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [initial])
    const items = [
      { start: '00:00', end: '06:00', location: 'Cafe', activity: 'Sleep', kind: 'sleep' as const },
      { start: '06:00', end: '09:00', location: 'Cafe', activity: 'Breakfast' },
      { start: '09:00', end: '12:00', location: 'Cafe', activity: 'Work' },
      { start: '12:00', end: '14:00', location: 'Cafe', activity: 'Lunch' },
      { start: '14:00', end: '20:00', location: 'Cafe', activity: 'Work' },
      { start: '20:00', end: '00:00', location: 'Cafe', activity: 'Rest' },
    ]
    const schedule = history('schedule_set', { type: 'schedule_set', personId: 'a', worldDate: '2026-09-21',
      generatedAt: WORLD_TIME, items }, 1)
    Object.assign(schedule.fact, { factType: 'schedule', subjectId: 'a:2026-09-21' })
    const state = history('resident_state', { type: 'resident_state', personId: 'a', cause: 'beat',
      windowStart: WORLD_TIME, patch: { activity: 'Working' }, events: [
        { simTime: WORLD_TIME, title: 'Opened the shop', description: 'The doors opened.' },
        { simTime: WORLD_TIME, title: 'Met a guest', description: 'A guest arrived.' },
      ], memories: [] }, 2)
    Object.assign(state.fact, { factType: 'resident_state', subjectId: 'a' })
    const result = reduceProjection(input({ baseline, personNames: { a: 'Ada' },
      commands: [schedule.command, state.command], facts: [schedule.fact, state.fact], throughVersion: 2 }))
    expect(result.diagnostics).toEqual([])
    expect(result.projection?.schedules).toEqual([expect.objectContaining({
      personId: 'a', timelineId: 'timeline', worldDate: '2026-09-21', itemsJson: JSON.stringify(items),
    })])
    expect(result.projection?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'command:command-2', title: 'Ada的生活状态发生变化' }),
      expect.objectContaining({ id: 'command-2:story:0', title: 'Opened the shop' }),
      expect.objectContaining({ id: 'command-2:story:1', title: 'Met a guest' }),
    ]))
  })

  it('replays a commitment proposal through fulfillment with relationship effects', () => {
    const resident = { personId: 'resident', timelineId: 'timeline', simTime: WORLD_TIME, location: 'Cafe',
      activity: 'Waiting', mood: 'Calm', goal: 'Meet', updatedRealAt: WORLD_TIME,
      currentDialogueId: null, lastBeatSimTime: null }
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [resident])
    baseline.rows.dialogues = [{ id: 'scene', timelineId: 'timeline', location: 'Cafe',
      participantIdsJson: JSON.stringify(['visitor', 'resident']), status: 'scene', turnLimit: 8,
      simStart: WORLD_TIME, simEnd: WORLD_TIME, kind: 'scene', visitorId: 'visitor', sceneBusyUntil: null }]
    const proposal = history('commitment_proposal', { type: 'commitment_proposal', commitmentId: 'promise',
      personId: 'resident', visitorId: 'visitor', sourceDialogueId: 'scene', title: 'Meet again', kind: 'meeting',
      location: 'Cafe', dueSim: '2026-09-21T08:30:00.000Z' }, 1)
    const accept = history('commitment', { type: 'commitment', commitmentId: 'promise', next: 'accepted' }, 2)
    const fulfill = history('commitment', { type: 'commitment', commitmentId: 'promise', next: 'fulfilled' }, 3)
    for (const step of [proposal, accept, fulfill]) Object.assign(step.fact, { factType: 'commitment', subjectId: 'promise' })
    const result = reduceProjection(input({ baseline, personNames: { resident: 'Ada', visitor: 'Visitor' },
      commands: [proposal.command, accept.command, fulfill.command],
      facts: [proposal.fact, accept.fact, fulfill.fact], throughVersion: 3 }))
    expect(result.diagnostics).toEqual([])
    expect(result.projection?.commitments).toEqual([expect.objectContaining({ id: 'promise', status: 'fulfilled' })])
    expect(result.projection?.memories).toContainEqual(expect.objectContaining({
      id: 'commitment:promise:fulfilled:memory', personId: 'resident', type: 'relationship', importance: 8,
    }))
    expect(result.projection?.states).toContainEqual(expect.objectContaining({
      personId: 'resident', mood: '因对方守约而感到被重视',
    }))
    expect(result.projection?.events.map(event => event.id)).toEqual(expect.arrayContaining([
      'command:command-1', 'commitment:promise:accepted', 'commitment:promise:fulfilled',
    ]))
  })

  it('rejects a commitment proposal whose source dialogue is not proven', () => {
    const proposal = history('commitment_proposal', { type: 'commitment_proposal', commitmentId: 'promise',
      personId: 'resident', visitorId: 'visitor', sourceDialogueId: 'missing', title: 'Meet', kind: 'meeting',
      location: 'Cafe', dueSim: '2026-09-21T09:00:00.000Z' }, 1)
    Object.assign(proposal.fact, { factType: 'commitment', subjectId: 'promise' })
    const result = reduceProjection(input({ commands: [proposal.command], facts: [proposal.fact], throughVersion: 1 }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'missing', domain: 'commitments', reasonCode: 'commitment_proposal_source_invalid',
    }))
  })

  it('replays NPC dialogue turns and releases participants when the dialogue closes', () => {
    const makeState = (personId: string) => ({ personId, timelineId: 'timeline', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME,
      currentDialogueId: null, lastBeatSimTime: null })
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [makeState('a'), makeState('b')])
    const start = history('dialogue_start', { type: 'dialogue_start', dialogueId: 'dialogue',
      participantIds: ['a', 'b'], location: 'Cafe', turnLimit: 2 }, 1)
    const first = history('dialogue_turn', { type: 'dialogue_turn', dialogueId: 'dialogue', speakerId: 'a',
      turnIndex: 0, utterance: 'Hello', thought: 'Be kind', memory: null, shouldEnd: false }, 2)
    const second = history('dialogue_turn', { type: 'dialogue_turn', dialogueId: 'dialogue', speakerId: 'b',
      turnIndex: 1, utterance: 'Hi', thought: 'Listen', memory: null, shouldEnd: false }, 3)
    const result = reduceProjection(input({ baseline, personNames: { a: 'Ada', b: 'Bo' },
      commands: [start.command, first.command, second.command], facts: [start.fact, first.fact, second.fact],
      throughVersion: 3 }))
    expect(result.diagnostics).toEqual([])
    expect(result.projection?.dialogues).toContainEqual(expect.objectContaining({
      id: 'dialogue', status: 'ended', simEnd: WORLD_TIME,
    }))
    expect(result.projection?.dialogueTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'command-2:turn', turnIndex: 0, personId: 'a' }),
      expect.objectContaining({ id: 'command-3:turn', turnIndex: 1, personId: 'b' }),
    ]))
    expect(result.projection?.states.every(state => state.currentDialogueId === null
      && state.lastBeatSimTime === WORLD_TIME)).toBe(true)
  })

  it('replays a scene conversation with its persisted turn IDs and thoughts', () => {
    const makeState = (personId: string) => ({ personId, timelineId: 'timeline', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME,
      currentDialogueId: null, lastBeatSimTime: null })
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [makeState('visitor'), makeState('resident')])
    const open = history('scene_open', { type: 'scene_open', dialogueId: 'scene', visitorId: 'visitor',
      participantIds: ['visitor', 'resident'], location: 'Cafe', turnLimit: 100 }, 1)
    const conversation = history('conversation', { type: 'conversation', dialogueId: 'scene', requestId: 'request',
      turns: [
        { id: 'visitor-turn', personId: 'visitor', utterance: 'Hello' },
        { id: 'resident-turn', personId: 'resident', utterance: 'Welcome' },
      ],
      sceneProjection: { location: 'Cafe', participantIds: ['visitor', 'resident'], simTime: WORLD_TIME, turnLimit: 100 },
      privateEffects: { memories: [{ id: 'thought', personId: 'resident', type: 'thought', content: 'Be welcoming',
        importance: 5, simTime: WORLD_TIME, createdAt: WORLD_TIME }], messages: [
        { id: 'message', senderPersonId: 'resident', recipientPersonId: 'visitor', content: 'Come back soon',
          location: 'Cafe', simTime: WORLD_TIME, createdAt: WORLD_TIME },
      ] } }, 2)
    const result = reduceProjection(input({ baseline, personNames: { visitor: 'Visitor', resident: 'Ada' },
      commands: [open.command, conversation.command], facts: [open.fact, conversation.fact], throughVersion: 2 }))
    expect(result.diagnostics).toEqual([])
    expect(result.projection?.dialogues).toContainEqual(expect.objectContaining({ id: 'scene', status: 'scene' }))
    expect(result.projection?.dialogueTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'visitor-turn', turnIndex: 0, thought: '' }),
      expect.objectContaining({ id: 'resident-turn', turnIndex: 1, thought: 'Be welcoming' }),
    ]))
    expect(result.projection?.events).toContainEqual(expect.objectContaining({
      id: 'command:command-2', dialogueId: 'scene', title: 'Visitor 与 Ada 在Cafe交谈',
    }))
    expect(result.projection?.memories).toContainEqual(expect.objectContaining({ id: 'thought', content: 'Be welcoming' }))
    expect(result.projection?.personaMessages).toContainEqual(expect.objectContaining({
      id: 'message', senderPersonId: 'resident', recipientPersonId: 'visitor', read: false,
    }))
  })

  it('rejects a dialogue turn with a non-contiguous index', () => {
    const makeState = (personId: string) => ({ personId, timelineId: 'timeline', simTime: WORLD_TIME,
      location: 'Cafe', activity: 'Waiting', mood: 'Calm', goal: 'Talk', updatedRealAt: WORLD_TIME,
      currentDialogueId: null, lastBeatSimTime: null })
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [makeState('a'), makeState('b')])
    const start = history('dialogue_start', { type: 'dialogue_start', dialogueId: 'dialogue',
      participantIds: ['a', 'b'], location: 'Cafe', turnLimit: 4 }, 1)
    const skipped = history('dialogue_turn', { type: 'dialogue_turn', dialogueId: 'dialogue', speakerId: 'a',
      turnIndex: 2, utterance: 'Too late', thought: 'Oops', memory: null, shouldEnd: false }, 2)
    const result = reduceProjection(input({ baseline, commands: [start.command, skipped.command],
      facts: [start.fact, skipped.fact], throughVersion: 2 }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'mismatch', domain: 'dialogueTurns', reasonCode: 'dialogue_turn_sequence_invalid',
    }))
  })

  it('replays memory summaries, corrections, and forgetting without losing source provenance', () => {
    const baseline = createRootProjectionBaseline(WORLD_TIME, WORLD_TIME, [])
    const memory = (id: string, content: string) => ({ id, personId: 'a', timelineId: 'timeline', type: 'thought',
      content, simTime: WORLD_TIME, createdAt: WORLD_TIME, importance: 5, summarized: false })
    baseline.rows.memories = [memory('m1', 'First'), memory('m2', 'Second'), memory('m3', 'Editable')]
    const summary = history('memory_summary', { type: 'memory_summary', personId: 'a', sourceMemoryIds: ['m1', 'm2'],
      summaryId: 'summary', content: 'First and second', importance: 7, simTime: WORLD_TIME, createdAt: WORLD_TIME }, 1)
    const correct = history('memory_correct', { type: 'memory_correct', memoryId: 'm3', personId: 'a',
      before: { type: 'thought', content: 'Editable', importance: 5, simTime: WORLD_TIME,
        createdAt: WORLD_TIME, summarized: false }, after: { content: 'Corrected', importance: 6 } }, 2)
    const forget = history('memory_forget', { type: 'memory_forget', memoryId: 'm3', personId: 'a',
      before: { type: 'thought', content: 'Corrected', importance: 6, simTime: WORLD_TIME,
        createdAt: WORLD_TIME, summarized: false } }, 3)
    const result = reduceProjection(input({ baseline, commands: [summary.command, correct.command, forget.command],
      facts: [summary.fact, correct.fact, forget.fact], throughVersion: 3 }))
    expect(result.diagnostics).toEqual([])
    expect(result.projection?.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', summarized: true }),
      expect.objectContaining({ id: 'm2', summarized: true }),
      expect.objectContaining({ id: 'summary', type: 'summary', summarized: false }),
    ]))
    expect(result.projection?.memories.some(item => item.id === 'm3')).toBe(false)
    expect(result.projection?.events.map(event => event.id)).toEqual(expect.arrayContaining([
      'command:command-2', 'command:command-3',
    ]))
  })

  it('rebuilds multi-hop private knowledge without upgrading rumor certainty', () => {
    const first = history('inform', { type: 'inform', recipientId: 'ada', topic: 'key',
      content: 'The key may be outside' }, 1)
    Object.assign(first.fact, { factType: 'knowledge', subjectId: 'ada:key', visibility: 'private',
      valueJson: JSON.stringify({ recipientId: 'ada', topic: 'key', content: 'The key may be outside',
        certainty: 'rumor', sourceFactId: null }) })
    const second = history('inform', { type: 'inform', recipientId: 'bo', topic: 'key',
      content: 'Ada heard the key may be outside', sourceFactId: first.fact.id }, 2)
    Object.assign(second.fact, { factType: 'knowledge', subjectId: 'bo:key', visibility: 'private',
      valueJson: JSON.stringify({ recipientId: 'bo', topic: 'key', content: 'Ada heard the key may be outside',
        certainty: 'rumor', sourceFactId: first.fact.id }) })
    const result = reduceProjection(input({ commands: [first.command, second.command],
      facts: [first.fact, second.fact], throughVersion: 2 }))
    expect(result.diagnostics).toEqual([])
    expect(result.projection?.knowledge.map(item => item.id)).toEqual(['fact-1', 'fact-2'])

    second.fact.valueJson = JSON.stringify({ recipientId: 'bo', topic: 'key', content: 'Ada heard the key may be outside',
      certainty: 'fact', sourceFactId: first.fact.id })
    expect(reduceProjection(input({ commands: [first.command, second.command], facts: [first.fact, second.fact],
      throughVersion: 2 })).diagnostics).toContainEqual(expect.objectContaining({
      domain: 'knowledge', reasonCode: 'knowledge_certainty_upgrade',
    }))
  })
})
