// 测试环境绑定类型：增强 Cloudflare.Env（workers-types 5.x 的扩展点）
import type { readD1Migrations } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      CONFIG_KV: KVNamespace;
      TEST_MIGRATIONS: Awaited<ReturnType<typeof readD1Migrations>>;
      LLM_API_KEY: string;
      ADMIN_TOKEN: string;
    }
  }
}

export {};
