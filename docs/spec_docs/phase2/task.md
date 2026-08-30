# Possibility 阶段二：活的世界 Tasks

> 依据：`docs/spec_docs/phase2/spec.md` + `docs/spec_docs/phase2/plan.md`。
> 验证约定：`npm --workspace api run build` = 后端类型检查；`npm --workspace web run build` = 前端类型检查+构建；D1 查询在 `api/` 目录下用 `npx wrangler d1 execute possibility --local --command "SQL"`。
> 注意：curl 提交中文 JSON 时必须写临时文件用 `--data-binary @file`（Windows 内联中文会 GBK 乱码）；`api/.dev.vars` 禁止读写，新增环境变量只改 `.dev.vars.example` 并提示用户手动同步。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `api/src/db/schema.ts` | 全部表结构变更（plan 核心数据结构） |
| 新建 | `api/drizzle/0001_*.sql` | schema 迁移（生成+手工回填 SQL） |
| 新建 | `api/src/db/migrate-data.ts` | 幂等数据迁移逻辑 |
| 修改 | `api/src/dev/routes.ts` | +migrate-p2、+seed-demo 路由 |
| 新建 | `api/src/dev/seed-demo.ts` | 雾影庄数据定义与创建逻辑 |
| 新建 | `api/src/agent/memory.ts` | 记忆可见性、检索、压缩查询 |
| 修改 | `api/src/agent/context.ts` | 默认世界查询改经 world_persons；记忆查询换 memory.ts |
| 修改 | `api/src/agent/tools.ts` | remember 加 importance |
| 新建 | `api/src/agent/engine-context.ts` | 引擎上下文装配 |
| 新建 | `api/src/agent/engine-prompt.ts` | 五种 step 提示词（JSON 输出指令） |
| 新建 | `api/src/engine/steps/types.ts` | AgentStep / StepExecutor / StepInput / StepOutput |
| 新建 | `api/src/engine/budget.ts` | 调用记账、每拍/每日上限、触顶 |
| 新建 | `api/src/engine/steps/schedule.ts` | 日程生成 |
| 新建 | `api/src/engine/steps/beat.ts` | 生活节拍 + 相遇检测 |
| 新建 | `api/src/engine/steps/dialogue.ts` | 对话轮转与结束 |
| 新建 | `api/src/engine/steps/injection.ts` | 注入事件反应 |
| 新建 | `api/src/engine/steps/summary.ts` | 记忆压缩 |
| 新建 | `api/src/engine/tick.ts` | tick 编排 |
| 新建 | `api/src/engine/routes.ts` | tick / status 路由 |
| 新建 | `api/src/worlds/queries.ts` | 快照/地点面板/人物详情/对话展开查询 |
| 新建 | `api/src/worlds/draft.ts` | Quick World 骨架生成 |
| 新建 | `api/src/worlds/routes.ts` | 世界服务路由 |
| 新建 | `api/src/worlds/stream.ts` | SSE 增量推送 |
| 新建 | `api/src/public/routes.ts` | 演示世界只读路由 |
| 修改 | `api/src/index.ts` | 挂载新路由 |
| 修改 | `api/src/home/routes.ts` | +运行中世界区块；personId 引用改造 |
| 修改 | `api/src/persons/routes.ts` | world.personId 引用改造 |
| 修改 | `api/src/timelines/routes.ts` | world.personId 引用改造 |
| 修改 | `api/.dev.vars.example` | +ENGINE_TICK_SECRET |
| 新建 | `scripts/migrate-p2.ts` | 数据迁移调用脚本 |
| 新建 | `scripts/seed-demo.ts` | 演示世界种子脚本 |
| 新建 | `scripts/engine-pinger.ts` | 节拍器 |
| 修改 | `package.json` | 新脚本；dev 三进程 |
| 修改 | `web/src/api/types.ts` | 世界相关类型 |
| 修改 | `web/src/api/client.ts` | worlds/public 接口 + SSE 订阅 |
| 新建 | `web/src/pages/WorldView.tsx` | 世界视图（owner/readonly 双态） |
| 新建 | `web/src/pages/Worlds.tsx` | 世界列表 |
| 新建 | `web/src/pages/WorldCreate.tsx` | Quick World 向导 |
| 新建 | `web/src/pages/DemoLanding.tsx` | 访客落地页 |
| 新建 | `web/src/components/world/LocationPanel.tsx` | 地点面板 |
| 新建 | `web/src/components/world/WorldEventFeed.tsx` | 事件流 |
| 新建 | `web/src/components/world/DialogueView.tsx` | 对话逐句+想法 |
| 新建 | `web/src/components/world/PersonDrawer.tsx` | 人物抽屉 |
| 新建 | `web/src/components/world/TimelineSwitcher.tsx` | 时间线切换+Fork |
| 新建 | `web/src/components/world/InjectBox.tsx` | 注入事件输入框 |
| 修改 | `web/src/App.tsx` | 路由（未登录→演示世界） |
| 修改 | `web/src/pages/Home.tsx` | +运行中的世界区块 |
| 修改 | `web/src/pages/PersonDetail.tsx` | 聊天文案改"打电话" |

