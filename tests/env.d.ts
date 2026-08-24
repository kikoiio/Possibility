// 测试环境绑定类型补充（合并到 cloudflare:test 的 env 类型）
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    CONFIG_KV: KVNamespace;
    TEST_MIGRATIONS: unknown;
  }
}
