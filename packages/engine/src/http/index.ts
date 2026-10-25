import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ControlPayload, SettingsPayload, SseEvent } from '@wispiva/contract';
import type { Runtime, RuntimeEvent } from '../runtime/index.js';

function badRequest(message: string, status = 400) {
  return { error: message, status };
}

export function createHttpApp(runtime: Runtime, options: { shutdownSignal?: AbortSignal } = {}): Hono {
  const app = new Hono();

  app.onError((error, context) => context.json({ error: error.message }, 400));
  app.use('*', async (context, next) => {
    if (options.shutdownSignal?.aborted) return context.json({ error: 'Engine is shutting down.' }, 503);
    await next();
  });

  app.get('/api/state', async (context) => context.json(await runtime.getState()));

  app.get('/api/lines/:id/log', async (context) => {
    const limitParam = Number(context.req.query('limit') ?? 50);
    const limit = Number.isInteger(limitParam) ? Math.max(1, Math.min(200, limitParam)) : 50;
    return context.json(await runtime.getLog(context.req.param('id'), context.req.query('beforeRevisionId'), limit));
  });

  app.get('/api/lines/:id/digest', async (context) => {
    const count = Number(context.req.query('limit') ?? 5);
    const limit = Number.isInteger(count) ? Math.max(1, Math.min(50, count)) : 5;
    return context.json(await runtime.getDigest(context.req.param('id'), limit));
  });

  app.get('/api/events', (context) => streamSSE(context, async (stream) => {
    let finish = () => {};
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    let snapshotReady = false;
    const pending: RuntimeEvent[] = [];
    let writes = Promise.resolve();
    const unsubscribe = runtime.subscribe((event) => {
      if (!snapshotReady) pending.push(event);
      else writes = writes.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })).catch(finish);
    });
    const abortStream = () => stream.abort();
    stream.onAbort(() => { unsubscribe(); finish(); });
    options.shutdownSignal?.addEventListener('abort', abortStream, { once: true });
    if (options.shutdownSignal?.aborted) abortStream();
    try {
      const snapshot: SseEvent = { type: 'snapshot', data: await runtime.getState() };
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
      const queued = pending.splice(0);
      writes = writes.then(async () => {
        for (const event of queued) await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }).catch(finish);
      snapshotReady = true;
      await writes;
      await stopped;
    } finally {
      unsubscribe();
      options.shutdownSignal?.removeEventListener('abort', abortStream);
      await writes;
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

  app.post('/api/chat', async (context) => {
    const body = await context.req.json<{ lineId: string; asEntity: string; otherEntity: string; text: string }>();
    if (!body?.lineId || !body.asEntity || !body.otherEntity || typeof body.text !== 'string' || !body.text.trim()) {
      return context.json(badRequest('lineId, asEntity, otherEntity, and text are required.'), 400);
    }
    return context.json(await runtime.chatTurn(body), 201);
  });

  app.post('/api/presence', async (context) => {
    const body = await context.req.json<{ lineId: string; entityId: string | null }>();
    if (!body?.lineId || (body.entityId !== null && typeof body.entityId !== 'string')) {
      return context.json(badRequest('lineId and entityId (string or null) are required.'), 400);
    }
    return context.json(await runtime.setViewpoint(body.lineId, body.entityId));
  });

  return app;
}
