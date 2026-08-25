// src/cognition/narrate.ts — 叙事者：把每个 tick 发生的事写成一段连贯故事
// 每个 tick 必发一段（读者的"5 分钟一更"）；前情入 prompt 防重复。

import { complete, type LlmContext } from '../llm/client';
import type { Dialogue } from './decide';
import type { LocalNow } from '../world/engine';

export interface BeatInput {
  local: LocalNow;
  weather: string;
  events: string[];
  /** 本 tick 各居民的行动（含内心 remark，叙事者可化用但不得直译心理） */
  actors: { name: string; location: string; activity: string; remark: string }[];
  dialogue?: Dialogue | undefined;
  /** 上一段故事正文（防重复的锚） */
  prevBeat?: string | undefined;
}

/**
 * 生成本 tick 的故事段落（2-4 句旁白）。
 * 双线并行用"与此同时"衔接；对话可引用一两句精彩的。
 */
export async function narrateBeat(ctx: LlmContext, input: BeatInput): Promise<string> {
  const actorLines = input.actors
    .map((a) => `${a.name}在${a.location}：${a.activity}`)
    .join('\n');
  const dialogueLines = input.dialogue
    ? `\n两人的对话：\n${input.dialogue.lines.map((l) => `${l.speaker}：${l.line}`).join('\n')}`
    : '';

  return complete(ctx, 'narrate', 'prose', [
    {
      role: 'system',
      content:
        '你是临海商店街的叙事者，用清淡温暖的旁白写一部正在连载的生活小说。' +
        '规则：只写发生的事，不解释设定；两位居民在不同地点时用「与此同时」等衔接；' +
        '对话只引用最精彩的一两句；绝不重复上一段已写过的情节——若行动相似，' +
        '就换一个角度（细节、光线、声音、心情）或一句带过。简体中文。',
    },
    {
      role: 'user',
      content:
        `时间：${input.local.localTime}（${input.local.period}），天气：${input.weather}。\n` +
        (input.events.length > 0 ? `街上的动静：${input.events.join('；')}\n` : '') +
        (input.prevBeat ? `上一段故事：${input.prevBeat}\n\n` : '') +
        `这一刻：\n${actorLines}${dialogueLines}\n\n` +
        '请写这一段（2-4 句）。',
    },
  ]);
}
