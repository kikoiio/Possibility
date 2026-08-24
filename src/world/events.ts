// src/world/events.ts — 世界事件生成：天气状态机 + 背景人物花絮
// 给世界"呼吸感"：天气流转、季节更替、背景人物的只言片语、流浪猫出没。

import { complete, type LlmContext } from '../llm/client';

/** 天气转移概率表：当前 → [晴, 阴, 雨] 的转移权重 */
const WEATHER_TRANSITIONS: Record<string, [string, number][]> = {
  晴: [
    ['晴', 0.7], ['阴', 0.25], ['雨', 0.05],
  ],
  阴: [
    ['晴', 0.3], ['阴', 0.5], ['雨', 0.2],
  ],
  雨: [
    ['晴', 0.2], ['阴', 0.5], ['雨', 0.3],
  ],
  雪: [
    ['阴', 0.5], ['晴', 0.3], ['雪', 0.2],
  ],
};

export function seasonOf(month: number): string {
  if (month >= 3 && month <= 5) return '春';
  if (month >= 6 && month <= 8) return '夏';
  if (month >= 9 && month <= 11) return '秋';
  return '冬';
}

function nextWeather(current: string, season: string, rng: () => number): string {
  const table = WEATHER_TRANSITIONS[current] ?? WEATHER_TRANSITIONS['晴']!;
  let r = rng();
  for (const [weather, weight] of table) {
    if (r < weight) {
      // 雪只在冬天出现
      if (weather === '雪' && season !== '冬') return '阴';
      return weather;
    }
    r -= weight;
  }
  return current;
}

/** 背景人物花絮模板池（不建模的人物，只被提及） */
const SNIPPET_POOL = [
  '駄菓子屋奶奶今天又在店门口打盹，收音机放着老歌。',
  '邮局大叔骑着自行车经过，车铃响了两声。',
  '那只流浪猫蹲在神社台阶上晒太阳。',
  '駄菓子屋进了一批新的玻璃弹珠汽水。',
  '邮局大叔说最近寄往城里的包裹变多了。',
  '流浪猫从旧书店门口溜达过去，尾巴翘得很高。',
  '駄菓子屋奶奶给路过的孩子分了糖。',
];

export interface EventsResult {
  weather: string;
  season: string;
  /** 本 tick 产生的世界事件描述 */
  events: string[];
}

/**
 * 按概率产出 0-2 个世界事件。
 * @param polish 背景花絮是否用 cheap 模型润色（默认 30% 概率）
 */
export async function rollEvents(
  ctx: LlmContext,
  current: { weather: string; season: string },
  local: { month: number },
  rng: () => number = Math.random,
): Promise<EventsResult> {
  const season = seasonOf(local.month);
  const weather = nextWeather(current.weather, season, rng);

  const events: string[] = [];

  if (weather !== current.weather) {
    events.push(`天气由${current.weather}转${weather}了`);
  }
  if (season !== current.season) {
    events.push(`季节进入了${season}季`);
  }

  // 背景人物花絮：25% 概率出现，其中 30% 用 cheap 模型润色
  if (rng() < 0.25) {
    const snippet = SNIPPET_POOL[Math.floor(rng() * SNIPPET_POOL.length)]!;
    if (rng() < 0.3) {
      try {
        const polished = await complete(ctx, 'action', 'cheap', [
          {
            role: 'user',
            content:
              `把下面这条商店街日常小花絮改写成更生动的一句话（不超过 40 字，保持原意）：\n${snippet}`,
          },
        ]);
        events.push(polished.trim());
      } catch (e) {
        console.warn('花絮润色失败，用原文', e);
        events.push(snippet);
      }
    } else {
      events.push(snippet);
    }
  }

  return { weather, season, events };
}
