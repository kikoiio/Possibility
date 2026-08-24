import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_CONFIG, type Config } from '../src/config';
import type { LlmContext } from '../src/llm/client';
import type { ResidentProfile } from '../src/persona/profile';
import { getMystery, listMysteries } from '../src/store/db';
import { advanceDaily, maybeAdvanceSeasonal, maybeSpawnDaily, markInvestigating } from '../src/world/mystery';

let nextReply = '';

const stubFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/chat/completions')) {
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: nextReply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 60, total_tokens: 140 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('not found', { status: 404 });
};

function makeCtx(config: Config = DEFAULT_CONFIG): LlmContext {
  return { env: { ...env, LLM_API_KEY: 'sk-test-stub' }, config, fetchImpl: stubFetch };
}

const hoshino: ResidentProfile = {
  id: 'hoshino', name: '星野', age: 42, role: '「满月喫茶」老板',
  description: '前刑警。', personality: '温和。', speechStyle: '语速慢。',
  likes: [], dislikes: [], scenario: '', dialogueExamples: [],
  schedule: [{ start: '06:00', end: '09:00', location: '满月喫茶', activity: '烘豆' }],
  home: '住家A', haunts: [], relations: {},
  secrets: '辞职前最后一案至今未破。',
};

describe('日常之谜完整生命周期', () => {
  it('出现 → 调查 → 5 条线索 → 揭晓', async () => {
    const ctx = makeCtx();

    // 概率之外不生成
    expect(await maybeSpawnDaily(ctx, () => 0.99)).toBeNull();

    // 生成
    nextReply = JSON.stringify({
      title: '周三的谜',
      premise: '駄菓子屋奶奶每周三都提前一小时关店，没人知道为什么。',
      resolution: '她去医院做理疗，不想让大家担心。',
      clues: ['奶奶的包裹', '医院的传单', '邻居的目击'],
    });
    const spawned = await maybeSpawnDaily(ctx, () => 0.0001);
    expect(spawned).not.toBeNull();
    expect(spawned!.title).toContain('谜');
    expect(spawned!.content).toContain('駄菓子屋');

    // 同日再生成被 cap 拦截
    nextReply = '{}';
    expect(await maybeSpawnDaily(ctx, () => 0.0001)).toBeNull();

    const mystery = (await listMysteries(env.DB, 'spawned'))[0]!;
    await markInvestigating(env.DB, mystery.id);
    expect((await getMystery(env.DB, mystery.id))!.state).toBe('investigating');

    // 5 条线索逐步释放
    for (let i = 1; i <= 5; i++) {
      nextReply = `第${i}条线索：有人看到奶奶搭上了去市里的公交。`;
      const clueEntry = await advanceDaily(ctx);
      expect(clueEntry).not.toBeNull();
      expect(clueEntry!.title).toContain('线索');
    }
    expect((await getMystery(env.DB, mystery.id))!.clues).toHaveLength(5);

    // 第 6 次推进：揭晓
    const resolved = await advanceDaily(ctx);
    expect(resolved!.title).toContain('谜底');
    expect(resolved!.content).toContain('理疗');
    expect((await getMystery(env.DB, mystery.id))!.state).toBe('resolved');
  });
});

describe('季度之谜（星野旧案）', () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    seasonalMystery: {
      title: '海风旧案',
      premise: '星野的抽屉里，锁着一份三年前的旧报纸。',
      stages: ['旧同事的来信被重新翻开', '堤坝边的旧锚点有了新发现'],
      resolution: '当年的殉职是一场救人义举，星野终于能原谅自己。',
    },
  };

  it('首更放出谜面，阶段按周推进，终章揭晓', async () => {
    const ctx = makeCtx(config);

    // 首次：放出谜面
    const first = await maybeAdvanceSeasonal(ctx, [hoshino]);
    expect(first).not.toBeNull();
    expect(first!.residentIds).toEqual(['hoshino']);
    expect(first!.content).toContain('旧报纸');

    // 同一周内不推进
    expect(await maybeAdvanceSeasonal(ctx, [hoshino])).toBeNull();

    // 把 createdTs 拨回 8 天前，模拟过了一周
    await env.DB.prepare("UPDATE mysteries SET created_ts = ? WHERE id = 'seasonal-old-case'")
      .bind(Date.now() - 8 * 24 * 3600 * 1000).run();

    nextReply = '那封信的落款日期，和卷宗里的记录对不上。';
    const stage1 = await maybeAdvanceSeasonal(ctx, [hoshino]);
    expect(stage1).not.toBeNull();
    expect(stage1!.title).toContain('海风旧案');

    // 再拨一周，第二阶段
    await env.DB.prepare("UPDATE mysteries SET clues = json_replace(clues, '$[0].ts', ?) WHERE id = 'seasonal-old-case'")
      .bind(Date.now() - 8 * 24 * 3600 * 1000).run();
    nextReply = '锚点旁的礁石缝里，有当年留下的刻痕。';
    const stage2 = await maybeAdvanceSeasonal(ctx, [hoshino]);
    expect(stage2).not.toBeNull();

    // 再拨一周，终章
    await env.DB.prepare("UPDATE mysteries SET clues = json_replace(clues, '$[1].ts', ?) WHERE id = 'seasonal-old-case'")
      .bind(Date.now() - 8 * 24 * 3600 * 1000).run();
    nextReply = '原来他不是没能回来，是把回来的机会让给了别人。';
    const finale = await maybeAdvanceSeasonal(ctx, [hoshino]);
    expect(finale!.title).toContain('终章');
    expect(finale!.content).toContain('回来');

    expect((await getMystery(env.DB, 'seasonal-old-case'))!.state).toBe('resolved');
    // 已揭晓后不再推进
    expect(await maybeAdvanceSeasonal(ctx, [hoshino])).toBeNull();
  });
});
