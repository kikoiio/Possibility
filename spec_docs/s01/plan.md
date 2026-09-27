# s01｜全局验收收口 Plan

> 依据：[spec.md](./spec.md)。本计划在保留现有未提交改动的前提下，关闭全局 AC03、AC05、AC07、AC08、AC09、AC14，并补齐 P4 旧 SSE 帧传输隔离证据。

## 架构概览

### 1. 证据收集层

从 D1 一次性读取某条时间线的固定世界模型、起始投影、Fork Checkpoint、版本化命令、事实和当前投影，形成不可变的 `TimelineEvidence`。该层只负责读取和标准化，不判断“是否正确”，也不修改数据库。

### 2. 独立投影器

新增纯确定性投影器，以基线为初始状态，严格按版本顺序消费命令与事实，生成预期投影。它不能读取当前 `person_states`、事件、记忆、对话等待验证表。每类世界行动对应一个独立 reducer；未知行动或证据缺失会产生“不支持/不完整”诊断，而不是回退到当前投影。

### 3. 审计与 Legacy 分级层

审计器比较“独立投影器结果”和“数据库当前投影”，同时运行现有命令—事实语义、可见性、可信度和版本不变量检查。每条时间线保存证据等级：

- `complete`：具有完整基线，所有历史动作可重放。
- `upgradeable`：已有可靠证据足以补齐结构，但尚未完成升级。
- `incomplete`：缺少不可恢复的历史证据，只读保留。

新建主线和 Fork 必须原子写入 `complete` 状态。升级流程只把可证明的数据转为 `complete`；不完整时间线永不从当前投影反向造历史。

### 4. 统一 Universe 写入门禁

在现有世界状态、权限和预算门禁之前增加 Universe 证据门禁。所有世界历史写入、引擎推进、模型入口、Fork、恢复任务和时间线管理都通过同一个策略入口。

门禁顺序统一为：

```text
身份与归属
  → 世界/时间线存在
  → Universe 证据等级
  → active/running 状态
  → 预算预检
  → 原子调用预留
  → 模型调用或版本化提交
```

安全冻结类控制操作与世界历史写入分开建模；暂停或归档可以让不完整数据变得更安全，但不能重新启用、运行或修改其历史。

### 5. 普通聊天请求状态机

复用当前未提交的 `chat_requests` 迁移方向，将普通聊天升级为与场景请求相同的持久状态机：

```text
pending → completed
        ↘ failed
        ↘ cancelled
```

请求身份绑定用户、会话、人物、世界、时间线及内容摘要。请求预留与用户消息原子写入；成功回复使用预先确定的消息 ID 原子完成。重复的同载荷请求读取既有结果，异载荷复用直接冲突。新增状态查询、取消和过期回收接口；前端不再以标签页内临时消息判断结果，而是通过服务端请求状态恢复。

### 6. 模型输出合同层

所有可能改变世界或形成完成消息的模型结果，在进入提交层前统一经历：

```text
传输完成
  → 结构解析
  → schema 校验
  → 知识可见性/可信度校验
  → 业务约束校验
  → 原子提交
```

截断、无效结构、越权知识、矛盾可信度、超时或取消统一进入失败终态。固定模型负责确定性矩阵，真实模型只负责获授权的抽样和连续生活旅程。

### 7. SSE 归属信封与客户端代次守卫

世界流事件统一携带 `worldId`、`timelineId`、`streamId`、`stateVersion` 和事件序号。客户端为每次订阅生成代次标识；解析到完整 SSE 帧后、调用 UI 回调前再次核对当前世界、时间线和订阅代次。这样即使旧帧已经进入读取缓冲区，取消订阅后才完成解析，也会在进入页面状态前被丢弃。

### 8. 分层验收设施

- 纯函数测试：投影器、分类器、模型结果校验、SSE 帧守卫。
- SQLite 集成测试：迁移、请求状态机、权限预算矩阵、故障回滚。
- 本地双 Worker：并发、租约、聊天重放和恢复。
- 登录态浏览器：legacy 只读提示、跨会话聊天恢复、真实切线竞态。
- Staging D1：迁移、跨 Worker 原子性和恢复。
- 真实模型：显式授权、固定调用上限、连续多拍和异常结果审查。
- 最终报告：同步全局 AC01–AC15，不再用 P4 阶段通过代替全局完成。