## T1: schema 改造与迁移生成

**文件：** `api/src/db/schema.ts`、`api/drizzle/0001_*.sql`
**依赖：** 无
**步骤：**
1. worlds：新增 locationsJson/status/pauseReason/isDemo/callsToday/callsDay/createdAt 列，移除 personId 列
2. 新增 world_persons / schedules / dialogues / dialogue_turns / llm_call_log 五张表（字段按 plan 核心数据结构）
3. timelines 加 status/ancestorIdsJson/lastRealTickAt；personStates 加 currentDialogueId/lastBeatSimTime；memories 加 importance/summarized；events 加 kind/actorPersonId/dialogueId
4. `npm --workspace api run db:generate` 生成迁移
5. 手工编辑生成的迁移 SQL，在 DROP personId 之前插入回填语句：world_persons ← (worlds.id, worlds.personId)；timelines.status='active'、ancestorIdsJson 主线 `'[]'` 分叉 `json_array(parent_timeline_id)`；memories.importance=5、summarized=0；events.kind='action'、actorPersonId 经 timelines 关联 worlds.personId 回填；worlds.createdAt 回填当前时间
6. 备份本地 D1：复制 `api/.wrangler/state/v3/d1/` 整个目录到项目外临时位置
7. `npm run db:migrate` 应用迁移

**验证：** 迁移无报错；`SELECT (SELECT COUNT(*) FROM worlds) w, (SELECT COUNT(*) FROM world_persons) wp` 两数相等；`SELECT status, ancestor_ids_json FROM timelines LIMIT 3` 有值；`SELECT COUNT(*) FROM memories WHERE importance=5` 等于记忆总数

## T2: 数据迁移 dev 路由与脚本

**文件：** `api/src/db/migrate-data.ts`、`api/src/dev/routes.ts`、`scripts/migrate-p2.ts`、`package.json`
**依赖：** T1
**步骤：**
1. migrate-data.ts 实现幂等迁移：locationsJson 为空的旧世界填默认 3 地点（住所/附近的公园/常去的咖啡馆）；status 空→'paused'；callsToday→0、callsDay→今日；isDemo→0
2. dev/routes.ts 加 `POST /api/dev/migrate-p2`（仅 ENVIRONMENT=local），返回处理行数
3. scripts/migrate-p2.ts 仿 seed.ts 调用该路由；package.json 加 `"migrate:p2": "tsx scripts/migrate-p2.ts"`
4. 起 api，执行 `npm run migrate:p2` 两次

**验证：** 两次执行均成功（幂等）；`SELECT status, locations_json FROM worlds LIMIT 3` 有值；`npm --workspace api run build` 通过

## T3: 演示世界种子「雾影庄」

