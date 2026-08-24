// src/cognition/plan.ts — 每日计划层（斯坦福 planning 的日级粒度）

import { z } from 'zod';
import { recall, write } from '../memory/store';
import { structured, type LlmContext } from '../llm/client';
import type { ResidentProfile } from '../persona/profile';
import type { WorldView } from '../world/types';
import { assemble } from './assemble';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const dayPlanSchema = z.object({
  blocks: z
    .array(
      z.object({
        start: hhmm,
        end: hhmm,
        location: z.string(),
        activity: z.string().describe('这个时间块做什么，一句话'),
      }),
    )
    .min(2)
    .max(8)
    .describe('今日计划时间块，2-8 个'),
});
export type DayPlan = z.infer<typeof dayPlanSchema>;

/**
 * 为居民生成当日计划并写入 kind=plan 记忆（salience=4）。
 * 计划基于作息表 + 昨日记忆 + 世界事件，cheap 模型足够。
 */
export async function planDay(
  ctx: LlmContext,
  profile: ResidentProfile,
  world: WorldView,
): Promise<DayPlan> {
  const memories = await recall(
    ctx,
    profile.id,
    '昨天 计划 心事',
    ctx.config.memoryRecallK,
  );

  const scheduleText = profile.schedule
    .map((b) => `${b.start}-${b.end} ${b.location}（${b.activity}）`)
    .join('；');

  const messages = assemble({
    profile,
    world,
    memories,
    situation: `新的一天开始了。你的日常作息：${scheduleText}`,
    instruction:
      '为今天制定计划（2-6 个时间块）。以你的作息为骨架，' +
      '可以因天气、事件或心事灵活变化（比如绕路去某个地方、抽时间想一件事）。' +
      '地点限用世界设定中的地点。',
  });

  const plan = await structured(ctx, 'plan', 'cheap', dayPlanSchema, messages);

  const planText =
    '今日计划：' +
    plan.blocks.map((b) => `${b.start}-${b.end} 去${b.location}${b.activity}`).join('；');
  await write(ctx, {
    residentId: profile.id,
    kind: 'plan',
    content: planText,
    salience: 4,
    tags: '计划 今日',
  });

  return plan;
}
