// src/env.ts — Workers 环境绑定类型
export interface Env {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  LLM_API_KEY: string;
  ADMIN_TOKEN: string;
}
