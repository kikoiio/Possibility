# Possibility 阶段二：活的世界 Plan

## 架构概览

总体形态：阶段二在现有「React SPA → Hono Worker → D1」单体架构上新增三个 subsystem：**世界引擎**、**世界服务**、**观察界面**，并改造数据模型让 World 成为一等公民。

```
                      ┌─────────────────────────────────────────┐
  访客(免登录) ──→ 观察界面 SPA ──→ Public 只读路由（仅演示世界）  │
  主人(登录)   ──→           ──→ 世界服务路由（世界/时间线/介入） │
                                    │                           │
  引擎节拍器(Node 脚本) ──POST tick──→ 世界引擎（Worker 内）      │
                                    │      ├─ 时钟推进(6x)      │
                                    │      ├─ 日程机械执行(免费) │
                                    │      ├─ 决策点调度 ────────┼──→ LLM（推理模型）
                                    │      │   相遇/对话/节拍/   │
                                    │      │   注入反应/摘要     │
                                    ▼      ▼                     │
                                  D1（世界/记忆流/对话/事件） ◄───┘
```

**组件划分：**

1. **世界引擎（Engine）**——阶段二的心脏。逻辑住在 Worker 内（独占 D1 与 LLM 访问），由一个 Node 节拍器脚本驱动：脚本每隔约 15 秒调用一次 `POST /api/engine/tick`（带共享密钥），等待返回后再发起下一次——天然串行、不会重入。每个 tick 引擎对所有"运行中"世界的活跃时间线做一轮推进：先把世界时钟按真实经过时间 ×6 快进；然后机械执行日程（到点切换地点/活动，零 LLM）；最后按预算顺序处理决策点（进行中的对话轮转 → 注入事件反应 → 到期的生活节拍 → 日程生成 → 记忆压缩），每世界每 tick 有调用上限，花不完的活留到下一拍。

2. **世界服务（Worlds API）**——主人的世界管理面：Quick World 创建（一句话 → LLM 生成骨架 → 选人入驻）、世界/时间线列表、暂停/继续、注入事件、世界级 Fork、归档时间线、世界快照与人物详情（状态/想法流/日程/记忆摘要）查询。复用现有登录态与归属校验。

3. **公共只读服务（Public API）**——访客的橱窗：仅暴露 `isDemo` 标记世界的快照、事件流、对话展开、人物想法流。免登录、无写接口，与认证路由完全分离。

4. **观察界面（SPA 新增页面）**——世界视图（顶部世界时钟+时间线切换、左侧地点面板、中央事件流、右侧人物详情抽屉）、世界列表、Quick World 创建向导。未登录访客落地页直接进入演示世界视图（同一组件，只读模式）。世界视图用 SSE 订阅增量更新。

5. **记忆与上下文（改造现有 agent 模块）**——记忆表升级为统一记忆流（事件/对话/想法/摘要同表，带重要性），检索按「近期 N + 重要性 top-K + 最新摘要」；引擎模式接入同一套自主体循环。聊天保留在人物页，文案改为"打电话"。

6. **节拍器与运维脚本**——`npm run dev` 从两进程变三进程（web + api + engine pinger）；seed 脚本新增「雾影庄」演示世界（6 人物含完整人物卡、地点、初始日程与记忆）。

关键架构取舍：**引擎逻辑全部在 Worker 内、节拍器只是个定时 ping**——本地开发与未来部署（Cloudflare Cron Trigger 替换 pinger）共用同一套引擎代码，不需要第二个运行时。

## 核心数据结构

改动总览：现有 10 张表保留 7 张不动（users / sessions / persons / conversations / messages 完全不动，timelines / memories / personStates / events 加列），改造 worlds，新增 5 张表（world_persons / schedules / dialogues / dialogue_turns / llm_call_log）。

