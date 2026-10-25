import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';
import { OpenAiLlmGateway } from './llm/client.js';
import { openSettingsStore } from './llm/settings.js';
import { projectWorld } from './projection/index.js';
import { Runtime } from './runtime/index.js';
import { openStore } from './store/index.js';

export { createApp } from './http/app.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
type EngineOptions = { dataDir?: string; webDist?: string };

// 只组装，不监听、不启动时钟，方便测试与嵌入。
export async function buildEngine(options: EngineOptions = {}) {
  const dataDir = resolve(options.dataDir ?? join(repositoryRoot, '.data/wispiva'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const store = await openStore(join(dataDir, 'wispiva.db'));
  try {
    const { settings, writeSettings } = await openSettingsStore({ path: join(dataDir, 'config.json') });
    const gateway = new OpenAiLlmGateway(settings, store);
    const runtime = new Runtime({ store, gateway, settings, writeSettings, projectWorld });
    const shutdown = new AbortController();
    const app = await createApp(runtime, {
      webDist: options.webDist ?? join(repositoryRoot, 'packages/web/dist'),
      shutdownSignal: shutdown.signal,
    });
    let closing: Promise<void> | undefined;
    const stopRequests = () => shutdown.abort();
    const close = () => closing ??= (async () => {
      stopRequests();
      try {
        await runtime.close();
      } finally {
        await store.close();
      }
    })();
    return { app, runtime, store, gateway, settings, stopRequests, close };
  } catch (error) {
    await store.close();
    throw error;
  }
}

function reportError(error: unknown) {
  process.stderr.write(`Wispiva: ${error instanceof Error ? error.message : String(error)}\n`);
}

export async function startEngine(options: EngineOptions & { port?: number } = {}) {
  let signalReceived = false;
  let closeRunning: (() => Promise<void>) | undefined;
  const onSignal = () => {
    signalReceived = true;
    if (closeRunning) void closeRunning().catch((error: unknown) => {
      reportError(error);
      process.exitCode = 1;
    });
  };
  const removeSignals = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const engine = await buildEngine(options);
    let server: ReturnType<typeof serve>;
    try {
      server = serve({ fetch: engine.app.fetch, hostname: '127.0.0.1', port: options.port ?? 8787 });
      await once(server, 'listening');
    } catch (error) {
      await engine.close();
      throw error;
    }

    let ticking: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      if (!ticking) {
        ticking = engine.runtime.tick().catch(reportError).finally(() => { ticking = undefined; });
      }
    };
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      clearInterval(timer);
      engine.stopRequests();
      try {
        // SSE 先结束；排空 HTTP 和当前 tick 后再关闭 runtime/SQLite。
        await Promise.all([
          new Promise<void>((resolveClose, reject) => {
            server.close((error) => error ? reject(error) : resolveClose());
          }),
          ticking,
        ]);
      } finally {
        try { await engine.close(); } finally { removeSignals(); }
      }
    })();
    closeRunning = close;
    if (signalReceived) await close();
    else {
      tick();
      timer = setInterval(tick, 1000);
    }
    return { ...engine, server, close };
  } catch (error) {
    removeSignals();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startEngine({ ...(process.env.WISPIVA_DATA_DIR ? { dataDir: process.env.WISPIVA_DATA_DIR } : {}) })
    .then((engine) => { if (engine.server.listening) process.stdout.write('http://127.0.0.1:8787\n'); })
    .catch((error: unknown) => {
      reportError(error);
      process.exitCode = 1;
    });
}
