# s01｜P3 Fork 与 Compare 验收闭环 Plan

> 依据：[spec.md](./spec.md)。本阶段聚焦 P3 当前四项缺口：多 Worker 并发证据、多级 Fork 隔离矩阵、消息送达完整旅程和 Compare UI 人工走查。先复核已有实现；只有验收证据暴露实际缺陷时才改运行时代码。

## 架构概览

- **Fork 写入与竞争验证**：继续由现有 Fork 服务捕获源 revision、状态、事实与继承投影，并用 D1 原子批次创建子线。扩展现有隔离验收驱动器，启动两个独立 Worker，共享同一临时本地 D1，对成功、幂等重试、源版本竞争、容量冲突和事务失败进行竞争验证；若出现缺陷，只在现有服务/数据库约束边界修复。
- **Fork 可见性与只读审计**：继续复用不可变 checkpoint、祖先 cutoff、记忆/事件选择器及世界状态审计。扩展固定旅程夹具，组合验证 Root→Child→Grandchild 中记忆、承诺、知识的允许继承、冻结边界与隔离，不另建平行历史模型。
- **消息获知旅程**：复用在场传话的版本化提交和居民决策上下文中的知识装配。旅程从子线提交开始，检查正确接收者的上下文包含带来源/certainty 的知识，并检查其他居民和根线/旁支不可见；不以居民必须回复或采取固定行动为条件。
- **Compare 证据与界面验收**：后端继续使用单次数据库快照和 Fork provenance 构造对照证据；前端继续使用 Compare 面板显示共同历史、分叉条件、差异证据和限制说明。通过登录态本地浏览器走查结构化 Fork 与历史不完整旧 Fork，并记录用户可见结果；若发现缺陷，仅做满足 spec 的最小调整。

## 核心数据结构与接口

本阶段复用现有数据契约，不新增业务表或并行历史结构。

### ForkSnapshot

由 `api/src/agent/visibility.ts` 定义，作为 Fork 时冻结的继承证据：

```ts
interface ForkSnapshot {
  version: 1
  sourceTimelineId: string
  sourceSimTime: string
  capturedAt: string
  ancestorCutoffs: AncestorCutoff[]
  states: PersonStateRow[]
  schedules: ScheduleRow[]
  memories: MemoryRow[]
  events: EventRow[]
  dialogues?: DialogueRow[]
  dialogueTurns?: DialogueTurnRow[]
  commitments: CommitmentRow[]
  personaMessages?: PersonaMessageRow[]
  completeDomains?: ProjectionDomain[]
  historyComplete: boolean
  sourceStateVersion?: number
  worldModelVersion?: number
  worldFacts?: WorldFactRow[]
}
```

`PersonStateRow`、`ScheduleRow`、`MemoryRow`、`EventRow`、`DialogueRow`、`DialogueTurnRow`、`CommitmentRow`、`PersonaMessageRow` 和 `WorldFactRow` 分别对应数据库 schema 中同名投影表的选取行类型。

可选域用于兼容旧快照。缺少字段不能被视作空集合或完整历史。

### AncestorCutoff

```ts
interface AncestorCutoff {
  timelineId: string
  realTime: string
  simTime: string | null
}
```

用于限定后代时间线从每个祖先可继承的历史边界。

### KnownFact

居民决策上下文中可见的结构化事实：

```ts
interface KnownFact {
  kind: 'environment' | 'knowledge'
  text: string
  sourceFactId: string
  certainty: 'fact' | 'rumor'
}
```

消息旅程检查接收者、来源事实 ID 和 certainty；不得将消息提交成功等同于居民已经阅读或采取行动。

### Compare 结果

```ts
interface ForkEvidence {
  forkTimelineId: string
  sourceTimelineId: string | null
  sourceSimTime: string | null
  provenance: 'snapshot' | 'legacy'
  sourceStateVersion: number | null
  worldModelVersion: number | null
  scenario: ForkScenario | null
}

interface TimelineEvidence {
  id: string
  simNow: string
  status: string
  parentTimelineId: string | null
  historyComplete: boolean
}

interface StateFactAndEventDifferences {
  states: {
    personId: string
    changes: { field: string; left: string | null; right: string | null; leftEvidence: unknown; rightEvidence: unknown }[]
  }[]
  facts: { key: string; left: { value: unknown; factId: string; version: number; simTime: string } | null;
    right: { value: unknown; factId: string; version: number; simTime: string } | null }[]
  worldModelVersions: { left: number | null; right: number | null }
  events: { shared: EventEvidence[]; leftOnly: EventEvidence[]; rightOnly: EventEvidence[] }
}

interface EventEvidence {
  id: string
  simTime: string
  title: string
  description: string
}

interface ComparisonResult {
  worldId: string
  interpretation: 'observed_differences_not_causal_claims'
  timeAlignment: 'same_sim_time' | 'different_sim_times'
  left: TimelineEvidence
  right: TimelineEvidence
  sharedForkOrigin: {
    timelineId: string
    leftFork: ForkEvidence | null
    rightFork: ForkEvidence | null
  } | null
  differences: StateFactAndEventDifferences
  limitations: string[]
}
```