### worlds（改造，升级为一等公民）
```
id, userId, name, description
locationsJson    -- [{name, description}]，5-8 个地点
status           -- running / paused / capped（触顶自动暂停）
pauseReason      -- 暂停原因（manual / daily_cap / null）
isDemo           -- 0/1，演示世界标记（Public API 只放行 isDemo=1）
callsToday       -- 当日已用 LLM 调用数（真实日期）
callsDay         -- callsToday 对应的真实日期（换天自动清零）
createdAt        -- 新增（原表没有）
```
删除 `personId`（人物归属移到 world_persons）。

### world_persons（新增，人物↔世界多对多）
```
worldId, personId, joinedAt   -- PK(worldId, personId)
```
隔离原理：时间线唯一属于一个世界，人物的状态/记忆都挂在（person × timeline）上，因此"同一人物在两个世界互不影响"由既有键天然保证。

### timelines（加列）
```
id, worldId, parentTimelineId, forkScenarioJson, simNow, createdAt  -- 既有
status           -- active / archived（引擎只推 active）
ancestorIdsJson  -- 从主线到自己的祖先链 [mainId, forkId1, ...]，主线为 []
lastRealTickAt   -- 上次引擎推进此线的真实时间（时钟推进依据）
```

### personStates（加列，既有 PK personId+timelineId）
```
personId, timelineId, simTime, location, activity, mood, goal, updatedRealAt  -- 既有
currentDialogueId  -- 正在进行的对话 id，非空时引擎跳过此人的节拍
lastBeatSimTime    -- 上次生活节拍的虚拟时间（注入事件感知的水位线）
```

### schedules（新增，每人每线每天一份）
```
personId, timelineId, worldDate   -- PK(personId, timelineId, worldDate)
itemsJson    -- [{start, end, location, activity}]，时间段+地点+内容
generatedAt  -- 生成时的虚拟时间
```

### dialogues（新增）
```
id, timelineId, location, participantIdsJson  -- [personId, ...]，2-3 人
status           -- ongoing / ended
turnLimit, simStart, simEnd
```

### dialogue_turns（新增）
```
id, dialogueId, turnIndex, personId
utterance   -- 说出的话（访客可见）
thought     -- 同一次生成产出的内心想法（存入记忆流 type=thought）
simTime, createdAt
```

### memories（加列，升级为统一记忆流）
```
id, personId, timelineId(null=主线), simTime, createdAt  -- 既有
type        -- 扩展：source / world / timeline / relationship / thought / summary
importance  -- 1-10，写入时由 LLM 顺带评分；迁移旧数据默认 5
summarized  -- 0/1，已被某条 summary 压缩覆盖（不再进提示词，库中保留可回溯）
```
记忆可见性规则（替代阶段一的"null∪本分叉"）：
`可见 = timelineId ∈ ancestorIds ∪ {self} 且 createdAt ≤ 本线 createdAt 的条目 ∪ 本线自身条目`——支持分叉的分叉，且天然排除分叉点之后的记忆。

### events（加列）
```
id, timelineId, simTime, title, description  -- 既有
kind            -- action / dialogue / injected / system
actorPersonId   -- 行动者（injected/system 可为空）
dialogueId      -- kind=dialogue 时关联 dialogues.id（前端展开逐句）
```

### llm_call_log（新增，成本护栏与可观测性）
```
id, worldId, timelineId, personId
purpose   -- schedule / beat / dialogue_turn / injection / summary / chat / distill
createdAt -- 真实时间（每日上限按真实日期统计）
```

### 引擎核心接口（非表，留 LangGraph 迁移接口）
```ts
interface AgentStep {
  kind: 'schedule' | 'beat' | 'dialogue_turn' | 'injection' | 'summary'
  personId: string | null       // null = 世界级步骤
  priority: number              // 预算不足时高优先级先执行
}
interface StepExecutor {
  perceive(step: AgentStep, world: WorldSnapshot): Promise<StepInput>
  decide(input: StepInput): Promise<StepOutput>   // LLM 调用发生在这里
  act(output: StepOutput): Promise<void>          // 写库
}
```

## 模块设计

