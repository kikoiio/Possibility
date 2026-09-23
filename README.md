# Possibility

> 一个可以创造、进入、交谈、干预和分叉的生成式平行世界。

Possibility 想创造的不是一个聊天机器人、一组彼此隔离的 AI 角色，也不是只能沿预设剧情前进的游戏。我们想创造的是一个真正以“世界”为中心的开放环境：它拥有持续的时间、空间、状态、规则、居民、关系、信息与历史；即使用户不在场，其中的人依然按照自身处境生活，并为已经发生的事情承担后果。

用户可以观察这个世界，以一个世界内身份进入其中，与居民实时交流并采取行动；也可以站在构造者的位置改变条件。任何时刻都可以被保存为分叉点：复制完全相同的过去，只改变一个条件，让多个平行宇宙独立发展，再进入其中观察、交流和比较。

这里的 **Possibility** 不是某一个确定答案，而是从同一段过去出发，可能发生的多个未来。

## 我们想突破什么

传统开放世界只能理解开发者预先写好的动作、角色反应和剧情分支。Possibility 希望让用户尝试没有被预先枚举的事情：说一句意料之外的话，建立一段新关系，传播一条信息，改变一项环境条件，或者从任意时刻创造另一个宇宙。

世界不应简单满足用户的愿望。居民拥有自己的知识、目标、关系和边界；他们可以误解、拒绝、改变主意，也会记住用户的行为。用户的交流不是世界之外的一次 Chat session，而是发生在具体时间、地点和关系中的世界事件，并可能改变之后的生活。

## 核心体验

**创造世界**：用自然语言、结构化设定或已有素材定义一个世界，以及其中的地点、人物、组织、资源、规则和初始条件。

**观察世界**：看见时间推进、人物行动、关系变化、信息传播和事件后果；世界的状态独立于叙述文本持续存在。

**进入世界**：以一个被世界承认的身份来到具体地点，受到时间、空间、知识和关系的约束。

**实时交流与行动**：与居民交谈，提出邀请、做出承诺或采取未被预先写死的行动；交流会进入共同历史，而不是在会话结束后消失。

**改变条件**：以构造者身份改变环境、规则或初始变量，然后观察居民如何自主回应，而不是直接指定结果。

**分叉宇宙**：从任意世界状态创建 Fork。新宇宙继承分叉前的全部事实和记忆，从改变发生的那一刻开始独立演化。

**比较可能性**：在平行宇宙之间比较状态、关系和事件如何逐步分化，同时明确区分“观察到的差异”与“已经证明的因果”。

完整的产品愿景、概念模型与设计原则见 [产品愿景](docs/PRODUCT_VISION.md)。该文档描述我们最终想要什么，不代表当前版本已经实现，也不限定未来的技术方案。

## 当前仓库

这是 Possibility 的本地开发与验证版本。目前已经围绕“持续生活的小世界”实现了一组早期能力：创建人物和世界、观察事件、进入世界交流、持续记忆、条件注入、时间线分叉与对照等。当前界面和机制只是探索愿景的一种方式，不应被视为最终产品边界。

本仓库暂不部署。技术栈与 Cloudflare Workers + D1 / GitHub Pages 的目标环境兼容。

## 技术栈

- **前端** `web/`：Vite + React 19 + TypeScript + Tailwind CSS（SPA，桌面 + 移动自适应）
- **后端** `api/`：Cloudflare Worker（本地 `wrangler dev`）+ Hono + Drizzle ORM
- **数据库**：Cloudflare D1（本地 = SQLite 文件）
- **引擎**：世界引擎住在 Worker 内，`scripts/engine-pinger.ts` 节拍器每 15s 驱动一拍（世界时钟 6 倍速，事件驱动调度，仅决策点调 LLM）
- **LLM**：OpenAI 兼容协议（chat completions + streaming + tools），服务商通过环境变量切换

## 从零启动

前置：Node.js ≥ 18、npm。

```bash
# 1. 安装依赖
npm install

# 2. 配置 LLM（OpenAI 兼容协议的任意服务商）
cp api/.dev.vars.example api/.dev.vars
#    编辑 api/.dev.vars，填入你的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
#    并填一个 ENGINE_TICK_SECRET（任意随机串，引擎节拍密钥）

# 3. 初始化本地数据库（D1 迁移 + 阶段二数据迁移）
npm run db:migrate
npm run migrate:p2   # 需先启动 api（见第 4 步）；阶段一老数据才需要，可重复执行

# 4. 启动（前端 :5173 + 后端 :8787 + 引擎节拍器，一条命令）
npm run dev

# 5. 写入种子账号与演示世界（另开一个终端）
npm run seed              # 创建 admin
npm run seed:demo         # 创建演示世界「雾影庄」（6 人物 / 7 地点，开箱即在运转）
```

