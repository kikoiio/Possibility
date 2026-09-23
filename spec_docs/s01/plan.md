# s01｜P1 世界状态一致性与连续推进 Plan

## 架构概览

本阶段沿用现有版本化命令与事实作为写入账本，不改变运行时提交机制。新增只读的投影重建路径：从不可变根线基线或 Fork checkpoint 出发，按版本重放已支持动作，构造预期投影，再与当前投影比较。审计入口汇总现有不变量检查与重建差异；检查器不修复、不写回世界状态。

```text
不可变主线基线 / Fork checkpoint
                 +
        按版本排序的命令与事实
                 │
                 ▼
        只读重建预期投影
                 │
                 ├── 与当前 D1 投影比较
                 └── 输出差异及命令/版本来源
                                           │
                                           ▼
                                auditUniverse 汇总
```

基线和当前投影、命令/事实通过一次一致性读取收集，避免在审计过程中读到不同版本。确定性连续旅程以测试控制的时钟逐拍调用现有引擎；多 Worker 旅程在同一新建隔离本地 D1 上同时发送 tick 请求。

## 核心数据结构

### ProjectionDomain

```ts
type ProjectionDomain =
  | 'clock' | 'states' | 'schedules' | 'events'
  | 'commitments' | 'memories' | 'dialogues'
  | 'dialogueTurns' | 'personaMessages' | 'knowledge'
```

`knowledge` 表示按当前时间线 checkpoint/祖先截止点可见的事实视图；事实账本本身仍是重放输入，不是可写回的投影。

### ProjectionRows

保存可比较的世界投影行集合：居民状态、日程、事件、承诺、记忆、对话、逐句发言和访客留言。`simTime` 表示时钟投影；`knowledge` 从有来源且在该线可见的知识事实派生。行使用数据库 schema 对应的类型，语义比较时按稳定 ID 排序。

```ts
type ProjectionRows = {
  simTime: string
  states: PersonStateRow[]
  schedules: ScheduleRow[]
  events: EventRow[]
  commitments: CommitmentRow[]
  memories: MemoryRow[]
  dialogues: DialogueRow[]
  dialogueTurns: DialogueTurnRow[]
  personaMessages: PersonaMessageRow[]
  knowledge: WorldFact[]
}
```

`PersonStateRow` 等行类型分别对应 `api/src/db/schema.ts` 中的持久化表记录；`knowledge` 是可见事实视图，不额外创建持久化表。

### ProjectionBaseline

```ts
interface ProjectionBaseline {
  source: 'root' | 'fork'
  version: number
  capturedAt: string
  simTime: string
  completeDomains: ProjectionDomain[]
  rows: Partial<Omit<ProjectionRows, 'simTime' | 'knowledge'>>
}
```

根线基线保存在不可变固定模型版本的扩展字段中；Fork 基线保存在时间线 checkpoint 中。完整域可以明确为空集合。缺少域不等于空集合，而表示该域不能被证明完整。

### TimelineEvidence

```ts
interface TimelineEvidence {
  timelineId: string
  revisionVersion: number
  revisionSimTime: string
  baseline: ProjectionBaseline | null
  commands: WorldCommand[]
  facts: WorldFact[]
  current: ProjectionRows
}
```

命令和事实按结果版本关联；Fork 的继承事实由其不可变 checkpoint 提供，并与子线本地事实按版本边界组合。

### ProjectionDifference 与 ReconstructionResult

```ts
interface ProjectionDifference {
  domain: ProjectionDomain | 'history'
  recordId?: string
  kind: 'missing' | 'mismatch' | 'unproven' | 'unsupported'
  commandId?: string
  version?: number
  detail: string
}

interface ReconstructionResult {
  status: 'complete' | 'incomplete' | 'legacy' | 'unsupported'
  throughVersion: number
  expected: ProjectionRows
  differences: ProjectionDifference[]
}
```

### 接口

```ts
collectTimelineEvidence(db, worldId, timelineId): Promise<TimelineEvidence>
rebuildProjection(evidence): ReconstructionResult
compareProjection(expected, current): ProjectionDifference[]
auditUniverse(db, worldId, timelineId): Promise<InvariantViolation[]>
```

- `collectTimelineEvidence` 只读取数据库，不调用会初始化或修改 revision 的写入口。
- `rebuildProjection` 是确定性 reducer，按版本验证命令/事实并计算预期投影；未知动作或不完整基线会返回对应状态，不静默跳过。
- `compareProjection` 比较域内语义字段、缺失行和多余行；忽略与世界状态无关的运行时维护字段。
- `auditUniverse` 保留现有命令、事实和版本校验，并将重建差异转换为现有审计问题格式。

## 模块设计

### 根线基线与 Fork checkpoint