**文件：** `api/src/dev/seed-demo.ts`、`api/src/dev/routes.ts`、`scripts/seed-demo.ts`、`package.json`
**依赖：** T1, T2
**步骤：**
1. 按 spec 附录手写 6 个完整 PersonModel（全原创设定；relationships 层互相引用其余五人；悬念钩子写进 memories/boundaries/unknowns 层）
2. `POST /api/dev/seed-demo`（仅 local，按世界名幂等）：建世界（isDemo=1、status='running'、7 地点、附录描述）+ 6 人物 + world_persons + 主线 timeline（status='active'、ancestorIdsJson='[]'、simNow=当前真实 ISO 时间）+ 6 个 personStates（地点分散：大厅/书房/图书室/门房小屋/温室花房/餐厅；lastBeatSimTime=simNow）；世界 owner=admin（不存在则报错提示先跑 `npm run seed`）
3. scripts/seed-demo.ts + package.json `"seed:demo"`
4. 执行 `npm run seed:demo`

**验证：** `SELECT COUNT(*) FROM world_persons wp JOIN worlds w ON w.id=wp.world_id WHERE w.is_demo=1` 返回 6；`SELECT json_array_length(locations_json) FROM worlds WHERE is_demo=1` 返回 7；api build 通过

## T4: 记忆可见性与检索 `agent/memory.ts`

**文件：** `api/src/agent/memory.ts`
**依赖：** T1
**步骤：**
1. `visibleMemories(db, personId, timeline)`：解析 timeline.ancestorIdsJson，查询 `timeline_id IN (祖先链 ∪ {self, NULL主线}) 且 (created_at ≤ timeline.createdAt 或 timeline_id = self)`，按 createdAt 升序（NULL 主线行仅当主线 id 在祖先链中时可见——分叉场景）
2. `retrieveForPrompt(db, personId, timeline)`：从可见集排除 summarized=1，取近期 12 条 + 重要性 top 8 + 最新 2 条 type=summary，去重后按 simTime 升序
3. `needsSummary(db, personId, timelineId)`：summarized=0 且 type≠'summary' 的条数 > 40
4. `oldestUnsummarized(db, personId, timelineId, n=30)`：取最老 n 条待压缩

**验证：** api build 通过；用 d1 execute 手工插入跨时间线记忆，临时脚本调用 visibleMemories 验证分叉看不到分叉点之后的条目

## T5: context.ts 改造 + tools.ts importance

**文件：** `api/src/agent/context.ts`、`api/src/agent/tools.ts`
**依赖：** T4
**步骤：**
1. context.ts：`eq(worlds.personId, ...)` 改为经 world_persons 查默认世界（joinedAt 最早的世界）；记忆查询替换为 `visibleMemories`；导出签名不变
2. tools.ts：REMEMBER_TOOL 参数加 importance（integer 1-10，可选）；remember 执行器写库带 importance（缺省 5，超出范围钳制）
3. api build 通过
4. 起 api，admin 登录，给阶段一人物发一条聊天消息（中文写临时 JSON 文件，`--data-binary @file`），SSE 流式回复正常

**验证：** 聊天回归正常（既有行为不破）；新写入的记忆行 importance 有值

## T6: 引擎上下文 `agent/engine-context.ts`

**文件：** `api/src/agent/engine-context.ts`
**依赖：** T4
**步骤：**
1. 定义 `WorldSnapshot` 类型（world+locations、timeline、persons 清单及各 personState、当日 schedules 映射）
2. `buildEngineContext(db, personId, timelineId)`：人物+模型、世界与地点、同世界其他人物（姓名 + identity 前 2 条 known + 与我的 relationship 记忆）、自身 personState、当日 schedule、retrieveForPrompt 记忆集、未感知注入事件（kind='injected' 且 simTime > lastBeatSimTime）、同地点清醒人物列表
3. `isAwake(scheduleItems, simNow)`：当前项 kind≠'sleep'（日程项结构加可选 kind 字段）

