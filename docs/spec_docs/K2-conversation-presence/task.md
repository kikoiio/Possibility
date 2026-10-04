# K2：交谈渠道与空间事实一致 Tasks

> 状态：实现、API/Web 验证与人物页电话旅程均已完成；验收证据见 [checklist.md](./checklist.md)。
> 输入：[spec.md](./spec.md)、[plan.md](./plan.md)，均已批准。
> 工作区：/home/neo/.codex/worktrees/b-trust-branching-6638/Possibility，分支 codex/b-trust-branching。

## 开发门槛与资源约束

- 本任务仅在 K2 的 spec、plan、task、checklist 四份文档全部获批后开始实施。
- 按下方依赖顺序执行；修改相同文件的任务前项完成后再进行。只有文件边界互不冲突时才并行编辑。
- 定向单测使用单 worker。API 构建、全量测试和浏览器端到端验证串行执行；启动重型验证前按仓库 AGENTS.md 检查 MemAvailable、换页速率和 memory PSI。
- 电话模型对话采用合成居民与隔离测试数据库，不使用个人真实世界数据。除非用户另行授权且隔离测试模型已配置，不执行真实模型调用。
- 每项实现任务完成后记录实际验证结果；本文件生成阶段未运行实现代码或测试。

## 实施进度（2026-10-04）

- **T1–T2 完成：** `chat_requests.channel` 已通过迁移 0036 增加，旧请求默认为 `unknown`；普通聊天由 API 固定记为 `phone`，渠道参加 requestId 内容匹配，查询、取消、恢复和 pending 响应都保留渠道。
- **T3–T5 完成：** 电话提示与工具运行态从服务端通信上下文构造。电话回合的 `act`、`update_state`、`remember` 先暂存；拒绝位置更新，忽略模型活动文案，由服务端固定电话活动。成功回合将状态、事件、记忆、回复和 completed 请求放在一次世界命令 D1 batch；失败或取消不留下居民副作用。共享事件只记录电话经历，不复制交谈正文。
- **T6–T7 完成：** `/scene` 未修改，并已回归；Web API 类型包含渠道，人物页不发送渠道、地点或参与者字段，无需增加渠道选择器或 UI 状态。
- **T8 完成：** API 全量回归、合成 API 电话旅程和人物页 Playwright 电话旅程均已运行。验证结果列于 `checklist.md`。
- 已有回复文本会在流中显示；提交前不发送状态/事件/记忆 SSE 或 completed 回执。服务端只在全部持久化成功后发送这些副作用事件。

## 文件清单

| 操作 | 文件 | 职责/任务 |
|---|---|---|
| 修改 | api/src/db/schema.ts | chat_requests.channel 类型与缺省值（T1） |
| 新建 | api/drizzle/0036_k2_chat_channel.sql（编号按实施时迁移顺序确认） | 旧请求渠道初始化为 unknown（T1） |
| 修改 | api/drizzle/meta/_journal.json | 登记 K2 迁移（T1） |
| 修改 | api/src/chat/requests.ts | 渠道保留、请求哈希校验、读取与恢复（T2） |
| 修改 | api/src/chat/routes.ts | 普通聊天固定 phone、构建渠道上下文及失败处理（T2、T3、T5） |
| 修改 | api/src/chat/recovery.test.ts、api/src/chat/routes.test.ts | 渠道默认、幂等、旧记录和路由边界（T2、T5） |
| 修改 | api/src/agent/types.ts、api/src/agent/context.ts | 通信上下文类型与服务端上下文装配（T3） |
| 修改 | api/src/agent/prompt.ts、相应 prompt 测试 | 电话及 unknown 语境说明（T3） |
| 修改 | api/src/agent/loop.ts、api/src/agent/tools.ts | 通信渠道运行态、位置护栏、副作用暂存（T4） |
| 修改 | api/src/world-state/types.ts、rules.ts、commit.ts | 聚合状态命令、渠道元数据与原子附写（T5） |
| 修改 | 相关 api/src/agent/tools.test.ts、api/src/agent/tools.integration.test.ts、api/src/world-state/commit.test.ts | 位置不变、暂存和失败原子性（T4、T5） |
| 保持并验证 | api/src/scene/routes.ts、相关 scene/commit 测试 | 现场交谈仍由服务端在场证据授权（T6） |
| 修改 | web/src/api/types.ts、web/src/api/client.ts | 请求渠道和恢复回执类型（T7） |
| 必要时修改 | web/src/components/ChatStream.tsx、web/src/pages/PersonDetail.tsx | 展示渠道与可恢复失败提示（T7） |
| 修改 | web/src/components/ChatStream.test.tsx 及页面组件测试 | 电话发送、请求恢复与失败提示（T7） |
| 新建/扩展 | api/src/db/k2-migration.test.ts、api/src/chat/routes.test.ts、api/src/test/product-journey.test.ts、web/e2e/k2-phone-chat.spec.ts | 电话渠道到持久回执、现场交谈路径与历史兼容（T8） |
| 修改 | docs/spec_docs/K2-conversation-presence/task.md、checklist.md | 记录完成状态和验收证据（T9） |

## T1：增加聊天请求渠道字段

**依赖：** 无。
**步骤：**
1. 为 chat_requests 增加受限渠道字段；旧数据迁移为 unknown。
2. 创建迁移并更新 journal；实施时根据已合并迁移重新确认编号。
3. 不更新已有 messages、对话历史、居民记忆或状态。

