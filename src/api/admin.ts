// src/api/admin.ts — 管理接口：条目下线 / 用量日报 / 手动 tick / 档案发布
// 全部需要 Bearer 管理员令牌（env.ADMIN_TOKEN）。

import { Hono } from 'hono';
import type { Env } from '../env';
import { dailyReport } from '../llm/usage';
import { parseProfile, ProfileError, upsertProfileRow } from '../persona/profile';
import { insertModerationLog, setEntryStatus } from '../store/db';
import { tick } from '../world/engine';

export const adminApi = new Hono<{ Bindings: Env }>();

// Bearer 鉴权中间件
adminApi.use('*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

adminApi.post('/entries/:id/takedown', async (c) => {
  const id = c.req.param('id');
  const changed = await setEntryStatus(c.env.DB, id, 'taken_down');
  if (!changed) return c.json({ error: 'not found' }, 404);
  await insertModerationLog(c.env.DB, {
    ts: Date.now(),
    targetType: 'entry',
    targetId: id,
    action: 'taken_down',
    reason: '管理员下线',
  });
  return c.json({ ok: true });
});

adminApi.get('/usage/daily', async (c) => {
  const day =
    c.req.query('day') ??
    new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return c.json(await dailyReport(c.env.DB, day));
});

// 手动触发一个 tick（调试/演示用；cron 只是触发器之一）
adminApi.post('/tick', async (c) => {
  const result = await tick(c.env);
  return c.json(result);
});

// 档案发布：上传 profile.md 原文 → 校验 → 写 D1（新增居民的发布通道，G4）
adminApi.post('/profiles/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.text();
  if (!raw.trim()) return c.json({ error: '空的档案内容' }, 400);

  try {
    const profile = parseProfile(raw);
    if (profile.id !== id) {
      return c.json({ error: `路径 id「${id}」与档案 id「${profile.id}」不一致` }, 400);
    }
  } catch (e) {
    if (e instanceof ProfileError) {
      return c.json({ error: e.message, field: e.field }, 400);
    }
    throw e;
  }

  await upsertProfileRow(c.env.DB, id, raw, Date.now());
  return c.json({ ok: true });
});