`TimelineEvidence` 保留两线 ID、模拟时刻、状态、父线及历史完整度；差异条目带对应时间线、模拟时间或事实 ID/version。此类型描述现有 API 结果的稳定语义，字段只在验收证明需要时调整。

### 核心接口

```ts
forkTimeline(
  db: Db,
  worldId: string,
  sourceId: string,
  scenario: ForkScenario | null,
  requestId?: string,
): Promise<{ id: string; simNow: string; snapshot: ForkSnapshot }>

compareTimelines(
  db: Db,
  worldId: string,
  leftId: string,
  rightId: string,
): Promise<ComparisonResult | null>

buildEngineContext(
  db: Db,
  personId: string,
  snapshot: WorldSnapshot,
): Promise<EngineContext | null>
```

`compareTimelines` 的结果包含两侧时间线证据、共同 Fork 来源、状态/事实/事件差异、时间对齐状态和限制说明。本阶段只有在验收发现缺字段或误导表述时才扩展结果。

Fork 相同请求 ID/相同载荷应重放同一子线；不同载荷或过期源状态以冲突结束。并发验收也核对活动时间线容量边界。

## 模块设计

### Fork 提交边界

**职责：** 捕获源 revision 与不可变状态快照；原子创建时间线及其初始投影；处理幂等重放与源状态/容量冲突。

**对外接口：** Fork 路由调用 `forkTimeline(...)`；成功返回既有子线与 checkpoint，冲突返回明确 409。

**依赖：** 时间线/版本表、`ForkSnapshot` 和现有数据库约束。若并发试验证明存在竞态，只在现有 D1 约束或提交事务边界修复。

### 继承可见性与审计

**职责：** 依据不可变 checkpoint 和祖先 cutoff 选择记忆/事件/知识；对结构化线检查投影与来源一致性，对旧线保留不完整状态。

**对外接口：** 继续使用现有可见性选择器和只读世界审计；测试层提供 Root→Child→Grandchild 组合矩阵。

**依赖：** Fork checkpoint、事实账本、记忆与承诺投影。

### 消息上下文旅程

**职责：** 从在场消息提交追踪至接收者的后续决策上下文，确认来源和 certainty；对其他人物/时间线执行不可见性断言。

**对外接口：** 复用在场提交路由和 `buildEngineContext(...)` 的知识装配边界；模型替身只用于确定性触发，不断言居民行为结果。

**依赖：** 在场命令/事实、Fork 可见性、居民上下文构造。

### Compare 证据与 UI

**职责：** 服务端汇总可授权的两线状态、共同 Fork 来源、差异证据和限制；客户端让用户检查这些证据、旧历史边界及返回目标线。

**对外接口：** 继续使用 Compare API 与 Compare 面板；仅在走查发现呈现缺口时改返回字段或页面提示。

**依赖：** 世界归属校验、Compare 单批读取、时间线选择状态。

### P3 验收驱动与记录

**职责：** 用临时 D1 启动多个 Worker 重复执行竞争场景；整理组合旅程、消息旅程及登录态 Compare 走查证据。

**对外接口：** 开发/验收工具，不成为产品运行模块；结果写入审计报告和 checklist。

**依赖：** 本地 Wrangler/Worker、固定模型替身、合成账号与临时目录。

## 模块交互

```text
Fork UI
  → 已登录的世界 Fork 路由（归属、活动状态、条件、请求 ID）
  → forkTimeline 读取源线与祖先证据
  → 原子写入子线、revision 0、状态/日程/承诺副本与不可变 checkpoint
  → 返回子线 ID 与来源版本
```

```text
Root → Child → Grandchild 隔离旅程
  → 每个分叉点固定当前可继承证据
  → 在父线/子线分别追加记忆、承诺、知识
  → 可见性选择器按 checkpoint/cutoff 计算各线可见集合
  → 只读审计对照快照、事实账本与当前投影
  → 断言允许继承的内容可见，越界内容不可见
```

```text
Child 中提交消息
  → 在场提交器写入版本化来源事实
  → buildEngineContext(接收者, Child)
  → 仅接收者上下文包含该来源与 certainty
  → 检查其他居民、Root 与旁支上下文均不可见
```

```text
Compare 面板
  → 已登录 Compare 路由（验证世界归属及两条时间线）
  → compareTimelines 在单次 D1 batch 读取状态/版本/事实/事件
  → 合并每条线自己的不可变 Fork checkpoint
  → 返回共同祖先、分叉来源、差异证据、时间对齐与限制
  → UI 人工检查结构化 Fork、legacy Fork 和返回选线行为
```

