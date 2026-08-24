import { describe, expect, it } from 'vitest';
import { assemble, memoryBlock } from '../src/cognition/assemble';
import type { ResidentProfile } from '../src/persona/profile';
import type { MemoryEntry } from '../src/store/db';
import type { WorldView } from '../src/world/types';

const profile: ResidentProfile = {
  id: 'hoshino',
  name: '星野',
  age: 42,
  role: '「满月喫茶」老板',
  description: '前刑警，辞职来到海边。',
  personality: '温和有礼，观察力是职业本能。',
  speechStyle: '语速慢，句子短。口头禅：「原来如此。」',
  likes: [],
  dislikes: [],
  scenario: '喫茶店是他的全部。',
  dialogueExamples: ['「这杯偏酸，适合今天的天气。」'],
  schedule: [{ start: '06:00', end: '09:00', location: '满月喫茶', activity: '烘豆' }],
  home: '住家A',
  haunts: [],
  relations: {},
};

const world: WorldView = {
  localTime: '2026-08-24 周一 18:30',
  period: '傍晚',
  weather: '晴',
  season: '夏末',
  location: '海边堤坝',
  coPresent: ['七濑'],
  events: ['起风了'],
};

function mem(id: number, content: string): MemoryEntry {
  return { id, residentId: 'hoshino', ts: 1000 + id, kind: 'observation', content, salience: 3, tags: '', subject: null };
}

describe('assemble', () => {
  it('五层顺序与内容锚点正确', () => {
    const messages = assemble({
      profile, world,
      memories: [mem(1, '七濑昨天提到了牛奶。')],
      situation: '你刚到堤坝。',
      instruction: '决定下一步行动。',
    });

    expect(messages).toHaveLength(5);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('你是星野');
    expect(messages[0]!.content).toContain('语速慢');
    expect(messages[1]!.content).toContain('海边堤坝');
    expect(messages[1]!.content).toContain('七濑');
    expect(messages[1]!.content).toContain('起风了');
    expect(messages[2]!.content).toContain('牛奶');
    expect(messages[3]!.content).toContain('你刚到堤坝');
    expect(messages[4]!.content).toContain('决定下一步行动');
    // depth-0 风格锚
    expect(messages[4]!.content).toContain('你是星野');
    expect(messages[4]!.content).toContain('语速慢');
  });

  it('记忆超预算时从尾部丢弃', () => {
    const memories = Array.from({ length: 50 }, (_, i) => mem(i, `第${i}条比较长的记忆内容，用来消耗预算额度。`));
    const block = memoryBlock(memories, 50); // 约 75 字预算
    const included = (block.match(/-/g) ?? []).length;
    expect(included).toBeLessThan(50);
    expect(included).toBeGreaterThan(0);
    // 头部长记忆优先保留
    expect(block).toContain('第0条');
  });

  it('空记忆时给出占位块', () => {
    expect(memoryBlock([], 800)).toContain('暂无');
  });
});
