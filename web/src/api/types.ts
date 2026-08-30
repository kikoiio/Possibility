/** 与后端对齐的数据类型 */

export type Provenance = 'known' | 'inferred'

export interface ModelItem {
  text: string
  provenance: Provenance
}

export interface PersonModel {
  identity: ModelItem[]
  behavior: ModelItem[]
  speech: ModelItem[]
  skills: ModelItem[]
  memories: ModelItem[]
  relationships: ModelItem[]
  boundaries: ModelItem[]
  unknowns: string[]
}

export interface InitialState {
  location: string
  activity: string
  mood: string
  goal: string
}

export interface DistillDraft {
  name: string
  model: PersonModel
  worldName: string
  worldDescription: string
  initialState: InitialState
}

export interface PersonState extends InitialState {
  simTime: string
}

export interface ForkScenario {
  whatIf: string
  startTime: string
  changedVariable: string
  participants: string[]
  invariants: string[]
}

export interface TimelineSummary {
  id: string
  parentTimelineId: string | null
  forkScenario: ForkScenario | null
  simNow: string
  createdAt: string
}

export interface PersonDetail {
  person: { id: string; name: string; model: PersonModel; createdAt: string }
  world: { id: string; name: string; description: string } | null
  state: (PersonState & { updatedRealAt: string }) | null
  timelines: TimelineSummary[]
}

export interface PersonListItem {
  id: string
  name: string
  createdAt: string
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'person' | 'system_note'
  content: string
  createdAt: string
}

export interface TimelineEvent {
  id: string
  timelineId: string
  simTime: string
  title: string
  description: string
}

export interface TimelineDetail {
  timeline: TimelineSummary & { worldId: string }
  world: { id: string; name: string; description: string }
  person: { id: string; name: string } | null
  events: TimelineEvent[]
  state: PersonState | null
}

export interface HomeData {
  persons: { id: string; name: string; createdAt: string; lastActivity: string }[]
  timelines: {
    id: string
    worldId: string
    worldName: string
    personId: string
    personName: string
    parentTimelineId: string | null
    simNow: string
    eventCount: number
  }[]
  worlds: {
    id: string
    name: string
    status: 'running' | 'paused' | 'capped'
    pauseReason: 'manual' | 'daily_cap' | null
    isDemo: boolean
    simNow: string | null
    personCount: number
    todayEventCount: number
  }[]
}

/** SSE 事件（后端 agent 事件 + 路由级事件） */
export type AgentStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'event'; id: string; simTime: string; title: string; description: string }
  | { type: 'state'; state: PersonState }
  | { type: 'memory'; id: string; content: string }
  | { type: 'timeline'; timelineId: string }
  | { type: 'skipped' }
  | { type: 'error'; message: string }
  | { type: 'done'; llmCalls?: number }

/* ===== 阶段二：活的世界 ===== */

export interface LocationDef {
  name: string
  description: string
}

export interface WorldSummary {
  id: string
  name: string
  description: string
  status: 'running' | 'paused' | 'capped'
  pauseReason: 'manual' | 'daily_cap' | null
  isDemo: boolean
  callsToday: number
  personCount: number
  simNow: string | null
  createdAt: string
}

export interface WorldDraft {
  name: string
  description: string
  locations: LocationDef[]
}

export interface TimelineInfo {
  id: string
  parentTimelineId: string | null
  status: 'active' | 'archived'
  simNow: string
  createdAt: string
  forkScenario: ForkScenario | null
}

export interface WorldEventItem {
  id: string
  simTime: string
  title: string
  description: string
  kind: 'action' | 'dialogue' | 'injected' | 'system'
  actorPersonId: string | null
  actorName: string | null
  dialogueId: string | null
  dialoguePreview: { personName: string; utterance: string }[] | null
}

export interface LocationBoardEntry {
  location: string
  persons: { id: string; name: string; activity: string }[]
}

export interface WorldSnapshot {
  world: {
    id: string
    name: string
    description: string
    status: WorldSummary['status']
    pauseReason: WorldSummary['pauseReason']
    isDemo: boolean
    callsToday: number
    locations: LocationDef[]
  }
  timelines: TimelineInfo[]
  currentTimelineId: string
  simNow: string
  locationBoard: LocationBoardEntry[]
  events: WorldEventItem[]
}

export interface ScheduleItem {
  start: string
  end: string
  location: string
  activity: string
  kind?: string
}

export interface PersonFocus {
  person: { id: string; name: string }
  state: {
    simTime: string
    location: string
    activity: string
    mood: string
    goal: string
    currentDialogueId: string | null
  } | null
  thoughts: { id: string; simTime: string | null; content: string; createdAt: string }[]
  schedule: ScheduleItem[] | null
  memories: { id: string; type: string; content: string; simTime: string | null; importance: number }[]
}

export interface DialogueDetail {
  dialogue: {
    id: string
    timelineId: string
    location: string
    status: 'ongoing' | 'ended'
    turnLimit: number
    simStart: string
    simEnd: string | null
    participants: { id: string; name: string }[]
  }
  turns: {
    turnIndex: number
    personId: string
    personName: string
    utterance: string
    thought: string
    simTime: string
  }[]
}

export interface DemoInfo {
  id: string
  name: string
  description: string
}

/** 世界流推送事件（SSE 按 event 名分发） */
export type WorldStreamEvent =
  | {
      type: 'event'
      id: string
      simTime: string
      title: string
      description: string
      kind: WorldEventItem['kind']
      actorPersonId: string | null
      dialogueId: string | null
    }
  | {
      type: 'dialogue_turn'
      dialogueId: string
      turnIndex: number
      personId: string
      utterance: string
      thought: string
      simTime: string
    }
  | {
      type: 'state'
      personId: string
      simTime: string
      location: string
      activity: string
      mood: string
      goal: string
      currentDialogueId: string | null
    }
  | { type: 'clock'; simNow: string; callsToday: number; worldStatus: WorldSummary['status']; pauseReason: WorldSummary['pauseReason'] }
