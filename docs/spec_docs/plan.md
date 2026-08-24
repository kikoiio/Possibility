# 虚拟邻居（Virtual Neighbor）Plan

> 依据已批准的 [spec.md](spec.md)（F1–F11 / N1–N8 / AC1–AC12）设计。
> 技术栈：TypeScript on Cloudflare Workers；存储 D1（SQLite + FTS5）+ KV；
> 前端 Vite 静态单页。¥0 永久免费层运行，模块边界保留迁回 VPS 的能力。

## 架构概览

无常驻进程、无自有服务器，全部运行在 Cloudflare 免费层：

1. **世界模拟器（Workers Cron Trigger）**
   Cloudflare 每 30 分钟触发一次 `tick()`（cron 只是触发器之一，
   管理端点也可手动触发）。每个 tick：加载世界状态 → 推进时钟
   （休眠时段直接 no-op）→ 注入世界事件 → 每位居民
   「感知 → 决策 → 行动」→ 同地相遇则对话 → 条目候选 → 护栏 →
   入 D1 → 保存状态快照。每日计划、独白、反思（阈值触发）、
   谜团推进按各自机制运行。
   免费层约束实测：wall-clock 15 分钟（一个 tick 仅 10-60s）、
   子请求 50 次（一个 tick 约 10-15 次 LLM 调用）、CPU 10ms
   （我们几乎纯等 LLM 网络 IO）。

2. **只读 API 服务（Hono on Workers）**
   公开只读接口：时间线、居民列表、单居民条目；
   管理接口（条目下线、用量日报、手动 tick）走管理员令牌；
   保留 WebSocket 能力（二/三期）。

3. **信息流前端（TS + Vite 静态单页）**
   轮询 API（30s）；零交互输入口；部署到 Pages 或直接放博客仓库，
   iframe 嵌入。

4. **存储（D1 + KV）**
   D1（SQLite 兼容，支持 FTS5，免费 5GB）：信息流条目、居民记忆、
   谜团、LLM 用量、护栏记录、世界状态快照——每 tick 落库天然
   实现中断续跑（N4）。KV：运行配置（每 tick 读取 = 热生效）。

5. **人格档案目录**
   personas/<居民id>/profile.md 为源文件；发布脚本写入 D1 profiles 表，
   运行时从 D1 读取。新增居民 = 加文件 + 运行发布命令，零代码改动。

**认知模块是多驱动器复用的核心**：cron tick（本期）、访客会话
（二期 Worker 路由）、语音管线（三期 WebSocket + LiveKit/CF Calls）
只是三种驱动器，都调用同一个 cognition 模块。大脑不长在 tick 循环里。

## 核心数据结构

### ResidentProfile（人格档案 → 内存对象）
来源：personas/<id>/profile.md（YAML frontmatter + markdown 小节），
字段对齐 Character Card V2 概念，扩展作息/关系/内情。
- `id: string` — 居民标识（目录名，如 hoshino）
- `name / age / role` — 姓名、年龄、身份
- `description: string` — 出身与经历（对齐 V2 description）
- `personality: string` — 性格（写行为不写形容词）
- `speechStyle: string` — 说话方式与口癖（生成时的风格锚）
- `likes / dislikes: string[]`
- `scenario: string` — 当前处境（对齐 V2 scenario）
- `dialogueExamples: string[]` — 对话示例（对齐 V2 mes_example）
- `schedule: TimeBlock[]` — 作息表：[时段, 地点, 活动]
- `home / haunts: string[]` — 住所与常去地点（须在地点清单内）
- `relations: Record<string, string>` — 对他人（含背景人物）的关系
- `secrets?: string` — 不公开内情（星野旧案细节，谜团引擎素材）

### WorldState（权威数据源，每 tick 存取于 D1 快照）
- `now / period` — 当前时间与时间段（清晨/上午/午后/傍晚/夜晚）
- `weather / season` — 天气与季节
- `residents: Record<id, Presence>` — Presence = {location, activity, since}
- `relations: Record<pair, {affinity: number, note: string}>`
- `mysteries: Record<id, Mystery>`
- `lastTickTs: number` — 上次心跳时刻

