import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { z } from 'zod';
import { DEFAULT_CONFIG } from '../src/config';
import { complete, structured, type LlmContext } from '../src/llm/client';
import { dailyReport } from '../src/llm/usage';

function chatCompletion(content: string, tokensIn = 100, tokensOut = 50) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut, total_tokens: tokensIn + tokensOut },
  };
}

/** 每个用例设置下一条 canned 回复 */
let nextReply = '';

const stubFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('/chat/completions')) {
    return new Response(JSON.stringify(chatCompletion(nextReply)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('not found', { status: 404 });
};

const ctx: LlmContext = {
  env: { ...env, LLM_API_KEY: 'sk-test-stub' },
  config: DEFAULT_CONFIG,
  fetchImpl: stubFetch,
};

describe('llm client', () => {
  it('complete 返回文本并记录用量', async () => {
    nextReply = '今天咖啡不错。';
    const text = await complete(ctx, 'action', 'cheap', [
      { role: 'user', content: '说一句' },
    ]);
    expect(text).toBe('今天咖啡不错。');

    const row = await env.DB.prepare('SELECT * FROM usage_records ORDER BY id DESC LIMIT 1').first<{
      purpose: string; tier: string; tokens_in: number; tokens_out: number; est_cost: number;
    }>();
    expect(row!.purpose).toBe('action');
    expect(row!.tier).toBe('cheap');
    expect(row!.tokens_in).toBe(100);
    expect(row!.tokens_out).toBe(50);
    expect(row!.est_cost).toBeGreaterThan(0);
  });

  it('structured 返回 zod 校验过的对象', async () => {
    nextReply = JSON.stringify({ location: '海边堤坝', activity: '散步' });
    const schema = z.object({ location: z.string(), activity: z.string() });
    const obj = await structured(ctx, 'plan', 'cheap', schema, [
      { role: 'user', content: '出计划' },
    ]);
    expect(obj.location).toBe('海边堤坝');
  });

  it('structured 输出不合 schema 时抛错', async () => {
    nextReply = JSON.stringify({ wrong: 'shape' });
    const schema = z.object({ location: z.string(), activity: z.string() });
    await expect(
      structured(ctx, 'plan', 'cheap', schema, [{ role: 'user', content: '出计划' }]),
    ).rejects.toThrow();
  });

  it('dailyReport 聚合当日用量', async () => {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const report = await dailyReport(env.DB, today);
    expect(report.totals.calls).toBeGreaterThanOrEqual(2); // 前两个测试各一次成功调用
    expect(report.totals.tokensIn).toBeGreaterThan(0);
    expect(report.rows.some((r) => r.purpose === 'action')).toBe(true);
  });
});