打开 http://localhost:5173 ：未登录直接进入演示世界只读视图；管理员登录后可创建人物与世界。

## 种子账号

| 账号 | 密码 | 说明 |
|---|---|---|
| `admin`（可配置） | 随机或本地配置 | `npm run seed` 首次创建时打印；重复执行不重建、不显示原密码 |
| `user_xxxxxx` | 随机 | `npm run seed -- --random N` 生成并打印 |

如需固定本地管理员凭据，请在被 Git 忽略的 `api/.dev.vars` 中设置 `DEV_ADMIN_USERNAME` 和 `DEV_ADMIN_PASSWORD`，不要把真实密码提交到仓库。

## 常用命令

```bash
npm run dev          # 并行启动 web + api + engine（三进程）
npm run dev:web      # 只起前端（:5173）
npm run dev:api      # 只起后端（:8787）
npm run dev:engine   # 只起引擎节拍器
npm run db:migrate   # 应用 D1 迁移（本地）
npm run migrate:p2   # 阶段二数据迁移（幂等）
npm run seed         # 种子账号
npm run seed:demo    # 演示世界「雾影庄」
npm --workspace web run build   # 前端类型检查 + 构建
npm --workspace api run build   # 后端类型检查
```

数据库结构变更流程：改 `api/src/db/schema.ts` → `npm --workspace api run db:generate` 生成迁移 → `npm run db:migrate` 应用。

## 当前实现的核心机制

**人物即自主体**：每个 Version = 分层人物模型 + LLM 扮演 + 工具（act / update_state / remember）。聊天（打电话）、懒惰追赶、What-if 推演共用一套自主体循环。

**活的世界**：世界引擎按固定节拍推进每个运行中的世界：时钟 6 倍速快进（停机不追赶）→ 机械执行日程（零 LLM）→ 决策点才调 LLM（日程生成 / 生活节拍 / 相遇对话 / 注入反应 / 记忆压缩）。每世界每拍与每日调用数有硬上限（`TICK_CALL_CAP` / `DAILY_CALL_CAP`，触顶自动暂停）。

**记忆流**：事件、对话、想法统一入记忆流（人物 × 时间线隔离，带重要性评分）；检索按「近期 + 重要性 + 最新摘要」；超阈值自动蒸馏为摘要（原文保留可回溯）。分叉只见分叉点之前的记忆，主线与分叉并行推进互不污染。

## 项目结构

```
web/            前端 SPA
  src/pages/      DemoLanding / Home / Worlds / WorldCreate / WorldView / People / PersonCreate / PersonDetail / TimelineView
  src/components/ world/（LocationPanel / WorldEventFeed / DialogueView / PersonDrawer / TimelineSwitcher / InjectBox / LifePanel / ComparePanel）+ 阶段一组件
  src/api/        fetch 封装（token、SSE 读取）+ 类型
api/            Worker 后端
  src/engine/     世界引擎：tick 编排 / budget 成本护栏 / steps（schedule / beat / dialogue / injection / summary）
  src/life/       归来回顾、持久约定、时间线证据对照
  src/agent/      自主体核心：context / engine-context / engine-prompt / memory（记忆流）/ prompt / tools / loop / distill
  src/worlds/     世界服务：queries / routes（创建/暂停/注入/Fork/归档）/ stream（SSE）/ draft
  src/public/     演示世界公共只读路由（免登录）
  src/persons/    人物创建与 CRUD
  src/chat/       打电话 SSE + 懒惰追赶
  src/timelines/  Fork 预览 / 推演 / 时间线详情 / 归档
  src/llm/        OpenAI 兼容流式客户端
  src/db/         Drizzle schema（15 张表）+ 阶段二数据迁移
scripts/        seed / seed-demo / migrate-p2 / engine-pinger
docs/           产品愿景与设计文档
```

## 说明

- 密码 PBKDF2 加盐哈希存储；会话 token 30 天过期；接口校验登录态与数据归属。
- 演示世界只读接口免登录，但仅暴露 `is_demo=1` 的世界；访客无任何写入口。
- 推演事件流页面标注「这是一种可能的发展，不是预测」。
- `.dev.vars` 含密钥，已在 .gitignore 中；模板见 `api/.dev.vars.example`。