**验证：** 迁移测试确认旧请求按 unknown 读取，已有消息与其他行未变；schema 检查通过。

## T2：将渠道纳入聊天请求生命周期

**依赖：** T1。
**步骤：**
1. ReserveChatRequestInput 与持久请求包含渠道；相同 requestId 的负载匹配同时比较渠道。
2. 普通人物页发送路由服务端固定为 phone，不接受客户端传入 channel/location/participant。
3. 查询、取消、恢复和幂等回执读取持久化渠道；旧请求保留 unknown。
4. requestId 同内容同渠道重放原回复，不同负载或渠道冲突。

**验证：** chat request/route 定向测试覆盖 phone、unknown、重放、冲突、取消和恢复。

## T3：注入受限通信上下文

**依赖：** T2。
**步骤：**
1. 在居民 prompt 上下文添加渠道和必要对端信息，信息由服务端会话与时间线解析。
2. phone 提示明确用户为远程联系人、居民地点来自当前世界状态、来访邀请不等于到场。
3. unknown 提示禁止构造未被证实的现场相遇；不从消息内容推断渠道。
4. 在场 /scene 保持独立提示和参与者上下文。

**验证：** prompt 测试确认 phone/unknown 语义入模，且不会把用户加入现场参与者列表；现场提示仍明确为当面。

## T4：约束电话模式工具效果

**依赖：** T3。
**步骤：**
1. 将渠道与对端元数据加入 ToolRunState。
2. phone 模式下拒绝居民位置字段更新；模型提供的同地活动文案不直接写入状态，活动由服务端记录为电话交谈。
3. 把 act、update_state、remember 改为本轮内存暂存；工具将暂存结果回传模型以继续本轮。
4. 暂存事件与记忆附上 phone 来源；取消或模型错误时清空暂存效果。

**验证：** tool/loop 定向测试覆盖模型试图改地点、活动改写为现场来访、合法记忆、事件来源以及失败时无 world command。

## T5：原子提交电话聊天回合

**依赖：** T4。
**步骤：**
1. 将一个成功回合的状态补丁、事件与记忆聚合成一条 resident_state 命令；命令带通信渠道及 request 来源。
2. 扩展 completeChatRequest/commitWorldCommand 集成，使命令投影、回复 message 与 request completed 状态在同一 D1 batch 提交。
3. 仅在提交成功后向客户端发送状态/事件完成反馈；模型中断、取消或数据库失败时不提交聚合效果。
4. 保留已预留的用户原始消息及失败请求状态作为恢复依据；同 ID 重试遵循原请求语义，不重复 world effect。

**验证：** 原子性测试在附写失败时确认无 reply、无状态命令/事实/事件/记忆和 completed 回执残留；成功及重放各只产生一条命令。

## T6：保护当面交谈路径

**依赖：** T2、T3；不改 scene 行为。
**步骤：**
1. 验证 /scene 仍只从服务端 persona 状态读取世界、时间线与地点。
2. 保持同地点、清醒、空闲居民资格检查及 scene generation 的证据。
3. 覆盖无 persona、缺少 personState、过期/错误地点和无合格回应居民的拒绝行为。
4. 确认合法 scene 仍使用 scene_open / conversation 原子命令并只写参与者记忆。

**验证：** scene routes、world-state commit 定向测试通过；拒绝用例没有 scene 或会面残留，合法用例完整提交。

## T7：接入 Web 请求状态与反馈

**依赖：** T2、T5。
**步骤：**
1. 扩展 Web 请求/恢复响应类型，使渠道和失败类型与 API 契约一致。
2. 保持人物页现有“打电话”入口，不暴露客户端自选渠道或地点。
3. 对失败、取消、恢复显示与实际请求渠道匹配的说明；只有原子提交完成后显示成功状态。
4. 保持旧聊天历史可读。

**验证：** 组件测试覆盖 phone 通话、失败后保留文本/可重试、恢复回执与旧消息兼容。

## T8：端到端覆盖 K2 验收

**依赖：** T1–T7。
**步骤：**
1. 使用合成账户/世界从人物页发起 phone 请求，检查数据库渠道、居民地点、活动、命令事件、记忆和权限边界。
2. 以注入输出模拟模型尝试制造现场会面；确认位置固定、活动由服务端规范化、无未授权在场记录。
3. 模拟成功、模型中断、持久化失败及 requestId 重放；检查原子回执。
4. 走一次具备真实在场证据的 /scene，确认现场交谈仍成功；再验证无证据请求被拒。
5. 验证旧聊天消息和旧 request 仍可读，历史渠道为 unknown。

**验证：** 运行定向 API/组件/E2E；内存允许后再运行相关 API/Web 全量验证。按 checklist 逐项记录结果和限制，不以 prompt 测试看作所有模型行为保证。

## T9：记录交付与验收证据

**依赖：** T8。
**步骤：**
1. 将 task 状态和每项实际验证结果记入 checklist.md。
2. 将未完成项、迁移版本、命令 ID 与数据边界记清楚。
3. 确认全部验收项有对应证据；有失败或不适用项时说明原因，不标记为通过。

**完成定义：** Spec、Plan、Task、Checklist 均已批准；实现留在 B 分支工作区；AC1–AC9 有可复现的验证证据，旧记录和 K1 知识隔离回归通过；实际验证结果已在 checklist 留档。