并发 Worker 旅程在每轮请求前用屏障对齐启动，轮后检查所有写入和数据库不变量；故障与拒绝路径通过事务前后快照确认无副作用。自动旅程的结构化证据与人工 UI 观察分别记录，不互相替代。

## 文件组织

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `scripts/verify-s01-workers.ts` | 在现有隔离 Worker/D1 驱动器中补 Fork 并发、重放、源版本冲突与容量冲突场景；沿用临时目录和清理机制。 |
| 修改 | `api/src/life/compare.test.ts` | 补 Root→Child→Grandchild 的记忆、承诺、知识继承/隔离矩阵，以及拒绝/失败无副作用断言。 |
| 修改 | `api/src/test/world-journey.test.ts` | 补子线消息提交→接收者上下文→根线/其他接收者不可见的完整固定模型旅程。 |
| 条件修改 | `api/src/life/fork.ts`、`api/src/worlds/routes.ts`、相关数据库迁移 | 仅当并发证据复现实际竞争缺陷时，修复快照/事务/约束边界。 |
| 条件修改 | `api/src/agent/visibility.ts`、`api/src/world-state/invariants.ts` | 仅当隔离矩阵或只读审计发现可见性/完整性缺陷时修复。 |
| 条件修改 | `api/src/life/compare.ts`、`web/src/components/world/ComparePanel.tsx` | 仅当登录态走查发现证据缺失、误导文案或返回选线串线时调整。 |
| 修改 | `docs/current-state-audit.md` | 记录 P3 起点、逐项现有覆盖、隔离环境和本轮证据。 |
| 修改 | `docs/world-quality-report.md` | 更新 P3 阶段状态、通过证据及未关闭边界。 |
| 修改 | `spec_docs/s01/checklist.md` | 将 AC1–AC6 逐项转成执行清单并填写实际结果。 |

本计划不预设新增业务表、依赖、迁移或浏览器自动化框架；条件修改项只有在验收发现缺陷时才进入实现。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 多实例环境 | 扩展已有本地 Worker 驱动器，让两个独立进程共享一次性 D1 文件；不连接远端 D1。 | 与已确认的环境一致，能实际覆盖跨 Worker 竞争，同时保持数据库和凭据隔离。 |
| 并发测试形式 | 固定种子数据、固定请求载荷，对两个 Worker 发起同步竞争；用响应与最终 D1 账本/时间线状态判定，不以耗时或吞吐量作为标准。 | 本阶段验证原子性、幂等和边界，不是性能基准测试。 |
| Fork 历史模型 | 继续以不可变 `ForkSnapshot` 和祖先 cutoff 为继承依据；只在证据显示缺域或错误继承时修复。 | 避免新增第二套历史来源，也防止覆盖现有 legacy 兼容规则。 |
| 多级隔离验证 | 采用固定夹具分别在 Fork 前/后写入记忆、承诺和知识，并逐线核对可见性与审计结果。 | 对应 P3 当前未闭合的组合矩阵，结果不依赖模型随机行为。 |
| 消息送达语义 | 将提交、接收者知识可用、居民实际回应作为不同观察状态；验收前两者及隔离，后者不设固定预期。 | 与 spec 的消息边界一致，避免把事实写入夸大成居民行为承诺。 |
| Compare 走查 | 使用本地合成账号及隔离数据，人工检查结构化与 legacy Fork 的证据/限制提示；界面缺陷才改 UI。 | 现有 API/UI 已有证据字段，需证明实际用户可读且不会误导。 |
| 数据库结构 | 当前不新增业务字段或表；若验收发现现有不可变快照无法表达必要来源，再单独评估最小结构调整。 | 已有 checkpoint、revision 和 facts 覆盖本轮需求，先检验其行为。 |

## Spec 覆盖

| Spec 项 | Plan 归属 |
|---|---|
| F1、AC1：并发 Fork 一致性 | Fork 写入与竞争验证模块；隔离 Worker 驱动器与现有 Fork 提交边界。 |
| F2、AC2：多级记忆/承诺/知识隔离 | Fork 可见性与只读审计模块；Root→Child→Grandchild 固定旅程。 |
| F3、AC3：消息进入正确接收者上下文 | 消息上下文旅程；版本化消息提交与 `buildEngineContext`。 |
| F4–F5、AC4：Compare 证据及因果边界 | Compare 证据与 UI 模块；API 单批读取及登录态浏览器走查。 |
| F6、AC5：访问和失败无副作用 | Fork/Compare 路由与提交边界；并发/权限/故障前后快照断言。 |
| AC6：P3 出口报告 | P3 验收驱动与记录；审计报告和 checklist。 |
