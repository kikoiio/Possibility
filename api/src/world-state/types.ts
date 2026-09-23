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
      sceneProjection?: { location: string; participantIds: string[]; simTime: string; turnLimit: number };
      acceptedCommitments?: { id: string; personId: string; title: string; kind: 'meeting' | 'help'; location: string; dueSim: string }[];
      privateEffects?: {
        memories: { id: string; personId: string; type: 'thought' | 'relationship'; content: string; importance: number;
          simTime: string; createdAt: string }[]
        messages: { id: string; senderPersonId: string; recipientPersonId: string; content: string; location: string;
          simTime: string; createdAt: string }[]
      } }
  | { type: 'dialogue_start'; dialogueId: string; participantIds: string[]; location: string; turnLimit: number }
  | { type: 'scene_open'; dialogueId: string; visitorId: string; participantIds: string[]; location: string; turnLimit: number }
  | { type: 'dialogue_turn'; dialogueId: string; speakerId: string; turnIndex: number; utterance: string; thought: string;
      memory: { content: string; importance: number } | null; shouldEnd: boolean }
  | { type: 'clock_advance'; from: string; to: string; observedAt: string }
  | { type: 'simulation_checkpoint'; personId: string; lastBeatSimTime: string }
  | { type: 'dialogue_recovery'; personId: string; dialogueId: string }
  | { type: 'schedule_set'; personId: string; worldDate: string; generatedAt: string;
      items: { start: string; end: string; location: string; activity: string; kind?: 'sleep' }[] }
  | { type: 'memory_summary'; personId: string; sourceMemoryIds: string[]; summaryId: string; content: string; importance: number;
      simTime: string; createdAt: string }
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
      memories: { type: 'thought' | 'timeline' | 'relationship' | 'world'; content: string; importance: number }[]
    }

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
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message)
  }
}