### M1 引擎核心 `api/src/engine/`
**职责：** 接收 pinger 的 tick → 对所有 running 世界 × active 时间线做一轮推进：推进时钟（真实经过 ×6，单拍钳制上限，停机不追赶）→ 机械执行日程（到点切地点/活动，零 LLM）→ 收集本拍决策点（按优先级：对话轮转 > 注入反应 > 生活节拍 > 日程生成 > 记忆压缩）→ 在每世界每拍调用预算内依次执行 → 记账（llm_call_log、callsToday，触顶置 capped）。
**对外接口：** `POST /api/engine/tick`（共享密钥鉴权，非用户登录态）；`GET /api/engine/status`（登录主人可见，N7 可观测性）。
**依赖：** db、agent 上下文/提示词、llm client、M2 执行器。

### M2 决策点执行器 `api/src/engine/steps/`
**职责：** 五种 step 各自实现 `perceive / decide / act`：
- **schedule**：人物当前世界日无日程 → 生成当日日程（模型+世界+地点+近期记忆 → itemsJson）。
- **beat**：日程项结束 → 一次 LLM 调用产出「这段时间做了什么（事件）+ 想法（thought）+ 可选记忆（带重要性）+ 下一步（跟日程/调整）」；若同地点有其他人且无对话冷却 → 转为发起 dialogue。
- **dialogue_turn**：进行中的对话每拍轮转一次——轮到谁就用谁的视角生成「发言 + 内心想法」写入 dialogue_turns；末轮顺带产出各自的关系记忆；达到轮次上限或双方话尽 → 结束对话、写 kind=dialogue 事件。
- **injection**：注入事件生效 → 该时间线清醒人物各得一次反应节拍（感知到事件，自行决定如何反应）。
- **summary**：某人未压缩记忆超阈值（40 条）→ 把最老 30 条蒸馏为一条 summary 记忆并标记原文。

**对外接口：** `StepExecutor` 接口，仅被 M1 调用。
**依赖：** db、agent、llm client。

### M3 agent 模块改造 `api/src/agent/`
**职责：** 支持按（person × timeline）装配引擎所需上下文：人物模型、世界与地点、同世界其他人物（姓名+公开身份+与我的关系记忆）、当日日程、记忆检索（近期 12 + 重要性 top 8 + 最新 2 条摘要，排除 summarized）；提示词新增引擎模式指令（不破坏 chat/catchup/simulate）。
**对外接口：** `buildEngineContext(personId, timelineId)`、`buildEnginePrompt(ctx, stepKind)`；既有 `buildAgentContext` 签名不变。
**依赖：** db、types。

### M4 世界服务 `api/src/worlds/`
**职责：** 主人的世界管理面，全部走现有 authMiddleware + 归属校验：
- `POST /api/worlds/draft`：一句话 → LLM 生成世界骨架（名称/背景/5-8 地点），不落库
- `POST /api/worlds`：确认创建（骨架 + 选定 1-6 人物）→ 建世界/关联/主线/初始状态，status=running
- `GET /api/worlds`、`GET /api/worlds/:id`（快照：世界+地点在场人物+近 1 世界日事件+时间线列表+引擎状态）
- `POST /api/worlds/:id/pause` / `resume`、`POST /api/worlds/:id/inject`
- `POST /api/worlds/:id/timelines/:tid/fork`（活跃线 <3 才允许）、`POST /api/timelines/:id/archive`
- `GET /api/worlds/:id/stream?timelineId=`：SSE，服务端每 2 秒轮询增量推送
- `GET /api/worlds/:id/persons/:pid?timelineId=`：人物详情（状态/想法流倒序/当日日程/近期记忆摘要）
- `GET /api/dialogues/:id`：对话逐句展开

**依赖：** db、agent（draft 用 complete 生成 JSON）、auth。

### M5 公共只读服务 `api/src/public/`
**职责：** 访客橱窗，无 authMiddleware，但路由内强制 `isDemo=1` 校验，只提供 GET：`GET /api/public/worlds/:id`（快照）、`GET /api/public/worlds/:id/stream`（SSE）、`GET /api/public/worlds/:id/persons/:pid`、`GET /api/public/dialogues/:id`。无任何写接口；查询实现与 M4 共用只读查询函数。
**依赖：** db（只读查询）。

