# s01｜全局验收收口 Tasks

> 依据：[spec.md](./spec.md) 与已批准的 [plan.md](./plan.md)。四份规格文档全部获批前不修改实现代码。远端 D1、部署和真实模型调用分别需要执行时的明确授权。

## 执行状态

任务只有在对应验证命令产生通过证据后才能标记完成。当前状态：

| 范围 | 状态 | 最近验证证据 |
|---|---|---|
| T01–T28 | 已完成 | 迁移、独立重建、legacy 分级、聊天恢复、模型合同和知识矩阵的定向测试及构建已通过。 |
| T29 | 已完成 | `tick.test.ts`、`world-journey.test.ts`、`llm/client.test.ts`：3 文件 20 项通过；API build 通过。 |
| T30 | 已完成 | 人类模型入口 incomplete/paused/capped/archived 门禁矩阵 5/5；关联路由 41/41；API build 通过。 |
| T31 | 已完成 | 内部 tick/director/schedule/beat/dialogue/injection/summary 矩阵与 guard/tick：3 文件 21 项通过。 |
| T32 | 已完成 | 管理写入、安全冻结、记忆及承诺矩阵：7 文件 37 项通过；API build 通过。 |
| T33 | 已完成 | 世界 SSE envelope 定向测试与 public route 回归：2 文件 3 项通过；API build 通过。 |
| T34–T35 | 已完成 | SSE parser、stream guard、WorldView 代次守卫：3 文件 11 项通过；Web build 通过。 |
| T36 | 已完成 | Evidence 只读提示与交互禁用接入；WorldView 7/7、API/Web build 通过。 |
| T37 | 已完成 | `npm run verify:s01:legacy`：3 个隔离数据库分类，升级 1 个、拒绝 incomplete 写入；unassessed/upgradeable 均为 0。 |
| T38 | 已完成 | `npm run verify:s01:workers` 退出码 0：双 Worker 聊天 pending/completed replay、载荷冲突、取消、过期接管及消息/回执账本通过；固定 provider 3 次。 |
| T39 | 已完成 | 延迟 SSE 分片夹具及 timeline generation 守卫回归包含在 Web 全量测试中；切线后旧 payload 不得改变 URL/timeline/version/events。 |
| T40–T41 | 已完成 | 最终 API 46 文件/344 项、Web 6 文件/20 项通过；API 与 Web production build 通过；legacy 与本地双 Worker 验收通过。 |
| T42 | 已完成 | 两个独立浏览器 profile 完成 owner-scoped pending 恢复；真实浏览器另用产品 `subscribeWorldStream` 与原生分片流释放旧时间线 SSE 半帧，旧事件被 generation guard 丢弃，新线 URL/version/event 保持不变。 |
| T43 | 已完成 | 远端迁移/Worker 脚本及 live-model 脚本 `node --check` 通过；配置严格校验测试目标名称与 database ID。 |
| T44 | 已完成 | staging 22/22 migrations、双 Worker 聊天/24 路 Fork/lease fencing 和 Root→Child→Grandchild 取消/故障恢复通过；最终 D1 只读审计无 pending、synthetic active timeline 或 lease。 |
| T45 | 已完成 | live-model 脚本硬上限 8、无自动重试，脱敏输出及 leave/re-enter 持久记忆检查；API build 通过。 |
| T46 | 已完成 | 一轮真实模型验收使用 4/8 次调用；隐私隔离、rumor certainty、连续记忆及重新进入恢复断言全通过，自动重试 0。 |
| T47 | 已完成 | Checklist、审计与质量报告已同步；原 AC01–AC15 均有实际通过证据，AC09 明确保留 `incomplete/read-only` 而不补造历史。 |
| T48 | 已完成 | 84 个已跟踪改动与新增文件逐项核对均属于已批准 S01 范围；全量回归、构建、差异检查和凭据扫描通过，创建单一逻辑提交且未推送。 |
| T49 | 已完成 | 在产品旅程和 24 小时全日旅程后分别对 Root/Child/Grandchild 执行不可变 reducer 重放；定向测试通过，纳入 API 全量 327 项。 |
| T50 | 已完成 | 内部权限矩阵新增 unassessed/upgradeable 证据拒绝及跨用户 lifecycle 管理拒绝/零副作用；`policy-matrix.test.ts` 12/12。 |
| T51 | 已完成 | 用户追加授权后，修复隔离 baseline 与状态事实分类；最终真实旅程 8 个 tick、4 个真实 beat 回执全部完成且无重试，fresh context 可重建，独立重放 complete 且零差异。 |
| T52 | 已完成 | 19 类命令/恢复组合重放、真实浏览器旧 SSE 半帧、完整权限矩阵和真实模型多渠道/无效输出恢复全部通过；最终真实模型轮次 8 次、零自动重试，本授权窗口累计 24/50。 |

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `api/drizzle/0020_dizzy_hannibal_king.sql`、`api/drizzle/meta/0020_snapshot.json` | 完善普通聊天请求状态、归属、heartbeat 和终态字段。 |
| 新建 | Drizzle 生成的 `api/drizzle/0021_*.sql` 及 meta 快照 | Universe evidence、模型调用回执字段和数据库 fencing。 |
| 修改 | `api/src/db/schema.ts`、`api/src/db/migrate-data.ts` | 新表/字段及 legacy 分类迁移入口。 |
| 新建 | `api/src/world-state/evidence.ts`、`projector.ts`、`classification.ts` | 证据收集、纯重建和分级。 |
| 修改 | `api/src/world-state/model.ts`、`rebuild.ts`、`invariants.ts`、`rules.ts`、`commit.ts`、`query.ts` | 重建编排、纯规则、最终门禁和读取状态。 |
| 新建/修改 | `api/src/world-state/*.test.ts`、`api/src/test/legacy-classification.test.ts` | 全域 reducer、差异诊断、分类与升级故障测试。 |
| 修改 | `api/src/engine/guard.ts`、`budget.ts`、`tick.ts`、`routes.ts`、`director-llm.ts`、`steps/*.ts` | 统一门禁、调用回执、模型合同及内部路径覆盖。 |
| 新建 | `api/src/engine/policy-matrix.test.ts` | 内部引擎和管理权限×预算矩阵。 |
| 新建/修改 | `api/src/llm/contracts.ts`、`contracts.test.ts`、`client.ts` | 完成帧、结构、知识和业务合同。 |
| 新建/修改 | `api/src/agent/knowledge.ts`、`knowledge.test.ts`、`visibility.ts`、`context.ts`、`engine-context.ts`、`loop.ts` | 多跳知识来源与模型上下文边界。 |
| 新建/修改 | `api/src/chat/requests.ts`、`routes.ts`、`routes.test.ts`、`recovery.test.ts` | 普通聊天持久请求状态机和 API。 |
| 修改 | `api/src/worlds/routes.ts`、`queries.ts`、`stream.ts`、`api/src/life/fork.ts`、`compare.ts` | evidence 状态、Fork 与 SSE envelope。 |
| 修改 | `api/src/scene/routes.ts`、`chapters/routes.ts`、`memories/routes.ts`、`persona/routes.ts`、`timelines/routes.ts` | 统一 Universe 门禁和模型合同。 |
| 新建/修改 | `api/src/test/knowledge-journey.test.ts`、`product-journey.test.ts`、`world-journey.test.ts` | 多渠道知识和完整产品旅程。 |
| 修改 | `web/src/api/client.ts`、`types.ts` | Chat request、evidence 和 stream envelope 契约。 |
| 新建 | `web/src/lib/sseParser.ts`、`streamGuard.ts` 及对应测试 | SSE 分片解析与订阅代次守卫。 |
| 新建/修改 | `web/src/components/world/EvidenceNotice.tsx`、`PersonDrawer.tsx`、`TimelineSwitcher.tsx`、`web/src/components/ChatStream.tsx` | legacy 只读提示与聊天恢复 UI。 |
| 修改 | `web/src/pages/WorldView.tsx`、`PersonDetail.tsx`、`WorldView.test.tsx` | evidence 操作边界和 SSE 归属。 |
| 新建/修改 | `scripts/verify-s01-legacy.ts`、`verify-s01-workers.ts`、`verify-s01-remote-workers.ts`、`verify-s01-remote-journey.ts`、`verify-s01-live-model.ts`、`scripts/fixtures/s01-stream-delay.ts` | 本地、远端、真实模型和传输故障验收。 |
| 修改 | `package.json` | 新增可复核验收命令。 |
| 修改 | `docs/current-state-audit.md`、`docs/world-quality-report.md`、`spec_docs/s01/checklist.md` | 实际证据和全局出口状态。 |

