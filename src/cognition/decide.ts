// src/cognition/decide.ts — 居民的决策、对话与独白

import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { complete, structured, type LlmContext } from '../llm/client';
import { recall } from '../memory/store';
import type { ResidentProfile } from '../persona/profile';
import { recentMemories, type MemoryEntry } from '../store/db';
import { isLocation } from '../world/locations';
import type { WorldView } from '../world/types';
import { assemble } from './assemble';

// ---------------------------------------------------------------------------
// decide：下一步行动（cheap 模型，结构化输出）
// ---------------------------------------------------------------------------

export const actionSchema = z.object({
  action: z
    .enum(['stay', 'move', 'speak', 'investigate'])
    .describe('stay 留在原地 / move 去别的地点 / speak 想和在场的人说话 / investigate 调查在意的事'),
  location: z.string().describe('目标地点（stay 时填当前地点）'),
  activity: z.string().describe('接下来在做的事，一句话'),
  remark: z.string().describe('此刻心里在想什么或注意到的细节，一句话'),
});
export type Action = z.infer<typeof actionSchema>;

/**
 * 决定居民下一步行动。
 * 记忆检索：当日 plan 优先 + 三元召回（地点/在场者/事件为线索）。
 * scheduleHint：作息表当前时段（engine 计算），给行动一个"此时该在哪"的锚。
 */
export async function decide(
  ctx: LlmContext,
  profile: ResidentProfile,
  world: WorldView,
  currentActivity: string,
  scheduleHint?: string,
): Promise<Action> {
  const db = ctx.env.DB;

  // 当日 plan 优先进入上下文（斯坦福：行动遵循计划）
  const recent = await recentMemories(db, profile.id, 20);
  const todayPlan = recent.find((m) => m.kind === 'plan');

  const hints = [world.location, ...world.coPresent, ...world.events].join(' ');
  const recalled = await recall(ctx, profile.id, hints, ctx.config.memoryRecallK);

  const memories: MemoryEntry[] = [
    ...(todayPlan ? [todayPlan] : []),
    ...recalled.filter((m) => m.id !== todayPlan?.id),
  ];

  const messages = assemble({
    profile,
    world,
    memories,
    situation:
      `你正在${world.location}${currentActivity ? `，${currentActivity}` : ''}。` +
      (scheduleHint ? `\n${scheduleHint}` : ''),
    instruction:
      '决定你下一步的行动。规则：' +
      '一、若有今日计划或作息安排，遵循之，除非眼前有更值得在意的事；' +
      '二、不要重复你刚刚做过的事（见记忆块顶部）——每个时刻都找一件具体而不同的' +
      '小事做，要有具体的对象、动作和缘由，拒绝「看店」「发呆」式的状态描述；' +
      '三、如果想和在场的人说话，选 speak；如果有让你起疑或在意的，选 investigate。' +
      '地点限用世界设定中的地点。',
  });

  const action = await structured(ctx, 'action', 'cheap', actionSchema, messages);

  // 裁决兜底：模型给出非法地点时强制留在原地（规则裁决在 engine，这里先防一手）
  if (!isLocation(action.location)) {
    return { ...action, action: 'stay', location: world.location };
  }
  return action;
}

// ---------------------------------------------------------------------------
// converse：同地居民的短对话（prose 模型）
// ---------------------------------------------------------------------------

export const dialogueSchema = z.object({
  lines: z
    .array(z.object({ speaker: z.string(), line: z.string() }))
    .min(2)
    .max(10),
});
export type Dialogue = z.infer<typeof dialogueSchema>;

/**
 * 生成两位居民的偶遇对话。双人的人格锚都注入 system，
 * 模型以"编剧"身份写对话，输出各自行走的台词。
 */
export async function converse(
  ctx: LlmContext,
  profiles: [ResidentProfile, ResidentProfile],
  world: WorldView,
): Promise<Dialogue> {
  const [a, b] = profiles;

  const personaBlock = (p: ResidentProfile) =>
    `【${p.name}】${p.age}岁，${p.role}。性格：${p.personality}。说话方式：${p.speechStyle}`;

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        `你在为临海商店街小镇的两位居民写一段偶遇时的短对话。\n\n` +
        `${personaBlock(a)}\n${personaBlock(b)}\n\n` +
        `要求：台词严格符合各自的说话方式（读者不看名字也能分辨谁在说话）；` +
        `对话要接得住对方的话，像真实街坊；` +
        `可以聊天气、街上的人和事、彼此的心事，但别解释设定；` +
        `speaker 只能填「${a.name}」或「${b.name}」。输出为简体中文。`,
    },
    {
      role: 'user',
      content:
        `时间：${world.localTime}（${world.period}），${world.season}，天气：${world.weather}。\n` +
        `地点：${world.location}。\n` +
        (world.events.length ? `发生的事：${world.events.join('；')}。\n` : '') +
        `${a.name}和${b.name}在这里碰面了。写一段 4-8 轮的对话。`,
    },
  ];

  return structured(ctx, 'dialogue', 'prose', dialogueSchema, messages);
}

// ---------------------------------------------------------------------------
// monologue：内心独白（prose 模型，每日定时）
// ---------------------------------------------------------------------------

/**
 * 生成居民的第一人称内心独白（信息流条目素材）。
 * depth-0 风格锚由 assemble 保证；独白形式由人格驱动
 * （星野的推理笔记、七濑的跳跃随想，都出自各自 speechStyle）。
 */
export async function monologue(
  ctx: LlmContext,
  profile: ResidentProfile,
  world: WorldView,
): Promise<string> {
  const memories = await recall(
    ctx,
    profile.id,
    '今天 心事 最近',
    ctx.config.memoryRecallK,
  );

  const messages = assemble({
    profile,
    world,
    memories,
    situation: '一天的喧嚣过去，你有了片刻独处的时间。',
    instruction:
      '写一段 150-300 字的第一人称内心独白：可以回顾今天、咀嚼一件在意的事、' +
      '或想想明天的打算。形式贴合你的性格（日记、笔记、随手想皆可），' +
      '不要喊口号，不要总结陈词。',
  });

  return complete(ctx, 'monologue', 'prose', messages);
}