**验证：** api build 通过

## T7: 引擎提示词 `agent/engine-prompt.ts`

**文件：** `api/src/agent/engine-prompt.ts`
**依赖：** T6
**步骤：**
1. 公共段：人设（复用 prompt.ts 分层结构）+ 世界/地点/同世界人物 + 当前状态/当日日程 + 记忆（检索集）
2. schedule 指令：输出 `{"items":[{"start","end","location","activity","kind"?}]}`，6-10 项覆盖清醒时段，地点必须来自世界地点列表，睡眠项标 kind='sleep'
3. beat / injection 指令：输出 `{"events":[{"title","description","offsetMin"}],"thought","memory":{"content","type","importance"}?,"nextLocation"?,"nextActivity"?,"mood"?,"goal"?}`；injection 额外包含注入事件原文
4. dialogue_turn 指令：输出 `{"utterance","thought","shouldEnd","memory":{"content","importance"}?}`；末轮必须给 memory
5. summary 指令：输入老记忆列表，输出 `{"content","importance"}`（一段第三人称摘要）
6. 全部指令声明「只输出 JSON」，并附 extractJson 复用说明

**验证：** api build 通过

## T8: step 类型与预算 `steps/types.ts` + `engine/budget.ts`

**文件：** `api/src/engine/steps/types.ts`、`api/src/engine/budget.ts`
**依赖：** T6
**步骤：**
1. types.ts：按 plan 定义 AgentStep / StepExecutor / StepInput / StepOutput（StepInput/Output 用联合类型按 kind 区分载荷）
2. budget.ts：`recordCall(db, {worldId, timelineId, personId, purpose})`——写 llm_call_log + worlds.callsToday+1（callsDay≠今日则先清零）；`tickBudgetOk(world, n)`（每拍 ≤8）；`dailyCapHit(world)`（≥400）；常量从 env 读、缺省 WORLD_SPEED=6 / TICK_CALL_CAP=8 / DAILY_CALL_CAP=400
3. 触顶动作 `capWorld(db, worldId)`：status='capped'、pauseReason='daily_cap'

**验证：** api build 通过

## T9: step 执行器 schedule

**文件：** `api/src/engine/steps/schedule.ts`
**依赖：** T7, T8
**步骤：**
1. perceive：人物当前世界日（由 simNow 得）无 schedules 行 → 组装 StepInput（engineContext）
2. decide：`complete(config, messages, {maxTokens: 8000})` → extractJson → 校验：6-10 项、时间升序不重叠、地点 ∈ 世界地点（不在则替换为首个地点）；失败重试一次
3. act：写 schedules 行（worldDate、itemsJson、generatedAt=simNow）

**验证：** api build 通过

## T10: step 执行器 beat（含相遇检测）

**文件：** `api/src/engine/steps/beat.ts`
**依赖：** T7, T8
**步骤：**
1. perceive：日程项刚结束、currentDialogueId 为空、清醒 → 相遇检测：同地点存在其他清醒人物（无 currentDialogueId、双方最近一次 ended 对话 simEnd ≥2 虚拟小时前或无）→ 返回 encounter 输入
2. encounter 分支 act（不调 LLM、不记账）：建 dialogues（ongoing、turnLimit=8、participantIdsJson=[发起者, 对方]）、双方 currentDialogueId 置位、写 events(kind='dialogue', title="A 与 B 在 X 开始了交谈", dialogueId)
3. solo 分支 decide：`complete`（8000）→ beat JSON；act：写 events（kind='action'，可多条，simTime=基准+offsetMin）、thought 记忆（type='thought'、importance=5）、可选 memory（带 importance）、更新 personStates（nextLocation/nextActivity/mood/goal、lastBeatSimTime=simNow）

**验证：** api build 通过

## T11: step 执行器 dialogue_turn