## T01｜冻结本轮基线与改动归属

**文件：** 无实现修改；结果记录到 `docs/current-state-audit.md` 的待执行区。
**依赖：** 无。

**步骤：**
1. 记录 HEAD、分支和完整 `git status --short`。
2. 保存 29 项既有改动的文件级 diff 摘要，区分 P4/远端补充、聊天请求雏形和本轮文档。
3. 标记禁止覆盖的用户改动；确认后续任务只触及计划列出的重叠区域。

**验证：** `git diff --check` 通过；审计中记录的文件数与 `git status --short` 一致。

## T02｜完善普通聊天请求 schema

**文件：** `api/src/db/schema.ts`、`api/drizzle/0020_dizzy_hannibal_king.sql`、`api/drizzle/meta/0020_snapshot.json`。
**依赖：** T01。

**步骤：**
1. 将请求表改为保存完整归属、内容摘要、预定消息 ID、heartbeat、终态时间和错误码。
2. 不重复保存聊天正文；保留必要外键和唯一性约束。
3. 校对 SQL、schema 和 snapshot 一致。

**验证：** `npm --workspace api run build` 通过；新建隔离 D1 应用 0000–0020 成功。

## T03｜增加 Universe evidence 与调用回执迁移

**文件：** `api/src/db/schema.ts`、新生成的 `api/drizzle/0021_*.sql`、`api/drizzle/meta/_journal.json` 及 snapshot。
**依赖：** T02。

