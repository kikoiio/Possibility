# 虚拟邻居（Virtual Neighbor）

一条活着的临海商店街：两位 AI 居民（星野与七濑）在 Cloudflare 免费层 24/7 自动生活，
每个心跳由"叙事者"写成一段连载小说，纯文字流公开展示；章节总结持续累积成前情提要。

- 需求与设计文档：[docs/spec_docs/](docs/spec_docs/)（spec / plan / task / checklist）
- AI 协作导览：[CLAUDE.md](CLAUDE.md)

## 架构

```
Cloudflare Cron → engine.tick → cognition（计划/决策/对话/独白/反思 + 叙事者）
                       ↓
        D1（条目/记忆/谜团/章节/用量/心跳日志/快照 + FTS5）→ Hono 只读 API → 纯文字流前端
LLM：DeepSeek（cheap/prose 两档） · 配置：KV（热生效） · 人格档案：personas/*.md → D1
```

技术栈：TypeScript on Cloudflare Workers · Hono · Vercel AI SDK · zod · D1（SQLite+FTS5）· vitest

## 本地开发

```bash
pnpm install
pnpm exec wrangler login
# .dev.vars 填入 LLM_API_KEY 与 ADMIN_TOKEN（勿提交）
pnpm run db:migrate:local
pnpm dev                         # http://localhost:8787
pnpm test                        # miniflare 真跑 D1/KV
pnpm run typecheck
```

## 部署

```bash
pnpm run build:web
pnpm run deploy                  # 正式（30 分钟心跳）
pnpm run deploy:demo             # 演示（独立 D1/KV，5 分钟心跳）
pnpm exec tsx scripts/publish-personas.ts <worker-url>
```

## 运维

管理端点（均需 `Authorization: Bearer $ADMIN_TOKEN`）：

| 端点 | 用途 |
|------|------|
| `POST /api/admin/tick` | 手动触发一个心跳 |
| `POST /api/admin/entries/:id/takedown` | 下线某条条目 |
| `GET /api/admin/usage/daily?day=` | 按天 LLM 用量与估算成本 |
| `GET /api/admin/tick-log` | 心跳日志（watchtower 数据源） |
| `POST /api/admin/profiles/:id` | 发布/更新人格档案（新增居民零代码改动） |

**运行配置**（KV 键 `config`，每 tick 读取即热生效；示例见 `config/kv.config.json`）：
休眠窗口、模型档位与单价、章节触发条数、记忆召回数、反思阈值、独白时刻、
日常之谜节奏、季度之谜大纲（seasonalMystery）。

```bash
# ⚠️ wrangler v4 的 kv 命令默认写本地模拟器，必须显式 --remote！
pnpm exec wrangler kv key put config --binding CONFIG_KV --path config/kv.config.json --remote
pnpm exec wrangler kv key put config --binding CONFIG_KV --env demo --path config/kv.config.demo.json --remote
```

**监测**（判断"真停了"还是"按设计静默"）：

```bash
pnpm exec tsx scripts/watchtower.ts <worker-url> --expect-every-min 5 [--watch-min 2]
```

**暂停世界**：Cloudflare Dashboard 删除对应 worker，或
`pnpm exec wrangler delete [--env demo]`（D1/KV 数据保留，`pnpm run deploy[:demo]` 随时复活）。

## 博客嵌入

```html
<iframe src="https://virtual-neighbor.3145558167.workers.dev"
        style="width:100%;height:78vh;border:1px solid #e5e2da;border-radius:12px;background:#f6f1e8;"
        loading="lazy" title="临海商店街"></iframe>
```

## 成本参考

实测每 tick ≈ ¥0.02–0.03（deepseek-chat，含叙事段落）；
demo（5 分钟心跳）≈ ¥2–3/天，正式（30 分钟）≈ ¥0.5/天。以 `usage/daily` 端点为准。
