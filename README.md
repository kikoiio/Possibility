# Possibility（阶段二：活的世界）

个人平行世界平台：创建人物（Version）、与 TA 持续文字交流（打电话）、用一句话 What-if 分叉时间线；多个人物生活在同一个持续运转的小世界里——按日程生活、相遇、交谈，主人可以随时以旁观者身份观察、注入事件、Fork 出新线。

本地开发、本地验收版本——不部署。技术栈与 Cloudflare Workers + D1 / GitHub Pages 的目标环境兼容。

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

## 核心机制

**人物即自主体**：每个 Version = 分层人物模型 + LLM 扮演 + 工具（act / update_state / remember）。聊天（打电话）、懒惰追赶、What-if 推演共用一套自主体循环。

**活的世界**：世界引擎按固定节拍推进每个运行中的世界：时钟 6 倍速快进（停机不追赶）→ 机械执行日程（零 LLM）→ 决策点才调 LLM（日程生成 / 生活节拍 / 相遇对话 / 注入反应 / 记忆压缩）。每世界每拍与每日调用数有硬上限（`TICK_CALL_CAP` / `DAILY_CALL_CAP`，触顶自动暂停）。

**记忆流**：事件、对话、想法统一入记忆流（人物 × 时间线隔离，带重要性评分）；检索按「近期 + 重要性 + 最新摘要」；超阈值自动蒸馏为摘要（原文保留可回溯）。分叉只见分叉点之前的记忆，主线与分叉并行推进互不污染。

## 项目结构

```
web/            前端 SPA
  src/pages/      DemoLanding / Home / Worlds / WorldCreate / WorldView / People / PersonCreate / PersonDetail / TimelineView
  src/components/ world/（LocationPanel / WorldEventFeed / DialogueView / PersonDrawer / TimelineSwitcher / InjectBox）+ 阶段一组件
  src/api/        fetch 封装（token、SSE 读取）+ 类型
api/            Worker 后端
  src/engine/     世界引擎：tick 编排 / budget 成本护栏 / steps（schedule / beat / dialogue / injection / summary）
  src/agent/      自主体核心：context / engine-context / engine-prompt / memory（记忆流）/ prompt / tools / loop / distill
  src/worlds/     世界服务：queries / routes（创建/暂停/注入/Fork/归档）/ stream（SSE）/ draft
  src/public/     演示世界公共只读路由（免登录）
  src/persons/    人物创建与 CRUD
  src/chat/       打电话 SSE + 懒惰追赶
  src/timelines/  Fork 预览 / 推演 / 时间线详情 / 归档
  src/llm/        OpenAI 兼容流式客户端
  src/db/         Drizzle schema（15 张表）+ 阶段二数据迁移
scripts/        seed / seed-demo / migrate-p2 / engine-pinger
docs/spec_docs/ 阶段一与阶段二（phase2）的 spec / plan / task / checklist 设计文档
```

## 说明

- 密码 PBKDF2 加盐哈希存储；会话 token 30 天过期；接口校验登录态与数据归属。
- 演示世界只读接口免登录，但仅暴露 `is_demo=1` 的世界；访客无任何写入口。
- 推演事件流页面标注「这是一种可能的发展，不是预测」。
- `.dev.vars` 含密钥，已在 .gitignore 中；模板见 `api/.dev.vars.example`。