### MemoryEntry（记忆条目，D1 表 + FTS5 索引）
- `id / residentId / ts`
- `kind: 'observation' | 'event' | 'dialogue' | 'reflection' | 'plan'`
  — plan 为当日计划（存记忆流，decide 时优先检索当日 plan）
- `content: string` — 第一人称视角存储
- `salience: 1–5` — 显著度（= 斯坦福 importance；检索与反思阈值因子）
- `tags: string[]` — 关键词（FTS5 索引，小写 fts5 建表）
- `subject: string | null` — 这段记忆关于谁：居民/背景人物/
  未来的访客 id（二期访客记忆的零迁移预留）

检索：`score = α·近因衰减 + β·salience + γ·FTS5 关键词匹配`（斯坦福三元组）。
反思：salience 累积超阈值触发（非定时），产出 kind=reflection 抽象认识。

### Entry（信息流条目，D1 表）
- `id / ts`
- `type: 'activity' | 'dialogue' | 'monologue' | 'mystery'`
- `residentIds: string[]` — 出场居民（1 或 2 人）
- `location: string`
- `title?: string` — mystery 类条目标题
- `content: string`
- `status: 'published' | 'taken_down'`

### Mystery（谜团，D1 表）
- `id / arc: 'daily' | 'seasonal'`
- `title / premise` — 谜面
- `state: 'spawned' | 'investigating' | 'resolved'`
- `clues: {ts, text}[]` — 已释放线索
- `resolution: string` — 谜底（生成即预定，保证线索前后呼应；
  seasonal 由档案 secrets + 配置手工给定）

### UsageRecord（LLM 用量，D1 表）
- `ts / purpose: 'plan' | 'action' | 'dialogue' | 'monologue' | 'reflection' | 'mystery' | 'guard'`
- `tier / model` — 档位与实际模型名
- `tokensIn / tokensOut / estCost`

## 模块设计

### config
**职责：** 运行配置读取（KV + 默认值，zod 校验）；每 tick 读取 = 热生效。
**接口：** `get(env): Promise<Config>`。
**依赖：** KV。

### llm
**职责：** Vercel AI SDK 封装；按用途路由模型档位；generateObject
结构化输出（zod 校验行动 JSON）；逐次记录用量。
**接口：** `complete(purpose, tier, messages): Promise<string>`；
`structured(purpose, tier, schema, messages): Promise<T>`。
**依赖：** config、store。预留：STT/TTS provider 类型（三期）。

### persona
**职责：** profile.md 解析与校验（D1 profiles 表读取 + gray-matter + zod）；
载入时过护栏。
**接口：** `loadAll(): ResidentProfile[] | throws ProfileError(field)`。
**依赖：** guard。

### cognition ★（居民大脑，多驱动器复用）
**职责：** 居民的感知、计划、决策、对话、独白、回应。
**接口：**
- `planDay(resident, world): Promise<void>` — 写入 kind=plan 记忆
- `decide(resident, world): Promise<Action>` — cheap 模型，结构化输出
- `converse(residents, world): Promise<Dialogue>` — prose 模型
- `monologue(resident, world): Promise<string>` — prose 模型，depth-0 风格锚
- `respond(resident, session): Promise<string>` — 二期会话用，本期仅壳
**内部：** `assemble(layers)` 分层注入组装器
（人格锚 → 世界状态 → 预算化记忆 → 当前情境 → depth-0 指令）。
**依赖：** llm、memory、persona、WorldState（只读）。不依赖任何驱动器。

### memory
**职责：** 记忆自动写入（salience 打分）、三元检索、阈值触发反思。
**接口：** `write(resident, kind, content, salience, subject)`；
`recall(resident, hints, k): MemoryEntry[]`；`maybeReflect(resident)`。
**依赖：** llm、store。

### engine（模拟器核心，由 cron/admin 触发）
**职责：** 时钟推进与休眠判断；规则裁决（移动/相遇/时间段）；
世界事件生成（按概率）；条目激活率控制；WorldState 快照存取。
**接口：** `tick(env): Promise<void>`（驱动 planDay/decide/converse/monologue）。
**依赖：** cognition、memory、mystery、entries、store、config。

