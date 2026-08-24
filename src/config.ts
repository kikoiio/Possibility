// src/config.ts — 运行配置：KV 读取 + 默认值兜底
// 每 tick 读一次 KV，改配置即时生效（AC10），无需重新部署。

import { z } from 'zod';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, '须为 HH:MM 格式');

const timeWindowSchema = z.object({
  start: hhmm.default('01:00'),
  end: hhmm.default('07:00'),
});

const modelTierSchema = z.object({
  provider: z.string().default('deepseek'),
  model: z.string().default('deepseek-chat'),
  // 估算单价（¥ / 1M tokens），DeepSeek 官方价随时可改
  priceInPer1M: z.number().nonnegative().default(2),
  priceOutPer1M: z.number().nonnegative().default(8),
});

export const configSchema = z.object({
  /** 世界时区（居民作息、休眠窗口、时间段都按它） */
  timezone: z.string().default('Asia/Shanghai'),
  /** 夜间休眠窗口（本地时间，跨零点如 23:00-07:00 也支持） */
  sleepWindow: timeWindowSchema.prefault({}),
  /** 模型档位 */
  modelTiers: z
    .object({
      cheap: modelTierSchema.prefault({}),
      prose: modelTierSchema.prefault({}),
    })
    .prefault({}),
  /** activity 类条目保留概率（0-1），防刷屏 */
  activationRate: z.number().min(0).max(1).default(0.6),
  /** recall 返回的最大记忆条数 */
  memoryRecallK: z.number().int().positive().default(8),
  /** 注入 prompt 的记忆 token 预算 */
  memoryTokenBudget: z.number().int().positive().default(800),
  /** 反思触发的显著度累计阈值 */
  reflectThreshold: z.number().positive().default(15),
  /** 独白产出时刻（本地时间 HH:MM，每日一篇/居民） */
  monologueTimeLocal: hhmm.default('19:30'),
  /** 日常之谜节奏（每周期望个数） */
  mysteryDailyPerWeek: z.number().positive().default(1.5),
  /** 季度之谜（星野旧案）：手工给定的阶段大纲，不设则不启用 */
  seasonalMystery: z
    .object({
      title: z.string(),
      premise: z.string(),
      stages: z.array(z.string()).min(1),
      resolution: z.string(),
    })
    .optional(),
});

export type Config = z.infer<typeof configSchema>;

/** 全字段默认值（所有 key 都有 default，parse({}) 必成功） */
export const DEFAULT_CONFIG: Config = configSchema.parse({});

const CONFIG_KV_KEY = 'config';

/**
 * 读取运行配置：KV 有值则合并默认值，非法则回落默认值并告警。
 * KV 中只需写要覆盖的字段（每个字段都有默认值）。
 */
export async function getConfig(env: { CONFIG_KV?: KVNamespace }): Promise<Config> {
  try {
    const raw = await env.CONFIG_KV?.get(CONFIG_KV_KEY);
    if (raw == null) return DEFAULT_CONFIG;
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn('KV config 非法，回落默认值', parsed.error.issues);
      return DEFAULT_CONFIG;
    }
    return parsed.data;
  } catch (e) {
    console.warn('读取 KV config 失败，回落默认值', e);
    return DEFAULT_CONFIG;
  }
}

/** 判断本地时刻 hh:mm 是否落在休眠窗口内（支持跨零点） */
export function inSleepWindow(config: Config, localHhmm: string): boolean {
  const { start, end } = config.sleepWindow;
  if (start === end) return false;
  if (start < end) return localHhmm >= start && localHhmm < end;
  // 跨零点：如 23:00 → 07:00
  return localHhmm >= start || localHhmm < end;
}
