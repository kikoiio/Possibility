// src/index.ts — Workers 入口：fetch(路由) + scheduled(cron tick)

import { Hono } from 'hono';
import { adminApi } from './api/admin';
import { publicApi } from './api/public';
import type { Env } from './env';
import { tick } from './world/engine';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'virtual-neighbor' }));
app.route('/api/admin', adminApi);
app.route('/api', publicApi);

export default {
  fetch: app.fetch,

  /** Cron 触发器：世界心跳（触发与逻辑解耦，admin/tick 是另一触发器） */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env));
  },
};