### M6 前端观察界面 `web/src/`
**职责：** 新增 WorldView（顶栏：世界名/世界时钟×6/时间线切换/暂停/Fork/注入框；左栏地点面板：每地点在场人物+活动；中央事件流：行动/对话可展开/注入事件标记；右侧人物抽屉：状态/想法流/今日日程/记忆摘要）、Worlds 列表页、WorldCreate 向导（描述→骨架编辑→选人→启动）、DemoLanding（未登录落地页 = WorldView 只读模式，走 M5）。Home 增加"运行中的世界"区块；PersonDetail 聊天入口文案改"打电话"。
**依赖：** M4/M5 接口、既有 api client（SSE 读取封装复用）。

### M7 数据迁移 `api/drizzle/` + `api/src/db/migrate-data.ts`
**职责：** schema 迁移（drizzle 生成）+ 数据迁移（幂等脚本）：旧 worlds（有 personId）→ 建 world_persons 关联、生成默认 3 地点、status=**paused**（旧世界不自动开跑，主人手动 resume，防止迁移后成本爆炸）；旧 timelines → status=active、ancestorIdsJson 按父子链回填；旧 memories → importance=5；旧 events → kind=action、actorPersonId=旧 personId。可重跑。
**依赖：** db。

### M8 脚本 `scripts/`
**职责：** `engine-pinger.ts`——每 15 秒 POST `/api/engine/tick`（带密钥），串行等待；`seed-demo.ts`——创建「雾影庄」：世界（isDemo=1、running、7 地点）、6 个手写完整人物卡（含互相的关系记忆与悬念钩子）、关联、主线、初始状态；`npm run dev` 变三进程（web+api+pinger）。
**依赖：** fetch 调用 M1/M4/dev 路由。

## 模块交互

### 流程 1：引擎一拍（tick）的完整调用链
```
pinger ──POST /api/engine/tick(密钥)──→ M1 引擎核心
M1: 1. 查询 status=running 的世界 × status=active 的时间线
    2. 逐时间线推进时钟：simNow += 真实经过×6（单拍钳制 ≤15 虚拟分钟）
    3. 机械日程：逐人物对照当日日程，simNow 越过某项 end 就切到下一项
       （更新 personStates.location/activity，零 LLM）
    4. 逐世界收集决策点，按优先级入队：
       P1 进行中的对话 → dialogue_turn step
       P2 未感知的注入事件 → injection step（每个清醒人物一个）
       P3 日程项刚结束且无对话的人物 → beat step
       P4 当前世界日无日程的人物 → schedule step
       P5 未压缩记忆 >40 条的人物 → summary step
    5. 预算内依次执行（每世界每拍 ≤8 次 LLM 调用，剩余留到下拍）：
       每个 step → M2 执行器 perceive(查库+M3 装上下文) → decide(LLM) → act(写库+记账)
    6. 记账：每执行一次 decide 写 llm_call_log、callsToday+1；
       callsToday ≥ 每日上限 → 世界置 capped、pauseReason=daily_cap
    7. 回写 timelines.simNow / lastRealTickAt → 返回本拍摘要 JSON 给 pinger
```

### 流程 2：相遇与对话（流程 1 中 beat step 的分支）
```
beat perceive 发现同地点有 ≥1 个清醒人物、双方都不在对话中、距上次对话 ≥2 虚拟小时
  → 不执行 solo beat，改为：建 dialogues(ongoing, turnLimit=8)、双方 currentDialogueId 置位
后续每拍（P1 最高优先级）：
  dialogue_turn：轮到 A → M3 装 A 的上下文（含与 B 的关系记忆+对话记录+当前场景）
    → LLM 生成「发言+内心想法」→ 写 dialogue_turns（访客立即可在流中看到）
    → 轮到 B → 同流程 …交替
结束（满 8 轮或双方话尽）：
  末轮 decide 顺带产出「这段对话值得记住什么+重要性」→ 各自写记忆流
  → dialogues 置 ended、写 events(kind=dialogue)、双方 currentDialogueId 清空
```

