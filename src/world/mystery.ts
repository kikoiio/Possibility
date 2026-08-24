// src/world/mystery.ts — 谜团引擎：日常之谜（LLM 生成）+ 季度之谜（手工大纲）
// 铁律：谜底的落点必须是人心与温暖，严禁犯罪与伤害细节（spec F6）。

import { z } from 'zod';
import { check } from '../feed/guard';
import type { EntryCandidate } from '../feed/entries';
import { complete, structured, type LlmContext } from '../llm/client';
import type { ResidentProfile } from '../persona/profile';
import {
  getMystery,
  listMysteries,
  upsertMystery,
  type Mystery,
} from '../store/db';

/** 每周清醒 tick 数（48/天 × 7 × (18h/24h)），spawn 概率分母 */
const AWAKE_TICKS_PER_WEEK = 48 * 7 * 0.75;
const SEASONAL_STAGE_INTERVAL_MS = 7 * 24 * 3600 * 1000; // 季度之谜每 7 天一阶段

// ---------------------------------------------------------------------------
// 日常之谜
// ---------------------------------------------------------------------------

const dailyMysterySchema = z.object({
  title: z.string().describe('谜团标题，8 字以内'),
  premise: z.string().describe('谜面：街上的某个反常现象，2-3 句'),
  resolution: z.string().describe('谜底：温暖人心的真相，1-2 句'),
  clues: z.array(z.string()).min(3).max(5).describe('3-5 条递进线索'),
});

export async function maybeSpawnDaily(
  ctx: LlmContext,
  rng: () => number = Math.random,
): Promise<EntryCandidate | null> {
  const db = ctx.env.DB;

  // 同时最多一个进行中的日常之谜
  const active = [
    ...(await listMysteries(db, 'spawned')),
    ...(await listMysteries(db, 'investigating')),
  ].filter((m) => m.arc === 'daily');
  if (active.length > 0) return null;

  const probability = ctx.config.mysteryDailyPerWeek / AWAKE_TICKS_PER_WEEK;
  if (rng() >= probability) return null;

  const generated = await structured(ctx, 'mystery', 'prose', dailyMysterySchema, [
    {
      role: 'system',
      content:
        '你在为临海商店街小镇设计一个"日常之谜"。铁律：谜底必须落在人心与温暖上' +
        '（误会、善意、小秘密、温情），严禁任何犯罪、伤害、血腥内容。' +
        '谜团围绕背景人物（駄菓子屋奶奶、邮局大叔、流浪猫）或街上的日常现象展开。' +
        '输出简体中文。',
    },
    { role: 'user', content: '生成一个。' },
  ]);

  // 谜面+谜底+线索全部过护栏，命中则本次放弃生成
  const fullText = [generated.title, generated.premise, generated.resolution, ...generated.clues].join('\n');
  if ((await check(db, fullText, 'entry', null)) !== 'ok') return null;

  const mystery: Mystery = {
    id: crypto.randomUUID(),
    arc: 'daily',
    title: generated.title,
    premise: generated.premise,
    state: 'spawned',
    clues: [],
    resolution: generated.resolution,
    createdTs: Date.now(),
  };
  await upsertMystery(db, mystery);

  return {
    type: 'mystery',
    residentIds: [],
    location: '街心公园',
    title: `谜：${generated.title}`,
    content: `街上有了让人在意的事——${generated.premise}`,
  };
}

/** 居民 investigate 行动指向谜团时调用：spawned → investigating */
export async function markInvestigating(db: D1Database, mysteryId: string): Promise<void> {
  const mystery = await getMystery(db, mysteryId);
  if (mystery && mystery.state === 'spawned') {
    await upsertMystery(db, { ...mystery, state: 'investigating' });
  }
}

/**
 * 推进日常之谜：释放下一条线索；线索耗尽则揭晓谜底。
 * 返回对应的信息流条目候选。
 */