## 核心数据结构与接口

### Universe 证据状态

```ts
type UniverseEvidenceLevel = 'unassessed' | 'complete' | 'upgradeable' | 'incomplete'

interface UniverseEvidenceRecord {
  timelineId: string
  level: UniverseEvidenceLevel
  assessedVersion: number | null
  baselineVersion: number | null
  reasonCodes: string[]
  assessedAt: string
}
```

数据库表 `universe_evidence` 包含 `timeline_id`、`level`、`assessed_version`、`baseline_version`、`reason_codes_json`、`assessed_at`。新建主线和 Fork 在同一事务中写入 `complete`。迁移后的 `unassessed`、`upgradeable`、`incomplete` 均拒绝世界历史写入；只有升级事务完成并复审通过后才能变为 `complete`。

### 重建输入与结果

```ts
interface ReplayInput {
  worldId: string
  timelineId: string
  baseline: ProjectionBaseline
  commands: WorldCommand[]
  facts: WorldFact[]
  throughVersion: number
}

interface RebuiltProjection {
  simTime: string
  states: PersonState[]
  schedules: Schedule[]
  events: WorldEvent[]
  commitments: Commitment[]
  memories: Memory[]
  dialogues: Dialogue[]
  dialogueTurns: DialogueTurn[]
  personaMessages: PersonaMessage[]
  knowledge: WorldFact[]
}

type ReplayDiagnosticKind =
  | 'missing' | 'extra' | 'mismatch' | 'unsupported' | 'unproven'
  | 'wrong_version' | 'wrong_timeline'

interface ReplayDiagnostic {
  kind: ReplayDiagnosticKind
  domain: ProjectionDomain | 'history'
  timelineId: string
  version?: number
  commandId?: string
  factId?: string
  recordId?: string
  reasonCode: string
}
```

核心接口：

```ts
collectReplayInput(db, worldId, timelineId): Promise<ReplayInputResult>
reduceProjection(input: ReplayInput): ReplayResult
readCurrentProjection(db, worldId, timelineId): Promise<RebuiltProjection>
compareProjection(expected, actual): ReplayDiagnostic[]
classifyUniverse(input, replayResult): UniverseClassification
auditUniverse(db, worldId, timelineId): Promise<UniverseAudit>
```

`reduceProjection` 是纯函数，不接收数据库对象，也不能读取当前投影。

### Legacy 分类与升级结果

```ts
interface UniverseClassification {
  level: 'complete' | 'upgradeable' | 'incomplete'
  assessedVersion: number | null
  baselineVersion: number | null
  reasonCodes: string[]
}

interface UpgradeResult {
  timelineId: string
  previousLevel: UniverseEvidenceLevel
  nextLevel: 'complete' | 'incomplete'
  changed: boolean
  reasonCodes: string[]
}
```

```ts
assessUniverse(db, worldId, timelineId): Promise<UniverseClassification>
upgradeProvableUniverse(db, worldId, timelineId): Promise<UpgradeResult>
```

升级只补齐可由不可变证据唯一确定的结构。无法唯一确定时返回 `incomplete`，不执行猜测性写入。

### Universe 写入门禁

```ts
interface UniverseWriteScope {
  userId?: string
  worldId: string
  timelineId: string
  purpose: CallPurpose | 'world_write' | 'fork' | 'management'
  requireRunning: boolean
  requireActiveTimeline: boolean
  reserveModelCall: boolean
}

type UniverseGateResult =
  | { ok: true; world: World; timeline: Timeline; evidence: UniverseEvidenceRecord }
  | { ok: false; status: 403 | 404 | 409 | 429; code: string; error: string }
```

```ts
gateUniverseWrite(db, scope, budgetConfig): Promise<UniverseGateResult>
requireWritableUniverse(db, worldId, timelineId): Promise<void>
```

`commitWorldCommand` 仍执行最终数据库级校验。暂停和归档属于安全冻结控制，不修改 Universe 历史；恢复、重新激活及其他写操作必须通过完整门禁。

### 普通聊天请求

完善当前尚未接入的 `chat_requests`：

```ts
type ChatRequestStatus = 'pending' | 'completed' | 'failed' | 'cancelled'

interface ChatRequest {
  requestId: string
  conversationId: string
  userId: string
  worldId: string
  timelineId: string
  personId: string
  contentHash: string
  userMessageId: string
  replyMessageId: string
  status: ChatRequestStatus
  heartbeatAt: number
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  errorCode: string | null
}
```

