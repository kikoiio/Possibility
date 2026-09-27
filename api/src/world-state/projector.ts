import type { worldCommands, worldFacts } from '../db/schema'
import { validateKnowledgeChain } from '../agent/knowledge'
import { PROJECTION_DOMAINS, type ProjectionBaseline, type ProjectionDomain, type ProjectionRows } from './model'

export interface ReplayInput {
  worldId: string
  timelineId: string
  baseline: ProjectionBaseline | null
  commands: (typeof worldCommands.$inferSelect)[]
  facts: (typeof worldFacts.$inferSelect)[]
  throughVersion: number
  /** Names come from the immutable pinned world model, never mutable person rows. */
  personNames?: Record<string, string>
  /** Ancestor/source facts visible at the baseline, used only for provenance validation. */
  sourceFacts?: (typeof worldFacts.$inferSelect)[]
  visibleTimelineIds?: string[]
}

export type RebuiltProjection = ProjectionRows

export type ReplayDiagnosticKind =
  | 'missing'
  | 'extra'
  | 'mismatch'
  | 'unsupported'
  | 'unproven'
  | 'wrong_version'
  | 'wrong_timeline'

export interface ReplayDiagnostic {
  kind: ReplayDiagnosticKind
  domain: ProjectionDomain | 'history'
  timelineId: string
  version?: number
  commandId?: string
  factId?: string
  recordId?: string
  reasonCode: string
}

export interface ReplayResult {
  ok: boolean
  projection: RebuiltProjection | null
  diagnostics: ReplayDiagnostic[]
}

const KNOWN_ACTION_TYPES = new Set([
  'enter', 'move', 'environment', 'intervention', 'inform', 'commitment', 'commitment_proposal', 'conversation',
  'dialogue_start', 'scene_open', 'dialogue_turn', 'clock_advance', 'simulation_checkpoint', 'dialogue_recovery',
  'schedule_set', 'memory_summary', 'memory_correct', 'memory_forget', 'resident_state',
])

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function cloneRows<T extends readonly unknown[]>(
  rows: T | undefined,
  worldId: string,
  timelineId: string,
  retargetNullTimeline = true,
): T {
  return (rows ?? []).map((row) => {
    const cloned = JSON.parse(JSON.stringify(row)) as unknown
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return cloned
    const record = cloned as Record<string, unknown>
    if ('worldId' in record) record.worldId = worldId
    if ('timelineId' in record && (record.timelineId !== null || retargetNullTimeline)) record.timelineId = timelineId
    return record
  }) as unknown as T
}

/** Canonicalize only top-level record collections; nested arrays retain their semantic order. */
export function normalizeProjection(projection: RebuiltProjection): RebuiltProjection {
  const sorted = <T>(rows: T[]) => [...rows].sort((left, right) => stableValue(left).localeCompare(stableValue(right)))
  return {
    simTime: projection.simTime,
    states: sorted(projection.states),
    schedules: sorted(projection.schedules),
    events: sorted(projection.events),
    commitments: sorted(projection.commitments),
    memories: sorted(projection.memories),
    dialogues: sorted(projection.dialogues),
    dialogueTurns: sorted(projection.dialogueTurns),
    personaMessages: sorted(projection.personaMessages),
    knowledge: sorted(projection.knowledge),
  }
}

export function serializeProjection(projection: RebuiltProjection): string {
  return stableValue(normalizeProjection(projection))
}

function projectionFromBaseline(input: ReplayInput): RebuiltProjection | null {
  if (!input.baseline) return null
  const rows = input.baseline.rows
  return normalizeProjection({
    simTime: input.baseline.simTime,
    states: cloneRows(rows.states, input.worldId, input.timelineId),
    schedules: cloneRows(rows.schedules, input.worldId, input.timelineId),
    events: cloneRows(rows.events, input.worldId, input.timelineId),
    commitments: cloneRows(rows.commitments, input.worldId, input.timelineId),
    memories: cloneRows(rows.memories, input.worldId, input.timelineId, input.baseline.source === 'fork'),
    dialogues: cloneRows(rows.dialogues, input.worldId, input.timelineId),
    dialogueTurns: cloneRows(rows.dialogueTurns, input.worldId, input.timelineId),
    personaMessages: cloneRows(rows.personaMessages, input.worldId, input.timelineId),
    knowledge: cloneRows(rows.knowledge, input.worldId, input.timelineId),
  })
}