### 流程 3：注入事件
```
主人在世界视图输入"突然下起暴雨" → M4 POST /worlds/:id/inject
  → 写 events(kind=injected, simTime=当前 simNow) → 立即返回
下一拍：M1 发现该事件 simTime > 某些人物的 lastBeatSimTime
  → 为这些人物各排一个 injection step（P2）
  → decide 时提示词含注入事件 → 人物自行反应（避雨/关窗/无感）
  → act 写事件/想法/状态 → lastBeatSimTime 推进（即"已感知"水位线）
```

### 流程 4：世界级 Fork
```
主人在世界视图点 Fork → M4 POST /worlds/:id/timelines/:tid/fork
  → 校验活跃线 <3 → 建新时间线：
    parentTimelineId=tid、ancestorIdsJson=tid.ancestorIds+[tid]、simNow=tid.simNow
  → 复制该线所有人物 personStates（currentDialogueId 清空）与当日 schedules
  → 记忆/事件不复制（可见性规则自动让新线看到分叉点之前的一切）
  → status=active → 下一拍起引擎并行推进两条线
归档：POST /api/timelines/:id/archive → status=archived，引擎跳过（数据保留）
```

### 流程 5：打开世界视图（主人与访客同构）
```
主人：SPA → M4 GET /worlds/:id（登录态+归属校验）
访客：SPA → M5 GET /public/worlds/:id（免登录，仅放行 isDemo=1）
两者拿到相同结构的快照：世界信息+simNow+时间线列表+引擎状态
  +地点列表（每个地点在场人物及活动）+近 1 世界日事件（对话事件带前两句预览）
随后建立 SSE：M4/M5 stream 端点每 2 秒轮询增量并推送：
  新事件 / 新 dialogue_turn / 人物状态变化 / 时钟与 callsToday 更新
点击人物 → GET persons/:pid（状态+想法流+当日日程+近期记忆摘要）
点击对话事件 → GET dialogues/:id（逐句+每句的内心想法）
```

### 流程 6：Quick World 创建
```
主人输入一句话 → M4 POST /worlds/draft → LLM(complete) 生成
  {name, description, locations[5-8]} → 前端可编辑骨架
→ 勾选 1-6 个已有人物 → POST /worlds
  → 建 worlds(running) + world_persons + 主线 timeline
    + 每人物初始 personStates（地点轮转分配）→ 返回世界 id
→ 前端跳转世界视图；下一拍引擎开始为他们生成首份日程（P4）
```

### 流程 7：打电话（阶段一聊天，基本不变）
```
PersonDetail → 既有 chat 路由（POST conversations / messages，SSE 流式）
变化仅两处：buildAgentContext 里"世界"改经 world_persons 找到该人物的默认世界
（迁移时创建的单人世界）；文案与叙事统一为"打电话"。
聊天中 remember/act 仍写入该世界主线的记忆流与事件流——
引擎推进该世界时，人物会在 beat 的上下文里看到这些记忆（电话的影响自然生效）。
```

**依赖方向**（无环）：pinger → M1 → M2 → M3 → db/llm；SPA → M4/M5 → db；M4 创建/注入/Fork 只写库，由 M1 下一拍消费——**所有 LLM 调用只发生在 M2 decide 与既有 chat/distill 路径**，这是成本护栏能成立的结构性保证。

## 文件组织