不在请求表重复保存聊天正文；正文仍只存在于消息表，幂等比较使用内容摘要。

```ts
reserveChatRequest(db, input): Promise<
  | { kind: 'reserved'; request: ChatRequest }
  | { kind: 'replay'; request: ChatRequest }
  | { kind: 'conflict' }
>
completeChatRequest(db, requestId, reply): Promise<ChatRequest>
failChatRequest(db, requestId, errorCode): Promise<ChatRequest>
cancelChatRequest(db, requestId): Promise<ChatRequest>
recoverExpiredChatRequest(db, requestId, now): Promise<ChatRequest>
```

HTTP 契约：

```text
POST /conversations/:conversationId/messages
  body: { requestId, content }

GET /conversations/:conversationId/requests/:requestId
POST /conversations/:conversationId/requests/:requestId/cancel
POST /conversations/:conversationId/requests/:requestId/recover
```

相同请求 ID 与内容摘要返回原状态；不同内容返回冲突。已失败或取消的请求不会再次调用模型，用户重试时创建新请求 ID。

### 模型调用回执

扩展调用账本，不记录原始 prompt 或模型输出：

```ts
type ModelCallStatus = 'reserved' | 'completed' | 'failed' | 'cancelled'

interface ModelCallReceipt {
  id: string
  requestId: string | null
  purpose: CallPurpose
  worldId: string | null
  timelineId: string | null
  personId: string | null
  contextHash: string | null
  contractVersion: string | null
  status: ModelCallStatus
  errorCode: string | null
  createdAt: string
  completedAt: string | null
}

type ModelOutcome<T> =
  | { ok: true; value: T; receiptId: string }
  | { ok: false; code: 'transport_error' | 'timeout' | 'cancelled' | 'truncated'
      | 'invalid_schema' | 'knowledge_violation' | 'business_rule_violation'; receiptId: string }
```

```ts
validateModelOutcome<T>(raw, contract): ModelOutcome<T>
```

### 知识来源链

沿用版本化 knowledge fact，通过 `sourceFactId` 形成来源链：

```ts
interface KnowledgeAssertion {
  recipientId: string
  topic: string
  content: string
  certainty: 'fact' | 'rumor'
  sourceFactId: string | null
}

validateKnowledgeChain(
  assertion: KnowledgeAssertion,
  visibleSourceFacts: WorldFact[],
): KnowledgeValidation
```

有来源的转述不能获得高于来源的可信度；无权读取来源的主体不能引用该来源。

### SSE 归属信封

```ts
interface WorldStreamEnvelope<T> {
  worldId: string
  timelineId: string
  streamId: string
  sequence: number
  stateVersion: number
  payload: T
}

interface SubscriptionIdentity {
  worldId: string
  timelineId: string
  generation: number
  streamId: string | null
}
```

```ts
subscribeWorldStream(worldId, timelineId, onEnvelope, options): () => void
acceptStreamEnvelope(active, envelope): boolean
```

只有归属、代次、流 ID 和版本均匹配的事件才能进入页面状态。

## 模块设计

### A. Evidence Collector

**职责：** 在一次只读快照中收集固定世界模型、Root 基线或 Fork Checkpoint、命令、事实、修订版本及当前投影；将当前投影与重放输入分开返回。

**接口：** `collectReplayInput`、`readCurrentProjection`。

**依赖：** 数据库 schema、Fork 可见性规则、固定世界模型解析。覆盖 F1–F3。

### B. Pure Projection Reducer

**职责：** 从基线开始按版本重放动作，分域维护全部投影；未知动作或不连续证据返回诊断。现有世界行动校验抽出纯 `projectWorldAction` 语义层，在线提交保留权限、数据库查询和事务。

**接口：** `reduceProjection`、`reduceAction`、`normalizeProjection`。

**依赖：** 世界行动类型、纯业务规则。覆盖 F1–F2。

### C. Audit and Classification

**职责：** 比较预期与当前投影；运行命令—事实、可见性、可信度和版本审计；判定 `complete`、`upgradeable`、`incomplete`；支持单线和批量审计。

**接口：** `auditUniverse`、`classifyUniverse`、`assessAllUniverses`。