**步骤：**
1. 新增 `universe_evidence` 表和索引。
2. 扩展 `llm_call_log` 的请求关联、上下文摘要、合同版本、状态、错误码和完成时间。
3. 新增聊天迟到 reply fencing 触发器。

**验证：** 全新隔离 D1 迁移成功；`npm --workspace api run build` 通过。

## T04｜增加迁移兼容夹具

**文件：** `api/src/test/legacy-migration.test.ts`。
**依赖：** T02–T03。

**步骤：**
1. 构造 0020 前数据库并应用新迁移。
2. 比较旧世界、时间线、消息和调用账本内容未被改写。
3. 断言旧时间线进入 fail-closed 证据状态且无未分类写权限。

**验证：** `npm --workspace api run test -- src/test/legacy-migration.test.ts` 通过。

## T05｜拆分只读证据收集器

**文件：** `api/src/world-state/evidence.ts`、`api/src/world-state/rebuild.ts`。
**依赖：** T03。

**步骤：**
1. 将基线、命令、事实读取移入 `collectReplayInput`。
2. 将当前投影读取移入 `readCurrentProjection`。
3. 使两种结果类型无法相互引用。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts` 通过。

## T06｜建立纯投影器骨架

**文件：** `api/src/world-state/projector.ts`、`api/src/world-state/model.ts`。
**依赖：** T05。

**步骤：**
1. 定义 `ReplayInput`、`RebuiltProjection`、diagnostic 和标准化函数。
2. 从完整 Root/Fork 基线创建内存投影。
3. 拒绝缺基线、不连续版本和未知动作。

**验证：** 新增 projector 测试验证相同输入得到字节稳定的标准化结果。

## T07｜实现时钟与人物状态 reducer

**文件：** `api/src/world-state/projector.ts`、`rules.ts`、projector 测试。
**依赖：** T06。

**步骤：**
1. 重放 clock、enter、move、resident state、simulation checkpoint 和 dialogue recovery。
2. 保持模拟时间、位置、活动、心情、目标和水位线一致。
3. 对错时间线、错版本和冲突地点产生明确诊断。

**验证：** 定向 projector 测试覆盖正常重放及每类篡改。

## T08｜实现日程与事件 reducer

**文件：** `api/src/world-state/projector.ts`、`rules.ts`、projector 测试。
**依赖：** T07。

**步骤：**
1. 重放 schedule set、主事件和 resident state 派生事件。
2. 使用命令 ID 生成与在线提交一致的确定性记录 ID。
3. 检测缺失、额外和正文不一致事件。

**验证：** 定向测试覆盖空日程、跨日程变化和多事件动作。

## T09｜实现承诺 reducer

**文件：** `api/src/world-state/projector.ts`、`rules.ts`、projector 测试。
**依赖：** T08。

**步骤：**
1. 重放提议、接受、拒绝、履约、失约、过期和解释。
2. 重建承诺派生关系记忆和居民心情变化。
3. 检测非法状态跃迁和错误来源对话。

**验证：** `npm --workspace api run test -- src/life/commitment-journey.test.ts` 与 projector 承诺测试通过。

## T10｜实现对话与发言 reducer

**文件：** `api/src/world-state/projector.ts`、`rules.ts`、projector 测试。
**依赖：** T09。

**步骤：**
1. 重放 NPC dialogue start/turn/end、scene open 和 conversation。
2. 重建 dialogue、turn、人物占用及关闭后的水位线。
3. 检测 turn index、参与者、地点和状态不一致。

**验证：** projector 对话测试和 `api/src/world-state/commit.test.ts` 定向用例通过。

## T11｜实现记忆与留言 reducer

**文件：** `api/src/world-state/projector.ts`、`rules.ts`、projector 测试。
**依赖：** T10。

**步骤：**
1. 重建 thought、relationship、timeline/world memory 和 persona message。
2. 重放 summary、correct、forget 及 summarized 标志。
3. 检测来源命令、人物和摘要集合不一致。

**验证：** projector 记忆测试及 `npm --workspace api run test -- src/agent/memory.test.ts src/memories/routes.test.ts` 通过。

## T12｜实现知识 reducer 与来源链

**文件：** `api/src/world-state/projector.ts`、`api/src/agent/knowledge.ts`、`api/src/agent/knowledge.test.ts`。
**依赖：** T11。

**步骤：**
1. 重建 knowledge facts 并解析 `sourceFactId` 链。
2. 强制接收者可见性和 certainty 单调不升级。
3. 检测环、断链、跨线来源和无权引用。

**验证：** `npm --workspace api run test -- src/agent/knowledge.test.ts` 通过。

## T13｜完成逐域比较与诊断

**文件：** `api/src/world-state/projector.ts`、`rebuild.ts`、`invariants.ts`、`rebuild.test.ts`。
**依赖：** T07–T12。

**步骤：**
1. 用独立 reducer 结果替代当前审计中的投影推断。
2. 每个域报告 missing、extra、mismatch、unsupported、unproven、wrong version/timeline。
3. 验证审计前后源表快照相同。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts src/world-state/invariants.test.ts` 通过。

