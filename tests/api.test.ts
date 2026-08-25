import { describe, expect, it, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { upsertProfileRow } from '../src/persona/profile';
import { insertEntry } from '../src/store/db';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM entries').run();
  await env.DB.prepare('DELETE FROM moderation_log').run();
  await env.DB.prepare('DELETE FROM profiles').run();
});

const PROFILE_MD = `---
id: hoshino
name: 星野
age: 42
role: 「满月喫茶」老板
home: 住家A
schedule:
  - { start: "06:00", end: "09:00", location: 满月喫茶, activity: 烘豆 }
relations:
  nanase: 打工店员
---

## description
前刑警，辞职来到海边。

## personality
温和有礼。

## speechStyle
语速慢。

## scenario
喫茶店是他的全部。

## secrets
这是绝不能公开的内情：旧案的卷宗编号 AX-731。
`;

async function seed() {
  await upsertProfileRow(env.DB, 'hoshino', PROFILE_MD, Date.now());
  await insertEntry(env.DB, {
    id: 'entry-1', ts: 2000, type: 'activity', residentIds: ['hoshino'],
    location: '满月喫茶', title: null, content: '星野在擦杯子。', status: 'published',
  });
  await insertEntry(env.DB, {
    id: 'entry-2', ts: 1000, type: 'monologue', residentIds: ['hoshino'],
    location: '满月喫茶', title: null, content: '今晚很静。', status: 'published',
  });
}

describe('public api', () => {
  it('GET /api/timeline 倒序返回已发布条目', async () => {
    await seed();
    const res = await SELF.fetch('http://test/api/timeline');
    expect(res.status).toBe(200);
    const body = await res.json<{ entries: { id: string }[]; nextCursor: string | null }>();
    expect(body.entries.map((e) => e.id)).toEqual(['entry-1', 'entry-2']);
    expect(body.nextCursor).toBeNull();
  });

  it('GET /api/timeline?resident 过滤', async () => {
    await seed();
    const res = await SELF.fetch('http://test/api/timeline?resident=nanase');
    const body = await res.json<{ entries: unknown[] }>();
    expect(body.entries).toHaveLength(0);
  });

  it('GET /api/residents 返回公开人格且不含 secrets', async () => {
    await seed();
    const res = await SELF.fetch('http://test/api/residents');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('星野');
    expect(text).not.toContain('AX-731');
    expect(text).not.toContain('secrets');
  });

  it('GET /api/residents/:id/entries 单居民条目', async () => {
    await seed();
    const res = await SELF.fetch('http://test/api/residents/hoshino/entries');
    const body = await res.json<{ entries: { id: string }[] }>();
    expect(body.entries.length).toBe(2);
  });

  it('公开路由拒绝写方法', async () => {
    const post = await SELF.fetch('http://test/api/timeline', { method: 'POST' });
    expect([404, 405]).toContain(post.status);
    const put = await SELF.fetch('http://test/api/residents', { method: 'PUT' });
    expect([404, 405]).toContain(put.status);
  });

  it('GET / 返回前端页面（静态资源托管）', async () => {
    const res = await SELF.fetch('http://test/');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('临海商店街');
  });

  it('GET /api/now 返回居民实时状态且不含隐私字段', async () => {
    await seed();
    const { saveSnapshot } = await import('../src/store/db');
    await saveSnapshot(env.DB, Date.now(), {
      lastTickTs: Date.now(),
      weather: '阴',
      season: '夏',
      residents: {
        hoshino: { location: '海边堤坝', activity: '散步想事', since: Date.now() },
      },
      pendingEvents: [],
      monologuedToday: {},
      plannedToday: {},
      lastConverseTs: {},
      lastActivityEntryTs: {},
    });

    const res = await SELF.fetch('http://test/api/now');
    expect(res.status).toBe(200);
    const body = await res.json<{
      weather: string;
      residents: { id: string; name: string; location: string; activity: string }[];
    }>();
    expect(body.weather).toBe('阴');
    const hoshino = body.residents.find((r) => r.id === 'hoshino')!;
    expect(hoshino.name).toBe('星野');
    expect(hoshino.location).toBe('海边堤坝');

    const text = JSON.stringify(body);
    expect(text).not.toContain('AX-731');
  });
});

describe('admin api', () => {
  it('无 token / 错 token 返回 401', async () => {
    expect((await SELF.fetch('http://test/api/admin/usage/daily', { method: 'GET' })).status).toBe(401);
    expect(
      (
        await SELF.fetch('http://test/api/admin/entries/entry-1/takedown', {
          method: 'POST',
          headers: { Authorization: 'Bearer wrong-token' },
        })
      ).status,
    ).toBe(401);
  });

  it('下线后条目从公开接口消失', async () => {
    await seed();
    const res = await SELF.fetch('http://test/api/admin/entries/entry-1/takedown', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const list = await SELF.fetch('http://test/api/timeline');
    const body = await list.json<{ entries: { id: string }[] }>();
    expect(body.entries.map((e) => e.id)).toEqual(['entry-2']);

    const log = await env.DB.prepare("SELECT * FROM moderation_log WHERE action = 'taken_down'").first();
    expect(log).not.toBeNull();
  });

  it('档案发布：合法档案上传成功，非法档案 400 并指名字段', async () => {
    const ok = await SELF.fetch('http://test/api/admin/profiles/hoshino', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'content-type': 'text/plain' },
      body: PROFILE_MD,
    });
    expect(ok.status).toBe(200);

    const bad = await SELF.fetch('http://test/api/admin/profiles/hoshino', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'content-type': 'text/plain' },
      body: PROFILE_MD.replace('## scenario', '## x_scenario'),
    });
    expect(bad.status).toBe(400);
    const err = await bad.json<{ field: string }>();
    expect(err.field).toBe('scenario');
  });

  it('用量日报返回结构', async () => {
    const res = await SELF.fetch('http://test/api/admin/usage/daily', {
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ totals: { calls: number } }>();
    expect(body.totals).toBeDefined();
  });
});
