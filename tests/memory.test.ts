import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_CONFIG } from '../src/config';
import type { LlmContext } from '../src/llm/client';
import { maybeReflect, recall, write } from '../src/memory/store';
import { insertMemory, unreflectedMemories } from '../src/store/db';

let nextReply = '';
let fetchCalls = 0;

const stubFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/chat/completions')) {
    fetchCalls++;
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: nextReply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('not found', { status: 404 });
};

const ctx: LlmContext = {
  env: { ...env, LLM_API_KEY: 'sk-test-stub' },
  config: DEFAULT_CONFIG,
  fetchImpl: stubFetch,
};

describe('memory.write', () => {
  it('显式给 salience/tags 时不调 LLM', async () => {
    fetchCalls = 0;
    await write(ctx, {
      residentId: 'hoshino', kind: 'plan', content: '今日计划：开店备料。',
      salience: 4, tags: '计划',
    });
    expect(fetchCalls).toBe(0);
  });

  it('缺省时由 cheap 模型评定显著度和关键词', async () => {
    nextReply = JSON.stringify({ salience: 4, tags: ['七濑', '直觉'] });
    const id = await write(ctx, {
      residentId: 'hoshino', kind: 'observation', content: '七濑凭直觉猜中了牛奶涨价。',
    });
    const row = await env.DB.prepare('SELECT * FROM memories WHERE id = ?').bind(id).first<{
      salience: number; tags: string;
    }>();
    expect(row!.salience).toBe(4);
    expect(row!.tags).toContain('七濑');
  });
});

describe('memory.recall', () => {
  it('FTS 命中的旧记忆排在无关的新记忆之前', async () => {
    const now = Date.now();
    await insertMemory(env.DB, {
      residentId: 'nanase', ts: now - 2 * 24 * 3600 * 1000, kind: 'observation',
      content: '駄菓子屋奶奶每周三提前关店，很反常。', salience: 5, tags: '奶奶 关店 反常', subject: '奶奶',
    });
    await insertMemory(env.DB, {
      residentId: 'nanase', ts: now - 3600 * 1000, kind: 'observation',
      content: '今天试吃了一款新饼干。', salience: 1, tags: '饼干 试吃', subject: null,
    });
    const results = await recall(ctx, 'nanase', '关店 奶奶', 5, now);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.content).toContain('关店');
  });

  it('无关键词命中时按近因+显著度排序', async () => {
    const now = Date.now();
    await insertMemory(env.DB, {
      residentId: 'recall-iso', ts: now - 1000, kind: 'observation',
      content: '刚烘好一锅豆子。', salience: 1, tags: '豆子', subject: null,
    });
    await insertMemory(env.DB, {
      residentId: 'recall-iso', ts: now - 2 * 24 * 3600 * 1000, kind: 'observation',
      content: '上周进的旧书到了。', salience: 1, tags: '旧书', subject: null,
    });
    const results = await recall(ctx, 'recall-iso', '毫无关联词', 5, now);
    expect(results[0]!.content).toContain('豆子');
  });
});

describe('memory.maybeReflect', () => {
  it('显著度累计未达阈值不反思', async () => {
    const did = await maybeReflect(ctx, 'fresh-resident');
    expect(did).toBe(false);
  });

  it('达阈值时生成 reflection 并标记原记忆', async () => {
    // DEFAULT_CONFIG.reflectThreshold = 15：塞入累计 16 的显著度
    for (let i = 0; i < 4; i++) {
      await insertMemory(env.DB, {
        residentId: 'reflect-iso', ts: Date.now() - i * 1000, kind: 'observation',
        content: `观察素材 ${i}：星野又在看那份旧报纸。`, salience: 4, tags: '星野 旧报纸', subject: 'hoshino',
      });
    }
    nextReply = JSON.stringify({
      reflections: [
        { content: '我觉得星野一直没放下过去那件事。', tags: ['星野', '过去'] },
      ],
    });

    const did = await maybeReflect(ctx, 'reflect-iso');
    expect(did).toBe(true);

    const reflections = await env.DB.prepare(
      "SELECT * FROM memories WHERE resident_id = 'reflect-iso' AND kind = 'reflection'",
    ).all();
    expect(reflections.results.length).toBe(1);
    expect((reflections.results[0] as { salience: number }).salience).toBe(5);

    const remaining = await unreflectedMemories(env.DB, 'reflect-iso', 50);
    // 参与反思的素材被标记；reflection 自身未参与（不递归反思）
    expect(remaining.every((m) => m.kind === 'reflection')).toBe(true);
  });
});