## T14｜实现 Universe 分类器

**文件：** `api/src/world-state/classification.ts`、`api/src/test/legacy-classification.test.ts`。
**依赖：** T13。

**步骤：**
1. 实现 complete、upgradeable、incomplete 判定及机器原因码。
2. 只将能唯一补齐的结构判为 upgradeable。
3. 覆盖 Root、Child、Grandchild 和缺 checkpoint legacy 数据。

**验证：** `npm --workspace api run test -- src/test/legacy-classification.test.ts` 通过。

## T15｜实现 Legacy 升级服务

**文件：** `api/src/world-state/classification.ts`、`api/src/db/migrate-data.ts`、分类测试。
**依赖：** T14。

**步骤：**
1. 生成带来源的最小升级计划。
2. 事务内写入、复审并切换 evidence 状态。
3. 注入升级中途失败，确认数据与状态整体回滚。

**验证：** legacy classification/migration 测试全部通过。

## T16｜为新建与 Fork 原子写 evidence

**文件：** `api/src/worlds/routes.ts`、`api/src/life/fork.ts`、相关创建/Fork 测试。
**依赖：** T03、T14。

**步骤：**
1. 新建主线事务写 `complete` evidence。
2. Fork 事务依据自身 checkpoint 写 `complete` evidence。
3. 注入 evidence 写失败，确认 Universe 创建/Fork 不留半成品。

**验证：** `npm --workspace api run test -- src/test/product-journey.test.ts src/life/compare.test.ts` 通过。

## T17｜将 evidence 状态加入读取契约

**文件：** `api/src/world-state/query.ts`、`api/src/worlds/queries.ts`、`api/src/life/compare.ts`、相关测试。
**依赖：** T14–T16。

**步骤：**
1. 世界快照、人物焦点和 Compare 返回 evidence level 与原因码。
2. 不向公共响应泄露私有诊断正文。
3. legacy 读取保持可用且不声称完整。

**验证：** public、legacy compatibility 和 Compare 定向测试通过。

## T18｜实现统一 Universe 写入门禁

**文件：** `api/src/engine/guard.ts`、`api/src/world-state/commit.ts`、`guard.test.ts`。
**依赖：** T14。

**步骤：**
1. 实现 `gateUniverseWrite` 和 `requireWritableUniverse`。
2. 将 evidence 检查放在预算预留前。
3. 在 `commitWorldCommand` 增加最终 evidence 检查。

**验证：** `npm --workspace api run test -- src/engine/guard.test.ts src/world-state/commit.test.ts` 通过。

## T19｜门禁引擎与生命周期路径

**文件：** `api/src/engine/tick.ts`、`routes.ts`、`api/src/worlds/routes.ts`、`api/src/timelines/routes.ts`、相关测试。
**依赖：** T18。

**步骤：**
1. tick 只枚举 complete+active 时间线。
2. resume、重新激活、Fork 和世界写入拒绝非 complete。
3. pause/archive 保持安全冻结可用且不改历史。

**验证：** engine guard、tick、Fork 和管理路由定向测试通过。

## T20｜实现聊天请求预留与重放

**文件：** `api/src/chat/requests.ts`、`api/src/chat/recovery.test.ts`。
**依赖：** T02–T03、T18。

**步骤：**
1. 原子插入 pending request 与 user message。
2. 实现完整归属和 content hash 重放判断。
3. 覆盖同载荷 replay、异载荷/跨会话冲突和并发唯一赢家。

**验证：** `npm --workspace api run test -- src/chat/recovery.test.ts` 通过。

## T21｜实现聊天完成与数据库 fencing

**文件：** `api/src/chat/requests.ts`、`api/drizzle/0021_*.sql`、`api/src/chat/recovery.test.ts`。
**依赖：** T20。

