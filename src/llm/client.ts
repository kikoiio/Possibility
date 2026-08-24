// src/llm/client.ts — Vercel AI SDK 封装：档位路由 + 结构化输出 + 用量记录

import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, Output, type ModelMessage } from 'ai';
import type { ZodType } from 'zod';
import type { Config } from '../config';
import { insertUsage, type UsagePurpose } from '../store/db';

export interface LlmContext {
  env: {
    DB: D1Database;
    LLM_API_KEY: string;
  };
  config: Config;
  /** 测试注入用：自定义 fetch（生产不传，用全局 fetch） */
  fetchImpl?: typeof fetch;
}

export type Tier = 'cheap' | 'prose';

function resolveModel(tier: Tier, ctx: LlmContext) {
  const t = ctx.config.modelTiers[tier];
  if (t.provider !== 'deepseek') {
    // 本期仅接入 DeepSeek；新 provider 在此分支扩展
    throw new Error(`未接入的 provider: ${t.provider}（本期仅支持 deepseek）`);
  }
  const provider = createDeepSeek({
    apiKey: ctx.env.LLM_API_KEY,
    ...(ctx.fetchImpl ? { fetch: ctx.fetchImpl } : {}),
  });
  return { model: provider(t.model), tierInfo: t };
}

async function recordUsage(
  ctx: LlmContext,
  purpose: UsagePurpose,
  tier: Tier,
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
): Promise<void> {
  const t = ctx.config.modelTiers[tier];
  const tokensIn = usage?.inputTokens ?? 0;
  const tokensOut = usage?.outputTokens ?? 0;
  const estCost = (tokensIn / 1e6) * t.priceInPer1M + (tokensOut / 1e6) * t.priceOutPer1M;
  await insertUsage(ctx.env.DB, {
    ts: Date.now(),
    purpose,
    tier,
    model: t.model,
    tokensIn,
    tokensOut,
    estCost,
  });
}

/** AI SDK v7：system 消息须从 messages 拆出，走 instructions 选项 */
function extractInstructions(messages: ModelMessage[]): {
  instructions: string | undefined;
  rest: ModelMessage[];
} {
  const systemTexts: string[] = [];
  const rest: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemTexts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    } else {
      rest.push(m);
    }
  }
  return { instructions: systemTexts.length > 0 ? systemTexts.join('\n\n') : undefined, rest };
}

/** 文本生成。每次调用自动记录用量。 */
export async function complete(
  ctx: LlmContext,
  purpose: UsagePurpose,
  tier: Tier,
  messages: ModelMessage[],
): Promise<string> {
  const { model } = resolveModel(tier, ctx);
  const { instructions, rest } = extractInstructions(messages);
  const result = await generateText({
    model,
    ...(instructions !== undefined ? { instructions } : {}),
    messages: rest,
  });
  await recordUsage(ctx, purpose, tier, result.usage);
  return result.text;
}

/**
 * 结构化生成（zod 校验）。
 * 模型输出不合规时抛错，由调用方决定是否重试。
 */
export async function structured<T>(
  ctx: LlmContext,
  purpose: UsagePurpose,
  tier: Tier,
  schema: ZodType<T>,
  messages: ModelMessage[],
): Promise<T> {
  const { model } = resolveModel(tier, ctx);
  const { instructions, rest } = extractInstructions(messages);
  const result = await generateText({
    model,
    ...(instructions !== undefined ? { instructions } : {}),
    messages: rest,
    output: Output.object({ schema }),
  });
  await recordUsage(ctx, purpose, tier, result.usage);
  return result.output;
}
