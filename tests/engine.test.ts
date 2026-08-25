import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { DEFAULT_CONFIG, type Config } from '../src/config';
import { upsertProfileRow } from '../src/persona/profile';
import { loadSnapshot } from '../src/store/db';
import { tick } from '../src/world/engine';
import type { WorldState } from '../src/world/types';

// 智能 stub：按 prompt 里的任务标记分发回复形状
const smartFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/chat/completions')) return new Response('not found', { status: 404 });

  const body = typeof init?.body === 'string' ? init.body : '';
  let content: string;
  if (body.includes('为今天制定计划')) {
    content = JSON.stringify({
      blocks: [
        { start: '06:00', end: '12:00', location: '满月喫茶', activity: '开店' },
        { start: '12:00', end: '22:00', location: '满月喫茶', activity: '营业' },
      ],
    });
  } else if (body.includes('决定你下一步的行动')) {
    content = JSON.stringify({
      action: 'stay', location: '满月喫茶', activity: '照看着店面', remark: '今天街上很安静。',
    });
  } else if (body.includes('写一段 4-8 轮的对话')) {
    content = JSON.stringify({
      lines: [
        { speaker: '星野', line: '今天真安静。' },
        { speaker: '七濑', line: '安静得能听见咖啡滴下来的声音！' },
      ],
    });
  } else if (body.includes('请写这一段')) {
    content = '午后的满月喫茶格外安静，星野擦着吧台。与此同时，七濑趴在桌边数奶泡，忽然说：「安静得能听见咖啡滴下来的声音！」';
  } else if (body.includes('浓缩成一章')) {
    content = JSON.stringify({ title: '安静的午后', content: '这一天店里格外安静，两位店主在无所事事中品出了些滋味。' });
  } else if (body.includes('内心独白')) {
    content = '安静的日子也有安静的好。';
  } else {
    content = '{}';
  }

  return new Response(
    JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

function profileMd(id: string, name: string, home: string): string {
  return `---
id: ${id}
name: ${name}
age: 30
role: 店主
home: ${home}
schedule:
  - { start: "08:00", end: "20:00", location: 满月喫茶, activity: 看店 }
---

## description
背景。

## personality
性格。

## speechStyle
说话方式。

## scenario
处境。
`;
}

/** 取当前本地 HH:MM（与 engine 同一时区算法） */
function currentHhmm(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(Date.now());
  const h = parts.find((p) => p.type === 'hour')!.value;
  const m = parts.find((p) => p.type === 'minute')!.value;
  return `${h}:${m}`;
}

/** 构造不与当前时间重叠的休眠窗口（当前时刻 ±12 小时对面） */
function oppositeSleepWindow(): { start: string; end: string } {
  const h = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(Date.now()).find((p) => p.type === 'hour')!.value;
  const opposite = (parseInt(h, 10) + 12) % 24;
  return {
    start: `${String(opposite).padStart(2, '0')}:00`,
    end: `${String((opposite + 1) % 24).padStart(2, '0')}:00`,
  };
}

async function seedProfiles() {
  await upsertProfileRow(env.DB, 'hoshino', profileMd('hoshino', '星野', '住家A'), Date.now());
  await upsertProfileRow(env.DB, 'nanase', profileMd('nanase', '七濑', '住家B'), Date.now());
}

describe('engine.tick', () => {
  it('完整一个 tick：计划/决策/相遇/独白/发布/快照', async () => {
    await seedProfiles();
    const config: Config = {
      ...DEFAULT_CONFIG,
      sleepWindow: oppositeSleepWindow(), // 保证不在休眠
      monologueTimeLocal: currentHhmm(), // 保证独白触发
    };
    await env.CONFIG_KV.put('config', JSON.stringify(config));

    const result = await tick(env, { rng: () => 0.5, fetchImpl: smartFetch });

    expect(result.slept).toBe(false);
    expect(result.actions['hoshino']?.activity).toContain('店面');
    // 1 段故事（含对话引用）+ 2 独白
    expect(result.entriesPublished).toBe(3);

    const entries = await env.DB.prepare('SELECT type, COUNT(*) AS c FROM entries GROUP BY type').all<{
      type: string; c: number;
    }>();
    const byType = Object.fromEntries(entries.results.map((r) => [r.type, r.c]));
    expect(byType['activity']).toBe(1); // 叙事段落（每个 tick 一段）
    expect(byType['monologue']).toBe(2);

    // 叙事段落是连贯故事而非模板动态
    const beat = await env.DB.prepare("SELECT content FROM entries WHERE type = 'activity'").first<{ content: string }>();
    expect(beat!.content).toContain('与此同时');

    // 快照：位置与计划标记
    const snap = await loadSnapshot(env.DB);
    const state = snap!.state as WorldState;
    expect(state.residents['hoshino']!.location).toBe('满月喫茶');
    expect(state.plannedToday['hoshino']).toBeTruthy();
    expect(state.monologuedToday['nanase']).toBeTruthy();

    // 计划与记忆入库
    const plans = await env.DB.prepare("SELECT COUNT(*) AS c FROM memories WHERE kind = 'plan'").first<{ c: number }>();
    expect(plans!.c).toBe(2);

    // 用量有记录
    const usage = await env.DB.prepare('SELECT COUNT(*) AS c FROM usage_records').first<{ c: number }>();
    expect(usage!.c).toBeGreaterThan(0);

    // 第二个 tick：每 tick 必有一段新故事（独白今日已发，对话冷却中）
    const second = await tick(env, { rng: () => 0.5, fetchImpl: smartFetch });
    expect(second.entriesPublished).toBe(1);

    await env.CONFIG_KV.delete('config');
  });

  it('条目攒够后自动生成章节（前情提要）', async () => {
    await seedProfiles();
    const config: Config = {
      ...DEFAULT_CONFIG,
      sleepWindow: oppositeSleepWindow(),
      monologueTimeLocal: currentHhmm(),
      chapterEveryEntries: 1, // 立即触发
    };
    await env.CONFIG_KV.put('config', JSON.stringify(config));

    await tick(env, { rng: () => 0.5, fetchImpl: smartFetch });

    const chapters = await env.DB.prepare('SELECT * FROM chapters').all<{ title: string; content: string }>();
    expect(chapters.results.length).toBeGreaterThanOrEqual(1);
    expect(chapters.results[0]!.title).toBe('安静的午后');
    expect(chapters.results[0]!.content).toContain('两位店主');

    await env.CONFIG_KV.delete('config');
  });

  it('休眠窗口内 no-op，仅推进 lastTickTs', async () => {
    await seedProfiles();
    // 覆盖当前时刻的休眠窗口
    const now = currentHhmm();
    const [h, m] = now.split(':').map(Number);
    const config: Config = {
      ...DEFAULT_CONFIG,
      sleepWindow: {
        start: `${String(Math.floor(h! - 1 + 24) % 24).padStart(2, '0')}:00`,
        end: `${String((h! + 1) % 24).padStart(2, '0')}:${String(m!).padStart(2, '0')}`,
      },
    };
    await env.CONFIG_KV.put('config', JSON.stringify(config));

    const before = (await env.DB.prepare('SELECT COUNT(*) AS c FROM entries').first<{ c: number }>())!.c;
    const result = await tick(env, { rng: () => 0.5, fetchImpl: smartFetch });

    expect(result.slept).toBe(true);
    expect(result.entriesPublished).toBe(0);
    const after = (await env.DB.prepare('SELECT COUNT(*) AS c FROM entries').first<{ c: number }>())!.c;
    expect(after).toBe(before);

    await env.CONFIG_KV.delete('config');
  });
});
