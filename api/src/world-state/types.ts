import type { EnvironmentCondition, EnvironmentValueKind } from './environment'

export type WorldAction =
  | { type: 'enter'; personId: string; to: string }
  | { type: 'move'; personId: string; to: string }
  | { type: 'environment'; location: string | null; condition: string; value: string }
  | { type: 'intervention'; requestId: string; text: string }
  | { type: 'inform'; recipientId: string; topic: string; content: string; sourceFactId?: string }
  | { type: 'commitment'; commitmentId: string; next: 'accepted' | 'declined' | 'fulfilled' | 'missed' | 'expired' | 'explained'; explanation?: string }
  | { type: 'commitment_proposal'; commitmentId: string; personId: string; visitorId: string; sourceDialogueId: string;
      title: string; kind: 'meeting' | 'help'; location: string; dueSim: string }
  | { type: 'conversation'; dialogueId: string; requestId: string; turns: { id: string; personId: string; utterance?: string }[];
      sceneProjection?: { location: string; participantIds: string[]; simTime: string; turnLimit: number; createdAt?: string };
      acceptedCommitments?: { id: string; personId: string; title: string; kind: 'meeting' | 'help'; location: string; dueSim: string }[];
      privateEffects?: {
        memories: { id: string; personId: string; type: 'thought' | 'relationship'; content: string; importance: number;
          simTime: string; createdAt: string; mentions?: string[]; location?: string | null; topics?: string[] }[]
        messages: { id: string; senderPersonId: string; recipientPersonId: string; content: string; location: string;
          simTime: string; createdAt: string }[]
      } }
  | { type: 'dialogue_start'; dialogueId: string; participantIds: string[]; location: string; turnLimit: number }
  | { type: 'scene_open'; dialogueId: string; visitorId: string; participantIds: string[]; location: string; turnLimit: number }
  | { type: 'dialogue_turn'; dialogueId: string; speakerId: string; turnIndex: number; utterance: string; thought: string;
      memory: { content: string; importance: number; mentions?: string[]; location?: string | null; topics?: string[] } | null; shouldEnd: boolean }
  | { type: 'clock_advance'; from: string; to: string; observedAt: string }
  | { type: 'simulation_checkpoint'; personId: string; lastBeatSimTime: string }
  | { type: 'dialogue_recovery'; personId: string; dialogueId: string }
  | { type: 'schedule_set'; personId: string; worldDate: string; generatedAt: string;
      items: { start: string; end: string; location: string; activity: string; kind?: 'sleep' }[] }
  | { type: 'memory_summary'; personId: string; sourceMemoryIds: string[]; summaryId: string; content: string; importance: number;
      simTime: string; createdAt: string;
      /** S2：目标层级（缺省 1 = L1；2 = L2 封顶）；旧命令缺省按 L1 语义回放 */
      level?: 1 | 2;
      /** S2：act 侧确定性合并的情境标注（mentions 为人物 ID），随命令负载双轨物化 */
      mentions?: string[]; location?: string | null; topics?: string[] }
  | { type: 'memory_correct'; memoryId: string; personId: string;
      before: { type: string; content: string; importance: number; simTime: string | null; createdAt: string; summarized: boolean };
      after: { content: string; importance: number } }
  | { type: 'memory_forget'; memoryId: string; personId: string;
      before: { type: string; content: string; importance: number; simTime: string | null; createdAt: string; summarized: boolean } }
  | {
      type: 'resident_state'
      personId: string
      cause: 'schedule' | 'beat' | 'injection' | 'agent_act' | 'agent_state' | 'agent_memory'
      windowStart: string
      patch: { location?: string; activity?: string; mood?: string; goal?: string; lastBeatSimTime?: string }
      advanceTo?: string
      events: { simTime: string; title: string; description: string }[]
      memories: { type: 'thought' | 'timeline' | 'relationship' | 'world'; content: string; importance: number;
        mentions?: string[]; location?: string | null; topics?: string[] }[]
      communicationChannel?: 'phone' | 'in_person' | 'unknown'
      communicationRequestId?: string
    }

/** Structured D3 environment action vocabulary (runtime validation remains in rules.ts). */
export type EnvironmentAction = {
  type: 'environment'
  location: string | null
  condition: EnvironmentCondition
  value: EnvironmentValueKind
}

/** Legacy input shape retained for command parsing before runtime validation. */
export type UnvalidatedEnvironmentAction = Extract<WorldAction, { type: 'environment' }>

export interface WorldCommandInput {
  id: string
  worldId: string
  timelineId: string
  userId: string
  actorKind?: 'owner' | 'visitor' | 'system'
  actorPersonId?: string
  engineTickLeaseToken?: string
  expectedVersion: number
  action: WorldAction
}

export class WorldStateError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409, readonly reasonCode?: string) {
    super(message)
  }
}
