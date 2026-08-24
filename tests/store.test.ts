import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getEntry,
  getMystery,
  insertEntry,
  insertMemory,
  insertModerationLog,
  insertUsage,
  listEntries,
  listMysteries,
  loadSnapshot,
  recentMemories,
  saveSnapshot,
  searchMemoriesFts,
  setEntryStatus,
  upsertMystery,
  usageByDay,
  type Entry,
} from '../src/store/db';

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: crypto.randomUUID(),
    ts: 1000,
    type: 'activity',
    residentIds: ['hoshino'],
    location: '满月喫茶',
    title: null,
    content: '星野在店里烘豆子。',
    status: 'published',
    ...overrides,
  };
}

describe('entries', () => {
  it('insertEntry + getEntry 往返', async () => {
    const entry = makeEntry();
    await insertEntry(env.DB, entry);
    expect(await getEntry(env.DB, entry.id)).toEqual(entry);
  });

  it('listEntries 默认排除 taken_down，keyset 分页不重叠', async () => {
    for (let i = 0; i < 5; i++) {
      await insertEntry(env.DB, makeEntry({ ts: 1000 + i, id: `e${i}` }));
    }
    await insertEntry(env.DB, makeEntry({ id: 'hidden', status: 'taken_down' }));

    const page1 = await listEntries(env.DB, { limit: 2 });
    expect(page1.map((e) => e.id)).toEqual(['e4', 'e3']);

    const page2 = await listEntries(env.DB, {
      limit: 2,
      beforeTs: page1[1]!.ts,
      beforeId: page1[1]!.id,
    });
    expect(page2.map((e) => e.id)).toEqual(['e2', 'e1']);

    const ids = new Set([...page1, ...page2].map((e) => e.id));
    expect(ids.has('hidden')).toBe(false);
  });

  it('listEntries 按居民过滤', async () => {
    await insertEntry(env.DB, makeEntry({ id: 'a', residentIds: ['hoshino'] }));
    await insertEntry(env.DB, makeEntry({ id: 'b', residentIds: ['nanase'] }));
    const list = await listEntries(env.DB, { residentId: 'nanase' });
    expect(list.map((e) => e.id)).toEqual(['b']);
  });

  it('setEntryStatus 下线后默认列表不可见，status=all 可见', async () => {
    const entry = makeEntry({ id: 'victim' });
    await insertEntry(env.DB, entry);
    expect(await setEntryStatus(env.DB, 'victim', 'taken_down')).toBe(true);

    const visible = await listEntries(env.DB, { residentId: 'hoshino' });
    expect(visible.map((e) => e.id)).not.toContain('victim');

    const all = await listEntries(env.DB, { status: 'all' });
    expect(all.map((e) => e.id)).toContain('victim');
  });
});

describe('memories', () => {
  it('insertMemory + recentMemories 按时间倒序', async () => {
    await insertMemory(env.DB, {
      residentId: 'hoshino', ts: 100, kind: 'observation',
      content: '今天七濑迟到了。', salience: 2, tags: '七濑 迟到', subject: 'nanase',
    });
    await insertMemory(env.DB, {
      residentId: 'hoshino', ts: 200, kind: 'reflection',
      content: '七濑的直觉有时比证据快。', salience: 4, tags: '七濑 直觉', subject: 'nanase',
    });
    const list = await recentMemories(env.DB, 'hoshino', 10);
    expect(list.map((m) => m.ts)).toEqual([200, 100]);
    expect(list[1]!.subject).toBe('nanase');
  });

  it('searchMemoriesFts 按 tags 关键词命中', async () => {
    await insertMemory(env.DB, {
      residentId: 'hoshino', ts: 100, kind: 'observation',
      content: '駄菓子屋奶奶每周三提前关店。', salience: 3, tags: '奶奶 关店 谜团', subject: null,
    });
    await insertMemory(env.DB, {
      residentId: 'hoshino', ts: 101, kind: 'observation',
      content: '今天换了新的咖啡豆。', salience: 2, tags: '咖啡豆', subject: null,
    });
    const hits = await searchMemoriesFts(env.DB, 'hoshino', '关店', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain('奶奶');
  });
});

describe('mysteries', () => {
  it('upsert 插入与更新状态，listMysteries 按状态过滤', async () => {
    const m = {
      id: 'm1', arc: 'daily' as const, title: '周三的谜', premise: '奶奶每周三早关店。',
      state: 'spawned' as const, clues: [], resolution: '她去做理疗。', createdTs: 1000,
    };
    await upsertMystery(env.DB, m);
    expect(await getMystery(env.DB, 'm1')).toEqual(m);

    await upsertMystery(env.DB, {
      ...m, state: 'investigating', clues: [{ ts: 1100, text: '星野注意到奶奶的包裹。' }],
    });
    const updated = await getMystery(env.DB, 'm1');
    expect(updated!.state).toBe('investigating');
    expect(updated!.clues).toHaveLength(1);

    expect(await listMysteries(env.DB, 'spawned')).toHaveLength(0);
    expect(await listMysteries(env.DB, 'investigating')).toHaveLength(1);
  });
});

describe('usage + moderation + snapshot', () => {
  it('insertUsage 后 usageByDay 聚合正确', async () => {
    await insertUsage(env.DB, {
      ts: 1000, purpose: 'action', tier: 'cheap', model: 'deepseek-chat',
      tokensIn: 100, tokensOut: 50, estCost: 0.001,
    });
    await insertUsage(env.DB, {
      ts: 2000, purpose: 'monologue', tier: 'prose', model: 'deepseek-chat',
      tokensIn: 500, tokensOut: 300, estCost: 0.005,
    });
    const rows = await usageByDay(env.DB, 0, 10000);
    expect(rows).toHaveLength(2);
    const monologue = rows.find((r) => r.purpose === 'monologue')!;
    expect(monologue.tokensOut).toBe(300);
    expect(monologue.estCost).toBeCloseTo(0.005);
  });

  it('insertModerationLog 写入记录', async () => {
    await insertModerationLog(env.DB, {
      ts: 1000, targetType: 'entry', targetId: 'e1', action: 'blocked', reason: '命中词表',
    });
    const row = await env.DB.prepare('SELECT * FROM moderation_log WHERE target_id = ?')
      .bind('e1').first();
    expect(row).not.toBeNull();
  });

  it('saveSnapshot / loadSnapshot 往返且可覆盖', async () => {
    await saveSnapshot(env.DB, 1000, { period: 'morning', residents: {} });
    const s1 = await loadSnapshot(env.DB);
    expect(s1!.ts).toBe(1000);

    await saveSnapshot(env.DB, 2000, { period: 'evening', residents: { hoshino: { location: '堤坝' } } });
    const s2 = await loadSnapshot(env.DB);
    expect(s2!.ts).toBe(2000);
    expect((s2!.state as { period: string }).period).toBe('evening');
  });
});