**步骤：**
1. 原子插入预定 reply 并将 pending 更新为 completed。
2. 实现 heartbeat、failed、cancelled 和过期回收。
3. 让迟到 Worker 在终态后整批失败且不留 reply。

**验证：** chat recovery 中的取消、回收和 late-worker 故障测试通过。

## T22｜接入聊天状态 API

**文件：** `api/src/chat/routes.ts`、`routes.test.ts`。
**依赖：** T20–T21。

**步骤：**
1. 发送接口要求 `requestId` 并调用请求服务。
2. 新增状态、取消和 recover 路由。
3. replay/pending/终态均不重复调用模型。

**验证：** `npm --workspace api run test -- src/chat/routes.test.ts src/chat/recovery.test.ts` 通过。

## T23｜接入聊天前端恢复

**文件：** `web/src/api/client.ts`、`types.ts`、`web/src/components/ChatStream.tsx`。
**依赖：** T22。

**步骤：**
1. 每次发送生成稳定 request ID。
2. 流中断后查询服务端状态并刷新历史。
3. pending 时展示恢复状态；failed/cancelled 要求新 ID 重试。

**验证：** `npm --workspace web run build` 通过；非 DOM 状态辅助函数测试通过。

## T24｜补聊天跨设备 API 旅程

**文件：** `api/src/chat/recovery.test.ts`、`api/src/test/product-journey.test.ts`。
**依赖：** T22。

**步骤：**
1. 模拟客户端 A 发起、客户端 B 查询和重放。
2. 核对只产生一次调用、一个用户消息和一个回复。
3. 覆盖断流、取消、过期和 Worker 替换。

**验证：** chat recovery 与 product journey 定向测试通过。

## T25｜扩展模型调用回执

**文件：** `api/src/engine/budget.ts`、`guard.ts`、`api/src/llm/client.ts`、相关测试。
**依赖：** T03。

**步骤：**
1. reservation 返回 receipt ID，并保持现有原子额度语义。
2. 更新 completed、failed、cancelled 和错误码。
3. 只保存 context hash，不保存 prompt/output。

**验证：** budget、guard 和 LLM client 定向测试通过。

## T26｜严格识别流式完成与截断

**文件：** `api/src/llm/client.ts`、`client.test.ts`、`api/src/llm/contracts.ts`、`contracts.test.ts`。
**依赖：** T25。

**步骤：**
1. 只有明确 `[DONE]`/完成事件才返回成功。
2. EOF、残缺 JSON、超时和取消映射为稳定错误码。
3. 保证 reader 和 Abort 资源均被释放。

**验证：** `npm --workspace api run test -- src/llm/client.test.ts src/llm/contracts.test.ts` 通过。

## T27｜接入结构化模型合同

**文件：** `api/src/llm/contracts.ts`、`api/src/engine/steps/*.ts`、`director-llm.ts`、`api/src/scene/routes.ts`、`chapters/generate.ts`、相关测试。
**依赖：** T12、T26。

**步骤：**
1. 为日程、节拍、对话、注入、摘要、director、scene、章节定义版本化合同。
2. 在写入前执行 schema、知识和业务规则校验。
3. 无效输出失败且不产生世界副作用。

**验证：** engine steps、scene、chapter 与 contracts 定向测试通过。

## T28｜完成多渠道知识矩阵

**文件：** `api/src/agent/knowledge.test.ts`、`api/src/test/knowledge-journey.test.ts`、`engine-context.test.ts`。
**依赖：** T12、T27。

**步骤：**
1. 覆盖普通聊天、在场交谈、NPC 对话、引擎决策、摘要和多跳转述。
2. 核对无权居民和公共视图不含 canary。
3. 故障注入 rumor→fact、跨线 source 和私有事实公开。

**验证：** knowledge、engine context 和 knowledge journey 测试通过。

## T29｜补真实连续生活的确定性替身旅程

**文件：** `api/src/test/world-journey.test.ts`、`api/src/engine/tick.test.ts`。
**依赖：** T13、T27–T28。

**步骤：**
1. 连续推进多个决策点并跨页面离开等价边界。
2. 每拍核对回执、上下文摘要、版本化结果及审计。
3. 注入一次无效模型输出，确认安全失败后可继续下一拍。

**验证：** world journey 与 tick 定向测试通过。

## T30｜统一人类入口门禁

**文件：** `api/src/scene/routes.ts`、`chat/routes.ts`、`chapters/routes.ts`、`memories/routes.ts`、`persona/routes.ts`、`timelines/routes.ts`、`worlds/routes.ts`。
**依赖：** T18、T22、T27。

