import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_CONFIG } from '../src/config';
import { converse, decide, monologue } from '../src/cognition/decide';
import { planDay } from '../src/cognition/plan';
import { respond } from '../src/cognition/respond';
import type { LlmContext } from '../src/llm/client';
import type { ResidentProfile } from '../src/persona/profile';
import type { WorldView } from '../src/world/types';

let nextReply = '';
let lastRequestBody = '';

const stubFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/chat/completions')) {
    lastRequestBody = typeof init?.body === 'string' ? init.body : '';
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: nextReply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
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

const hoshino: ResidentProfile = {
  id: 'hoshino', name: '星野', age: 42, role: '「满月喫茶」老板',
  description: '前刑警，辞职来到海边。',
  personality: '温和有礼，观察力是职业本能。',
  speechStyle: '语速慢，句子短。口头禅：「原来如此。」',
  likes: [], dislikes: [],
  scenario: '喫茶店是他的全部。',
  dialogueExamples: [],
  schedule: [
    { start: '06:00', end: '09:00', location: '满月喫茶', activity: '烘豆备料' },
    { start: '18:00', end: '19:00', location: '海边堤坝', activity: '散步' },
  ],
  home: '住家A', haunts: ['满月喫茶'], relations: {},
};

const nanase: ResidentProfile = {
  ...hoshino,
  id: 'nanase', name: '七濑', age: 24, role: '喫茶店打工店员',
  personality: '直觉跳脱，结论比证据快十倍。',
  speechStyle: '语速快，感叹多，想到就说。',
  home: '住家B',
};

const world: WorldView = {
  localTime: '2026-08-24 周一 09:30',
  period: '上午',
  weather: '晴',
  season: '夏末',
  location: '满月喫茶',
  coPresent: ['七濑'],
  events: [],
};

describe('planDay', () => {
  it('生成当日计划并写入 kind=plan 记忆', async () => {
    nextReply = JSON.stringify({
      blocks: [
        { start: '06:00', end: '09:00', location: '满月喫茶', activity: '烘豆备料' },
        { start: '18:00', end: '19:00', location: '海边堤坝', activity: '散步想事' },
      ],
    });
    const plan = await planDay(ctx, hoshino, world);
    expect(plan.blocks).toHaveLength(2);

    const row = await env.DB.prepare(
      "SELECT * FROM memories WHERE resident_id = 'hoshino' AND kind = 'plan'",
    ).first<{ content: string; salience: number }>();
    expect(row!.content).toContain('今日计划');
    expect(row!.salience).toBe(4);

    // 作息表进入了 prompt
    expect(lastRequestBody).toContain('烘豆备料');
  });
});

describe('decide', () => {
  it('返回合法行动，prompt 含人格锚、今日计划、作息提示与防重复指令', async () => {
    nextReply = JSON.stringify({
      action: 'stay', location: '满月喫茶', activity: '给七濑示范手冲', remark: '她今天来得很早。',
    });
    const action = await decide(
      ctx, hoshino, world, '擦杯子',
      '按你的作息，这个时段你通常在满月喫茶（烘豆备料）。',
    );
    expect(action.action).toBe('stay');
    expect(action.location).toBe('满月喫茶');

    expect(lastRequestBody).toContain('你是星野');
    expect(lastRequestBody).toContain('语速慢');
    expect(lastRequestBody).toContain('今日计划'); // planDay 写入的 plan 被检索到
    expect(lastRequestBody).toContain('按你的作息');
    expect(lastRequestBody).toContain('不要重复');
  });

  it('模型给出非法地点时兜底留在原地', async () => {
    nextReply = JSON.stringify({
      action: 'move', location: '火星', activity: '去看看', remark: '想多了。',
    });
    const action = await decide(ctx, hoshino, world, '发呆');
    expect(action.action).toBe('stay');
    expect(action.location).toBe('满月喫茶');
  });
});

describe('converse', () => {
  it('双人人格锚注入，返回对话行', async () => {
    nextReply = JSON.stringify({
      lines: [
        { speaker: '星野', line: '今天风大，豆子烘得慢。' },
        { speaker: '七濑', line: '难怪！我就说香味比昨天淡了一点！' },
      ],
    });
    const dialogue = await converse(ctx, [hoshino, nanase], world);
    expect(dialogue.lines).toHaveLength(2);

    expect(lastRequestBody).toContain('星野');
    expect(lastRequestBody).toContain('七濑');
    expect(lastRequestBody).toContain('语速慢');
    expect(lastRequestBody).toContain('语速快');
  });
});

describe('monologue', () => {
  it('返回独白文本，depth-0 含风格锚', async () => {
    nextReply = '今晚的堤坝很安静。旧案的卷宗，我又看了一遍。';
    const text = await monologue(ctx, hoshino, world);
    expect(text).toContain('堤坝');

    expect(lastRequestBody).toContain('你是星野');
    expect(lastRequestBody).toContain('内心独白');
  });
});

describe('respond 壳', () => {
  it('本期抛 NotImplemented', async () => {
    await expect(respond(ctx, hoshino, { visitorId: 'v1', messages: [] })).rejects.toThrow(
      'NotImplemented',
    );
  });
});
