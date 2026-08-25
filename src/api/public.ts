// src/api/public.ts — 公开只读接口：时间线 / 居民 / 单居民条目
// 本期无任何写接口（spec F8）；resident 响应绝不包含 secrets。

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConfig } from '../config';
import type { Env } from '../env';
import { loadAll, type ResidentProfile } from '../persona/profile';
import { listEntries, loadSnapshot, type Entry } from '../store/db';
import { localNow } from '../world/engine';
import type { WorldState } from '../world/types';

export const publicApi = new Hono<{ Bindings: Env }>();

function toPublicEntry(entry: Entry) {
  return {
    id: entry.id,
    ts: entry.ts,
    type: entry.type,
    residentIds: entry.residentIds,
    location: entry.location,
    title: entry.title,
    content: entry.content,
  };
}

function toPublicResident(profile: ResidentProfile) {
  // 明确列出公开字段：secrets / schedule 不下发
  return {
    id: profile.id,
    name: profile.name,
    age: profile.age,
    role: profile.role,
    description: profile.description,
    personality: profile.personality,
    speechStyle: profile.speechStyle,
    likes: profile.likes,
    dialogueExamples: profile.dialogueExamples,
  };
}

async function handleTimeline(c: Context<{ Bindings: Env }>, residentId?: string) {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 50);
  const cursor = c.req.query('cursor');

  let beforeTs: number | undefined;
  let beforeId: string | undefined;
  if (cursor) {
    const sep = cursor.indexOf(':');
    if (sep > 0) {
      beforeTs = Number(cursor.slice(0, sep));
      beforeId = cursor.slice(sep + 1);
    }
  }

  const rows = await listEntries(c.env.DB, {
    limit: limit + 1,
    ...(beforeTs !== undefined && beforeId !== undefined ? { beforeTs, beforeId } : {}),
    ...(residentId !== undefined ? { residentId } : {}),
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? `${last.ts}:${last.id}` : null;

  return c.json({ entries: page.map(toPublicEntry), nextCursor });
}

publicApi.get('/timeline', (c) => handleTimeline(c, c.req.query('resident')));

publicApi.get('/residents', async (c) => {
  const { profiles } = await loadAll(c.env.DB);
  return c.json({ residents: profiles.map(toPublicResident) });
});

/**
 * 「此刻」：居民实时状态（来自世界快照，零 LLM 成本）。
 * 让世界在信息流条目的间隔里也能被看见。
 */
publicApi.get('/now', async (c) => {
  const config = await getConfig(c.env);
  const local = localNow(config.timezone, Date.now());
  const snap = await loadSnapshot(c.env.DB);
  const state = snap?.state as WorldState | undefined;
  const { profiles } = await loadAll(c.env.DB);

  return c.json({
    localTime: local.localTime,
    period: local.period,
    weather: state?.weather ?? '晴',
    season: state?.season ?? '',
    residents: profiles.map((p) => {
      const presence = state?.residents[p.id];
      return {
        id: p.id,
        name: p.name,
        location: presence?.location ?? p.home,
        activity: presence?.activity ?? '在家',
        since: presence?.since ?? null,
      };
    }),
  });
});

publicApi.get('/residents/:id/entries', (c) => handleTimeline(c, c.req.param('id')));