**依赖：** Evidence Collector、Reducer、现有语义审计。覆盖 F1–F3。

### D. Legacy Upgrade Service

**职责：** 对可升级时间线执行最小升级；事务内写入、复审并切为 `complete`；失败整体回滚；为读取 API 提供等级和限制原因。

**接口：** `assessUniverse`、`upgradeProvableUniverse`、`readUniverseEvidence`。

**依赖：** Audit and Classification、数据库事务。覆盖 F3。

### E. Universe Policy Gate

**职责：** 统一身份、归属、证据等级、时间线、世界状态和预算检查，并在 `commitWorldCommand` 形成纵深防御。显式入口清单包括世界行动、注入、Fork、记忆、承诺、场景、普通聊天、catch-up、章节、Fork 预览/模拟、tick、director、所有步骤、恢复和管理写操作。

**接口：** `gateUniverseWrite`、`requireWritableUniverse`、`worldReservation`、`userReservation`。

**依赖：** 身份数据、Universe Evidence、预算账本。覆盖 F3、F7。

### F. Durable Chat Request Service

**职责：** 原子预留请求和用户消息；跨 Worker 唯一占有；维护 heartbeat 和终态；成功时原子写回复；重放不重复调用；失败不生成伪完整回复。

**接口：** `reserveChatRequest`、`touchChatRequest`、`completeChatRequest`、`failChatRequest`、`cancelChatRequest`、`recoverExpiredChatRequest`、`readOwnedChatRequest`。

**依赖：** Chat Request 表、消息表、Policy Gate、模型合同。覆盖 F6、F7。

### G. Model Contract and Receipt Layer

**职责：** 调用前创建回执并预留预算；流式响应检查终止标志；结构化响应检查 schema、知识与业务合同；更新完成、失败或取消；真实模型脚本复用生产解析路径。

**依赖：** LLM client、预算预留、知识可见性规则。覆盖 F4、F5、F7。

### H. Knowledge Provenance Validator

**职责：** 沿 `sourceFactId` 验证来源链；限制主体可见性和可信度；防止多跳、摘要或工具调用升级 rumor；为多渠道矩阵提供统一夹具。

**接口：** `resolveVisibleKnowledge`、`validateKnowledgeChain`、`assertKnowledgeWrite`。

**依赖：** 世界事实、人物可见性。覆盖 F4、F5。

### I. World Stream Envelope

**职责：** 生成服务端 `streamId` 和序号；包装所有非心跳帧；客户端解析后核对代次与归属；拆分纯 SSE parser 与 guard。

**依赖：** 世界流查询、前端 timeline guard。覆盖 F8。

### J. Read-only Product Surface

**职责：** 在快照、人物、Compare 和公共响应中传递证据等级；对 `upgradeable`/`incomplete` 显示只读提示并禁用写入口；服务端仍为最终边界。

**依赖：** Legacy Upgrade Service、世界查询与页面。覆盖 F3、F8。

### K. Acceptance Harness and Reporting

**职责：** 扩展本地与远端 Worker、真实模型和 SSE 故障脚本；最终同步 Checklist、审计和质量报告。

**依赖：** 所有模块，但不被产品运行时代码依赖。覆盖 F5、F6、F8、F9。

依赖方向：

```text
纯业务规则 → Projection Reducer → Audit / Classification → Legacy Upgrade
数据库与身份 → Universe Policy Gate → 产品路由 / Engine / Chat
LLM Client → Model Contract → Chat / Scene / Engine
World Stream → SSE Envelope → Web Guards / Pages
```

## 模块交互

### 新 Universe 创建

```text
创建世界或 Fork
  → 构造完整不可变基线
  → 写入世界/时间线/初始投影/revision/evidence(complete)
  → 同一事务提交
  → 运行独立重建审计
```

任一写入失败则整体回滚。Fork 依据自己的 Checkpoint 写入 `complete`，不盲目继承父线状态。

### Legacy 分类与升级

```text
收集不可变证据 → 构造 ReplayInput → 独立重放 → 分类
  ├─ complete：记录完整状态
  ├─ upgradeable：生成唯一升级计划 → 事务升级 → 复审 → complete
  └─ incomplete：记录原因，只读保留
```

分类不改历史；升级失败整体回滚。出口前不得残留 `unassessed`，`upgradeable` 必须收敛为 `complete` 或 `incomplete`。

### 世界写入