### mystery
**职责：** 谜团生成、线索分阶段释放、揭晓落地（温暖向、无犯罪细节）。
**接口：** `maybeSpawn(world): Mystery | null`；`advance(world): EntryCandidate | null`。
**依赖：** llm、store。

### entries
**职责：** 把世界事件/对话/独白落成信息流条目。
**接口：** `draft(...): EntryCandidate`。
**依赖：** store（写 Entry）。

### guard
**职责：** 规则 + 词表检查。对象：信息流条目（发布前）、人格档案
（载入时）。拦截留记录。
**接口：** `check(text, context): 'ok' | {reason: string}`。
**依赖：** store（写拦截记录）。

### api
**职责：** Hono 装配。public：时间线/居民/单居民条目（只读）；
admin：条目下线、用量日报、手动触发 tick（Bearer token）。
**依赖：** store、config、engine。预留：二期会话路由、WebSocket。

### web
**职责：** 信息流单页（轮询、按居民筛选、居民主页、移动端适配）。
**依赖：** api（fetch）。零交互输入口。

### store
**职责：** D1 访问层：schema 迁移、各表读写、FTS5 索引维护、
快照存取。**全项目唯一与平台耦合的模块**（迁回 VPS 时替换为
better-sqlite3 实现即可）。
**依赖：** D1 binding。

## 模块交互

### 一个 tick 的生命周期（cron 触发）
```
Workers scheduled 事件 → engine.tick：
  加载 WorldState 快照 + config(KV)
  → 休眠窗口内？直接 no-op 返回
  → events：世界事件生成（天气/花絮，概率触发 mystery.maybeSpawn）
  → 居民循环（激活率过滤）：
      cognition.decide（assemble：人格锚+世界状态+recall 记忆+当日 plan）
        → llm.structured（cheap 档）→ Action
      engine 规则裁决（移动/停留/相遇检测）→ 更新 WorldState
      entries.draft「动态」候选；memory.write（observation）
  → 同地 ≥2 人：cognition.converse（prose 档）→「对话」候选
  → （到机制触发点）mystery.advance / monologue / maybeReflect
  → 全部候选过 guard.check → 拦截留记录
  → 写入 D1 → 保存 WorldState 快照
  → api 立即可读 → web 下轮轮询呈现
```

### 驱动器关系
```
cron tick（本期）  = Workers scheduled 调 engine.tick
手动 tick（调试）  = api/admin 端点调 engine.tick（token 保护）
chat（二期）       = api 会话路由调 cognition.respond
voice（三期）      = api WebSocket 调 cognition.respond + STT/TTS provider
```

依赖分层（无环）：config / store 在底 → llm、persona、guard、memory
居中 → cognition、mystery、entries 在上 → engine、api 为顶层驱动器。

## 文件组织