**文件：** `api/src/engine/steps/dialogue.ts`
**依赖：** T7, T8
**步骤：**
1. perceive：ongoing 对话 + 已有 turns → 确定本轮发言者（participantIds[turnIndex % 人数]）；装入发言者上下文 + 已有对话记录
2. decide：`complete`（4000）→ {utterance, thought, shouldEnd, memory?}
3. act：写 dialogue_turns（utterance+thought）+ thought 同步写 memories（type='thought'、importance=5）；有 memory 则写记忆（带 importance）
4. 结束条件（turnIndex+1 ≥ turnLimit 或 shouldEnd 且双方均已发言 ≥2 轮）：dialogues 置 ended/simEnd、双方 currentDialogueId 清空、更新事件 title 为"A 与 B 在 X 交谈"；否则 turnIndex+1 落库
5. decide 失败重试一次后：本轮以占位句跳过（utterance="……（沉默）"），不阻塞对话

**验证：** api build 通过

## T12: step 执行器 injection 与 summary

**文件：** `api/src/engine/steps/injection.ts`、`api/src/engine/steps/summary.ts`
**依赖：** T10
**步骤：**
1. injection：perceive 取 simTime > 人物 lastBeatSimTime 的 kind='injected' 事件；decide 用 injection 提示词（8000）；act 复用 beat 的 act + lastBeatSimTime 推进到注入事件 simTime
2. summary：perceive=oldestUnsummarized(30)；decide（12000）→ {content, importance}；act 写 summary 记忆 + 原文批量置 summarized=1

**验证：** api build 通过

## T13: tick 编排 `engine/tick.ts`

**文件：** `api/src/engine/tick.ts`
**依赖：** T8–T12
**步骤：**
1. `runTick(env, db)`：查 status='running' 的 worlds × status='active' 的 timelines
2. 时钟：lastRealTickAt 为 null → 仅置位；否则 advance = min(真实经过, 150s) × WORLD_SPEED，simNow += advance
3. 机械日程：逐人物对照当日 items，simNow 越过当前项 end → 切下一项（更新 location/activity，写 personStates；零 LLM 零记账）
4. 决策点收集（P1 对话轮转 → P2 injection → P3 beat → P4 schedule → P5 summary），逐世界按序执行，decide 前查 tickBudgetOk，不足则剩余留下拍
5. 每次 decide 成功执行后 recordCall；dailyCapHit → capWorld 并停止该世界本拍
6. 回写 timelines.simNow/lastRealTickAt；返回摘要 `{worlds: [{id, timelines: [{id, simNow, steps: [{kind, personId, ok}]}]}]}`

**验证：** api build 通过

## T14: 引擎路由 + 节拍器

**文件：** `api/src/engine/routes.ts`、`api/src/index.ts`、`scripts/engine-pinger.ts`、`package.json`、`api/.dev.vars.example`
**依赖：** T13
**步骤：**
1. `POST /api/engine/tick`：校验 `x-engine-secret` 头 === env.ENGINE_TICK_SECRET（否则 403）→ runTick → 返回摘要
2. `GET /api/engine/status`：authMiddleware，返回各世界（含 demo）simNow/lastRealTickAt/callsToday/status/pauseReason
3. `.dev.vars.example` 加 `ENGINE_TICK_SECRET=`（注释提示：本地随机串，需同步到 .dev.vars）——**告知用户手动复制，不替用户写 .dev.vars**
4. scripts/engine-pinger.ts：读 env ENGINE_TICK_SECRET（process.env），每 15s 串行 POST（fetch 超时 300s），打印每拍摘要
5. package.json：`"dev:engine": "tsx scripts/engine-pinger.ts"`；dev 改三进程 `-n web,api,engine`
6. index.ts 挂载 engineRoutes

**验证：** 未设密钥时 pinger 收到 403（鉴权生效）；api build 通过

## T15: 引擎冒烟验证（里程碑）