```text
请求 → 身份/归属 → evidence=complete → active/running
  → 必要时预算预留 → 解析/校验 → commit 最终复查
  → 原子写 command + fact + projection + revision
```

引擎只枚举 `complete + active` 时间线；证据状态或租约变化由最终数据库检查拒绝。

### 普通聊天

首次发送：

```text
客户端 requestId → 会话/Universe 门禁 → contentHash
  → 原子写 chat_request(pending) + user message
  → 模型回执/预算 → 流式生成/heartbeat → 完整终止/校验
  → 原子写 person reply + request(completed) + receipt(completed)
```

重放与恢复：

```text
相同 requestId
  ├─ 归属或 hash 不同：409
  ├─ completed：返回既有回复
  ├─ failed/cancelled：返回终态
  └─ pending：返回 pending，客户端查询状态
```

取消或回收以条件更新将 `pending` 变为终态，数据库触发器阻止旧 Worker 插入预定 reply。

### 模型调用

```text
业务请求 → 门禁 → 原子预算与 receipt(reserved) → contextHash → provider
  → 完整性 → schema → 知识/可信度 → 业务规则
  → receipt(completed|failed|cancelled) → 成功时才允许业务提交
```

无明确完成帧的流视为 `truncated`，结构化输出不做部分字段宽松提交。

### 知识传播

```text
知识或转述 → sourceFactId → 可见性 → 递归来源链
  → 最高允许 certainty → 接收者/主题/内容校验 → 版本化提交
```

任一步为 rumor，后续均不得成为 fact。普通聊天文本本身不创建世界知识。

### SSE 切线

```text
订阅 A(generation=1, stream=A1) → 缓冲分片
切换 B → generation=2 → abort A → 建立 B1
旧 A 分片组成完整帧 → envelope guard → generation 过期 → 丢弃
```

### 验收顺序

```text
迁移/静态检查 → 纯函数测试 → SQLite 故障与矩阵
  → API/Web 全量回归和构建 → 本地双 Worker → 浏览器
  → 显式 staging D1 → 单独授权的真实模型 → 报告同步
```

真实模型和远端步骤不会自动执行，到达对应任务时分别请求明确授权。

## 文件组织

```text
api/
├── drizzle/
│   ├── 0020_dizzy_hannibal_king.sql
│   ├── 0021_<generated>.sql
│   └── meta/
└── src/
    ├── db/{schema.ts,migrate-data.ts}
    ├── world-state/{evidence.ts,projector.ts,classification.ts,rebuild.ts,invariants.ts,model.ts,rules.ts,commit.ts,query.ts}
    ├── engine/{guard.ts,budget.ts,tick.ts,director-llm.ts,routes.ts,steps/*,policy-matrix.test.ts}
    ├── llm/{client.ts,contracts.ts,contracts.test.ts}
    ├── agent/{visibility.ts,knowledge.ts,context.ts,engine-context.ts,loop.ts,knowledge.test.ts}
    ├── chat/{requests.ts,routes.ts,routes.test.ts,recovery.test.ts}
    ├── worlds/{routes.ts,queries.ts,stream.ts}
    ├── life/{fork.ts,compare.ts}
    ├── scene/routes.ts
    ├── chapters/routes.ts
    ├── memories/routes.ts
    ├── persona/routes.ts
    └── test/{legacy-migration.test.ts,legacy-classification.test.ts,knowledge-journey.test.ts,product-journey.test.ts,world-journey.test.ts}
web/src/
├── api/{client.ts,types.ts}
├── lib/{timelineGuard.ts,sseParser.ts,streamGuard.ts}
├── components/ChatStream.tsx
├── components/world/{EvidenceNotice.tsx,PersonDrawer.tsx,TimelineSwitcher.tsx}
└── pages/{WorldView.tsx,PersonDetail.tsx,WorldView.test.tsx}
scripts/
├── verify-s01-workers.ts
├── verify-s01-remote-workers.ts
├── verify-s01-remote-journey.ts
├── verify-s01-live-model.ts
├── verify-s01-legacy.ts
└── fixtures/s01-stream-delay.ts
docs/{current-state-audit.md,world-quality-report.md}
spec_docs/s01/{spec.md,plan.md,task.md,checklist.md}
```

### 现有未提交改动的处理