/** Pure replay entry. Reducers replace the explicit reducer_not_implemented diagnostics domain by domain. */
export function reduceProjection(input: ReplayInput): ReplayResult {
  const diagnostics: ReplayDiagnostic[] = []
  const report = (diagnostic: Omit<ReplayDiagnostic, 'timelineId'>) => diagnostics.push({
    ...diagnostic,
    timelineId: input.timelineId,
  })
  if (!input.baseline) {
    report({ kind: 'missing', domain: 'history', reasonCode: 'baseline_missing' })
    return { ok: false, projection: null, diagnostics }
  }
  const projection = projectionFromBaseline(input)!
  const appendEvent = (event: RebuiltProjection['events'][number], commandId: string, version: number) => {
    if (projection.events.some(existing => existing.id === event.id)) {
      report({ kind: 'extra', domain: 'events', commandId, recordId: event.id, version,
        reasonCode: 'event_id_already_exists' })
      return
    }
    projection.events.push(event)
  }
  const appendMemory = (memory: RebuiltProjection['memories'][number], commandId: string, version: number) => {
    if (projection.memories.some(existing => existing.id === memory.id)) {
      report({ kind: 'extra', domain: 'memories', commandId, recordId: memory.id, version,
        reasonCode: 'memory_id_already_exists' })
      return
    }
    projection.memories.push(memory)
  }
  const locationWrites = new Map<string, { location: string; commandId: string }>()
  const recordLocation = (personId: string, simTime: string, location: string, commandId: string, version: number) => {
    const key = `${personId}\u0000${simTime}`
    const prior = locationWrites.get(key)
    if (prior && prior.location !== location) {
      report({ kind: 'mismatch', domain: 'states', commandId, recordId: personId, version,
        reasonCode: 'conflicting_location_at_same_time' })
    }
    locationWrites.set(key, { location, commandId })
  }
  for (const domain of PROJECTION_DOMAINS) {
    if (!input.baseline.completeDomains.includes(domain)) {
      report({ kind: 'missing', domain, reasonCode: 'baseline_domain_missing' })
    }
  }
  if (!Number.isSafeInteger(input.throughVersion) || input.throughVersion < 0) {
    report({ kind: 'wrong_version', domain: 'history', reasonCode: 'through_version_invalid' })
  }
  if (input.commands.length !== input.throughVersion) {
    report({ kind: input.commands.length < input.throughVersion ? 'missing' : 'extra', domain: 'history',
      reasonCode: 'command_count_mismatch' })
  }
  if (input.facts.length !== input.throughVersion) {
    report({ kind: input.facts.length < input.throughVersion ? 'missing' : 'extra', domain: 'history',
      reasonCode: 'fact_count_mismatch' })
  }

  const factsByVersion = new Map(input.facts.map(fact => [fact.version, fact]))
  for (let index = 0; index < input.commands.length; index++) {
    const command = input.commands[index]
    const expectedVersion = index + 1
    if (command.worldId !== input.worldId || command.timelineId !== input.timelineId) {
      report({ kind: 'wrong_timeline', domain: 'history', commandId: command.id,
        version: command.resultVersion, reasonCode: 'command_scope_mismatch' })
    }
    if (command.expectedVersion !== index || command.resultVersion !== expectedVersion) {
      report({ kind: 'wrong_version', domain: 'history', commandId: command.id,
        version: command.resultVersion, reasonCode: 'command_version_gap' })
    }
    const fact = factsByVersion.get(expectedVersion)
    if (!fact) {
      report({ kind: 'missing', domain: 'history', commandId: command.id,
        version: expectedVersion, reasonCode: 'fact_missing_for_command' })
    } else {
      if (fact.timelineId !== input.timelineId) {
        report({ kind: 'wrong_timeline', domain: 'history', commandId: command.id, factId: fact.id,
          version: fact.version, reasonCode: 'fact_scope_mismatch' })
      }
      if (fact.sourceCommandId !== command.id) {
        report({ kind: 'mismatch', domain: 'history', commandId: command.id, factId: fact.id,
          version: fact.version, reasonCode: 'fact_command_mismatch' })
      }
    }
    let action: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(command.payloadJson) as unknown
      action = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch { /* reported below */ }
    if (!action || typeof action.type !== 'string') {
      report({ kind: 'unsupported', domain: 'history', commandId: command.id,
        version: command.resultVersion, reasonCode: 'command_payload_invalid' })
      continue
    }
    if (action.type !== command.type) {
      report({ kind: 'mismatch', domain: 'history', commandId: command.id,
        version: command.resultVersion, reasonCode: 'command_type_mismatch' })
      continue
    }
    if (!KNOWN_ACTION_TYPES.has(action.type)) {
      report({ kind: 'unsupported', domain: 'history', commandId: command.id,
        version: command.resultVersion, reasonCode: 'action_type_unknown' })
      continue
    }
    const stateIndex = (personId: string) => projection.states.findIndex(state => state.personId === personId)
    if (action.type === 'clock_advance') {
      const from = typeof action.from === 'string' ? action.from : ''
      const to = typeof action.to === 'string' ? action.to : ''
      if (from !== projection.simTime || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)) {
        report({ kind: 'mismatch', domain: 'clock', commandId: command.id, factId: fact?.id,
          version: command.resultVersion, reasonCode: 'clock_transition_invalid' })
        continue
      }
      if (fact && (fact.factType !== 'clock' || fact.subjectId !== input.timelineId || fact.simTime !== to)) {
        report({ kind: 'mismatch', domain: 'clock', commandId: command.id, factId: fact.id,
          version: command.resultVersion, reasonCode: 'clock_fact_mismatch' })
      }
      projection.simTime = to
      continue
    }
    if (action.type === 'enter' || action.type === 'move') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const to = typeof action.to === 'string' ? action.to : ''
      const index = stateIndex(personId)
      if (!personId || !to || (action.type === 'enter' ? index >= 0 : index < 0)) {
        report({ kind: action.type === 'enter' ? 'extra' : 'missing', domain: 'states', commandId: command.id,
          recordId: personId || undefined, version: command.resultVersion,
          reasonCode: action.type === 'enter' ? 'enter_state_already_exists' : 'move_state_missing' })
        continue
      }
      if (fact && (fact.factType !== 'location' || fact.subjectId !== personId)) {
        report({ kind: 'mismatch', domain: 'states', commandId: command.id, factId: fact.id,
          recordId: personId, version: command.resultVersion, reasonCode: 'location_fact_mismatch' })
      }
      recordLocation(personId, projection.simTime, to, command.id, command.resultVersion)
      const priorLocation = index >= 0 ? projection.states[index].location : null
      let locationFact: Record<string, unknown> | null = null
      try { locationFact = fact ? JSON.parse(fact.valueJson) as Record<string, unknown> : null } catch { /* fact mismatch is reported above */ }
      const personName = typeof locationFact?.personName === 'string'
        ? locationFact.personName : input.personNames?.[personId] ?? '一位人物'
      if (action.type === 'enter') {
        projection.states.push({ personId, timelineId: input.timelineId, simTime: projection.simTime, location: to,
          activity: '刚来到这里', mood: '平静', goal: '探索这个世界', updatedRealAt: command.createdAt,
          currentDialogueId: null, lastBeatSimTime: projection.simTime })
      } else {
        projection.states[index] = { ...projection.states[index], location: to, simTime: projection.simTime,
          updatedRealAt: command.createdAt }
      }
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: projection.simTime,
        title: `${personName}来到${to}`,
        description: priorLocation ? `${personName}从${priorLocation}来到${to}。` : `${personName}进入世界，来到${to}。`,
        kind: 'action', actorPersonId: personId, dialogueId: null }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'resident_state') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const index = stateIndex(personId)
      const patch = action.patch && typeof action.patch === 'object' && !Array.isArray(action.patch)
        ? action.patch as Record<string, unknown> : null
      const advanceTo = action.advanceTo === undefined ? projection.simTime
        : typeof action.advanceTo === 'string' ? action.advanceTo : ''
      if (index < 0 || !patch || !advanceTo || Date.parse(advanceTo) < Date.parse(projection.simTime)) {
        report({ kind: index < 0 ? 'missing' : 'mismatch', domain: 'states', commandId: command.id,
          recordId: personId || undefined, version: command.resultVersion, reasonCode: 'resident_state_transition_invalid' })
        continue
      }
      const allowedPatch = ['location', 'activity', 'mood', 'goal', 'lastBeatSimTime'] as const
      if (Object.entries(patch).some(([key, value]) => !allowedPatch.includes(key as typeof allowedPatch[number])
        || typeof value !== 'string')) {
        report({ kind: 'mismatch', domain: 'states', commandId: command.id, recordId: personId,
          version: command.resultVersion, reasonCode: 'resident_state_patch_invalid' })
        continue
      }
      const expectedFactType = typeof patch.location === 'string'
        && projection.states[index]?.location !== patch.location ? 'location' : 'resident_state'
      if (fact && (fact.factType !== expectedFactType || fact.subjectId !== personId || fact.simTime !== advanceTo)) {
        report({ kind: 'mismatch', domain: 'states', commandId: command.id, factId: fact.id,
          recordId: personId, version: command.resultVersion, reasonCode: 'resident_state_fact_mismatch' })
      }
      if (typeof patch.location === 'string') {
        recordLocation(personId, advanceTo, patch.location, command.id, command.resultVersion)
      }
      projection.states[index] = { ...projection.states[index], ...patch, simTime: advanceTo,
        updatedRealAt: command.createdAt }
      if (Date.parse(advanceTo) > Date.parse(projection.simTime)) projection.simTime = advanceTo
      const personName = input.personNames?.[personId] ?? '一位人物'
      const cause = typeof action.cause === 'string' ? action.cause : ''
      const storyEvents = Array.isArray(action.events) ? action.events : []
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: advanceTo,
        title: `${personName}的${cause === 'schedule' ? '日程' : '生活'}状态发生变化`,
        description: storyEvents.length
          ? `${personName}在${storyEvents.length}段已记录经历后，状态出现了可追溯变化。`
          : `${personName}的结构化状态已更新。`,
        kind: 'action', actorPersonId: personId, dialogueId: null }, command.id, command.resultVersion)
      storyEvents.forEach((item, storyIndex) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          report({ kind: 'mismatch', domain: 'events', commandId: command.id, version: command.resultVersion,
            reasonCode: 'resident_story_event_invalid' })
          return
        }
        const story = item as Record<string, unknown>
        if (typeof story.simTime !== 'string' || typeof story.title !== 'string' || typeof story.description !== 'string') {
          report({ kind: 'mismatch', domain: 'events', commandId: command.id, version: command.resultVersion,
            reasonCode: 'resident_story_event_invalid' })
          return
        }
        appendEvent({ id: `${command.id}:story:${storyIndex}`, timelineId: input.timelineId, simTime: story.simTime,
          title: story.title, description: story.description, kind: 'action', actorPersonId: personId, dialogueId: null },
        command.id, command.resultVersion)
      })
      const stateMemories = Array.isArray(action.memories) ? action.memories : []
      stateMemories.forEach((item, memoryIndex) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return
        const memory = item as Record<string, unknown>
        if (typeof memory.type !== 'string' || typeof memory.content !== 'string'
          || typeof memory.importance !== 'number') {
          report({ kind: 'mismatch', domain: 'memories', commandId: command.id,
            version: command.resultVersion, reasonCode: 'resident_memory_invalid' })
          return
        }
        appendMemory({ id: `${command.id}:memory:${memoryIndex}`, personId, timelineId: input.timelineId,
          type: memory.type, content: memory.content, simTime: advanceTo, createdAt: command.createdAt,
          importance: memory.importance, summarized: false }, command.id, command.resultVersion)
      })
      continue
    }
    if (action.type === 'simulation_checkpoint') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const lastBeatSimTime = typeof action.lastBeatSimTime === 'string' ? action.lastBeatSimTime : ''
      const index = stateIndex(personId)
      if (index < 0 || !lastBeatSimTime || Date.parse(lastBeatSimTime) > Date.parse(projection.simTime)) {
        report({ kind: index < 0 ? 'missing' : 'mismatch', domain: 'states', commandId: command.id,
          recordId: personId || undefined, version: command.resultVersion, reasonCode: 'simulation_checkpoint_invalid' })
        continue
      }
      projection.states[index] = { ...projection.states[index], lastBeatSimTime, updatedRealAt: command.createdAt }
      continue
    }
    if (action.type === 'dialogue_start' || action.type === 'scene_open') {
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      const participantIds = Array.isArray(action.participantIds)
        ? action.participantIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
      const location = typeof action.location === 'string' ? action.location : ''
      const turnLimit = Number.isSafeInteger(action.turnLimit) ? Number(action.turnLimit) : 0
      const visitorId = action.type === 'scene_open' && typeof action.visitorId === 'string' ? action.visitorId : null
      const participantStates = participantIds.map(personId => stateIndex(personId))
      if (!dialogueId || participantIds.length < 2 || !location || !turnLimit
        || projection.dialogues.some(dialogue => dialogue.id === dialogueId)
        || participantStates.some(index => index < 0)
        || participantStates.some(index => projection.states[index].location !== location
          || projection.states[index].currentDialogueId !== null)
        || (action.type === 'scene_open' && (!visitorId || !participantIds.includes(visitorId)))) {
        report({ kind: projection.dialogues.some(dialogue => dialogue.id === dialogueId) ? 'extra' : 'mismatch',
          domain: 'dialogues', commandId: command.id, recordId: dialogueId || undefined,
          version: command.resultVersion, reasonCode: `${action.type}_transition_invalid` })
        continue
      }
      projection.dialogues.push({ id: dialogueId, timelineId: input.timelineId, location,
        participantIdsJson: JSON.stringify(participantIds), status: action.type === 'scene_open' ? 'scene' : 'ongoing',
        turnLimit, simStart: projection.simTime, simEnd: action.type === 'scene_open' ? projection.simTime : null,
        kind: action.type === 'scene_open' ? 'scene' : 'npc', visitorId, sceneBusyUntil: null })
      if (action.type === 'dialogue_start') {
        for (const index of participantStates) {
          projection.states[index] = { ...projection.states[index], currentDialogueId: dialogueId,
            updatedRealAt: command.createdAt }
        }
        let conversationFact: Record<string, unknown> | null = null
        try { conversationFact = fact ? JSON.parse(fact.valueJson) as Record<string, unknown> : null } catch { /* diagnosed elsewhere */ }
        const participantNames = Array.isArray(conversationFact?.participantNames)
          ? conversationFact!.participantNames.filter((name): name is string => typeof name === 'string') : []
        const title = `${(participantNames.length === participantIds.length
          ? participantNames : participantIds.map(id => input.personNames?.[id] ?? '某人')).join(' 与 ')} 在${location}开始交谈`
        appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: projection.simTime,
          title, description: '居民之间开始了一场交谈。', kind: 'dialogue', actorPersonId: null,
          dialogueId }, command.id, command.resultVersion)
      }
      continue
    }
    if (action.type === 'dialogue_turn') {
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      const speakerId = typeof action.speakerId === 'string' ? action.speakerId : ''
      const turnIndex = Number.isSafeInteger(action.turnIndex) ? Number(action.turnIndex) : -1
      const utterance = typeof action.utterance === 'string' ? action.utterance : ''
      const thought = typeof action.thought === 'string' ? action.thought : ''
      const dialogueIndex = projection.dialogues.findIndex(dialogue => dialogue.id === dialogueId)
      const dialogue = projection.dialogues[dialogueIndex]
      let participantIds: string[] = []
      try { participantIds = dialogue ? JSON.parse(dialogue.participantIdsJson) as string[] : [] } catch { /* diagnosed below */ }
      const priorTurns = projection.dialogueTurns.filter(turn => turn.dialogueId === dialogueId)
        .sort((left, right) => left.turnIndex - right.turnIndex)
      if (!dialogue || dialogue.status !== 'ongoing' || dialogue.kind !== 'npc' || !participantIds.includes(speakerId)
        || turnIndex !== priorTurns.length || participantIds[turnIndex % participantIds.length] !== speakerId
        || participantIds.some(personId => {
          const index = stateIndex(personId)
          return index < 0 || projection.states[index].currentDialogueId !== dialogueId
        })) {
        report({ kind: dialogue ? 'mismatch' : 'missing', domain: 'dialogueTurns', commandId: command.id,
          recordId: `${dialogueId}:${turnIndex}`, version: command.resultVersion, reasonCode: 'dialogue_turn_sequence_invalid' })
        continue
      }
      projection.dialogueTurns.push({ id: `${command.id}:turn`, dialogueId, turnIndex, personId: speakerId,
        utterance, thought, simTime: projection.simTime, createdAt: command.createdAt })
      appendMemory({ id: `${command.id}:thought`, personId: speakerId, timelineId: input.timelineId,
        type: 'thought', content: thought, simTime: projection.simTime, createdAt: command.createdAt,
        importance: 5, summarized: false }, command.id, command.resultVersion)
      if (action.memory && typeof action.memory === 'object' && !Array.isArray(action.memory)) {
        const memory = action.memory as Record<string, unknown>
        if (typeof memory.content === 'string' && typeof memory.importance === 'number') {
          appendMemory({ id: `${command.id}:memory`, personId: speakerId, timelineId: input.timelineId,
            type: 'relationship', content: memory.content, simTime: projection.simTime, createdAt: command.createdAt,
            importance: memory.importance, summarized: false }, command.id, command.resultVersion)
        }
      }
      const counts = new Map<string, number>()
      for (const turn of [...priorTurns, { personId: speakerId }]) {
        counts.set(turn.personId, (counts.get(turn.personId) ?? 0) + 1)
      }
      const closes = turnIndex + 1 >= dialogue.turnLimit
        || (action.shouldEnd === true && participantIds.every(id => (counts.get(id) ?? 0) >= 2))
      let turnFact: Record<string, unknown> | null = null
      try { turnFact = fact ? JSON.parse(fact.valueJson) as Record<string, unknown> : null } catch { /* diagnosed elsewhere */ }
      const speakerName = typeof turnFact?.speakerName === 'string' ? turnFact.speakerName
        : input.personNames?.[speakerId] ?? '某人'
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: projection.simTime,
        title: `${speakerName}在${dialogue.location}说话`, description: utterance,
        kind: 'dialogue', actorPersonId: speakerId, dialogueId }, command.id, command.resultVersion)
      if (closes) {
        projection.dialogues[dialogueIndex] = { ...dialogue, status: 'ended', simEnd: projection.simTime }
        for (const personId of participantIds) {
          const index = stateIndex(personId)
          projection.states[index] = { ...projection.states[index], currentDialogueId: null,
            lastBeatSimTime: projection.simTime, updatedRealAt: command.createdAt }
        }
      }
      continue
    }
    if (action.type === 'conversation') {
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      const requestId = typeof action.requestId === 'string' ? action.requestId : ''
      const dialogue = projection.dialogues.find(item => item.id === dialogueId)
      let participants: string[] = []
      try { participants = dialogue ? JSON.parse(dialogue.participantIdsJson) as string[] : [] } catch { /* diagnosed below */ }
      const turns = Array.isArray(action.turns) ? action.turns : null
      const scene = action.sceneProjection && typeof action.sceneProjection === 'object' && !Array.isArray(action.sceneProjection)
        ? action.sceneProjection as Record<string, unknown> : null
      const projectedParticipants = Array.isArray(scene?.participantIds) ? scene!.participantIds : []
      if (!dialogue || dialogue.kind !== 'scene' || dialogue.status !== 'scene' || !requestId || !turns?.length
        || !scene || scene.location !== dialogue.location || scene.simTime !== projection.simTime
        || stableValue(projectedParticipants) !== stableValue(participants)) {
        report({ kind: dialogue ? 'mismatch' : 'missing', domain: 'dialogues', commandId: command.id,
          recordId: dialogueId || undefined, version: command.resultVersion, reasonCode: 'scene_conversation_projection_invalid' })
        continue
      }
      const privateEffects = action.privateEffects && typeof action.privateEffects === 'object'
        && !Array.isArray(action.privateEffects) ? action.privateEffects as Record<string, unknown> : null
      const thoughtEffects = Array.isArray(privateEffects?.memories)
        ? privateEffects!.memories.filter((item): item is Record<string, unknown> => Boolean(item)
          && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'thought') : []
      const nextThought = new Map<string, Record<string, unknown>[]>()
      for (const memory of thoughtEffects) {
        if (typeof memory.personId !== 'string') continue
        nextThought.set(memory.personId, [...nextThought.get(memory.personId) ?? [], memory])
      }
      const startingIndex = projection.dialogueTurns.filter(turn => turn.dialogueId === dialogueId).length
      const turnCreatedAt = typeof scene.createdAt === 'string' ? scene.createdAt : command.createdAt
      turns.forEach((item, offset) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return
        const turn = item as Record<string, unknown>
        if (typeof turn.id !== 'string' || typeof turn.personId !== 'string' || typeof turn.utterance !== 'string') return
        const thought = nextThought.get(turn.personId)?.shift()?.content
        projection.dialogueTurns.push({ id: turn.id, dialogueId, turnIndex: startingIndex + offset,
          personId: turn.personId, utterance: turn.utterance, thought: typeof thought === 'string' ? thought : '',
          simTime: projection.simTime, createdAt: turnCreatedAt })
      })
      const effectMemories = Array.isArray(privateEffects?.memories) ? privateEffects!.memories : []
      effectMemories.forEach((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return
        const memory = item as Record<string, unknown>
        if (typeof memory.id !== 'string' || typeof memory.personId !== 'string'
          || typeof memory.type !== 'string' || typeof memory.content !== 'string'
          || typeof memory.simTime !== 'string' || typeof memory.createdAt !== 'string'
          || typeof memory.importance !== 'number') return
        appendMemory({ id: memory.id, personId: memory.personId, timelineId: input.timelineId,
          type: memory.type, content: memory.content, simTime: memory.simTime, createdAt: memory.createdAt,
          importance: memory.importance, summarized: false }, command.id, command.resultVersion)
      })
      const effectMessages = Array.isArray(privateEffects?.messages) ? privateEffects!.messages : []
      effectMessages.forEach((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return
        const message = item as Record<string, unknown>
        if (typeof message.id !== 'string' || typeof message.senderPersonId !== 'string'
          || typeof message.recipientPersonId !== 'string' || typeof message.content !== 'string'
          || typeof message.location !== 'string' || typeof message.simTime !== 'string'
          || typeof message.createdAt !== 'string') return
        if (projection.personaMessages.some(existing => existing.id === message.id)) {
          report({ kind: 'extra', domain: 'personaMessages', commandId: command.id, recordId: message.id,
            version: command.resultVersion, reasonCode: 'persona_message_id_already_exists' })
          return
        }
        projection.personaMessages.push({ id: message.id, worldId: input.worldId, timelineId: input.timelineId,
          senderPersonId: message.senderPersonId, recipientPersonId: message.recipientPersonId,
          content: message.content, location: message.location, simTime: message.simTime,
          read: false, createdAt: message.createdAt })
      })
      const acceptedCommitments = Array.isArray(action.acceptedCommitments) ? action.acceptedCommitments : []
      acceptedCommitments.forEach((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !dialogue.visitorId) return
        const accepted = item as Record<string, unknown>
        if (typeof accepted.id !== 'string' || typeof accepted.personId !== 'string'
          || typeof accepted.title !== 'string' || (accepted.kind !== 'meeting' && accepted.kind !== 'help')
          || typeof accepted.location !== 'string' || typeof accepted.dueSim !== 'string') return
        if (projection.commitments.some(existing => existing.id === accepted.id)) {
          report({ kind: 'extra', domain: 'commitments', commandId: command.id, recordId: accepted.id,
            version: command.resultVersion, reasonCode: 'commitment_id_already_exists' })
          return
        }
        projection.commitments.push({ id: accepted.id, worldId: input.worldId, timelineId: input.timelineId,
          personId: accepted.personId, visitorId: dialogue.visitorId, sourceDialogueId: dialogue.id,
          title: accepted.title, kind: accepted.kind, location: accepted.location, dueSim: accepted.dueSim,
          status: 'accepted', createdSim: projection.simTime, updatedSim: projection.simTime,
          createdAt: command.createdAt })
      })
      let conversationFact: Record<string, unknown> | null = null
      try { conversationFact = fact ? JSON.parse(fact.valueJson) as Record<string, unknown> : null } catch { /* diagnosed elsewhere */ }
      const participantNames = Array.isArray(conversationFact?.participantNames)
        ? conversationFact!.participantNames.filter((name): name is string => typeof name === 'string') : []
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: projection.simTime,
        title: `${(participantNames.length === participants.length
          ? participantNames : participants.map(id => input.personNames?.[id] ?? '某人')).join(' 与 ')} 在${dialogue.location}交谈`,
        description: `一次在场交谈已记录（${turns.length} 句）；完整发言见交谈记录。`, kind: 'dialogue',
        actorPersonId: dialogue.visitorId, dialogueId }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'schedule_set') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const worldDate = typeof action.worldDate === 'string' ? action.worldDate : ''
      const generatedAt = typeof action.generatedAt === 'string' ? action.generatedAt : ''
      const items = Array.isArray(action.items) ? action.items : null
      if (!personId || !worldDate || !generatedAt || !items) {
        report({ kind: 'mismatch', domain: 'schedules', commandId: command.id,
          version: command.resultVersion, reasonCode: 'schedule_payload_invalid' })
        continue
      }
      if (projection.schedules.some(schedule => schedule.personId === personId && schedule.worldDate === worldDate)) {
        report({ kind: 'extra', domain: 'schedules', commandId: command.id, recordId: `${personId}:${worldDate}`,
          version: command.resultVersion, reasonCode: 'schedule_already_exists' })
        continue
      }
      if (fact && (fact.factType !== 'schedule' || fact.subjectId !== `${personId}:${worldDate}`)) {
        report({ kind: 'mismatch', domain: 'schedules', commandId: command.id, factId: fact.id,
          recordId: `${personId}:${worldDate}`, version: command.resultVersion, reasonCode: 'schedule_fact_mismatch' })
      }
      projection.schedules.push({ personId, timelineId: input.timelineId, worldDate,
        itemsJson: JSON.stringify(items), generatedAt })
      continue
    }
    if (action.type === 'dialogue_recovery') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const dialogueId = typeof action.dialogueId === 'string' ? action.dialogueId : ''
      const index = stateIndex(personId)
      if (index < 0 || !dialogueId || projection.states[index].currentDialogueId !== dialogueId) {
        report({ kind: index < 0 ? 'missing' : 'mismatch', domain: 'states', commandId: command.id,
          recordId: personId || undefined, version: command.resultVersion, reasonCode: 'dialogue_recovery_state_mismatch' })
        continue
      }
      projection.states[index] = { ...projection.states[index], currentDialogueId: null,
        updatedRealAt: command.createdAt }
      continue
    }
    if (action.type === 'memory_summary') {
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const sourceMemoryIds = Array.isArray(action.sourceMemoryIds)
        ? action.sourceMemoryIds.filter((id): id is string => typeof id === 'string') : []
      const summaryId = typeof action.summaryId === 'string' ? action.summaryId : ''
      const content = typeof action.content === 'string' ? action.content : ''
      const importance = typeof action.importance === 'number' ? action.importance : 0
      const simTime = typeof action.simTime === 'string' ? action.simTime : ''
      const createdAt = typeof action.createdAt === 'string' ? action.createdAt : ''
      const sources = sourceMemoryIds.map(id => projection.memories.find(memory => memory.id === id))
      if (!personId || !summaryId || !content || !simTime || !createdAt || !sourceMemoryIds.length
        || sources.some(memory => !memory || memory.personId !== personId || memory.summarized || memory.type === 'summary')) {
        report({ kind: sources.some(memory => !memory) ? 'missing' : 'mismatch', domain: 'memories',
          commandId: command.id, recordId: summaryId || undefined, version: command.resultVersion,
          reasonCode: 'memory_summary_source_invalid' })
        continue
      }
      for (const source of sources) source!.summarized = true
      appendMemory({ id: summaryId, personId, timelineId: input.timelineId, type: 'summary', content,
        simTime, createdAt, importance, summarized: false }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'memory_correct' || action.type === 'memory_forget') {
      const memoryId = typeof action.memoryId === 'string' ? action.memoryId : ''
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const index = projection.memories.findIndex(memory => memory.id === memoryId && memory.personId === personId)
      const memory = projection.memories[index]
      const before = action.before && typeof action.before === 'object' && !Array.isArray(action.before)
        ? action.before as Record<string, unknown> : null
      const matches = memory && before && memory.timelineId === input.timelineId
        && memory.type === before.type && memory.content === before.content && memory.importance === before.importance
        && memory.simTime === before.simTime && memory.createdAt === before.createdAt
        && memory.summarized === before.summarized
      if (!matches) {
        report({ kind: memory ? 'mismatch' : 'missing', domain: 'memories', commandId: command.id,
          recordId: memoryId || undefined, version: command.resultVersion, reasonCode: 'memory_maintenance_before_mismatch' })
        continue
      }
      if (action.type === 'memory_correct') {
        const after = action.after && typeof action.after === 'object' && !Array.isArray(action.after)
          ? action.after as Record<string, unknown> : null
        if (!after || typeof after.content !== 'string' || typeof after.importance !== 'number') {
          report({ kind: 'mismatch', domain: 'memories', commandId: command.id, recordId: memoryId,
            version: command.resultVersion, reasonCode: 'memory_correction_after_invalid' })
          continue
        }
        projection.memories[index] = { ...memory, content: after.content, importance: after.importance }
      } else {
        projection.memories.splice(index, 1)
      }
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: projection.simTime,
        title: action.type === 'memory_correct' ? '居民记忆被校正' : '居民遗忘了一条记忆',
        description: action.type === 'memory_correct' ? '构造者校正了一条居民记忆。' : '构造者让居民遗忘了一条记忆。',
        kind: 'injected', actorPersonId: null, dialogueId: null }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'environment') {
      const location = typeof action.location === 'string' ? action.location.trim() || null : null
      const condition = typeof action.condition === 'string' ? action.condition.trim() : ''
      const valueText = typeof action.value === 'string' ? action.value.trim() : ''
      let value: Record<string, unknown> | null = null
      try { value = fact ? JSON.parse(fact.valueJson) as Record<string, unknown> : null } catch { /* diagnosed below */ }
      if (!fact || fact.factType !== 'environment' || fact.subjectId !== `${location ?? 'world'}:${condition}`
        || !value || value.location !== location || value.condition !== condition || value.value !== valueText) {
        report({ kind: fact ? 'mismatch' : 'missing', domain: 'history', commandId: command.id,
          factId: fact?.id, version: command.resultVersion, reasonCode: 'environment_fact_mismatch' })
        continue
      }
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: fact.simTime,
        title: `${location ?? '世界'}的${condition}发生变化`,
        description: `${location ?? '整个世界'}的${condition}变为：${valueText}。`, kind: 'action',
        actorPersonId: null, dialogueId: null }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'intervention') {
      const requestId = typeof action.requestId === 'string' ? action.requestId.trim() : ''
      const text = typeof action.text === 'string' ? action.text.trim() : ''
      let value: Record<string, unknown> | null = null
      try { value = fact ? JSON.parse(fact.valueJson) as Record<string, unknown> : null } catch { /* diagnosed below */ }
      if (!fact || fact.factType !== 'intervention' || fact.subjectId !== requestId || !value
        || value.requestId !== requestId || value.text !== text || value.authoredBy !== 'builder') {
        report({ kind: fact ? 'mismatch' : 'missing', domain: 'history', commandId: command.id,
          factId: fact?.id, version: command.resultVersion, reasonCode: 'intervention_fact_mismatch' })
        continue
      }
      appendEvent({ id: `intervention:${requestId}`, timelineId: input.timelineId, simTime: fact.simTime,
        title: text.slice(0, 60), description: text, kind: 'injected', actorPersonId: null,
        dialogueId: null }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'inform') {
      const recipientId = typeof action.recipientId === 'string' ? action.recipientId : ''
      const topic = typeof action.topic === 'string' ? action.topic.trim() : ''
      const content = typeof action.content === 'string' ? action.content.trim() : ''
      const sourceFactId = typeof action.sourceFactId === 'string' && action.sourceFactId ? action.sourceFactId : null
      let value: Record<string, unknown> | null = null
      try {
        const parsed = fact ? JSON.parse(fact.valueJson) as unknown : null
        value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      } catch { /* diagnosed below */ }
      const certainty = value?.certainty === 'fact' || value?.certainty === 'rumor' ? value.certainty : null
      if (!fact || fact.factType !== 'knowledge' || fact.visibility !== 'private'
        || fact.subjectId !== `${recipientId}:${topic}` || !value || !certainty
        || value.recipientId !== recipientId || value.topic !== topic || value.content !== content
        || (value.sourceFactId ?? null) !== sourceFactId) {
        report({ kind: fact ? 'mismatch' : 'missing', domain: 'knowledge', commandId: command.id,
          factId: fact?.id, recordId: fact?.id, version: command.resultVersion, reasonCode: 'knowledge_fact_mismatch' })
        continue
      }
      const visibleFacts = [
        ...(input.sourceFacts ?? []),
        ...projection.knowledge,
        ...input.facts.filter(candidate => candidate.version < command.resultVersion),
      ].filter((candidate, candidateIndex, all) => all.findIndex(item => item.id === candidate.id) === candidateIndex)
      const validation = validateKnowledgeChain({ recipientId, topic, content, certainty, sourceFactId }, visibleFacts, {
        currentVersion: command.resultVersion,
        currentTimelineId: input.timelineId,
        allowedTimelineIds: new Set(input.visibleTimelineIds ?? [input.timelineId]),
      })
      if (!validation.ok) {
        report({ kind: validation.reasonCode === 'source_missing' ? 'missing' : 'mismatch', domain: 'knowledge',
          commandId: command.id, factId: fact.id, recordId: fact.id, version: command.resultVersion,
          reasonCode: `knowledge_${validation.reasonCode}` })
        continue
      }
      if (projection.knowledge.some(existing => existing.id === fact.id)) {
        report({ kind: 'extra', domain: 'knowledge', commandId: command.id, factId: fact.id,
          recordId: fact.id, version: command.resultVersion, reasonCode: 'knowledge_fact_already_exists' })
        continue
      }
      projection.knowledge.push({ ...fact })
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: fact.simTime,
        title: '一条消息被转告', description: '一位居民获得一条消息；内容只对获知者可见。',
        kind: 'action', actorPersonId: null, dialogueId: null }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'commitment_proposal') {
      const id = typeof action.commitmentId === 'string' ? action.commitmentId : ''
      const personId = typeof action.personId === 'string' ? action.personId : ''
      const visitorId = typeof action.visitorId === 'string' ? action.visitorId : ''
      const sourceDialogueId = typeof action.sourceDialogueId === 'string' ? action.sourceDialogueId : ''
      const title = typeof action.title === 'string' ? action.title.trim() : ''
      const kind = action.kind === 'meeting' || action.kind === 'help' ? action.kind : null
      const location = typeof action.location === 'string' ? action.location : ''
      const dueSim = typeof action.dueSim === 'string' ? action.dueSim : ''
      const source = projection.dialogues.find(dialogue => dialogue.id === sourceDialogueId)
      let participants: string[] = []
      try { participants = source ? JSON.parse(source.participantIdsJson) as string[] : [] } catch { /* diagnosed below */ }
      if (!id || !personId || !visitorId || !title || !kind || !location || !dueSim
        || !source || source.kind !== 'scene' || source.visitorId !== visitorId
        || !participants.includes(personId) || !participants.includes(visitorId)) {
        report({ kind: source ? 'mismatch' : 'missing', domain: 'commitments', commandId: command.id,
          recordId: id || undefined, version: command.resultVersion, reasonCode: 'commitment_proposal_source_invalid' })
        continue
      }
      if (projection.commitments.some(item => item.id === id)) {
        report({ kind: 'extra', domain: 'commitments', commandId: command.id, recordId: id,
          version: command.resultVersion, reasonCode: 'commitment_id_already_exists' })
        continue
      }
      if (fact && (fact.factType !== 'commitment' || fact.subjectId !== id)) {
        report({ kind: 'mismatch', domain: 'commitments', commandId: command.id, factId: fact.id,
          recordId: id, version: command.resultVersion, reasonCode: 'commitment_fact_mismatch' })
      }
      projection.commitments.push({ id, worldId: input.worldId, timelineId: input.timelineId, personId, visitorId,
        sourceDialogueId, title, kind, location, dueSim, status: 'proposed', createdSim: projection.simTime,
        updatedSim: projection.simTime, createdAt: command.createdAt })
      const residentName = input.personNames?.[personId] ?? '一位居民'
      appendEvent({ id: `command:${command.id}`, timelineId: input.timelineId, simTime: projection.simTime,
        title: `${residentName}提出了一项邀请`, description: '一位居民提出一项邀请；具体内容仅对当事人可见。',
        kind: 'dialogue', actorPersonId: personId, dialogueId: sourceDialogueId }, command.id, command.resultVersion)
      continue
    }
    if (action.type === 'commitment') {
      const id = typeof action.commitmentId === 'string' ? action.commitmentId : ''
      const next = typeof action.next === 'string' ? action.next : ''
      const index = projection.commitments.findIndex(item => item.id === id)
      const item = projection.commitments[index]
      const transitions: Record<string, string[]> = {
        proposed: ['accepted', 'declined', 'expired'],
        accepted: ['fulfilled', 'missed'],
        missed: ['explained'],
      }
      if (!item || !transitions[item.status]?.includes(next)) {
        report({ kind: item ? 'mismatch' : 'missing', domain: 'commitments', commandId: command.id,
          recordId: id || undefined, version: command.resultVersion, reasonCode: 'commitment_transition_invalid' })
        continue
      }
      if (fact && (fact.factType !== 'commitment' || fact.subjectId !== id)) {
        report({ kind: 'mismatch', domain: 'commitments', commandId: command.id, factId: fact.id,
          recordId: id, version: command.resultVersion, reasonCode: 'commitment_fact_mismatch' })
      }
      projection.commitments[index] = { ...item, status: next, updatedSim: projection.simTime }
      const labels: Record<string, string> = { accepted: '已经约好', declined: '婉拒', fulfilled: '如约完成',
        missed: '未能赴约', expired: '邀请已过期', explained: '已解释失约' }
      const residentName = input.personNames?.[item.personId] ?? '对方'
      const visitorName = input.personNames?.[item.visitorId] ?? '来访者'
      const explanation = typeof action.explanation === 'string' && action.explanation
        ? `说明：${action.explanation.slice(0, 500)}` : ''
      const memoryText = `${visitorName}与${residentName}的「${item.title}」：${labels[next]}。${explanation}`
      const eventId = `commitment:${id}:${next}`
      appendEvent({ id: eventId, timelineId: input.timelineId, simTime: projection.simTime,
        title: `${item.title} · ${labels[next]}`, description: memoryText, kind: 'action',
        actorPersonId: item.visitorId, dialogueId: item.sourceDialogueId }, command.id, command.resultVersion)
      const memoryId = `${eventId}:memory`
      if (projection.memories.some(memory => memory.id === memoryId)) {
        report({ kind: 'extra', domain: 'memories', commandId: command.id, recordId: memoryId,
          version: command.resultVersion, reasonCode: 'commitment_memory_already_exists' })
      } else {
        projection.memories.push({ id: memoryId, personId: item.personId, timelineId: input.timelineId,
          type: 'relationship', content: memoryText, simTime: projection.simTime, createdAt: command.createdAt,
          importance: 8, summarized: false })
      }
      if (next === 'fulfilled' || next === 'missed') {
        const stateIndexValue = stateIndex(item.personId)
        if (stateIndexValue < 0) {
          report({ kind: 'missing', domain: 'states', commandId: command.id, recordId: item.personId,
            version: command.resultVersion, reasonCode: 'commitment_resident_state_missing' })
        } else {
          projection.states[stateIndexValue] = { ...projection.states[stateIndexValue],
            mood: next === 'fulfilled' ? '因对方守约而感到被重视' : '约定落空，有些失落',
            updatedRealAt: command.createdAt }
        }
      }
      continue
    }
    report({ kind: 'unsupported', domain: 'history', commandId: command.id,
      version: command.resultVersion, reasonCode: `reducer_not_implemented:${action.type}` })
  }

  return { ok: diagnostics.length === 0, projection: normalizeProjection(projection), diagnostics }
}