**步骤：**
1. 将显式入口清单逐项接入 `gateUniverseWrite`。
2. 保证门禁在消息、请求、预算和模型调用之前。
3. 保留只读路由和安全冻结操作。

**验证：** 现有路由测试和 `llm-routes.guard.test.ts` 通过。

## T31｜补内部引擎门禁矩阵

**文件：** `api/src/engine/policy-matrix.test.ts`、`api/src/engine/tick.ts`、`director-llm.ts`、`steps/*.ts`。
**依赖：** T19、T25、T27。

**步骤：**
1. 枚举 tick、director、schedule、beat、dialogue、injection、summary。
2. 覆盖 missing、incomplete、paused、capped、archived 和错 timeline。
3. 核对零模型调用及零版本/事实/投影变化。

**验证：** `npm --workspace api run test -- src/engine/policy-matrix.test.ts` 通过。

## T32｜补管理操作门禁矩阵

**文件：** `api/src/engine/policy-matrix.test.ts` 及对应管理路由测试。
**依赖：** T30–T31。

**步骤：**
1. 枚举 pause、archive、resume、timeline archive/reactivate、记忆、承诺和 persona 写入。
2. 验证安全冻结例外及所有恢复/历史写入拒绝规则。
3. 核对跨用户、错世界和预算隔离。

**验证：** policy matrix 与关联路由测试通过。

## T33｜服务端发送 SSE 归属信封

**文件：** `api/src/worlds/stream.ts`、`api/src/worlds/routes.ts`、stream 测试。
**依赖：** T17。

**步骤：**
1. 每个连接生成 stream ID 和单调 sequence。
2. 包装所有非心跳帧的 world/timeline/version。
3. 保持快照与增量游标无重复、不缺失。

**验证：** API stream 定向测试与 API build 通过。

## T34｜实现前端 SSE parser 与代次守卫

**文件：** `web/src/lib/sseParser.ts`、`streamGuard.ts` 及测试、`web/src/api/client.ts`。
**依赖：** T33。

**步骤：**
1. 将分片解析器抽成纯函数。
2. 实现 world/timeline/generation/stream/version 检查。
3. 在 unsubscribe 后阻止已缓冲旧帧调用回调。

**验证：** `npm --workspace web run test -- src/lib/streamGuard.test.ts` 通过。

## T35｜接入世界页 SSE 代次

**文件：** `web/src/pages/WorldView.tsx`、`WorldView.test.tsx`、`web/src/lib/timelineGuard.ts`。
**依赖：** T34。

**步骤：**
1. 世界/时间线切换时递增 generation。
2. 只把通过 envelope guard 的事件交给页面 reducer。
3. 保留旧快照和版本倒退守卫。

**验证：** Web WorldView 与 stream guard 测试通过。

## T36｜增加 Legacy 只读产品提示

**文件：** `web/src/components/world/EvidenceNotice.tsx`、`PersonDrawer.tsx`、`TimelineSwitcher.tsx`、`web/src/pages/WorldView.tsx`、`PersonDetail.tsx`、API types。
**依赖：** T17、T23。

**步骤：**
1. 显示 complete/upgradeable/incomplete 的用户可读状态。
2. 非 complete 隐藏或禁用运行、聊天、Fork 和历史写入入口。
3. 保留读取、Compare 及安全冻结入口。

**验证：** Web build、WorldView 和 PersonDrawer 测试通过。

## T37｜增加本地 Legacy 验收脚本

**文件：** `scripts/verify-s01-legacy.ts`、`package.json`。
**依赖：** T14–T17、T36。

**步骤：**
1. 构造 complete、upgradeable、incomplete 三类隔离数据库。
2. 执行分类、升级、重审和拒绝写入。
3. 输出脱敏计数并清理临时目录。

**验证：** `npm run verify:s01:legacy` 退出码 0，且无 `unassessed`/`upgradeable` 残留。

## T38｜扩展本地双 Worker 聊天恢复

**文件：** `scripts/verify-s01-workers.ts`。
**依赖：** T21–T24、T31。

**步骤：**
1. 两 Worker 并发发送同一聊天 request ID。
2. 验证唯一模型调用、重放、冲突、取消和过期接管。
3. 核对消息、请求、回执和预算账本。

**验证：** `npm run verify:s01:workers` 退出码 0：同 requestId 只有一次 provider call、1 条用户消息/1 条人物回复/1 条回执；跨 Worker pending/completed replay 200、异载荷 409；取消/过期恢复均无迟到人物回复，lease 为 0。

## T39｜增加 SSE 传输延迟夹具

**文件：** `scripts/fixtures/s01-stream-delay.ts`、`scripts/verify-s01-workers.ts`。
**依赖：** T33–T35。

**步骤：**
1. 让旧时间线 SSE 帧分片进入缓冲后暂停。
2. 切换时间线并释放旧帧剩余分片。
3. 记录旧帧未进入当前页面状态的可复核标识。

