// src/memory/store.ts — 记忆：写入（显著度/关键词）、三元检索、阈值触发反思
// 检索公式（斯坦福三元组）：score = α·近因 + β·显著度 + γ·FTS 相关度

import { z } from 'zod';
import { structured, type LlmContext } from '../llm/client';
import {
  insertMemory,
  markReflected,
  recentMemories,
  searchMemoriesFts,
  unreflectedMemories,
  type InsertMemoryInput,
  type MemoryEntry,
  type MemoryKind,
} from '../store/db';

// 三元检索权重（α/β/γ，可调）
export const ALPHA_RECENCY = 1.0;
export const BETA_SALIENCE = 1.0;
export const GAMMA_RELEVANCE = 1.2;
/** 近因衰减时间常数：3 天（毫秒） */
const RECENCY_TAU_MS = 3 * 24 * 3600 * 1000;

export interface WriteMemoryInput {
  residentId: string;
  kind: MemoryKind;
  content: string;
  subject?: string | null;
  /** 已知时直接给（如 plan 固定 4）；缺省则调 cheap 模型打分 */
  salience?: number;
  tags?: string;
}

const salienceSchema = z.object({
  salience: z.number().int().min(1).max(5).describe('这段记忆的重要程度 1-5'),
  tags: z.array(z.string()).max(6).describe('关键词，用于检索，2-6 个'),
});

/** 写入记忆：缺省显著度/关键词时由 cheap 模型评定（斯坦福 importance 评分） */
export async function write(ctx: LlmContext, input: WriteMemoryInput): Promise<number> {
  let { salience, tags } = input;
  if (salience === undefined || tags === undefined) {
    const scored = await structured(ctx, 'reflection', 'cheap', salienceSchema, [
      {
        role: 'user',
        content:
          `请为以下这段（某位居民的）记忆评定重要程度（1=日常琐事，5=影响深远的事），` +
          `并抽取 2-6 个关键词：\n\n${input.content}`,
      },
    ]);
    salience = scored.salience;
    tags = scored.tags.join(' ');
  }

  const row: InsertMemoryInput = {
    residentId: input.residentId,
    ts: Date.now(),
    kind: input.kind,
    content: input.content,
    salience,
    tags,
    subject: input.subject ?? null,
  };
  return insertMemory(ctx.env.DB, row);
}

function ftsQueryFromHints(hints: string): string {
  // hints 已是空格分隔关键词；过滤 FTS 特殊字符，防语法错误
  return hints
    .replace(/["()*:^]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(' ');
}

/**
 * 三元检索：FTS 命中集 ∪ 近期集，按 α·近因 + β·显著度 + γ·相关度 排序取 top-k。
 */
export async function recall(
  ctx: LlmContext,
  residentId: string,
  hints: string,
  k: number,
  now: number = Date.now(),
): Promise<MemoryEntry[]> {
  const db = ctx.env.DB;
  const query = ftsQueryFromHints(hints);

  const ftsHits = query
    ? await searchMemoriesFts(db, residentId, query, k * 3)
    : [];
  const recent = await recentMemories(db, residentId, k * 3);

  // 合并候选集，FTS 命中给相关度分
  const candidates = new Map<number, { memory: MemoryEntry; relevance: number }>();
  const maxRank = ftsHits.length || 1;
  ftsHits.forEach((m, i) => {
    // rank 越靠前相关度越高，归一化到 (0,1]
    candidates.set(m.id, { memory: m, relevance: 1 - i / maxRank });
  });
  for (const m of recent) {
    if (!candidates.has(m.id)) candidates.set(m.id, { memory: m, relevance: 0 });
  }

  const scored = [...candidates.values()].map(({ memory, relevance }) => {
    const recency = Math.exp(-(now - memory.ts) / RECENCY_TAU_MS);
    const score =
      ALPHA_RECENCY * recency +
      BETA_SALIENCE * (memory.salience / 5) +
      GAMMA_RELEVANCE * relevance;
    return { memory, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.memory);
}

const reflectionSchema = z.object({
  reflections: z
    .array(
      z.object({
        content: z.string().describe('第一人称的抽象认识，1-2 句'),
        tags: z.array(z.string()).max(5),
      }),
    )
    .min(1)
    .max(3),
});

/**
 * 阈值触发反思（斯坦福机制）：未反思显著度累计超阈值时，
 * prose 模型把近期零散经历沉淀为 1-3 条抽象认识（kind=reflection，salience=5）。
 */
export async function maybeReflect(ctx: LlmContext, residentId: string): Promise<boolean> {
  const db = ctx.env.DB;
  const threshold = ctx.config.reflectThreshold;

  const pending = await unreflectedMemories(db, residentId, 50);
  let acc = 0;
  const involved: MemoryEntry[] = [];
  for (const m of pending) {
    acc += m.salience;
    involved.push(m);
    if (acc >= threshold) break;
  }
  if (acc < threshold) return false;

  const material = involved
    .slice()
    .reverse()
    .map((m) => `- [${m.kind}] ${m.content}`)
    .join('\n');

  const result = await structured(ctx, 'reflection', 'prose', reflectionSchema, [
    {
      role: 'user',
      content:
        `以下是「你」最近的一段经历记录。请把它们沉淀为 1-3 条更抽象的认识` +
        `（对某人的印象、某个规律、对某事的猜想），用第一人称，每条 1-2 句：\n\n${material}`,
    },
  ]);

  for (const r of result.reflections) {
    await insertMemory(db, {
      residentId,
      ts: Date.now(),
      kind: 'reflection',
      content: r.content,
      salience: 5,
      tags: r.tags.join(' '),
      subject: null,
    });
  }
  await markReflected(db, involved.map((m) => m.id));
  return true;
}