**文件：** 无（纯验证）
**依赖：** T14, T3
**步骤：**
1. 用户同步 ENGINE_TICK_SECRET 到 .dev.vars 后，`npm run dev` 起三进程
2. 观察 10 分钟：pinger 日志每拍有摘要；`GET /api/engine/status`（带 admin token）雾影庄 simNow 推进 ≈6 倍速
3. d1 查 `SELECT COUNT(*) FROM schedules`：6 人生成当日日程
4. d1 查 events/memories(type='thought') 随时间增长
5. 加速验证相遇：`UPDATE person_states SET location='大厅' WHERE person_id IN (两人)`，等 2-3 拍，查 dialogues/dialogue_turns 有行、对话逐轮增长
6. 查 `SELECT COUNT(*) FROM llm_call_log` 与 worlds.callsToday 一致增长

**验证：** 以上全部观察到；若 LLM 返回 JSON 解析失败，回到 T7/T9-T12 修提示词或解析容错

## T16: 世界查询 `worlds/queries.ts`

**文件：** `api/src/worlds/queries.ts`
**依赖：** T1
**步骤：**
1. `worldSnapshot(db, worldId, timelineId?)`：世界+全部时间线（含 status）+当前线 simNow+地点面板（每地点在场人物姓名/活动）+近 1 世界日事件（kind='dialogue' 的带前 2 句预览）
2. `personFocus(db, worldId, personId, timelineId)`：personState、想法流（type='thought' 倒序 50 条）、当日 schedule、近期非 thought 记忆 20 条
3. `dialogueDetail(db, dialogueId)`：dialogue + 全部 turns（含每句 thought 与说话人姓名）

**验证：** api build 通过

## T17: 世界服务（创建/列表/暂停/继续）

**文件：** `api/src/worlds/draft.ts`、`api/src/worlds/routes.ts`、`api/src/index.ts`
**依赖：** T16
**步骤：**
1. draft.ts：`POST /api/worlds/draft`——一句话描述 → `complete`（8000）→ {name, description, locations[5-8]}，不落库；解析失败重试一次
2. routes.ts：`POST /api/worlds`——校验人物 1-6 个且归属本人 → 建世界（running）+ world_persons + 主线 + 初始 personStates（地点轮转分配）→ 返回 id
3. `GET /api/worlds`：本人世界列表（名称/status/simNow/人物数/callsToday）
4. `POST /api/worlds/:id/pause`（status→paused、pauseReason='manual'）、`POST /api/worlds/:id/resume`（→running、pauseReason=null、callsToday=0 视为手动复位）
5. 全部路由 authMiddleware + `eq(worlds.userId, userId)` 归属校验

**验证：** api build 通过；curl 建草案（中文写文件 --data-binary）返回骨架 JSON

## T18: 世界介入（inject / fork / archive）

**文件：** `api/src/worlds/routes.ts`
**依赖：** T17
**步骤：**
1. `POST /api/worlds/:id/inject`：{text} → 写 events(kind='injected', simTime=当前线 simNow, title=text 前 20 字, description=text) → 返回事件 id
2. `POST /api/worlds/:id/timelines/:tid/fork`：校验该世界 active 线 <3（否则 409 提示先归档）→ 建新线（parentTimelineId=tid、ancestorIdsJson 追加、simNow=tid.simNow、status='active'、forkScenarioJson 可空）→ 复制 personStates（currentDialogueId=null）与当日 schedules → 返回新线 id
3. `POST /api/timelines/:id/archive`：status→'archived'；若归档后该世界 active=0 则拒绝（400）
4. 归属校验同 T17

**验证：** api build 通过；curl 冒烟：fork 后 `SELECT COUNT(*) FROM timelines WHERE world_id=? AND status='active'` =2；第 4 条 fork 返回 409

## T19: SSE 增量推送 `worlds/stream.ts`