**验证：** 本地脚本自动断言 URL、timeline、version 和事件列表未被旧帧改变。

## T40｜补完整确定性产品旅程

**文件：** `api/src/test/product-journey.test.ts`、`world-journey.test.ts`、`web/src/pages/WorldView.test.tsx`。
**依赖：** T29–T36。

**步骤：**
1. 串联 CREATE→RUN→OBSERVE→ENTER→ACT→CHAT→FORK→COMPARE→RETURN。
2. 加入请求恢复、知识链和独立重建审计。
3. 返回主线后继续推进并验证所有 evidence 为 complete。

**验证：** API product/world journey 与 Web WorldView 测试通过。

## T41｜运行本地全量回归

**文件：** 无新增产品文件；失败时只修改对应任务文件。
**依赖：** T04–T40。

**步骤：**
1. 运行 API/Web 全量测试和构建。
2. 运行 legacy、本地双 Worker 和 SSE 延迟验收。
3. 运行 `git diff --check` 并核对迁移 journal。

**验证：** 所有命令退出码 0，实际数量记录到审计报告草稿。

## T42｜执行登录态浏览器验收

**文件：** `docs/current-state-audit.md`。
**依赖：** T41。

**步骤：**
1. 使用一次性 D1 和合成账号验证 legacy 只读提示。
2. 用两个独立浏览器 profile 验证普通聊天服务端 pending 发现与完成恢复。
3. 执行 SSE 旧帧切线、完整产品旅程和匿名只读检查。

**验证：** 本地隔离 D1 浏览器验收：Chrome 与 Codex 内置浏览器分别登录同一合成 owner；browser A 创建 request，browser B 无本地 request ID 仍通过 `/requests/pending` 发现并恢复回复。另在真实浏览器加载产品 `subscribeWorldStream`，先写入旧线 SSE 半帧、切换 generation/URL/时间线并取消订阅，再释放旧分片；最终只接受新线事件，旧 signal 已 aborted，浏览器 warning/error 为 0。

## T43｜准备远端迁移与 Worker 验收

**文件：** `scripts/apply-s01-remote-migrations.ts`、`verify-s01-remote-workers.ts`、`verify-s01-remote-journey.ts`。
**依赖：** T41。

**步骤：**
1. 加入 0020/0021 migration、evidence 分类和 chat request 检查。
2. 保留配置名称、数据库 ID 和唯一 fixture 安全限制。
3. 用 `node --check` 验证脚本，不连接网络。

**验证：** 所有远端脚本 `node --check` 通过。

## T44｜执行 staging D1 验收（授权门）

**文件：** `docs/current-state-audit.md`。
**依赖：** T42–T43；需要用户明确授权远端 staging 操作。

**步骤：**
1. 应用待处理迁移并确认重复执行无变化。
2. 运行双 Worker 分类、聊天并发/恢复、Fork、tick 和故障旅程。
3. 清理临时 Worker、Fork、请求和 lease，保留允许的不可变审计历史。

**验证：** `verify:s01:remote-workers` 与 `verify:s01:remote-journey` 退出码 0；远端 migration ledger 22/22、重复检查 pending 0；最终只读审计无 pending scene/chat、无 lease、无 active synthetic timeline。根线仅在旧不可变初始状态/空事件证据唯一重建并通过全域 replay 后升级为 complete。

## T45｜完善真实模型验收脚本

**文件：** `scripts/verify-s01-live-model.ts`、`package.json`。
**依赖：** T26–T29。

**步骤：**
1. 复用生产合同、知识校验和调用回执。
2. 增加连续多个决策点及离开/恢复等价步骤。
3. 硬限制最多 8 次尝试、零自动重试，并隐藏 canary、prompt 和原始响应。

**验证：** 未提供授权变量时安全拒绝；`npm --workspace api run build` 和脚本静态检查通过。

## T46｜执行真实模型验收（授权门）

**文件：** `docs/current-state-audit.md`。
**依赖：** T42、T45；需要用户明确授权最多 8 次可能计费的真实模型调用。

**步骤：**
1. 执行一次脚本，不自动重试失败调用。
2. 核对知识隔离、rumor 可信度、结构合同和连续决策持久化。
3. 记录脱敏结果和实际调用数。

**验证：** 所有脚本断言通过；本轮 4 次真实调用、自动重试 0、硬上限 8。该隔离样本不能替代 AC3/AC5 尚缺的多渠道/真实连续世界模拟证据。

## T47｜汇总全局验收与报告

**文件：** `spec_docs/s01/checklist.md`、`docs/current-state-audit.md`、`docs/world-quality-report.md`。
**依赖：** T41–T46。