```
virtual-neighbor/
├── package.json / pnpm-lock.yaml / tsconfig.json
├── wrangler.jsonc                 — Worker 配置：cron、D1/KV 绑定、env.demo
├── migrations/                    — D1 schema 迁移（含 FTS5 虚拟表，小写 fts5）
│   └── 0001_init.sql
├── src/
│   ├── index.ts                   — Workers 入口：fetch(router) + scheduled(tick)
│   ├── config.ts                  — KV 配置读取 + 默认值（zod）
│   ├── llm/client.ts              — Vercel AI SDK 封装：档位路由 + 结构化输出
│   ├── llm/usage.ts               — UsageRecord 记录与按天统计
│   ├── persona/profile.ts         — 打包资源读取 + gray-matter + zod 校验
│   ├── cognition/assemble.ts      — 分层注入组装器
│   ├── cognition/plan.ts          — planDay（每日计划层）
│   ├── cognition/decide.ts        — decide / converse / monologue
│   ├── cognition/respond.ts       — 二期会话接口（本期留壳）
│   ├── memory/store.ts            — 写入 / 三元检索(FTS5) / 反思阈值触发
│   ├── world/engine.ts            — tick 主流程：时钟/裁决/激活率/快照
│   ├── world/events.ts            — 天气/季节/背景人物花絮
│   ├── world/mystery.ts           — 谜团引擎（日常 + 季度旧案）
│   ├── feed/entries.ts            — 条目生成（动态/对话/独白/谜团）
│   ├── feed/guard.ts              — 发布前护栏（条目 + 档案）
│   ├── api/public.ts              — Hono 只读路由（时间线/居民/条目）
│   ├── api/admin.ts               — 管理路由（下线/用量日报/手动 tick，token）
│   └── store/db.ts                — D1 访问层（唯一平台耦合模块）
├── web/                           — 信息流前端（TS + Vite 轻量构建）
│   ├── index.html
│   └── src/main.ts / api.ts / ui.ts / style.css
├── personas/
│   ├── hoshino/profile.md         — 星野
│   └── nanase/profile.md          — 七濑
└── tests/                         — vitest + workers 池（miniflare 模拟 D1/KV）
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 语言/运行时 | TypeScript on Cloudflare Workers（V8） | 全栈同语言；Workers 原生跑 TS；语音阶段有 LiveKit/CF Calls 退路 |
| 托管 | Cloudflare 全家桶：Workers + Cron + D1 + KV + Pages | ¥0 永久、24/7、零运维、自动 HTTPS（免费层限制已逐项实测通过） |
| 心跳 | Cron Trigger `*/30 * * * *`；admin 端点手动 tick 备用 | 触发与逻辑解耦，任何触发器都能驱动同一 tick |
| 包管理/开发 | pnpm + wrangler（本地 miniflare 模拟 D1/KV/Cron） | Workers 标准工具链 |
| Web 框架 | Hono | 原生为 Workers 类运行时设计；REST+未来 WS 全覆盖 |
| LLM 接入 | Vercel AI SDK | provider 无关、edge 兼容；generateObject+zod 校验行动 JSON；原生流式（二/三期刚需） |
| 数据校验 | zod | 档案/配置/LLM 输出统一 schema |
| 存储 | Cloudflare D1（SQLite + FTS5，小写 fts5 建表） | 免费 5GB；FTS5 支撑记忆三元检索；注意 FTS5 表导出限制（导出前先 drop 虚拟表） |
| 配置生效 | KV 存运行配置，每 tick 读取 | 热生效（AC10），无需重新部署 |
| 演示模式 | wrangler env.demo：独立 D1 + 加密 cron + 预览域名 | 加速跑且不产生公开内容（F10） |
| 记忆检索 | 近因×显著度×FTS5 关键词 | 斯坦福三元组；不引向量库，接口预留 embedding |
| 反思触发 | 显著度累积超阈值 | 斯坦福验证的机制；省调用更自然 |
| 模拟节奏 | 心跳+夜间休眠+每日计划层+激活率 | spec F1/F5；Concordia 激活率防刷屏感 |
| 人格档案 | profile.md（frontmatter+小节），字段对齐 chara_card_v2；源文件在 personas/，发布脚本写入 D1 | 远期兼容角色卡生态（UGC 创建）；档案即数据，新增居民零代码改动 |
| 内容护栏 | 规则+词表，覆盖条目与档案 | 本期够用且零成本；预留 LLM 审查位 |
| 前端 | TS + Vite 构建的静态单页，轮询 30s | 产物纯静态；Pages/博客仓库任意托管，iframe 嵌入 |
| 平台解耦 | store 为唯一平台耦合模块；engine/config 接口化 | 保留迁回 VPS（Oracle 免费层后备）的能力 |
| 语音前瞻（硬规定） | API 层保留 WS 能力；三期必须流式管线（LiveKit 系），禁止串行整段式 | 旧项目慢在串行架构而非语言，不再重蹈 |
| 测试 | vitest + @cloudflare/vitest-pool-workers | miniflare 内模拟 D1/KV 真跑 |
| 旧代码 | 全部退役删除，不迁移 | spec「不做的事」；新仓库结构重写 |