```
api/
├── drizzle/
│   └── 0001_xxx.sql                  新建 — schema 迁移（drizzle 生成）
├── src/
│   ├── index.ts                      修改 — 挂载 engine/worlds/public 路由
│   ├── engine/                       新建（M1+M2）
│   │   ├── tick.ts                   — tick 编排：时钟推进、机械日程、决策点调度
│   │   ├── budget.ts                 — 调用记账、每拍/每日上限、触顶置 capped
│   │   ├── routes.ts                 — POST /api/engine/tick、GET /api/engine/status
│   │   └── steps/
│   │       ├── types.ts              — AgentStep / StepExecutor / StepInput / StepOutput
│   │       ├── schedule.ts           — 当日日程生成
│   │       ├── beat.ts               — 生活节拍（含相遇检测→发起对话）
│   │       ├── dialogue.ts           — 对话轮转、结束与记忆沉淀
│   │       ├── injection.ts          — 注入事件反应
│   │       └── summary.ts            — 记忆压缩蒸馏
│   ├── agent/
│   │   ├── context.ts                修改 — 记忆查询改用 ancestorIds 可见性规则
│   │   ├── engine-context.ts         新建 — 引擎上下文装配（同世界人物/日程/感知水位）
│   │   ├── engine-prompt.ts          新建 — 引擎模式提示词（五种 step 各一段指令）
│   │   ├── memory.ts                 新建 — 记忆检索（近期+重要性+摘要）、压缩查询
│   │   ├── tools.ts                  修改 — remember 增加 importance 参数
│   │   ├── prompt.ts / loop.ts / distill.ts / types.ts   不动
│   ├── worlds/                       新建（M4）
│   │   ├── routes.ts                 — 世界 CRUD/暂停/继续/注入/Fork/归档/人物详情
│   │   ├── queries.ts                — 快照/地点面板/事件流/对话展开（M5 复用）
│   │   ├── stream.ts                 — SSE 增量推送（轮询实现）
│   │   └── draft.ts                  — Quick World 骨架生成
│   ├── public/
│   │   └── routes.ts                 新建（M5）— 演示世界只读（复用 worlds/queries+stream）
│   ├── db/
│   │   ├── schema.ts                 修改 — 全部表结构变更
│   │   ├── migrate-data.ts           新建（M7）— 幂等数据迁移
│   │   └── client.ts                 不动
│   ├── chat/ timelines/ persons/ home/ auth/ llm/ dev/   基本不动
│   │   （chat/routes.ts 微调：经 world_persons 找默认世界；home/routes.ts 加世界区块数据）
web/
├── src/
│   ├── App.tsx                       修改 — 路由：/ 未登录→演示世界，登录→Home
│   ├── pages/
│   │   ├── WorldView.tsx             新建 — 世界视图（owner 模式/readonly 模式双态）
│   │   ├── Worlds.tsx                新建 — 世界列表
│   │   ├── WorldCreate.tsx           新建 — Quick World 向导
│   │   ├── DemoLanding.tsx           新建 — 访客落地页（WorldView readonly + public API）
│   │   ├── Home.tsx                  修改 — 加"运行中的世界"区块
│   │   └── PersonDetail.tsx          修改 — 聊天入口文案改"打电话"
│   ├── components/world/             新建
│   │   ├── LocationPanel.tsx         — 地点列表+在场人物
│   │   ├── WorldEventFeed.tsx        — 事件流（按 kind 分样式，对话可展开）
│   │   ├── DialogueView.tsx          — 逐句对话+每句内心想法
│   │   ├── PersonDrawer.tsx          — 人物抽屉：状态/想法流/日程/记忆摘要
│   │   ├── TimelineSwitcher.tsx      — 时间线切换+Fork 入口
│   │   └── InjectBox.tsx             — 注入事件输入框
│   └── api/
│       ├── client.ts                 修改 — worlds/public 接口 + SSE 订阅封装
│       └── types.ts                  修改 — 世界相关类型
scripts/
│   ├── engine-pinger.ts              新建 — 节拍器（15s 间隔，串行）
│   ├── seed-demo.ts                  新建 — 雾影庄演示世界种子
│   └── seed.ts                       不动
package.json                          修改 — dev 变三进程（web+api+pinger）
docs/spec_docs/phase2/                新建 — 本阶段四份文档
```

新增 24 个文件，修改 12 个，其余不动。`chat` / `timelines` / `persons` / `auth` / `llm` 五大既有模块基本零侵入。