**职责：** 为新建的结构化根线固定版本 0 的完整投影域集合；为 Fork 固定源线检查点的继承投影、可见事实和完整性信息。旧记录若缺少域快照，明确标为不完整，不将当前可变行追认为历史基线。

**主要位置：** `api/src/world-state/model.ts`、`api/src/agent/visibility.ts`、`api/src/life/fork.ts`、`api/src/worlds/routes.ts`、`api/src/persons/routes.ts`。

**依赖：** 已有不可变 `world_model_versions` 与 `fork_snapshot_json` 存储及其数据库保护。

### 只读投影重建器

**职责：** 从基线、版本化命令与事实建立预期状态；根据动作重建时钟、居民状态、日程、事件、承诺、记忆、对话、逐句发言、访客留言和知识可见集合；为未知动作、缺失证据和差异定位来源命令/版本。

**对外接口：** `collectTimelineEvidence`、`rebuildProjection`、`compareProjection`。

**主要位置：** 新建 `api/src/world-state/rebuild.ts` 与 `api/src/world-state/rebuild.test.ts`。

**依赖：** 根线/分叉基线、`world_commands`、`world_facts` 及各当前投影表。

### 一致性审计入口

**职责：** 将既有版本连续性、命令—事实语义检查与完整重建比较结合。权限、归属与公开只读边界由相关 API 路由回归验证。旧线和缺失投影域仍可报告已知不变量问题，但不能宣称完整重建通过。

**主要位置：** `api/src/world-state/invariants.ts`、`api/src/world-state/invariants.test.ts`。

**依赖：** 只读证据收集器与纯重建器。

### 确定性连续推进旅程

**职责：** 用固定居民、完整日程和固定模型响应推进至少一整天模拟时间；逐拍核对时钟、日程切换、居民状态、事实和事件，最终运行完整审计。测试倍率只存在于验收环境。

**主要位置：** `api/src/test/world-fixture.ts`、`api/src/test/world-journey.test.ts`、`api/src/engine/tick.test.ts`。

**依赖：** 现有 tick、虚拟时钟推进和版本化提交边界。

### 隔离本地 D1 多 Worker 旅程

**职责：** 新建可丢弃的本地持久化目录，应用迁移并播种固定夹具；启动两个独立 Worker 实例，共享该目录并同时推进同一时间线；核对租约、fencing、修订与投影结果；结束后清理 Worker 和目录。

**主要位置：** 新建 `scripts/verify-s01-workers.ts`，并在根目录 `package.json` 添加专用验收命令。

