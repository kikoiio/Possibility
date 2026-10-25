import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ControlPayload, SettingsPayload, SseEvent } from '@wispiva/contract';
import type { Runtime } from '../runtime/index.js';

function badRequest(message: string, status = 400) {
  return { error: message, status };
}

export function createHttpApp(runtime: Runtime): Hono {
  const app = new Hono();

  app.onError((error, context) => context.json({ error: error.message }, 400));

  app.get('/api/state', async (context) => context.json(await runtime.getState()));

  app.get('/api/lines/:id/log', async (context) => {
    const limitParam = Number(context.req.query('limit') ?? 50);
    const limit = Number.isInteger(limitParam) ? Math.max(1, Math.min(200, limitParam)) : 50;
    return context.json(await runtime.getLog(context.req.param('id'), context.req.query('beforeRevisionId'), limit));
  });

  app.get('/api/events', (context) => streamSSE(context, async (stream) => {
    let snapshotReady = false;
    const pending: SseEvent[] = [];
    let writes = Promise.resolve();
    const unsubscribe = runtime.subscribe((event) => {
      if (!snapshotReady) pending.push(event);
      else writes = writes.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
    });
    try {
      const snapshot: SseEvent = { type: 'snapshot', data: await runtime.getState() };
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
      const queued = pending.splice(0);
      writes = writes.then(async () => {
        for (const event of queued) await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      snapshotReady = true;
      await writes;
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    } finally {
      unsubscribe();
    }
  }));

  app.post('/api/settings', async (context) => {
    const body = await context.req.json<SettingsPayload>();
    if (!body || !Array.isArray(body.models)) return context.json(badRequest('models must be an array.'), 400);
    await runtime.updateSettings(body);
    return context.json({ ok: true });
  });

  app.post('/api/draft', async (context) => {
    const body = await context.req.json<{ lineId?: string }>();
    return context.json(await runtime.createDraft(body.lineId), 201);
  });

  app.post('/api/edit', async (context) => {
    const body = await context.req.json<{ draftId: string; prompt: string }>();
    if (!body.draftId || !body.prompt) return context.json(badRequest('draftId and prompt are required.'), 400);
    return context.json(await runtime.editDraft(body.draftId, body.prompt));
  });

  app.post('/api/confirm', async (context) => {
    const body = await context.req.json<{ draftId: string; proposalId: string; ifText: string; name?: string }>();
    if (!body.draftId || !body.proposalId || !body.ifText) return context.json(badRequest('draftId, proposalId, and ifText are required.'), 400);
    return context.json(await runtime.confirm(body), 201);
  });

  app.post('/api/control', async (context) => {
    const body = await context.req.json<ControlPayload>();
    if (!body.lineId) return context.json(badRequest('lineId is required.'), 400);
    return context.json(await runtime.control(body));
  });

  return app;
}