## 技术决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| D1 | 引擎驻留位置 | 逻辑在 Worker 内，外部 Node pinger 定时 POST tick | Worker 独占 D1/LLM 访问，单一运行时；pinger 串行等待返回，天然无重入；未来部署可用 Cron Trigger 直接替换 pinger，引擎代码零改动 |
| D2 | 时钟推进 | simNow += 真实经过 × 6，单拍钳制 ≤15 虚拟分钟 | 钳制即"停机不追赶"的实现：重启后只从停机点小幅继续，永不补跳；正常 15s 一拍 = 推进 90 虚拟秒 |
| D3 | 成本结构 | 机械日程免费，仅决策点调 LLM；所有 LLM 调用只发生在 M2 decide 与既有 chat/distill 路径 | 结构性保证每日上限可 enforce；半夜人物睡觉（无日程项结束）成本自然趋零 |
| D4 | 对话执行 | 分拍轮转：每拍推进一轮（一人发言），8 轮上限，2-3 人 | 对话在事件流中"现场展开"（访客看到逐句出现）；成本摊到多拍；避免单请求分钟级长耗时 |
| D5 | 相遇检测 | 在 beat 的 perceive 中做：同地点 + 双方清醒 + 无进行中对话 + 距上次对话 ≥2 虚拟小时 | 不新增调度路径；冷却防止同两人反复聊天烧预算 |
| D6 | 注入事件感知 | 水位线机制：事件 simTime > 人物 lastBeatSimTime 即未感知，反应后推进水位线 | 无需消费记录表；与节拍共用一条状态字段 |
| D7 | 记忆可见性 | ancestorIds ∈ 祖先链 ∪ 自身 且 createdAt ≤ 本线创建时间 | 支持分叉的分叉；自动排除分叉点之后的记忆；替代阶段一"null∪本分叉"规则（旧数据迁移时回填祖先链） |
| D8 | 记忆检索 | 近期 12 条 + 重要性 top 8 + 最新 2 条 summary（排除 summarized），纯 SQL | 不做 embedding（已裁定）；检索确定性、零额外调用 |
| D9 | 想法存储 | 合入 memories 表（type=thought），不单独建表 | F13 统一记忆流；详情页按 type 过滤即是想法流 |
| D10 | Fork 语义 | 复制 personStates + 当日 schedules；不复制记忆与事件 | 可见性规则让新线自动继承分叉点前的一切；复制记忆会造成双写污染 |
| D11 | SSE 实现 | 服务端在 SSE 连接内每 2 秒轮询增量推送 | 满足 N2；不引入 Durable Objects；本地单进程下最简单可靠 |
| D12 | 预算默认值 | 每拍 ≤8 次/世界；每日 ≤400 次/世界（含演示世界独立额度）；均走环境变量可调 | 按"6 人 × 6 世界日 × (1 日程 + ~8 节拍）+ 对话与摘要"估算约 400/日；触顶自动暂停 |
| D13 | token 预算 | schedule 8000 / beat 8000 / dialogue_turn 4000 / summary 12000 | 沿用阶段一教训：推理模型 reasoning 烧预算，宁多勿少（蒸馏 16000 的先例） |
| D14 | 旧世界迁移 | 迁移后 status=paused，主人手动 resume | 防止迁移后所有旧世界同时开跑、成本爆炸 |
| D15 | 演示世界人物卡 | 手写完整 PersonModel，不走 distill | 质量可控；规避推理模型对真人建档的匿名化与名字抖动问题（阶段一实测教训） |
| D16 | 角色编排 | 不引入 LangGraph；五种 step 实现统一 AgentStep/StepExecutor 接口 | 用户已拍板：留迁移接口，未来换图执行器不动引擎 |
| D17 | step 失败处理 | 单个 step 的 LLM 失败：重试一次，再失败则跳过该决策点并记日志 | N3：一人失败不阻塞同线其他人，也不阻塞整拍 |
| D18 | Quick World 入驻 | 人物 PersonModel 原样引用，初始状态地点轮转分配 | 人物可属多世界，模型共享、状态/记忆按线隔离；不复制人物卡 |
