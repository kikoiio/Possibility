import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Runtime } from '../runtime/index.js';
import { createHttpApp } from './index.js';

export async function createApp(runtime: Runtime, options: {
  webDist: string;
  shutdownSignal?: AbortSignal;
}) {
  const root = resolve(options.webDist);
  const index = join(root, 'index.html');
  const built = await stat(index).then((file) => file.isFile(), () => false);
  if (!built) {
    throw new Error(`网页尚未构建，缺少 ${index}。请在仓库根目录运行 npm run wispiva，或先运行 npm run build --workspace=@wispiva/web。`);
  }

  const app = createHttpApp(runtime, options);
  // API 的未知路径也必须保留 404，不能落入 SPA。
  app.all('/api', (context) => context.notFound());
  app.all('/api/*', (context) => context.notFound());
  app.on(['GET', 'HEAD'], '*', serveStatic({ root }));
  app.on(['GET', 'HEAD'], '*', serveStatic({ path: index }));
  return app;
}
