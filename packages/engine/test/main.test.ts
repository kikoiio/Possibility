import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEngine } from '../src/main.js';
import { OpenAiLlmGateway } from '../src/llm/client.js';
import { openStore } from '../src/store/index.js';

const directories: string[] = [];
const engines: Awaited<ReturnType<typeof buildEngine>>[] = [];

async function fixture() {
  const base = join(process.cwd(), '.tmp');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'main-'));
  directories.push(directory);
  const webDist = join(directory, 'web/dist');
  const dataDir = join(directory, 'data');
  await mkdir(join(webDist, 'assets'), { recursive: true });
  await writeFile(join(webDist, 'index.html'), '<!doctype html><title>Wispiva test</title><div id="root"></div>');
  await writeFile(join(webDist, 'assets/app.js'), 'document.title = "Wispiva";');
  return { dataDir, webDist };
}

async function build(options: Parameters<typeof buildEngine>[0]) {
  const engine = await buildEngine(options);
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('engine assembly without listening', () => {
  it('opens SQLite, settings and the real gateway, projects worlds and persists settings', async () => {
    vi.stubEnv('GROQ_LLM_API_KEY', 'environment-test-key');
    const options = await fixture();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const engine = await build(options);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    expect(engine.gateway).toBeInstanceOf(OpenAiLlmGateway);
    expect(engine.settings.apiKey).toBe('environment-test-key');
    expect((await stat(join(options.dataDir, 'wispiva.db'))).isFile()).toBe(true);

    await engine.store.createLine({
      id: 'line_test', name: 'Test', parentLineId: null, forkRevisionId: null, forkTimeMinutes: null,
      headRevisionId: 'rev_test', worldTimeMinutes: 0, speed: 24, paused: true,
      plan: null, status: 'ready', error: null, retryAt: 0,
    });
    await engine.store.appendRevisions('line_test', [{
      id: 'rev_test', parentId: null, worldTimeMinutes: 0,
      event: { id: 'event_test', kind: 'origin', text: 'Origin', atMinutes: 0 },
      world: { lineId: 'line_test', entities: {
        place: { kind: 'place', name: 'Test place', x: 3, z: 4 },
        ada: { kind: 'character', name: 'Ada', location: 'place' },
      } },
    }]);
    const response = await engine.app.request('/api/state');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('environment-test-key');
    expect(JSON.parse(text)).toMatchObject({ views: { line_test: {
      places: [{ id: 'place', x: 3, z: 4 }], characters: [{ id: 'ada', locationId: 'place' }],
    } } });

    const update = await engine.app.request('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: ['configured-model'], apiKey: 'configured-test-key' }),
    });
    expect(update.status).toBe(200);
    expect(engine.settings.models).toEqual(['configured-model']);
    const config = join(options.dataDir, 'config.json');
    expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({ apiKey: 'configured-test-key' });
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    await engine.close();
    await engine.close();

    const restarted = await build(options);
    expect(restarted.settings.apiKey).toBe('configured-test-key');
    expect((await restarted.store.getLine('line_test'))?.worldTimeMinutes).toBe(0);
  });

  it('does not start timers when assembled and closes the store on a missing web build', async () => {
    const options = await fixture();
    vi.useFakeTimers();
    const engine = await build(options);
    expect(vi.getTimerCount()).toBe(0);
    await engine.close();
    await rm(join(options.webDist, 'index.html'));
    await expect(buildEngine(options)).rejects.toThrow(/网页尚未构建.*npm run wispiva/);
    const store = await openStore(join(options.dataDir, 'wispiva.db'));
    await store.close();
  });
});

describe('web and API routing', () => {
  it('serves assets and HEAD requests, and falls back to index.html for SPA paths', async () => {
    const engine = await build(await fixture());
    for (const path of ['/', '/worlds/alpha?tab=log', '/nested/deep/link']) {
      const response = await engine.app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('<title>Wispiva test</title>');
    }
    const asset = await engine.app.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(await asset.text()).toBe('document.title = "Wispiva";');
    const head = await engine.app.request('/worlds/alpha', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await engine.app.request('/', { method: 'POST' })).status).toBe(404);
  });

  it('keeps known and unknown API routes outside the SPA fallback', async () => {
    const { webDist, dataDir } = await fixture();
    await mkdir(join(webDist, 'api'), { recursive: true });
    await writeFile(join(webDist, 'api/unknown'), 'must not be exposed');
    const engine = await build({ webDist, dataDir });
    const state = await engine.app.request('/api/state');
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ lines: [], views: {} });
    for (const path of ['/api', '/api/unknown', '/api/lines/missing/no-such-route']) {
      const response = await engine.app.request(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Wispiva test');
    }
    expect((await engine.app.request('/api/state', { method: 'POST' })).status).toBe(404);
  });

  it('ends SSE subscriptions and rejects new requests when shutdown begins', async () => {
    const engine = await build(await fixture());
    const response = await engine.app.request('/api/events');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('snapshot');
    engine.runtime.events.emit('event', { type: 'snapshot', data: await engine.runtime.getState() });
    engine.runtime.events.emit('event', { type: 'snapshot', data: await engine.runtime.getState() });
    engine.runtime.events.emit('event', { type: 'snapshot', data: await engine.runtime.getState() });
    engine.stopRequests();
    while (!(await reader.read()).done) { /* 排空已缓冲数据，随后必须结束。 */ }
    expect(engine.runtime.events.listenerCount('event')).toBe(0);
    expect((await engine.app.request('/api/state')).status).toBe(503);
    await engine.close();
    await expect(engine.store.listLines()).rejects.toThrow();
  });
});