export async function advanceDaily(ctx: LlmContext): Promise<EntryCandidate | null> {
  const db = ctx.env.DB;
  const active = (await listMysteries(db, 'investigating')).filter((m) => m.arc === 'daily');
  const mystery = active[0];
  if (!mystery) return null;

  // 从 structured 生成时暂存的完整线索集：clues 字段只存"已释放"的，
  // 完整线索大纲存在 premise 生成结果里——为简单起见，线索从谜面再生成一条递进线索。
  // （生成时只保留谜底，线索随调查逐步生成，保证每次递进都贴合当下调查语境。）
  const releasedCount = mystery.clues.length;
  if (releasedCount >= 5) {
    // 揭晓
    await upsertMystery(db, { ...mystery, state: 'resolved' });
    return {
      type: 'mystery',
      residentIds: [],
      location: '街心公园',
      title: `谜底：${mystery.title}`,
      content: `${mystery.title}有了答案——${mystery.resolution}`,
    };
  }

  const clue = await complete(ctx, 'mystery', 'prose', [
    {
      role: 'system',
      content:
        `你在为日常之谜「${mystery.title}」写第 ${releasedCount + 1} 条线索。` +
        `谜面：${mystery.premise}\n谜底（对居民保密）：${mystery.resolution}\n` +
        (releasedCount > 0
          ? `已释放的线索：${mystery.clues.map((c) => c.text).join('；')}\n`
          : '') +
        '要求：是居民在街上能注意到的一个小细节，比上一条更接近真相但不揭底；' +
        '一句话；温暖向；简体中文。',
    },
    { role: 'user', content: '写下一条线索。' },
  ]);

  const text = clue.trim();
  if ((await check(db, text, 'entry', null)) !== 'ok') return null;

  await upsertMystery(db, {
    ...mystery,
    clues: [...mystery.clues, { ts: Date.now(), text }],
  });

  return {
    type: 'mystery',
    residentIds: [],
    location: '街心公园',
    title: `线索：${mystery.title}`,
    content: text,
  };
}

// ---------------------------------------------------------------------------
// 季度之谜（星野旧案）：配置大纲驱动，每 7 天推进一阶段
// ---------------------------------------------------------------------------

const SEASONAL_ID = 'seasonal-old-case';

export async function maybeAdvanceSeasonal(
  ctx: LlmContext,
  profiles: ResidentProfile[],
): Promise<EntryCandidate | null> {
  const outline = ctx.config.seasonalMystery;
  if (!outline) return null;

  const db = ctx.env.DB;
  const hoshino = profiles.find((p) => p.secrets);
  if (!hoshino) return null;

  let mystery = await getMystery(db, SEASONAL_ID);
  const now = Date.now();

  if (!mystery) {
    // 首次：建立谜团并放出谜面
    mystery = {
      id: SEASONAL_ID,
      arc: 'seasonal',
      title: outline.title,
      premise: outline.premise,
      state: 'investigating',
      clues: [],
      resolution: outline.resolution,
      createdTs: now,
    };
    await upsertMystery(db, mystery);
    return {
      type: 'mystery',
      residentIds: [hoshino.id],
      location: '满月喫茶',
      title: outline.title,
      content: outline.premise,
    };
  }

  if (mystery.state === 'resolved') return null;

  const stageIndex = mystery.clues.length;
  const lastTs = mystery.clues.at(-1)?.ts ?? mystery.createdTs;
  if (now - lastTs < SEASONAL_STAGE_INTERVAL_MS) return null;

  if (stageIndex >= outline.stages.length) {
    // 终章：揭晓
    await upsertMystery(db, { ...mystery, state: 'resolved' });
    const text = await complete(ctx, 'mystery', 'prose', [
      {
        role: 'system',
        content:
          `你是${hoshino.name}，${hoshino.role}。${hoshino.speechStyle}\n` +
          `那桩让你辞职的旧案，今天终于可以放下了。` +
          `真相：${outline.resolution}\n` +
          '写一段 100-200 字的第一人称推理笔记作结：克制、温暖、不渲染伤痛。简体中文。',
      },
      { role: 'user', content: '写下这最后一页。' },
    ]);
    const content = text.trim();
    if ((await check(db, content, 'entry', null)) !== 'ok') return null;
    return {
      type: 'mystery',
      residentIds: [hoshino.id],
      location: '满月喫茶',
      title: `${outline.title}·终章`,
      content,
    };
  }

  // 推进一个阶段：大纲 → prose 写成星野的推理笔记片段
  const stage = outline.stages[stageIndex]!;
  const text = await complete(ctx, 'mystery', 'prose', [
    {
      role: 'system',
      content:
        `你是${hoshino.name}，${hoshino.role}。${hoshino.speechStyle}\n` +
        `你在推理笔记里记下了那桩旧案的新进展：${stage}\n` +
        '写成 80-150 字的第一人称笔记片段：克制、留白、不渲染伤痛。简体中文。',
    },
    { role: 'user', content: '记下这一笔。' },
  ]);
  const content = text.trim();
  if ((await check(db, content, 'entry', null)) !== 'ok') return null;

  await upsertMystery(db, {
    ...mystery,
    clues: [...mystery.clues, { ts: now, text: content }],
  });

  return {
    type: 'mystery',
    residentIds: [hoshino.id],
    location: '满月喫茶',
    title: `${outline.title}·${'一二三四五六七八九十'[stageIndex] ?? stageIndex + 1}`,
    content,
  };
}
