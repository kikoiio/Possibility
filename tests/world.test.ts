import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_CONFIG } from '../src/config';
import { publishAll } from '../src/feed/entries';
import { rollEvents } from '../src/world/events';
import type { LlmContext } from '../src/llm/client';

const ctx: LlmContext = {
  env: { ...env, LLM_API_KEY: 'sk-test-stub' },
  config: DEFAULT_CONFIG,
  fetchImpl: async () => new Response('{}', { status: 404 }),
};

describe('entries.publishAll', () => {
  it('activity 类按激活率丢弃，其余类型不受影响', async () => {
    const candidates = [
      { type: 'activity' as const, residentIds: ['hoshino'], location: '满月喫茶', content: '星野在擦杯子。' },
      { type: 'monologue' as const, residentIds: ['hoshino'], location: '满月喫茶', content: '今晚很静。' },
    ];
    // rng 恒 0.99 > 0.6：activity 全丢弃
    const dropped = await publishAll(env.DB, candidates, { activationRate: 0.6, rng: () => 0.99 });
    expect(dropped.skipped).toHaveLength(1);
    expect(dropped.published).toHaveLength(1);
    expect(dropped.published[0]!.type).toBe('monologue');

    // rng 恒 0.1 < 0.6：activity 也发布
    const kept = await publishAll(env.DB, candidates, { activationRate: 0.6, rng: () => 0.1 });
    expect(kept.published).toHaveLength(2);
  });

  it('违规内容进入 blocked 且不发布', async () => {
    const result = await publishAll(
      env.DB,
      [{ type: 'activity', residentIds: ['x'], location: '街心公园', content: '他发现了藏尸的地点。' }],
      { activationRate: 1, rng: () => 0 },
    );
    expect(result.published).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toContain('藏尸');
  });
});

describe('events.rollEvents', () => {
  it('天气转移产生事件', async () => {
    const result = await rollEvents(ctx, { weather: '晴', season: '夏' }, { month: 8 }, () => 0.8);
    expect(result.weather).toBe('阴');
    expect(result.events.some((e) => e.includes('转阴'))).toBe(true);
  });

  it('季节更替产生事件', async () => {
    const result = await rollEvents(ctx, { weather: '晴', season: '夏' }, { month: 9 }, () => 0.1);
    expect(result.season).toBe('秋');
    expect(result.events.some((e) => e.includes('秋'))).toBe(true);
  });

  it('背景花絮按概率出现（不走 LLM 时用模板原文）', async () => {
    // rng 序列：天气 0.1（晴保持）、花絮判定 0.1（出现）、润色判定 0.9（不润色）
    const rolls = [0.1, 0.1, 0.9, 0.0];
    let i = 0;
    const result = await rollEvents(ctx, { weather: '晴', season: '夏' }, { month: 8 }, () => rolls[i++] ?? 0.99);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events.some((e) => e.includes('駄菓子屋') || e.includes('邮局') || e.includes('流浪猫'))).toBe(true);
  });
});
