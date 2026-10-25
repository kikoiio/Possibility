import type { Memory, Revision, WorldState } from '@wispiva/contract';
import { validateMemories, validateWorld } from '../domain/index.js';

export type GenesisMessage = { role: 'user' | 'assistant'; content: string };

export type GenesisGatewayInput = {
  conversation: GenesisMessage[];
  world: WorldState | null;
  memories: Memory[];
};

/** Each response contains the current world draft and the seeds introduced on this turn. */
export type GenesisGatewayOutput = {
  reply: string;
  world: WorldState;
  memories: Memory[];
  originText?: string;
};

export interface GenesisGateway {
  respond(input: GenesisGatewayInput): Promise<GenesisGatewayOutput>;
}

export type GenesisOrigin = {
  world: WorldState;
  memories: Memory[];
  revision: Revision;
};

export type GenesisState = {
  conversation: GenesisMessage[];
  world: WorldState | null;
  memories: Memory[];
  reply: string | null;
  originText: string | null;
};

export type GenesisOptions = { gateway: GenesisGateway };

export function createGenesisState(): GenesisState {
  return { conversation: [], world: null, memories: [], reply: null, originText: null };
}

/** Append one user turn, ask the injected model gateway, then validate the accumulated origin. */
export async function continueGenesis(
  state: GenesisState,
  userText: string,
  options: GenesisOptions,
): Promise<GenesisState> {
  const text = userText.trim();
  if (text.length === 0) throw new Error('创世输入不能为空。');

  const conversation = [...state.conversation, { role: 'user' as const, content: text }];
  const result = await options.gateway.respond({
    conversation: structuredClone(conversation),
    world: state.world === null ? null : structuredClone(state.world),
    memories: structuredClone(state.memories),
  });
  if (result.reply.trim().length === 0) throw new Error('创世 gateway 必须返回非空回复。');

  const memories = mergeMemories(state.memories, result.memories);
  const nextConversation = [...conversation, { role: 'assistant' as const, content: result.reply }];
  const world = structuredClone(result.world);
  assertValidAccumulation(world, memories);
  const next: GenesisState = {
    conversation: nextConversation,
    world,
    memories,
    reply: result.reply,
    originText: result.originText?.trim() || result.reply,
  };
  return next;
}

/** Freeze the accumulated conversation into the materials needed by an origin revision. */
export function finalizeGenesis(
  state: GenesisState,
  createId: (kind: 'revision' | 'event') => string = (kind) => `genesis_${kind}`,
): GenesisOrigin {
  if (state.world === null || state.reply === null) throw new Error('至少完成一轮创世对话后才能定稿。');
  assertValidAccumulation(state.world, state.memories);
  const eventId = createId('event');
  const revisionId = createId('revision');
  const originMemories = state.memories.map((memory) => ({ ...memory, sourceEventId: eventId }));
  return {
    world: structuredClone(state.world),
    memories: originMemories,
    revision: {
      id: revisionId,
      parentId: null,
      worldTimeMinutes: 0,
      event: {
        id: eventId,
        kind: 'origin',
        text: state.originText ?? state.reply,
        memories: structuredClone(originMemories),
        atMinutes: 0,
      },
      world: structuredClone(state.world),
    },
  };
}

function mergeMemories(existing: Memory[], incoming: Memory[]): Memory[] {
  const byId = new Map(existing.map((memory) => [memory.id, memory]));
  for (const memory of incoming) byId.set(memory.id, structuredClone(memory));
  return [...byId.values()];
}

function assertValidAccumulation(world: WorldState, memories: Memory[]): void {
  const worldIssues = validateWorld(world);
  if (worldIssues.length > 0) throw new Error(`创世 world 无效：${worldIssues.map((issue) => issue.message).join('；')}`);
  const memoryIssues = validateMemories(world, memories);
  const malformed = memories.some((memory) => !memory.id.trim() || !memory.text.trim());
  if (memoryIssues.length > 0 || malformed) {
    throw new Error(`创世前史记忆无效：${memoryIssues.map((issue) => issue.message).join('；') || 'id/text 不能为空'}`);
  }
}