**依赖：** 本地 Wrangler D1、`engineTickLeases`、版本化提交路径。Wrangler 本地 D1 支持通过 `--persist-to` 指定持久化位置，详见 [Cloudflare D1 本地开发文档](https://developers.cloudflare.com/d1/best-practices/local-development/)。所有迁移和 Worker 命令必须使用同一个临时目录与本地模式。

### 失败、权限和 Fork 矩阵

**职责：** 在现有提交、引擎、场景、权限和 Fork 回归中补齐成功/拒绝/取消/恢复/重复/竞争案例。每个拒绝案例检查版本、事实、投影和时间线集合无变化；多级 Fork 检查 checkpoint 之后的祖先内容不会泄漏。

**主要位置：** `api/src/world-state/commit.test.ts`、`api/src/engine/tick-lease.test.ts`、`api/src/engine/tick.test.ts`、`api/src/life/compare.test.ts` 及相关路由测试。

**依赖：** 固定小世界夹具与隔离 D1。

### 阶段证据

**职责：** 记录 P1 各验收项的实际命令、环境、结果、关键观察及 legacy 降级范围；所有 AC 通过后才标记阶段出口通过。

**主要位置：** `docs/current-state-audit.md`。

**依赖：** 自动化测试和隔离 Worker 旅程的实际运行结果。

## 模块交互

```text
新建根线 ──→ 固定版本 0 基线
Fork 创建 ──→ 父线 checkpoint ──→ 子线固定 checkpoint

验收调用
   │
   ├── 一致性读取：基线/checkpoint + 当前投影 + 命令/事实 + 时间线版本
   │
   ▼
证据收集器 ──→ 纯重建器 ──→ 投影比较器
                                 │
                                 ├── 无差异：结构化时间线重建一致
                                 └── 差异/缺证：返回域、行、来源命令/版本
                                           │
                                           ▼
                                auditUniverse 汇总报告
```

读路径只从一个 D1 batch 收集同一时点的数据。重建器对命令与事实按版本排序，先验证二者关联及支持范围，再计算预期投影；比较器按稳定 ID 和域语义字段比较。审计始终只读。

连续旅程由测试时钟逐拍推进，至少覆盖完整的一天模拟时间，并在每拍后核对版本和状态；最终运行重建审计。多 Worker 旅程由隔离脚本准备唯一 D1 目录，两个 Worker 实例同时发送请求，随后检查只有一个有效结果、旧租约 token 不能提交，且所有投影与账本一致。失败/恢复/Fork 场景通过故障注入和固定请求 ID 验证，无副作用以修订、事实、投影及时间线行前后比较为证。

## 文件组织

```text
spec_docs/s01/
├── spec.md                         — 已批准的 P1 行为规格
├── plan.md                         — 本技术设计
├── task.md                          — 待审批后拆分的执行步骤
└── checklist.md                    — 待审批后定义的行为验收项

api/src/world-state/
├── model.ts                        — 根线结构化基线与完整性信息
├── rebuild.ts                      — 证据收集、纯重建、投影比较
├── rebuild.test.ts                 — 重建、差异定位及 legacy 降级
├── invariants.ts                   — 汇总现有不变量和重建差异
└── invariants.test.ts              — 命令、事实、版本和投影审计回归

api/src/agent/
└── visibility.ts                   — Fork checkpoint 类型、读取与继承边界

api/src/life/
└── fork.ts                         — 捕获完整的子线 checkpoint

api/src/
├── worlds/routes.ts                — 新建世界时固定根线基线
├── persons/routes.ts               — 人物快捷建世界时固定根线基线
├── test/world-fixture.ts           — 固定居民、日程、状态和模拟时间
├── test/world-journey.test.ts      — 重建、多拍和多级 Fork 旅程
└── engine/tick.test.ts             — 加速时钟下的完整日推进

scripts/
└── verify-s01-workers.ts           — 隔离 D1 多 Worker 并发验收

package.json                        — 添加本地多 Worker 验收命令
docs/current-state-audit.md         — 追加 P1 验收证据与阶段判断
```

无需增加 SQL schema 迁移；基线与 checkpoint 在已有不可变 JSON 字段中扩展。新增的多 Worker 命令只能在临时本地持久化目录执行。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 投影重建 | 只读、确定性的 reducer 生成预期投影，再与当前记录比较 | 不改写数据，可定位缺失、篡改和无来源记录 |
| 命令/事实语义 | 从现有审计路径提取可复用的纯映射逻辑 | 防止重建器与审计器维护两套不一致规则 |
| 基线完整性 | 根线基线与 Fork checkpoint 明确列出完整投影域 | 旧线缺失的历史证据不会被误判为空或完整 |
| 基线持久化 | 扩展不可变固定模型 JSON 与 Fork checkpoint JSON | 复用既有持久化和不可变保护，避免 D1 schema 迁移 |
| 领域比较 | 按语义字段、稳定 ID 和稳定顺序比较 | 避免行顺序或无关运行时字段造成误报 |
| 完整日旅程 | 测试时钟与确定性模型替身驱动现有 tick | 加速验收但不改变线上倍率，不依赖真实模型 |
| 多 Worker 环境 | 临时本地 D1 目录、两个独立 Worker、显式本地模式，禁用 Wrangler metrics | 测量跨实例竞争，同时避免接触默认/远端数据库 |

## 需求追踪

| Spec 项 | 设计归属 | 主要验证位置 |
|---|---|---|
| F1 / AC2–AC3 | 根线/分支基线、只读重建器、域比较与差异诊断 | `world-state/rebuild.test.ts`、`world-state/invariants.test.ts` |
| F2、F7 / AC4、AC10–AC11 | Fork checkpoint、祖先截止点及多级投影重建 | `life/compare.test.ts`、`test/world-journey.test.ts` |
| F3 / AC1、AC5、AC11 | 固定居民、多日程边界及加速 tick 旅程 | `engine/tick.test.ts`、`test/world-journey.test.ts` |
| F4 / AC6 | 请求重放、内容冲突、CAS 与原子回滚 | `world-state/commit.test.ts`、相关路由测试 |
| F5 / AC7 | 场景取消/恢复、待处理请求过期与迟到提交拒绝 | `scene/recovery.test.ts`、场景路由测试 |
| F6 / AC8–AC9 | 隔离 D1 多 Worker 竞争及拒绝边界矩阵 | `scripts/verify-s01-workers.ts`、`engine/tick-lease.test.ts`、路由测试 |
| N4–N5 / AC12 | legacy 降级及验收证据报告 | `world-state/rebuild.test.ts`、`docs/current-state-audit.md` |

## 自检

- Spec 覆盖：F1–F7 均在基线/重建器、引擎旅程、提交/并发矩阵或 Fork 模块中有明确归属。
- 接口完整性：证据收集、纯重建、投影比较和统一审计入口的输入/输出已定义。
- 依赖清晰度：基线与 checkpoint → 证据收集 → 重建 → 比较 → 审计；写入路径不依赖重建器，无循环依赖。
- 矛盾检查：legacy 证据保持未知；隔离重建不写回；加速时钟只影响测试；多 Worker 使用显式临时本地 D1。