**文件：** `api/src/worlds/stream.ts`
**依赖：** T16
**步骤：**
1. `GET /api/worlds/:id/stream?timelineId=`：authMiddleware + 归属校验
2. streamSSE 循环：每 2s 查增量——新 events（rowid > 游标）、进行中对话的新 turns、personStates 变化（对比 updatedRealAt）、timeline.simNow/callsToday/status → writeSSE；15s 无数据发心跳；客户端断开退出循环
3. 事件载荷带 kind/actorPersonId/dialogueId，便于前端分样式渲染

**验证：** `curl -N -H "Authorization: Bearer TOKEN" "http://localhost:8787/api/worlds/WID/stream?timelineId=TID"` 持续收到推送（引擎运行中 2s 内可见新事件）

## T20: 公共只读路由 `public/routes.ts`

**文件：** `api/src/public/routes.ts`、`api/src/index.ts`
**依赖：** T16, T19
**步骤：**
1. 无 authMiddleware；`loadDemoWorld(db, id)`：is_demo=1 否则 404
2. `GET /api/public/demo`：返回首个 is_demo=1 世界的 id+名称+描述（落地页入口）
3. `GET /api/public/worlds/:id`（worldSnapshot）、`GET /api/public/worlds/:id/persons/:pid`（personFocus）、`GET /api/public/dialogues/:id`（dialogueDetail）
4. `GET /api/public/worlds/:id/stream`：复用 T19 推送逻辑（跳过 auth，强制 demo 校验）
5. 该路由文件不注册任何 POST/PUT/DELETE

**验证：** 无 token curl 快照成功；`curl -X POST /api/public/...` 404；public 路由访问非 demo 世界 id → 404

## T21: 既有路由 personId 引用改造

**文件：** `api/src/persons/routes.ts`、`api/src/timelines/routes.ts`、`api/src/home/routes.ts`、`api/src/index.ts`
**依赖：** T5, T17, T20
**步骤：**
1. persons/routes.ts GET /:id：`eq(worlds.personId, ...)` 改经 world_persons 查默认世界
2. timelines/routes.ts GET /timelines/:id：person 查询改经 world_persons
3. home/routes.ts：r.world.personId 改 world_persons；返回加 worlds 区块（运行中世界：名称/status/simNow/人物数/今日事件数）
4. index.ts 确认挂载 worldsRoutes/publicRoutes/engineRoutes

**验证：** api build 通过；阶段一页面回归：首页/人物详情/时间线详情接口返回正常

## T22: 前端 API 层

**文件：** `web/src/api/types.ts`、`web/src/api/client.ts`
**依赖：** T17–T20（接口形状确定）
**步骤：**
1. types.ts：World/LocationDef/TimelineInfo/WorldSnapshot/LocationBoardEntry/WorldEvent/DialogueDetail/PersonFocus/EngineStatus/DemoInfo
2. client.ts：draft/createWorld/listWorlds/worldSnapshot/pause/resume/inject/fork/archiveTimeline/personFocus/dialogueDetail（带 token）；publicDemo/publicSnapshot/publicPersonFocus/publicDialogue（不带 token）
3. `subscribeWorldStream(worldId, timelineId, handlers, {public: boolean})`：复用既有 SSE 读取封装，按事件类型分发（event/dialogue_turn/state/clock/status）
4. token 从既有存储读取；public 函数不附带

**验证：** `npm --workspace web run build` 通过

## T23: WorldView 与世界组件族

**文件：** `web/src/pages/WorldView.tsx`、`web/src/components/world/*.tsx`
**依赖：** T22
**步骤：**
1. WorldView（props: worldId, readonly, api 命名空间 owner/public）：挂载取快照 → 订阅流 → 增量合并
2. 顶栏：世界名、世界时钟（快照 simNow + 流更新 + 本地 ×6 插值平滑）、status 徽章、callsToday；owner 模式加 暂停/继续 按钮与 InjectBox、TimelineSwitcher（含 Fork）
3. LocationPanel：每地点卡片列出在场人物（可点击）与活动
4. WorldEventFeed：按 kind 分样式（action 普通 / dialogue 可展开前两句 / injected 高亮 / system 灰显）；点开 dialogue → DialogueView（逐句+每句想法折叠显示）
5. PersonDrawer：状态卡（地点/活动/情绪/目标）、想法流 Tab、今日日程 Tab、记忆摘要 Tab
6. readonly 模式隐藏一切写控件

