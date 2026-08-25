# CLAUDE.md

## 项目是什么

虚拟邻居（Virtual Neighbor）：一条"活着的"临海商店街。两位 AI 居民（星野、七濑）
在 Cloudflare 免费层上 24/7 自动生活——起居、相遇、闲聊、解谜、写日记——
以纯文字连载小说形式公开展示。需求与设计定稿在 `docs/spec_docs/`（spec/plan/task/checklist）。

## 技术栈与结构

TypeScript on Cloudflare Workers · Hono · Vercel AI SDK（v7，system 走 `instructions`）·
zod · D1（SQLite + FTS5，小写 fts5）· KV（运行配置，**kv CLI 必须带 --remote**）· vitest + workers 池

```
src/
  index.ts            Workers 入口：fetch(路由) + scheduled(cron tick)
  config.ts           KV 运行配置（zod，每 tick 读 = 热生效）
  store/db.ts         D1 访问层（唯一平台耦合模块）
  llm/client.ts       Vercel AI SDK 封装：档位/结构化输出/用量记录
  persona/profile.ts  人格档案解析（D1 profiles 表，新增居民零代码）
  cognition/          居民大脑：assemble(分层注入) plan decide narrate respond(二期壳)
  memory/store.ts     记忆：写入(显著度) / 三元检索(FTS5) / 阈值反思
  world/              engine(tick 主流程) events mystery(日常+季度) chapter(章节) locations types
  feed/               entries(发布管线) guard(护栏)
  api/                public(只读) admin(Bearer token)
personas/<id>/profile.md   人格档案源文件（scripts/publish-personas.ts 发布到 D1）
migrations/           D1 schema 迁移（wrangler d1 migrations apply DB --local/--remote）
web/                  信息流前端（Vite 构建纯静态页 → web/dist → assets 托管）
config/               kv.config.json（正式）/ kv.config.demo.json（演示）
scripts/              publish-personas.ts / watchtower.ts(监测) / live-llm-check.ts
```

## 核心机制（改了会影响味道的地方）

- **每个 tick 一段故事**：cognition/narrate.ts 把本 tick 的行动/对话写成 2-4 句旁白，
  前情入 prompt 防重复。不要再退回模板动态。
- **章节**：world/chapter.ts 每 chapterEveryEntries 条自动浓缩一章（前情提要，累积成概览）。
- **谜团**：日常之谜 LLM 生成（谜底生成即预定、必须温暖向）；季度之谜（星野旧案）
  由 KV seasonalMystery 大纲驱动，每 7 天一阶段。
- **记忆检索**：α·近因 + β·显著度 + γ·FTS5(tags)；中文靠 tags 空格分隔，不依赖分词。
- **护栏**：feed/guard.ts 词表覆盖条目与档案；发布前必过。

## 常用命令

```bash
pnpm dev                 # 本地开发
pnpm test                # 全部测试（miniflare 真跑 D1/KV）
pnpm run typecheck       # 根 + web 双检查
pnpm run deploy / deploy:demo
pnpm exec tsx scripts/publish-personas.ts <worker-url>
pnpm exec tsx scripts/watchtower.ts <worker-url> --expect-every-min 5 [--watch-min 2]
# 运行配置（务必 --remote！）：
pnpm exec wrangler kv key put config --binding CONFIG_KV [--env demo] --path config/<file> --remote
```

## 运维要点

- secrets：LLM_API_KEY / ADMIN_TOKEN 在 `.dev.vars`（gitignore）与 `wrangler secret put`
- 管理端点：`POST /api/admin/tick`（手动心跳）`/entries/:id/takedown`（下线）
  `/usage/daily`（用量成本）`/tick-log`（心跳日志）`/profiles/:id`（发布档案）
- demo 与 prod 有独立 D1/KV；workers.dev 子域名 3145558167
- 成本实测：每 tick ≈ ¥0.02-0.03（deepseek-chat）；demo(5min) ≈ ¥2-3/天

## 测试注意事项

- 测试用 stub fetch 拦截 LLM 调用（tests/ 各文件有模式可循）
- workers 池共享存储：测试用独立 resident id 或 beforeEach 清表隔离
- engine 测试用"智能 stub"按 prompt 任务标记分发回复形状
