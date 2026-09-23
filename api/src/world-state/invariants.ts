import { and, asc, eq, isNull, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import { readForkSnapshot } from '../agent/visibility'
import { commitments, dialogueTurns, dialogues, events, memories, personaMessages, personStates, schedules, timelines, universeRevisions, worldCommands, worldFacts, worldModelVersions } from '../db/schema'
import { parsePinnedWorldModel } from './model'
import type { TimelineEvidence } from './rebuild'

export interface InvariantViolation { code: string; timelineId: string; commandId?: string; recordId?: string; version?: number; detail: string }

/** Verify the immutable domain fact says what its accepted command actually committed. */
function factMatchesCommand(action: Record<string, unknown>, fact: { factType: string; subjectId: string }, value: Record<string, unknown>): boolean | null {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  switch (action.type) {
    case 'enter': case 'move':
      return fact.factType === 'location' && fact.subjectId === action.personId && value.to === action.to
    case 'environment': {
      const location = typeof action.location === 'string' ? action.location.trim() || null : null
      const condition = typeof action.condition === 'string' ? action.condition.trim() : ''
      const next = typeof action.value === 'string' ? action.value.trim() : ''
      return fact.factType === 'environment' && fact.subjectId === `${location ?? 'world'}:${condition}`
        && value.location === location && value.condition === condition && value.value === next
    }
    case 'inform': {
      const topic = typeof action.topic === 'string' ? action.topic.trim() : ''
      const content = typeof action.content === 'string' ? action.content.trim() : ''
      return fact.factType === 'knowledge' && fact.subjectId === `${action.recipientId}:${topic}`
        && value.recipientId === action.recipientId && value.topic === topic && value.content === content
        && (value.sourceFactId ?? null) === (action.sourceFactId ?? null)
        && (value.certainty === 'fact' || value.certainty === 'rumor')
    }
    case 'intervention': {
      const requestId = typeof action.requestId === 'string' ? action.requestId.trim() : ''
      const text = typeof action.text === 'string' ? action.text.trim() : ''
      return fact.factType === 'intervention' && fact.subjectId === requestId
        && value.requestId === requestId && value.text === text && value.authoredBy === 'builder'
    }
    case 'clock_advance':
      return fact.factType === 'clock' && value.from === action.from && value.to === action.to
        && value.observedAt === action.observedAt
    case 'simulation_checkpoint':
      return fact.factType === 'resident_state' && fact.subjectId === action.personId
        && value.cause === 'runtime_checkpoint'
        && same(value.changes, { lastBeatSimTime: action.lastBeatSimTime })
    case 'dialogue_recovery':
      return fact.factType === 'resident_state' && fact.subjectId === action.personId
        && value.cause === 'dialogue_recovery' && value.previousDialogueId === action.dialogueId
        && same(value.changes, { currentDialogueId: null })
    case 'resident_state':
      return (fact.factType === 'resident_state' || fact.factType === 'location') && fact.subjectId === action.personId
        && value.cause === action.cause && value.windowStart === action.windowStart
        && same(value.changes, action.patch)
        && (action.advanceTo == null ? value.advanceTo == null : value.advanceTo === action.advanceTo)
    case 'conversation': {
      const turns = Array.isArray(action.turns) ? action.turns : []
      const participants = [...new Set(turns.flatMap(turn => turn && typeof turn === 'object'
        && typeof (turn as Record<string, unknown>).personId === 'string'
        ? [(turn as Record<string, unknown>).personId as string] : []))].sort()
      return fact.factType === 'conversation' && fact.subjectId === action.dialogueId
        && value.dialogueId === action.dialogueId && value.requestId === action.requestId
        && value.turnCount === turns.length && same(value.turns, turns) && same(value.participants, participants)
    }
    case 'dialogue_start':
      return fact.factType === 'conversation' && fact.subjectId === action.dialogueId
        && value.dialogueId === action.dialogueId && same(value.participants, action.participantIds)
        && value.location === action.location && value.status === 'ongoing'
    case 'scene_open':
      return fact.factType === 'conversation' && fact.subjectId === action.dialogueId
        && value.dialogueId === action.dialogueId && value.visitorId === action.visitorId
        && same(value.participants, action.participantIds) && value.location === action.location
        && value.status === 'scene' && value.kind === 'scene' && value.turnLimit === action.turnLimit
    case 'dialogue_turn':
      return fact.factType === 'conversation' && fact.subjectId === action.dialogueId
        && value.dialogueId === action.dialogueId && value.turnIndex === action.turnIndex
        && value.speakerId === action.speakerId && value.utterance === action.utterance
    case 'commitment_proposal':
      return fact.factType === 'commitment' && fact.subjectId === action.commitmentId
        && value.commitmentId === action.commitmentId && value.from === null && value.to === 'proposed'
        && value.personId === action.personId && value.visitorId === action.visitorId
        && value.sourceDialogueId === action.sourceDialogueId
        && value.title === (typeof action.title === 'string' ? action.title.trim() : '')
        && value.kind === action.kind && value.location === action.location && value.dueSim === action.dueSim
    case 'commitment':
      return fact.factType === 'commitment' && fact.subjectId === action.commitmentId
        && value.commitmentId === action.commitmentId && value.to === action.next
    case 'memory_summary':
      return fact.factType === 'memory_summary' && fact.subjectId === action.personId
        && value.personId === action.personId && same(value.sourceMemoryIds, action.sourceMemoryIds)
        && value.summaryId === action.summaryId && value.content === action.content
        && value.importance === action.importance && value.simTime === action.simTime && value.createdAt === action.createdAt
    case 'memory_correct': case 'memory_forget':
      return fact.factType === 'memory_maintenance' && fact.subjectId === action.memoryId
        && value.operation === (action.type === 'memory_correct' ? 'correct' : 'forget')
        && value.memoryId === action.memoryId && value.personId === action.personId
        && same(value.before, action.before)
        && (action.type === 'memory_forget' ? value.after === undefined : same(value.after, action.after))
    case 'schedule_set':
      return fact.factType === 'schedule' && fact.subjectId === `${action.personId}:${action.worldDate}`
        && value.personId === action.personId && value.worldDate === action.worldDate
        && value.generatedAt === action.generatedAt && same(value.items, action.items)
    default:
      return null
  }
}

/** The accepted command is authoritative for whether its fact may be publicly read. */
function factVisibilityForCommand(action: Record<string, unknown>): 'world' | 'private' | null {
  switch (action.type) {
    case 'enter': case 'move': case 'environment': case 'intervention': case 'clock_advance':
    case 'conversation': case 'dialogue_start': case 'scene_open': case 'dialogue_turn':
      return 'world'
    case 'simulation_checkpoint': case 'dialogue_recovery': case 'schedule_set': case 'memory_summary':
    case 'memory_correct': case 'memory_forget': case 'inform': case 'commitment': case 'commitment_proposal':
      return 'private'
    case 'resident_state':
      return action.cause === 'agent_memory' ? 'private' : 'world'
    default:
      return null
  }
}

/** Read-only diagnosis; legacy prose is deliberately excluded from the fact proof. */
export async function auditProjectionEvidence(db: Db, worldId: string, timelineId: string, evidence: TimelineEvidence): Promise<InvariantViolation[]> {
  const timeline = evidence.timeline
  if (!timeline) return [{ code: 'missing_timeline', timelineId, detail: 'Timeline does not belong to the requested world' }]
  const revision = evidence.revision
  if (!revision) return [] // Legacy timeline: no invented state history to audit.
  const [commands, facts, stateRows, eventRows, commitmentRows, memoryRows, dialogueRows, turnRows, modelRows, personaMessageRows, scheduleRows] = [
    evidence.commands, evidence.facts, evidence.current.states, evidence.current.events, evidence.current.commitments,
    evidence.current.memories, evidence.current.dialogues, evidence.current.dialogueTurns, evidence.modelRows,
    evidence.current.personaMessages, evidence.current.schedules,
  ]
  const violations: InvariantViolation[] = []
  const report = (code: string, detail: string, commandId?: string, version?: number, recordId?: string) => violations.push({ code, timelineId, commandId, recordId, version, detail })
  if (commands.length !== revision.version || facts.length !== revision.version) report('version_count', `revision=${revision.version}, commands=${commands.length}, facts=${facts.length}`)
  const factByCommand = new Map(facts.map(f => [f.sourceCommandId, f]))
  const commandById = new Map(commands.map(command => [command.id, command]))
  const actionByCommand = new Map<string, Record<string, unknown>>()
  const eventById = new Map(eventRows.map(event => [event.id, event]))
  const expectedEventIds = new Set<string>()
  type CommitmentProjection = { status: string; title?: string; kind?: string; location?: string; dueSim?: string;
    personId?: string; visitorId?: string; sourceDialogueId?: string; updatedSim: string; commandId: string; version: number }
  const conversationCommitments = new Map<string, CommitmentProjection>()
  if (revision.simTime !== timeline.simNow) {
    const latestFact = facts.at(-1)
    report('timeline_clock_projection', `Expected timeline time ${revision.simTime}, got ${timeline.simNow}`, latestFact?.sourceCommandId, latestFact?.version)
  }
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]
    if (command.resultVersion !== i + 1 || command.expectedVersion !== i) report('version_gap', 'Command versions are not contiguous', command.id, command.resultVersion)
    const fact = factByCommand.get(command.id)
    if (!fact || fact.version !== command.resultVersion) report('fact_missing', 'Command has no matching fact', command.id, command.resultVersion)
    let action: Record<string, unknown> = {}
    try { action = JSON.parse(command.payloadJson) as Record<string, unknown> } catch {
      report('command_payload', 'Command payload is not valid JSON', command.id, command.resultVersion)
    }
    if (command.worldId !== worldId || command.timelineId !== timelineId) {
      report('command_scope', 'Command is stored outside the requested world/timeline scope', command.id, command.resultVersion)
    }
    actionByCommand.set(command.id, action)
    if (action.type === 'conversation' && Array.isArray(action.acceptedCommitments)) {
      const factValue = fact?.valueJson ? (() => {
        try { return JSON.parse(fact.valueJson) as Record<string, unknown> } catch { return {} }
      })() : {}
      const recordedIds = Array.isArray(factValue.acceptedCommitmentIds) ? factValue.acceptedCommitmentIds : []
      const actionIds = action.acceptedCommitments.map(item => item && typeof item === 'object'
        ? (item as Record<string, unknown>).id : null)
      if (JSON.stringify([...recordedIds].sort()) !== JSON.stringify([...actionIds].sort())) {
        report('commitment_projection', 'Conversation fact does not reference its accepted commitment actions', command.id, command.resultVersion)
      }
      for (const item of action.acceptedCommitments) {
        if (!item || typeof item !== 'object') continue
        const value = item as Record<string, unknown>
        if (typeof value.id !== 'string' || typeof value.personId !== 'string') continue
        conversationCommitments.set(value.id, {
          status: 'accepted',
          ...(typeof value.title === 'string' ? { title: value.title } : {}),
          ...(value.kind === 'meeting' || value.kind === 'help' ? { kind: value.kind } : {}),
          ...(typeof value.location === 'string' ? { location: value.location } : {}),
          ...(typeof value.dueSim === 'string' ? { dueSim: value.dueSim } : {}),
          personId: value.personId, visitorId: command.actorKind === 'visitor' ? command.actorId ?? undefined : undefined,
          sourceDialogueId: typeof action.dialogueId === 'string' ? action.dialogueId : undefined,
          updatedSim: fact?.simTime ?? '', commandId: command.id, version: command.resultVersion,
        })
      }
    }
    const eventId = action.type === 'intervention' && typeof action.requestId === 'string'
      ? `intervention:${action.requestId}`
      : action.type === 'commitment' && typeof action.commitmentId === 'string' && typeof action.next === 'string'
        ? `commitment:${action.commitmentId}:${action.next}`
        : `command:${command.id}`
    const hasEvent = action.type !== 'clock_advance' && action.type !== 'simulation_checkpoint' && action.type !== 'scene_open'
      && action.type !== 'dialogue_recovery' && action.type !== 'memory_summary' && action.type !== 'schedule_set'
    if (hasEvent) {
      expectedEventIds.add(eventId)
      const event = eventById.get(eventId)
      if (!event) {
        report('event_missing', 'Committed fact has no derived event in its timeline', command.id, command.resultVersion)
      } else {
        const expectedKind = action.type === 'intervention' || action.type === 'memory_correct' || action.type === 'memory_forget' ? 'injected'
          : ['conversation', 'dialogue_start', 'dialogue_turn', 'commitment_proposal'].includes(String(action.type)) ? 'dialogue' : 'action'
        const expectedDialogueId = action.type === 'conversation' || action.type === 'dialogue_start' || action.type === 'dialogue_turn'
          ? action.dialogueId
          : action.type === 'commitment_proposal' ? action.sourceDialogueId : undefined
        const fact = factByCommand.get(command.id)
        let expectedTitle: string | undefined
        let expectedDescription: string | undefined
        if (action.type === 'environment') {
          const location = typeof action.location === 'string' ? action.location.trim() || null : null
          const condition = typeof action.condition === 'string' ? action.condition.trim() : ''
          const value = typeof action.value === 'string' ? action.value.trim() : ''
          expectedTitle = `${location ?? '世界'}的${condition}发生变化`
          expectedDescription = `${location ?? '整个世界'}的${condition}变为：${value}。`
        } else if (action.type === 'intervention') {
          const text = typeof action.text === 'string' ? action.text.trim() : ''
          expectedTitle = text.slice(0, 60)
          expectedDescription = text
        } else if (action.type === 'inform') {
          expectedTitle = '一条消息被转告'
          expectedDescription = '一位居民获得一条消息；内容只对获知者可见。'
        } else if (action.type === 'memory_correct' || action.type === 'memory_forget') {
          expectedTitle = action.type === 'memory_correct' ? '居民记忆被校正' : '居民遗忘了一条记忆'
          expectedDescription = action.type === 'memory_correct' ? '构造者校正了一条居民记忆。' : '构造者让居民遗忘了一条记忆。'
        } else if (action.type === 'dialogue_turn' && typeof action.utterance === 'string') {
          expectedDescription = action.utterance
        }
        if (event.timelineId !== timelineId || (fact && event.simTime !== fact.simTime) || event.kind !== expectedKind
          || !event.title.trim() || !event.description.trim()
          || (expectedTitle !== undefined && event.title !== expectedTitle)
          || (expectedDescription !== undefined && event.description !== expectedDescription)
          || (typeof expectedDialogueId === 'string' && event.dialogueId !== expectedDialogueId)) {
          report('event_projection', `Derived event ${eventId} does not match its fact scope/time/kind`, command.id, command.resultVersion)
        }
      }
    }
    if (action.type === 'resident_state' && Array.isArray(action.events)) {
      const expectedStoryIds = new Set<string>()
      action.events.forEach((item, index) => {
        if (!item || typeof item !== 'object') return
        const story = item as Record<string, unknown>
        const id = `${command.id}:story:${index}`
        expectedStoryIds.add(id)
        expectedEventIds.add(id)
        const event = eventById.get(id)
        if (!event) {
          report('event_missing', `Resident-state story event ${id} is missing`, command.id, command.resultVersion)
          return
        }
        if (event.timelineId !== timelineId || event.simTime !== story.simTime || event.title !== story.title
          || event.description !== story.description || event.kind !== 'action' || event.actorPersonId !== action.personId
          || event.dialogueId !== null) {
          report('event_projection', `Resident-state story event ${id} differs from its immutable action`, command.id, command.resultVersion)
        }
      })
      for (const event of eventRows) {
        if (event.id.startsWith(`${command.id}:story:`) && !expectedStoryIds.has(event.id)) {
          report('event_projection', `Unexpected resident-state story event ${event.id}`, command.id, command.resultVersion)
        }
      }
    }
  }
  // Rebuild the fields with versioned evidence, without inventing a pre-history
  // baseline for legacy state that predates the first command.
  type RebuiltState = { location?: string | null; activity?: string | null; mood?: string | null; goal?: string | null;
    lastBeatSimTime?: string | null; currentDialogueId?: string | null; simTime?: string | null }
  const rebuiltStates = new Map<string, { state: RebuiltState; commandId: string; version: number }>()
  let baselineAvailable = false
  let memoryBaselineAt: string | null = null
  const baselineRows: { personId: string; state: RebuiltState }[] = []
  const baselineScheduleRows: (typeof scheduleRows[number])[] = []
  const forkSnapshot = timeline.parentTimelineId ? readForkSnapshot(timeline) : null
  let baselineEventIds: Set<string> | null = null
  const availableFactsById = new Map([...(forkSnapshot?.worldFacts ?? []), ...facts].map(fact => [fact.id, fact]))
  if (forkSnapshot) {
    baselineAvailable = true
    memoryBaselineAt = forkSnapshot.capturedAt
    for (const row of forkSnapshot.states) baselineRows.push({ personId: row.personId, state: {
      location: row.location, activity: row.activity, mood: row.mood, goal: row.goal,
      lastBeatSimTime: row.lastBeatSimTime ?? null, currentDialogueId: null, simTime: row.simTime,
    } })
  } else if (!timeline.parentTimelineId && modelRows[0]) {
    try {
      const model = JSON.parse(modelRows[0].modelJson) as {
        initialStates?: { capturedAt?: unknown; states?: unknown }
        initialEvents?: { timelineId?: unknown; eventIds?: unknown }
        projectionBaseline?: { capturedAt?: unknown; completeDomains?: unknown; rows?: { states?: unknown; schedules?: unknown } }
      }
      const rootProjection = model.projectionBaseline
      const rootDomains = Array.isArray(rootProjection?.completeDomains) ? rootProjection.completeDomains : []
      if (rootDomains.includes('states') && Array.isArray(rootProjection?.rows?.states)) {
        baselineAvailable = true
        memoryBaselineAt = typeof rootProjection.capturedAt === 'string' ? rootProjection.capturedAt : null
        for (const row of rootProjection.rows.states) {
          if (!row || typeof row !== 'object' || typeof (row as { personId?: unknown }).personId !== 'string') continue
          const value = row as Record<string, unknown>
          baselineRows.push({ personId: value.personId as string, state: {
            location: typeof value.location === 'string' ? value.location : null,
            activity: typeof value.activity === 'string' ? value.activity : null,
            mood: typeof value.mood === 'string' ? value.mood : null,
            goal: typeof value.goal === 'string' ? value.goal : null,
            lastBeatSimTime: typeof value.lastBeatSimTime === 'string' ? value.lastBeatSimTime : null,
            currentDialogueId: typeof value.currentDialogueId === 'string' ? value.currentDialogueId : null,
            simTime: typeof value.simTime === 'string' ? value.simTime : null,
          } })
        }
      }
      if (rootProjection?.completeDomains && Array.isArray(rootProjection.completeDomains)
        && rootProjection.completeDomains.includes('schedules') && Array.isArray(rootProjection.rows?.schedules)) {
        baselineScheduleRows.push(...rootProjection.rows.schedules as (typeof scheduleRows[number])[])
      }
      const initialEvents = model.initialEvents
      if (!timeline.parentTimelineId && initialEvents?.timelineId === timelineId
        && Array.isArray(initialEvents.eventIds) && initialEvents.eventIds.every(id => typeof id === 'string')) {
        baselineEventIds = new Set(initialEvents.eventIds)
      }
      const captureTime = model.initialStates && 'capturedAt' in model.initialStates
        ? model.initialStates.capturedAt : null
      if (typeof captureTime === 'string' && Number.isFinite(Date.parse(captureTime))) memoryBaselineAt = captureTime
      const states = model.initialStates?.states
      if (!rootDomains.includes('states') && Array.isArray(states)) {
        baselineAvailable = true
        for (const row of states) {
          if (!row || typeof row !== 'object' || typeof (row as { personId?: unknown }).personId !== 'string') continue
          const value = row as Record<string, unknown>
          baselineRows.push({ personId: value.personId as string, state: {
            location: typeof value.location === 'string' ? value.location : null,
            activity: typeof value.activity === 'string' ? value.activity : null,
            mood: typeof value.mood === 'string' ? value.mood : null,
            goal: typeof value.goal === 'string' ? value.goal : null,
            lastBeatSimTime: typeof value.lastBeatSimTime === 'string' ? value.lastBeatSimTime : null,
            currentDialogueId: typeof value.currentDialogueId === 'string' ? value.currentDialogueId : null,
            simTime: typeof value.simTime === 'string' ? value.simTime : null,
          } })
        }
      }
    } catch { /* malformed or legacy model snapshots have no verifiable baseline */ }
  }
  for (const row of baselineRows) rebuiltStates.set(row.personId, {
    state: row.state, commandId: `baseline:${timelineId}`, version: 0,
  })
  const locationsAtInstant = new Map<string, { location: string; commandId: string; version: number }>()
  const latestCommitments = new Map<string, CommitmentProjection>(conversationCommitments)
  const snapshotCommitments = forkSnapshot && Array.isArray(forkSnapshot.commitments)
    ? forkSnapshot.commitments.filter(item => item.status === 'proposed' || item.status === 'accepted') : null
  if (snapshotCommitments) {
    // Forks intentionally allocate new commitment IDs in the child. Match the
    // immutable source checkpoint to child rows by their stable commitment
    // details, then replay any later child facts against the copied IDs.
    const unmatched = [...commitmentRows]
    for (const source of snapshotCommitments) {
      const index = unmatched.findIndex(item => item.worldId === source.worldId
        && item.personId === source.personId && item.visitorId === source.visitorId
        && item.sourceDialogueId === source.sourceDialogueId && item.title === source.title
        && item.kind === source.kind && item.location === source.location && item.dueSim === source.dueSim
        && item.createdSim === source.createdSim && item.createdAt === source.createdAt)
      if (index < 0) {
        report('commitment_projection', `Fork checkpoint commitment ${source.id} is missing or has altered details`,
          `baseline:${timelineId}`, 0)
        continue
      }
      const [child] = unmatched.splice(index, 1)
      latestCommitments.set(child.id, {
        status: source.status, title: source.title, kind: source.kind, location: source.location,
        dueSim: source.dueSim, personId: source.personId, visitorId: source.visitorId,
        sourceDialogueId: source.sourceDialogueId ?? undefined, updatedSim: source.updatedSim,
        commandId: `baseline:${timelineId}`, version: 0,
      })
    }
  }
  const latestMemorySummaries = new Map<string, { personId: string; summaryId: string; content: string; simTime: string;
    createdAt: string; commandId: string; version: number }>()
  const memoryMaintenance = new Map<string, { operation: 'correct' | 'forget'; content?: string; importance?: number;
    commandId: string; version: number }>()
  const expectedCommitmentMemories = new Map<string, { eventId: string; personId: string; simTime: string;
    createdAt: string; commandId: string; version: number }>()
  const expectedResidentMemories = new Map<string, { personId: string; type: string; content: string; importance: number;
    simTime: string; createdAt: string; commandId: string; version: number }>()
  const expectedConversationMemories = new Map<string, { personId: string; type: string; content: string; importance: number;
    simTime: string; createdAt: string; commandId: string; version: number }>()
  const expectedPersonaMessages = new Map<string, { senderPersonId: string; recipientPersonId: string; content: string;
    location: string; simTime: string; createdAt: string; commandId: string; version: number }>()
  const expectedDialogues = new Map<string, { location: string; participantIdsJson: string; status: string; kind: string;
    turnLimit: number; simStart: string; simEnd: string | null; commandId: string; version: number }>()
  const expectedSchedules = new Map<string, { personId: string; worldDate: string; itemsJson: string; generatedAt: string;
    commandId: string; version: number }>()
  const expectedTurns = new Map<string, { dialogueId: string; turnIndex: number; personId: string; utterance?: string;
    thought?: string; commandId: string; version: number }>()
  const stateForFact = (personId: string, fact: typeof facts[number]) => {
    const entry = rebuiltStates.get(personId) ?? { state: {}, commandId: fact.sourceCommandId, version: fact.version }
    entry.commandId = fact.sourceCommandId
    entry.version = fact.version
    rebuiltStates.set(personId, entry)
    return entry.state
  }
  const scheduleKey = (personId: string, worldDate: string) => `${personId}:${worldDate}`
  if (forkSnapshot && Array.isArray(forkSnapshot.schedules)) for (const schedule of forkSnapshot.schedules) {
    expectedSchedules.set(scheduleKey(schedule.personId, schedule.worldDate), { personId: schedule.personId,
      worldDate: schedule.worldDate, itemsJson: schedule.itemsJson, generatedAt: schedule.generatedAt,
      commandId: `baseline:${timelineId}`, version: 0 })
  }
  for (const schedule of baselineScheduleRows) expectedSchedules.set(scheduleKey(schedule.personId, schedule.worldDate), {
    personId: schedule.personId, worldDate: schedule.worldDate, itemsJson: schedule.itemsJson, generatedAt: schedule.generatedAt,
    commandId: `baseline:${timelineId}`, version: 0,
  })
  for (const fact of facts) {
    let value: Record<string, unknown>
    try { value = JSON.parse(fact.valueJson) as Record<string, unknown> } catch {
      report('fact_payload', 'Fact payload is not valid JSON', fact.sourceCommandId, fact.version)
      continue
    }
    if (fact.factType === 'location' || fact.factType === 'resident_state') {
      const entry = rebuiltStates.get(fact.subjectId) ?? { state: {}, commandId: fact.sourceCommandId, version: fact.version }
      const after = value.after && typeof value.after === 'object' ? value.after as Record<string, unknown> : {}
      const changes = value.changes && typeof value.changes === 'object' ? value.changes as Record<string, unknown> : {}
      const target = typeof value.to === 'string' ? value.to
        : typeof changes.location === 'string' ? changes.location : after.location
      if (typeof target === 'string') {
        const key = `${fact.subjectId}:${fact.simTime}`
        const prior = locationsAtInstant.get(key)
        if (prior && prior.location !== target) {
          report('location_time_conflict', `Resident ${fact.subjectId} has conflicting locations ${prior.location} and ${target} at ${fact.simTime}`,
            fact.sourceCommandId, fact.version)
        } else locationsAtInstant.set(key, { location: target, commandId: fact.sourceCommandId, version: fact.version })
      }
      if (typeof target === 'string') entry.state.location = target
      for (const field of ['location', 'activity', 'mood', 'goal', 'lastBeatSimTime'] as const) {
        const next = changes[field] ?? after[field]
        if (typeof next === 'string') entry.state[field] = next
      }
      if (Object.hasOwn(changes, 'currentDialogueId')) {
        const next = changes.currentDialogueId
        if (next === null || typeof next === 'string') entry.state.currentDialogueId = next
      }
      if (fact.factType === 'location' || Object.keys(after).length) entry.state.simTime = fact.simTime
      entry.commandId = fact.sourceCommandId
      entry.version = fact.version
      rebuiltStates.set(fact.subjectId, entry)
    }
    const action = actionByCommand.get(fact.sourceCommandId)
    if (action) {
      const matches = factMatchesCommand(action, fact, value)
      if (matches === false) report('fact_command_projection', `Fact ${fact.id} does not match its immutable ${String(action.type)} command`,
        fact.sourceCommandId, fact.version)
      else if (matches === null) report('command_action_unsupported', `Command action ${String(action.type ?? '(missing)')} has no audit projection rule`,
        fact.sourceCommandId, fact.version)
      const expectedVisibility = factVisibilityForCommand(action)
      if (expectedVisibility && fact.visibility !== expectedVisibility) {
        report('fact_visibility_projection', `Fact ${fact.id} must be ${expectedVisibility}, got ${fact.visibility}`,
          fact.sourceCommandId, fact.version)
      }
      if (action.type === 'inform') {
        const sourceId = typeof action.sourceFactId === 'string' ? action.sourceFactId : null
        let expectedCertainty: 'fact' | 'rumor' = 'rumor'
        if (sourceId) {
          const source = availableFactsById.get(sourceId)
          let sourceValue: Record<string, unknown> = {}
          if (source?.valueJson) {
            try { sourceValue = JSON.parse(source.valueJson) as Record<string, unknown> } catch { /* reported below */ }
          }
          const sameLinePrecedes = source && source.timelineId === timelineId && source.version < fact.version
          const canCite = source && (source.factType === 'knowledge'
            || (source.visibility === 'world' && ['environment', 'location', 'resident_state'].includes(source.factType)))
          if (!source || !canCite || (source.timelineId === timelineId && !sameLinePrecedes)) {
            report('knowledge_source_projection', `Inform command cites missing, unsupported, or future fact ${sourceId}`,
              fact.sourceCommandId, fact.version)
          } else if (source.factType === 'knowledge') {
            expectedCertainty = sourceValue.certainty === 'fact' ? 'fact' : 'rumor'
          } else {
            expectedCertainty = 'fact'
          }
        }
        if (value.certainty !== expectedCertainty) {
          report('knowledge_certainty_projection', `Knowledge fact ${fact.id} must preserve certainty ${expectedCertainty}, got ${String(value.certainty)}`,
            fact.sourceCommandId, fact.version)
        }
      }
    }
    if (action?.type === 'scene_open' && typeof action.dialogueId === 'string' && Array.isArray(action.participantIds)
      && typeof action.location === 'string' && typeof action.turnLimit === 'number' && typeof action.visitorId === 'string') {
      expectedDialogues.set(action.dialogueId, { location: action.location, participantIdsJson: JSON.stringify(action.participantIds),
        status: 'scene', kind: 'scene', turnLimit: action.turnLimit, simStart: fact.simTime, simEnd: fact.simTime,
        commandId: fact.sourceCommandId, version: fact.version })
    }
    if (action?.type === 'dialogue_start' && typeof action.dialogueId === 'string' && Array.isArray(action.participantIds)
      && typeof action.location === 'string' && typeof action.turnLimit === 'number') {
      expectedDialogues.set(action.dialogueId, { location: action.location, participantIdsJson: JSON.stringify(action.participantIds),
        status: 'ongoing', kind: 'npc', turnLimit: action.turnLimit, simStart: fact.simTime, simEnd: null,
        commandId: fact.sourceCommandId, version: fact.version })
    }
    if (action?.type === 'schedule_set' && typeof action.personId === 'string' && typeof action.worldDate === 'string'
      && typeof action.generatedAt === 'string' && Array.isArray(action.items)) {
      expectedSchedules.set(scheduleKey(action.personId, action.worldDate), { personId: action.personId,
        worldDate: action.worldDate, itemsJson: JSON.stringify(action.items), generatedAt: action.generatedAt,
        commandId: fact.sourceCommandId, version: fact.version })
    }
    if (action?.type === 'dialogue_turn' && typeof action.dialogueId === 'string' && typeof action.speakerId === 'string'
      && typeof action.turnIndex === 'number' && typeof action.utterance === 'string' && typeof action.thought === 'string') {
      const command = commandById.get(fact.sourceCommandId)
      if (command) {
        expectedConversationMemories.set(`${fact.sourceCommandId}:thought`, { personId: action.speakerId, type: 'thought',
          content: action.thought, importance: 5, simTime: fact.simTime, createdAt: command.createdAt,
          commandId: fact.sourceCommandId, version: fact.version })
        if (action.memory && typeof action.memory === 'object') {
          const memory = action.memory as Record<string, unknown>
          if (typeof memory.content === 'string' && typeof memory.importance === 'number') {
            expectedConversationMemories.set(`${fact.sourceCommandId}:memory`, { personId: action.speakerId,
              type: 'relationship', content: memory.content, importance: memory.importance, simTime: fact.simTime,
              createdAt: command.createdAt, commandId: fact.sourceCommandId, version: fact.version })
          }
        }
      }
      expectedTurns.set(`${fact.sourceCommandId}:turn`, { dialogueId: action.dialogueId, turnIndex: action.turnIndex,
        personId: action.speakerId, utterance: action.utterance, thought: action.thought,
        commandId: fact.sourceCommandId, version: fact.version })
      const dialogue = expectedDialogues.get(action.dialogueId)
      if (dialogue) {
        dialogue.commandId = fact.sourceCommandId
        dialogue.version = fact.version
        if (value.ended === true) { dialogue.status = 'ended'; dialogue.simEnd = fact.simTime }
      }
    }
    if (action?.type === 'conversation' && typeof action.dialogueId === 'string' && Array.isArray(action.turns)) {
      const scene = action.sceneProjection && typeof action.sceneProjection === 'object'
        ? action.sceneProjection as Record<string, unknown> : null
      if (scene && typeof scene.location === 'string' && Array.isArray(scene.participantIds)
        && scene.participantIds.every(id => typeof id === 'string') && typeof scene.simTime === 'string'
        && typeof scene.turnLimit === 'number') {
        expectedDialogues.set(action.dialogueId, { location: scene.location,
          participantIdsJson: JSON.stringify(scene.participantIds), status: 'scene', kind: 'scene',
          turnLimit: scene.turnLimit, simStart: scene.simTime, simEnd: scene.simTime,
          commandId: fact.sourceCommandId, version: fact.version })
      }
      action.turns.forEach((turn, turnIndex) => {
        if (turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).id === 'string'
          && typeof (turn as Record<string, unknown>).personId === 'string') {
          const row = turn as { id: string; personId: string; utterance?: unknown }
          expectedTurns.set(row.id, { dialogueId: action.dialogueId as string, turnIndex, personId: row.personId,
            ...(typeof row.utterance === 'string' ? { utterance: row.utterance } : {}),
            commandId: fact.sourceCommandId, version: fact.version })
        }
      })
      const command = commandById.get(fact.sourceCommandId)
      const effects = action.privateEffects && typeof action.privateEffects === 'object'
        ? action.privateEffects as Record<string, unknown> : null
      if (command && Array.isArray(effects?.memories)) effects.memories.forEach(item => {
        if (!item || typeof item !== 'object') return
        const memory = item as Record<string, unknown>
        if (typeof memory.id !== 'string' || typeof memory.personId !== 'string' || typeof memory.type !== 'string'
          || typeof memory.content !== 'string' || typeof memory.importance !== 'number'
          || typeof memory.simTime !== 'string' || typeof memory.createdAt !== 'string') return
        expectedConversationMemories.set(memory.id, { personId: memory.personId, type: memory.type, content: memory.content,
          importance: memory.importance, simTime: memory.simTime, createdAt: memory.createdAt,
          commandId: fact.sourceCommandId, version: fact.version })
      })
      if (command && Array.isArray(effects?.messages)) effects.messages.forEach(item => {
        if (!item || typeof item !== 'object') return
        const message = item as Record<string, unknown>
        if (typeof message.id !== 'string' || typeof message.senderPersonId !== 'string'
          || typeof message.recipientPersonId !== 'string' || typeof message.content !== 'string'
          || typeof message.location !== 'string' || typeof message.simTime !== 'string'
          || typeof message.createdAt !== 'string') return
        expectedPersonaMessages.set(message.id, { senderPersonId: message.senderPersonId,
          recipientPersonId: message.recipientPersonId, content: message.content, location: message.location,
          simTime: message.simTime, createdAt: message.createdAt, commandId: fact.sourceCommandId, version: fact.version })
      })
    }
    if (action?.type === 'dialogue_start' && Array.isArray(action.participantIds) && typeof action.dialogueId === 'string') {
      for (const personId of action.participantIds) {
        if (typeof personId === 'string') stateForFact(personId, fact).currentDialogueId = action.dialogueId
      }
    }
    if (action?.type === 'dialogue_turn' && value.ended === true && Array.isArray(value.participants)) {
      for (const personId of value.participants) {
        if (typeof personId === 'string') {
          const state = stateForFact(personId, fact)
          state.currentDialogueId = null
          state.lastBeatSimTime = fact.simTime
        }
      }
    }
    if (action?.type === 'resident_state' && typeof action.personId === 'string' && Array.isArray(action.memories)) {
      const command = commandById.get(fact.sourceCommandId)
      if (command) action.memories.forEach((item, index) => {
        if (!item || typeof item !== 'object') return
        const memory = item as Record<string, unknown>
        if (typeof memory.type !== 'string' || typeof memory.content !== 'string' || typeof memory.importance !== 'number') return
        expectedResidentMemories.set(`${fact.sourceCommandId}:memory:${index}`, {
          personId: action.personId as string, type: memory.type, content: memory.content,
          importance: memory.importance, simTime: fact.simTime, createdAt: command.createdAt,
          commandId: fact.sourceCommandId, version: fact.version,
        })
      })
    }
    if (fact.factType === 'commitment' && typeof value.commitmentId === 'string' && typeof value.to === 'string') {
      const prior = latestCommitments.get(value.commitmentId)
      latestCommitments.set(value.commitmentId, {
        ...(prior ?? {}),
        status: value.to,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(value.kind === 'meeting' || value.kind === 'help' ? { kind: value.kind } : {}),
        ...(typeof value.location === 'string' ? { location: value.location } : {}),
        ...(typeof value.dueSim === 'string' ? { dueSim: value.dueSim } : {}),
        ...(typeof value.personId === 'string' ? { personId: value.personId } : {}),
        ...(typeof value.visitorId === 'string' ? { visitorId: value.visitorId } : {}),
        ...(typeof value.sourceDialogueId === 'string' ? { sourceDialogueId: value.sourceDialogueId } : {}),
        updatedSim: fact.simTime, commandId: fact.sourceCommandId, version: fact.version,
      })
    }
    // Fulfillment/failure transitions deterministically affect the resident's
    // mood in commitWorldCommand even though they do not produce a separate
    // resident_state fact. Replay that coupled projection from the immutable
    // transition command so the audit can catch a stale or corrupted mood.
    if (action?.type === 'commitment' && typeof action.commitmentId === 'string'
      && typeof action.next === 'string') {
      const commitment = latestCommitments.get(action.commitmentId)
      const personId = commitment?.personId ?? commitmentRows.find(item => item.id === action.commitmentId)?.personId
      const eventId = `commitment:${action.commitmentId}:${action.next}`
      const command = commandById.get(fact.sourceCommandId)
      if (personId && command) expectedCommitmentMemories.set(`${eventId}:memory`, {
        eventId, personId, simTime: fact.simTime, createdAt: command.createdAt,
        commandId: fact.sourceCommandId, version: fact.version,
      })
      if (personId && (action.next === 'fulfilled' || action.next === 'missed')) {
        stateForFact(personId, fact).mood = action.next === 'fulfilled'
          ? '因对方守约而感到被重视'
          : '约定落空，有些失落'
      }
    }
    if (fact.factType === 'memory_summary' && Array.isArray(value.sourceMemoryIds) && typeof value.personId === 'string'
      && typeof value.summaryId === 'string' && typeof value.content === 'string' && typeof value.simTime === 'string'
      && typeof value.createdAt === 'string') {
      for (const id of value.sourceMemoryIds) if (typeof id === 'string') latestMemorySummaries.set(id, {
        personId: value.personId, summaryId: value.summaryId, content: value.content, simTime: value.simTime,
        createdAt: value.createdAt, commandId: fact.sourceCommandId, version: fact.version,
      })
      latestMemorySummaries.set(value.summaryId, { personId: value.personId, summaryId: value.summaryId,
        content: value.content, simTime: value.simTime, createdAt: value.createdAt,
        commandId: fact.sourceCommandId, version: fact.version })
    }
    if (fact.factType === 'memory_maintenance' && typeof value.memoryId === 'string'
      && (value.operation === 'correct' || value.operation === 'forget')) {
      const after = value.after && typeof value.after === 'object' ? value.after as Record<string, unknown> : {}
      memoryMaintenance.set(value.memoryId, { operation: value.operation,
        ...(value.operation === 'correct' && typeof after.content === 'string' && typeof after.importance === 'number'
          ? { content: after.content, importance: after.importance } : {}),
        commandId: fact.sourceCommandId, version: fact.version })
    }
  }
  const factSourceCounts = new Map<string, number>()
  for (const fact of facts) {
    factSourceCounts.set(fact.sourceCommandId, (factSourceCounts.get(fact.sourceCommandId) ?? 0) + 1)
    const source = commandById.get(fact.sourceCommandId)
    if (!source) {
      report('fact_source_scope', `Fact ${fact.id} has no source command in this timeline`, fact.sourceCommandId, fact.version)
      continue
    }
    if (source.worldId !== worldId || source.timelineId !== fact.timelineId || source.resultVersion !== fact.version) {
      report('fact_source_scope', `Fact ${fact.id} is linked to a command from another scope or version`, source.id, fact.version)
    }
  }
  for (const [commandId, count] of factSourceCounts) if (count > 1) {
    const command = commandById.get(commandId)
    report('fact_source_cardinality', `Command ${commandId} has ${count} primary facts; expected one`, commandId, command?.resultVersion)
  }
  if (modelRows.length !== 1) {
    report('world_model_version_missing', `Revision points to world model version ${revision.worldModelVersion}, but ${modelRows.length} matching rows were found`)
  } else {
    try { parsePinnedWorldModel(modelRows[0].modelJson) }
    catch { report('world_model_version_invalid', `World model version ${revision.worldModelVersion} is incomplete or malformed`) }
  }
  // Replay the virtual clock backward from the immutable revision. Every ordinary
  // command observes the current world time; explicit clock advances encode both
  // ends. Legacy timelines without a revision returned above and remain unknown.
  let expectedSimTime = revision.simTime
  for (const fact of [...facts].reverse()) {
    const action = actionByCommand.get(fact.sourceCommandId)
    let commandSimTime = expectedSimTime
    if (action?.type === 'clock_advance' && typeof action.to === 'string') commandSimTime = action.to
    else if (action?.type === 'resident_state' && typeof action.advanceTo === 'string') commandSimTime = action.advanceTo
    if (fact.simTime !== commandSimTime) {
      report('fact_time_projection', `Fact ${fact.id} is at ${fact.simTime}, but its command belongs at ${commandSimTime}`,
        fact.sourceCommandId, fact.version)
    }
    if (action?.type === 'clock_advance' && typeof action.from === 'string') expectedSimTime = action.from
    else if (action?.type === 'resident_state' && typeof action.advanceTo === 'string') break
  }
  const stateByPerson = new Map(stateRows.map(state => [state.personId, state]))
  for (const [personId, expected] of rebuiltStates) {
    const actual = stateByPerson.get(personId)
    if (!actual) {
      report('state_projection', `Expected a state row for ${personId}, got none`, expected.commandId, expected.version, personId)
      continue
    }
    const mismatches = Object.entries(expected.state).filter(([field, value]) => actual[field as keyof typeof actual] !== value)
    if (mismatches.length) report('state_projection', `Expected ${JSON.stringify(expected.state)}, got ${JSON.stringify(Object.fromEntries(mismatches.map(([field]) => [field, actual[field as keyof typeof actual]])))}`, expected.commandId, expected.version, personId)
  }
  if (baselineAvailable) for (const actual of stateRows) {
    if (!rebuiltStates.has(actual.personId)) {
      report('unproven_state_projection', `State for ${actual.personId} has no immutable baseline or fact`, undefined, revision.version)
    }
  }
  const commitmentById = new Map(commitmentRows.map(item => [item.id, item]))
  for (const [commitmentId, expected] of latestCommitments) {
    const actual = commitmentById.get(commitmentId)
    const fields = ['status', 'title', 'kind', 'location', 'dueSim', 'personId', 'visitorId', 'sourceDialogueId', 'updatedSim'] as const
    const mismatches = fields.filter(field => expected[field] !== undefined && actual?.[field] !== expected[field])
    if (!actual || mismatches.length) {
      report('commitment_projection', `Expected ${commitmentId} ${JSON.stringify(Object.fromEntries(fields
        .filter(field => expected[field] !== undefined).map(field => [field, expected[field]])))}, got ${actual
        ? JSON.stringify(Object.fromEntries(mismatches.map(field => [field, actual[field]]))) : 'missing'}`,
      expected.commandId, expected.version)
    }
  }
  if (snapshotCommitments) for (const actual of commitmentRows) {
    if (!latestCommitments.has(actual.id)) {
      report('unproven_commitment_projection', `Fork commitment ${actual.id} has no checkpoint or committed fact`,
        undefined, revision.version)
    }
  }
  if (!timeline.parentTimelineId && baselineAvailable) for (const actual of commitmentRows) {
    if (!latestCommitments.has(actual.id)) {
      report('unproven_commitment_projection', `Commitment ${actual.id} has no initial baseline or committed fact`,
        undefined, revision.version)
    }
  }
  const memoryById = new Map(memoryRows.map(memory => [memory.id, memory]))
  const isSummarizedSource = (memoryId: string) => {
    const summary = latestMemorySummaries.get(memoryId)
    return summary !== undefined && summary.summaryId !== memoryId
  }
  for (const [memoryId, expected] of latestMemorySummaries) {
    if (memoryMaintenance.get(memoryId)?.operation === 'forget') continue
    const actual = memoryById.get(memoryId)
    const isSummary = memoryId === expected.summaryId
    if (!actual || actual.personId !== expected.personId || (isSummary
      ? actual.type !== 'summary' || actual.content !== expected.content || actual.simTime !== expected.simTime || actual.createdAt !== expected.createdAt
      : actual.summarized !== true)) {
      report('memory_summary_projection', `Expected ${isSummary ? 'summary' : 'source'} memory ${memoryId} to match its immutable summary fact`, expected.commandId, expected.version)
    }
  }
  for (const [memoryId, expected] of expectedCommitmentMemories) {
    if (memoryMaintenance.has(memoryId)) continue
    const actual = memoryById.get(memoryId)
    const event = eventById.get(expected.eventId)
    if (!actual || !event || actual.personId !== expected.personId || actual.timelineId !== timelineId
      || actual.type !== 'relationship' || actual.content !== event.description || actual.simTime !== expected.simTime
      || actual.createdAt !== expected.createdAt || actual.importance !== 8 || actual.summarized !== isSummarizedSource(memoryId)) {
      report('memory_projection', `Commitment transition ${expected.eventId} is missing or disagrees with its relationship memory`,
        expected.commandId, expected.version)
    }
  }
  for (const [memoryId, expected] of expectedResidentMemories) {
    if (memoryMaintenance.has(memoryId)) continue
    const actual = memoryById.get(memoryId)
    if (!actual || actual.personId !== expected.personId || actual.timelineId !== timelineId || actual.type !== expected.type
      || actual.content !== expected.content || actual.importance !== expected.importance || actual.simTime !== expected.simTime
      || actual.createdAt !== expected.createdAt || actual.summarized !== isSummarizedSource(memoryId)) {
      report('memory_projection', `Resident-state command memory ${memoryId} is missing or differs from its immutable action`,
        expected.commandId, expected.version)
    }
  }
  for (const [memoryId, expected] of expectedConversationMemories) {
    if (memoryMaintenance.has(memoryId)) continue
    const actual = memoryById.get(memoryId)
    if (!actual || actual.personId !== expected.personId || actual.timelineId !== timelineId || actual.type !== expected.type
      || actual.content !== expected.content || actual.importance !== expected.importance || actual.simTime !== expected.simTime
      || actual.createdAt !== expected.createdAt || actual.summarized !== isSummarizedSource(memoryId)) {
      report('memory_projection', `Conversation memory ${memoryId} is missing or differs from its private command evidence`,
        expected.commandId, expected.version)
    }
  }
  for (const [memoryId, maintenance] of memoryMaintenance) {
    const actual = memoryById.get(memoryId)
    if (maintenance.operation === 'forget') {
      if (actual) report('memory_projection', `Memory ${memoryId} should have been forgotten`, maintenance.commandId, maintenance.version)
    } else if (!actual || actual.content !== maintenance.content || actual.importance !== maintenance.importance) {
      report('memory_projection', `Memory ${memoryId} does not match its versioned correction`, maintenance.commandId, maintenance.version)
    }
  }
  if (memoryBaselineAt) {
    const provenMemoryIds = new Set([
      ...latestMemorySummaries.keys(), ...expectedCommitmentMemories.keys(),
      ...expectedResidentMemories.keys(), ...expectedConversationMemories.keys(), ...memoryMaintenance.keys(),
    ])
    const baselineMs = Date.parse(memoryBaselineAt)
    for (const actual of memoryRows) {
      if (actual.timelineId !== timelineId || Date.parse(actual.createdAt) <= baselineMs || provenMemoryIds.has(actual.id)) continue
      report('unproven_memory_projection', `Timeline memory ${actual.id} was created after its immutable baseline without a source command`,
        undefined, revision.version)
    }
  }
  const personaMessageById = new Map(personaMessageRows.map(message => [message.id, message]))
  for (const [messageId, expected] of expectedPersonaMessages) {
    const actual = personaMessageById.get(messageId)
    if (!actual || actual.worldId !== worldId || actual.timelineId !== timelineId
      || actual.senderPersonId !== expected.senderPersonId || actual.recipientPersonId !== expected.recipientPersonId
      || actual.content !== expected.content || actual.location !== expected.location || actual.simTime !== expected.simTime
      || actual.createdAt !== expected.createdAt) {
      report('persona_message_projection', `Conversation message ${messageId} is missing or differs from its private command evidence`,
        expected.commandId, expected.version)
    }
  }
  if (baselineAvailable) for (const actual of personaMessageRows) {
    if (!expectedPersonaMessages.has(actual.id)) {
      report('unproven_persona_message_projection', `Persona message ${actual.id} has no matching committed conversation command`,
        undefined, revision.version)
    }
  }
  const dialogueById = new Map(dialogueRows.map(dialogue => [dialogue.id, dialogue]))
  for (const [dialogueId, expected] of expectedDialogues) {
    const actual = dialogueById.get(dialogueId)
    if (!actual || actual.timelineId !== timelineId || actual.location !== expected.location
      || actual.participantIdsJson !== expected.participantIdsJson || actual.status !== expected.status || actual.kind !== expected.kind
      || actual.turnLimit !== expected.turnLimit || actual.simStart !== expected.simStart || actual.simEnd !== expected.simEnd) {
      report('conversation_projection', `Expected dialogue ${dialogueId} to match its conversation facts`, expected.commandId, expected.version)
    }
  }
  if (baselineAvailable) for (const actual of dialogueRows) {
    if (!expectedDialogues.has(actual.id)) {
      report('unproven_conversation_projection', `Dialogue ${actual.id} has no matching committed conversation command`, undefined, revision.version)
    }
  }
  const turnsById = new Map(turnRows.filter(turn => dialogueById.has(turn.dialogueId)).map(turn => [turn.id, turn]))
  for (const [turnId, expected] of expectedTurns) {
    const actual = turnsById.get(turnId)
    if (!actual || actual.dialogueId !== expected.dialogueId || actual.turnIndex !== expected.turnIndex
      || actual.personId !== expected.personId || (expected.utterance != null && actual.utterance !== expected.utterance)
      || (expected.thought != null && actual.thought !== expected.thought)) {
      report('conversation_projection', `Expected dialogue turn ${turnId} to match its conversation fact`, expected.commandId, expected.version)
    }
  }
  if (baselineAvailable) for (const actual of turnsById.values()) {
    if (!expectedTurns.has(actual.id)) {
      report('unproven_dialogue_turn_projection', `Dialogue turn ${actual.id} has no matching committed conversation command`, undefined, revision.version)
    }
  }
  const scheduleByKey = new Map(scheduleRows.map(schedule => [scheduleKey(schedule.personId, schedule.worldDate), schedule]))
  for (const [key, expected] of expectedSchedules) {
    const actual = scheduleByKey.get(key)
    if (!actual || actual.timelineId !== timelineId || actual.itemsJson !== expected.itemsJson
      || actual.generatedAt !== expected.generatedAt) {
      report('schedule_projection', `Schedule ${key} is missing or differs from its Fork checkpoint / command`,
        expected.commandId, expected.version)
    }
  }
  if (baselineAvailable) for (const actual of scheduleRows) {
    if (!expectedSchedules.has(scheduleKey(actual.personId, actual.worldDate))) {
      report('unproven_schedule_projection', `Schedule ${actual.personId}:${actual.worldDate} has no baseline or schedule command`,
        undefined, revision.version)
    }
  }
  if (forkSnapshot !== null || baselineEventIds !== null) for (const event of eventRows) {
    if (!expectedEventIds.has(event.id) && !baselineEventIds?.has(event.id)) {
      report('unproven_event_projection', `Event ${event.id} has no matching committed command`, undefined, revision.version)
    }
  }
  return violations
}

/** Public read-only audit entry: collect one D1 snapshot, replay it, then expose invariant diagnostics. */
export async function auditUniverse(db: Db, worldId: string, timelineId: string): Promise<InvariantViolation[]> {
  const { collectTimelineEvidence, rebuildProjection } = await import('./rebuild')
  const evidence = await collectTimelineEvidence(db, worldId, timelineId)
  const result = await rebuildProjection(db, worldId, timelineId, evidence)
  return result.differences.map(difference => {
    const separator = difference.detail.indexOf(': ')
    return {
      code: separator < 0 ? difference.kind : difference.detail.slice(0, separator),
      timelineId,
      commandId: difference.commandId,
      version: difference.version,
      detail: separator < 0 ? difference.detail : difference.detail.slice(separator + 2),
    }
  })
}