- `0020_dizzy_hannibal_king.sql` 和 `chat_requests` schema 作为 F6 雏形，在现有内容上补齐字段、heartbeat、终态和 fencing。
- `0019`、场景恢复、权限矩阵及远端脚本的现有改动作为本轮基线保留。
- 实现前记录每个脏文件的 diff，只修改与批准计划重叠的部分。
- 未确认归属前不提交现有 29 项改动；`task.md` 将整理既有改动与新增实现分开。

### 文件边界原则

- 纯 reducer 不导入数据库客户端。
- 路由不直接实现请求状态机或证据分类，只调用服务层。
- 模型解析不直接写数据库。
- 前端 guard 不依赖 React，可独立单测。
- 验收脚本不导入生产密钥或默认远端配置。
- 报告只记录脱敏结果，不记录 canary、模型凭据或 D1 标识。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 投影正确性证明 | 独立纯 reducer 重建后逐域比较 | 现有语义审计不能证明全部当前投影可复算。 |
| reducer 与在线提交规则 | 共享纯业务投影规则，分离数据库校验和写入 | 避免语义漂移，同时保证 reducer 不读取当前投影。 |
| Universe 证据状态 | 独立 `universe_evidence` 表 | 不改变不可变历史表语义，便于迁移、分类和门禁。 |
| 新 Universe | 创建事务内直接写 `complete` | 新世界和 Fork 已有完整基线。 |
| Legacy 默认 | fail closed | 未评估、可升级和不完整均不应继续产生历史。 |
| 缺失历史 | 不反推、不补造 | 当前投影不能证明真实历史。 |
| 可升级条件 | 不可变证据能唯一确定 | 保证升级是结构补齐而非故事推测。 |
| 安全控制 | 允许暂停/归档，禁止恢复、运行、Fork 和历史写入 | 安全冻结降低风险且不改历史。 |
| 聊天幂等 | request ID + 内容摘要 + 完整归属 | 支持跨设备恢复并检测滥用。 |
| 聊天正文 | 只存消息表 | 减少敏感数据重复。 |
| 回复 ID | 请求预留时确定 | 支持 fencing、重放和定位。 |
| 失败同 ID | 不再次调用，新尝试使用新 ID | 一个请求身份至多一次模型尝试。 |
| 迟到 Worker | 应用 CAS + 数据库触发器 | 防止跨 Worker 竞态。 |
| 模型账本 | 扩展预算日志为调用回执 | 同时保留原子额度和结果状态。 |
| 模型原文 | 不写调用账本 | 防止私有内容与 canary 泄漏。 |
| 流式完成 | 必须出现协议完成标志 | EOF 不能证明模型完整完成。 |
| 知识可信度 | 来源链单调不升级 | rumor 不能经转述变成 fact。 |
| SSE 隔离 | 服务端信封 + 客户端代次 | 同时解决归属和缓冲迟到。 |
| 全域审计 | 离线全量、在线增量 | 避免产品请求无界扫描。 |
| 权限覆盖 | 显式入口清单 + 矩阵测试 | 防止内部或新增入口绕过。 |
| 迁移编号 | 完善未交付 `0020`；证据状态使用后续 migration | 保留现有成果并分离概念边界。 |
| 真实模型 | 默认最多 8 次计费尝试、无自动重试，执行前再授权 | 覆盖知识和连续决策，同时硬限制费用。 |
| 真实模型失败 | 任一结构/隔离/可信度失败即不通过 | 固定模型不能掩盖真实路径失败。 |
| 远端环境 | 显式 staging/acceptance 配置，名称与 ID 双校验 | 防止误操作生产 D1。 |
| 提交策略 | 文档全批后开发；脏改动先归属盘点 | 避免混入用户改动或未验证内容。 |

## Plan 自检

- F1–F2：Evidence Collector、Reducer、Audit 覆盖。
- F3：Classification、Upgrade、Policy Gate、只读 UI 覆盖。
- F4–F5：Model Contract、Knowledge Validator、真实模型旅程覆盖。
- F6：Durable Chat Request Service 覆盖。
- F7：Universe Policy Gate 与入口矩阵覆盖。
- F8：SSE Envelope 与客户端代次守卫覆盖。
- F9：Acceptance Harness 与报告同步覆盖。
- 依赖方向单向，产品运行时代码不依赖验收脚本。
- 未发现与 [spec.md](./spec.md) 冲突的技术决策。