**验证：** web build 通过

## T24: Worlds 列表与 WorldCreate 向导

**文件：** `web/src/pages/Worlds.tsx`、`web/src/pages/WorldCreate.tsx`
**依赖：** T22
**步骤：**
1. Worlds：世界卡片（名称/描述/status 徽章/simNow/人物数/callsToday）+ 点击进入 WorldView + 「创建世界」入口
2. WorldCreate 三步：① 一句话描述 → draft ② 骨架编辑（名称/背景/地点增删改，5-8 校验）③ 勾选 1-6 人物（来自既有 GET /persons）→ 提交创建 → 跳转 WorldView

**验证：** web build 通过

## T25: DemoLanding、路由与 Home 区块

**文件：** `web/src/pages/DemoLanding.tsx`、`web/src/App.tsx`、`web/src/pages/Home.tsx`、`web/src/pages/PersonDetail.tsx`
**依赖：** T23
**步骤：**
1. DemoLanding：publicDemo() 拿演示世界 → WorldView readonly + 顶部「登录以创建你的世界」入口
2. App.tsx：未登录 `/` → DemoLanding（不再跳 Login）；登录态路由加 `/worlds`、`/worlds/new`、`/worlds/:id`
3. Home.tsx：加「运行中的世界」区块（卡片：名称/status/simNow/今日事件数 → 链 WorldView）
4. PersonDetail.tsx：聊天入口文案改「打电话」

**验证：** web build 通过

## T26: 前端浏览器联调

**文件：** 无（纯验证）
**依赖：** T23, T24, T25, T15
**步骤：**
1. `npm run dev` 三进程运行，preview 打开；admin 登录
2. 走 Quick World 全流程：描述 → 骨架 → 选 3 人 → 创建 → 世界视图人物开始生活
3. 世界视图观察 ≥5 分钟：时钟走动、事件流增长、地点面板人物活动变化
4. 点人物 → 抽屉四 Tab 内容正常；点对话事件 → 逐句展开
5. 注入「突然下起暴雨」→ 2-3 拍内事件流出现注入事件与人物反应
6. Fork → 时间线切换器出现新线，两线时钟都在走；暂停 → 时钟停走；继续 → 恢复
7. 浏览器 console 无报错

**验证：** 以上全部观察到（preview_screenshot 留证）

## T27: 访客视角与安全验证

**文件：** 无（纯验证）
**依赖：** T25, T20
**步骤：**
1. 无痕窗口打开 `/` → 直接进入演示世界只读视图：地点/事件流/对话/人物想法可见；无注入/Fork/暂停控件；无登录跳转
2. `curl -X POST http://localhost:8787/api/worlds/WID/inject`（无 token）→ 401
3. `curl http://localhost:8787/api/worlds/WID`（无 token，WID 为私人世界）→ 401
4. `curl http://localhost:8787/api/public/worlds/WID`（WID 为私人世界）→ 404
5. `curl -X POST http://localhost:8787/api/engine/tick`（无密钥头）→ 403

**验证：** 全部符合预期

## 执行顺序

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14
                                                                        ↓
T26 ← T23 ∥ T24 ∥ T25 ← T22 ← T21 ← T20 ← T19 ← T18 ← T17 ← T16 ← T15（冒烟里程碑）
 ↓
T27
```

- T1–T3：数据层就绪（schema、迁移、演示世界）
- T4–T14：引擎构建；T15 冒烟是硬里程碑——不过不进后端 API 阶段
- T16–T21：世界服务与只读服务
- T22–T25：前端（T23/T24/T25 可并行）
- T26–T27：联调与访客安全验证
