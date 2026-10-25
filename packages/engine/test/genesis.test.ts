import { describe, expect, it } from 'vitest';
import type { Memory, WorldState } from '@wispiva/contract';
import { continueGenesis, createGenesisState, finalizeGenesis, type GenesisGateway } from '../src/genesis/index.js';
import { validateMemories, validateWorld } from '../src/domain/index.js';

const world: WorldState = {
  entities: {
    阿苇: { kind: 'character', name: '阿苇' },
    老舟: { kind: 'character', name: '老舟' },
    书院: { kind: 'place', name: '临水书院' },
  },
  premise: { village: '芦汀', secret: '书院曾经失火' },
};

const memory = (id: string, owner: string, text: string, valence: number): Memory => ({
  id, owner, text, valence, intensity: 0.7, importance: 7, about: ['书院'],
});

describe('conversational genesis', () => {
  it('accumulates two turns into a valid origin world and owner-colored memory seeds', async () => {
    const gateway: GenesisGateway = {
      async respond({ conversation, memories }) {
        const firstTurn = conversation.length === 1;
        expect(memories).toHaveLength(firstTurn ? 0 : 1);
        return {
          reply: firstTurn ? '书院的火灾一直被隐瞒。' : '阿苇当年目睹了火灾。',
          world,
          memories: firstTurn
            ? [memory('mem_wei_fire', '阿苇', '我记得那场火，仍心有余悸。', -0.8)]
            : [memory('mem_zhou_secret', '老舟', '我一直担心旧事被揭开。', -0.4)],
          originText: '芦汀与旧书院火灾的前史。',
        };
      },
    };
    const opts = { gateway };
    const first = await continueGenesis(createGenesisState(), '设定一座临水书院，它曾经失火。', opts);
    const second = await continueGenesis(first, '阿苇记得火灾，老舟想掩盖真相。', opts);
    const origin = finalizeGenesis(second, (kind) => `${kind}_origin`);

    expect(second.conversation).toHaveLength(4);
    expect(validateWorld(origin.world)).toEqual([]);
    expect(validateMemories(origin.world, origin.memories)).toEqual([]);
    expect(origin.memories.map(({ owner, valence }) => [owner, valence])).toEqual([['阿苇', -0.8], ['老舟', -0.4]]);
    expect(origin.revision.parentId).toBeNull();
    expect(origin.revision.event.kind).toBe('origin');
    expect(origin.revision.event.memories).toEqual(origin.memories);
    expect(origin.memories.every((row) => row.sourceEventId === 'event_origin')).toBe(true);
  });

  it('rejects an invalid appraisal or world from the gateway', async () => {
    const gateway: GenesisGateway = { async respond() { return {
      reply: '回复', world, memories: [memory('bad', '陌生人', '无效归属', 1.8)],
    }; } };
    await expect(continueGenesis(createGenesisState(), '开始', { gateway })).rejects.toThrow('前史记忆无效');
  });
});