**步骤：**
1. 为收口 AC1–AC10 记录实际证据。
2. 将结果映射回原全局 AC01–AC15。
3. 只有全部通过时才把 S01 标为完成；失败和未知保持显式。

**验证：** 三份报告状态一致，命令、计数、环境和限制可复核。

## T48｜交付审计与逻辑提交

**文件：** 本轮所有已批准文件。
**依赖：** T47。

**步骤：**
1. 对照 T01 基线检查未覆盖用户无关改动。
2. 运行最终全量测试、构建、脚本静态检查和 `git diff --check`。
3. 仅对归属清楚且验证通过的逻辑组创建提交；未确认内容保持未提交并报告。

**验证：** `git diff --check` 通过；凭据格式扫描无命中，`.dev.vars`、本地 D1 和 staging config 未进入提交。工作区全部改动已与 S01 文件清单及验收范围逐项对应，创建单一逻辑提交，未推送。

## T49｜补 Root/Child/Grandchild 独立重建等价旅程

**文件：** `api/src/test/product-journey.test.ts`、`api/src/test/world-journey.test.ts`。
**依赖：** T37–T41。

**步骤：**
1. 在包含聊天投影的产品旅程结束后重放主线和分支。
2. 在跨 24 小时、多次日程转换及嵌套 Fork 旅程结束后重放三代时间线。
3. 断言重放状态 complete 且所有域差异为空。

**验证：** 两个定向旅程测试通过；附加 baseline schedule reducer 用例；API 全量 45 文件/328 项通过。

## T50｜补内部状态与管理权限矩阵

**文件：** `api/src/engine/policy-matrix.test.ts`。
**依赖：** T30–T32。

**步骤：**
1. 将 unassessed 与 upgradeable 纳入内部模型入口拒绝矩阵。
2. 验证非 owner 对世界 pause/resume/archive 与时间线 archive/reactivate 均被拒。
3. 对拒绝前后世界、时间线、命令、事实和版本做快照比较。

**验证：** `npm --workspace api run test -- src/engine/policy-matrix.test.ts` 12/12 通过。

## T51｜真实模型多节拍旅程增量验收

**文件：** `scripts/verify-s01-live-journey.ts`、`package.json`、`docs/current-state-audit.md`。
**依赖：** T45–T46；严格受既有 8 次授权预算约束。

**步骤：**
1. 在隔离内存 D1 运行真实节拍，每次最多一个 provider reservation，不自动重试。
2. 核对调用回执、上下文 hash、重新构造的引擎上下文和独立 reducer 重放。
3. 授权预算耗尽即停止，不以固定模型替换真实样本。

**验证：** 修正 baseline 后的连续旅程已有 4 个 completed beat 回执、fresh context 和零差异重放；后续 T52 在新的 50 次授权窗口内补齐多渠道、真实无效合同与下一节拍恢复。

## T52｜关闭最终验收缺口

**文件：** `api/src/test/replay-combination.test.ts`、`api/src/world-state/invariants.ts`、`api/src/chat/routes.ts`、`api/src/scene/recovery.test.ts`、`api/src/engine/policy-matrix.test.ts`、`scripts/verify-s01-workers.ts`、`scripts/verify-s01-live-closure.ts`、验收文档。
**依赖：** T42、T49–T51；真实模型调用已获用户授权 50 次以内。

**步骤：**
1. 对全部 19 类命令和恢复路径逐次提交、收集不可变证据并独立重建。
2. 在真实浏览器释放切线前已进入 parser 的旧 SSE 半帧。
3. 补齐 evidence 状态、恢复与管理生命周期矩阵，并保持无来源 legacy 为只读。
4. 用真实模型覆盖六类渠道、真实无效合同、无污染失败和下一节拍恢复。

**验证：** 定向 31/31、API 46 文件/344 项、Web 6 文件/20 项及两端 build 通过；本地双 Worker、legacy 和浏览器验证通过；真实模型最终轮 8 次调用中 7 completed、1 个预期 failed/contract_violation，零自动重试，独立重放 complete/零差异。

## 执行顺序

```text
T01
 ├→ T02 → T03 → T04
 ├→ T05 → T06 → T07 → T08 → T09 → T10 → T11 → T12 → T13 → T14 → T15
 │                                                            ├→ T16 → T17
 │                                                            └→ T18 → T19
 ├→ T20 → T21 → T22 → T23 → T24
 ├→ T25 → T26 → T27 → T28 → T29
 ├→ T30 → T31 → T32
 └→ T33 → T34 → T35 → T36

T14–T36 → T37 → T38 → T39 → T40 → T41 → T42
T41 → T43 → T44（远端授权门）
T29 → T45 → T46（真实模型授权门）
T42 + T44 + T46 → T47 → T48
```
