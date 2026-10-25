# 轨道间接口约定(P0.5,P1 四轨的实现契约)

日期:2026-10-25。状态:**生效**(随 M0 冻结)。本文冻结 P1 四轨(domain/store/clock/llm)之间的 TypeScript 接口签名;改动视同 contract 变更,须同步所有在跑轨道。模块依赖禁令见 ARCHITECTURE §3。

## 1. domain 轨道(A)导出清单

`packages/engine/src/domain/index.ts` 必须导出(纯函数,零 I/O/时间/数据库):

```ts
export type Diagnostic = { nodeId?: string; requirementId: string; message: string };
export class DomainError extends Error { diagnostics: Diagnostic[] }   // 演算失败整段拒绝

// 应用 ops:成功返回新世界与变更路径;任何一条非法则整体抛 DomainError,不部分应用。
// path 为 RFC 6901 子集;禁 __proto__/constructor/prototype;set 要求父路径存在且必带 value;
// remove 要求目标存在且禁带 value;写 entities/*/location 时校验引用存在。
export function applyOps(world: WorldState, ops: Op[]): { world: WorldState; changes: string[] };

// 同 applyOps 的校验逻辑,但不应用;llm 载荷校验用。
export function validateOps(world: WorldState, ops: Op[]): Diagnostic[];

// 记忆行校验:owner/about 引用存在、valence∈[-1,1]、intensity∈[0,1]、importance 为 1..10 整数、about 非空。
export function validateMemories(world: WorldState, memories: Memory[]): Diagnostic[];

// 世界不变量:entities 为对象;location 引用存在(供 store 重启恢复后复检)。
export function validateWorld(world: WorldState): Diagnostic[];

// 计划校验:fromMinutes === 基准 worldTimeMinutes;事件按 atMinutes 升序;id 唯一;
// 逐事件 applyOps 演算整段可行(在副本上推演,不改入参)。
export function validatePlan(world: WorldState, plan: Plan): Diagnostic[];

// 草稿应用(fork 基准):对 base.world 应用 ops,返回新世界与 changedPaths(edit revision 用)。
export function applyDraft(base: WorldState, ops: Op[]): { world: WorldState; changes: string[] };
```

## 2. store 轨道(B)实现、D/E 轨道消费的接口

`packages/engine/src/store/index.ts` 导出 `class Store implements StoreApi`;D/E 只 import 类型 `StoreApi`(定义在 `engine/src/store/api.ts`,B 轨先行提交该文件的最小占位类型以解依赖——允许先提交类型、后交实现)。

```ts
export type MemoryRow = Memory & {
  lineId: string;
  atMinutes: Minutes;              // 事件世界时间
  lastAccessedMinutes?: number;    // 检索命中时由 store 回写
};
export type ReflectionRow = {
  lineId: string; owner: string;
  version: number; text: string; fromMinutes: Minutes; toMinutes: Minutes;
  generatedAt: EpochMs;
};

export interface StoreApi {
  // 线(T4:单事务内改元数据)
  getLine(id: string): Promise<WorldLine | null>;
  listLines(): Promise<WorldLine[]>;
  createLine(line: WorldLine): Promise<void>;
  updateLine(id: string, patch: Partial<Pick<WorldLine,
    'name' | 'speed' | 'paused' | 'plan' | 'status' | 'error' | 'retryAt'
    | 'headRevisionId' | 'worldTimeMinutes'>>): Promise<void>;

  // revision(T2:N 个新 revision + line 头部更新同一事务)
  getRevision(id: string): Promise<Revision | null>;
  appendRevisions(lineId: string, revisions: Revision[]): Promise<void>;
  pageLog(lineId: string, q: { beforeRevisionId?: string; limit: number }): Promise<LogPage>;

  // 草稿(T3)
  createDraft(draft: Draft): Promise<void>;
  getDraft(id: string): Promise<Draft | null>;
  deleteDraft(id: string): Promise<void>;

  // 审计(永不删除)
  createCall(call: LlmCall): Promise<void>;
  updateCall(id: string, patch: Partial<Pick<LlmCall,
    'status' | 'attempts' | 'usage' | 'error' | 'finishedAt'>>): Promise<void>;
  getCall(id: string): Promise<LlmCall | null>;

  // 记忆(Q11 表;appendMemories 回填 sourceEventId)
  appendMemories(lineId: string, memories: Memory[], sourceEventId: string): Promise<void>;
  getMemories(lineId: string, owners: string[], limit: number): Promise<MemoryRow[]>;
  searchMemoryText(lineId: string, owners: string[], query: string, limit: number): Promise<MemoryRow[]>; // FTS5 trigram
  touchMemories(ids: string[], atMinutes: number): Promise<void>;   // 检索命中回写 lastAccessed

  // L2 叙事(版本化,读最新)
  getReflection(lineId: string, owner: string): Promise<ReflectionRow | null>;
  saveReflection(row: ReflectionRow): Promise<void>;                // version = 旧+1

  // 事务边界(T1–T4);fn 内全部操作原子提交
  transaction<T>(fn: (tx: StoreApi) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
export function openStore(path: string): Promise<Store>;   // 建表+FTS5 虚表+迁移检查
```

重启恢复(B 内部):`recoverInFlight()`——inFlight call 标 failed、line 回 ready,不伪造结果。

## 3. clock 轨道(C)导出清单

```ts
export type LineClockState = {
  lineId: string; speed: number; paused: boolean;
  anchorWallMs: EpochMs;        // 上次采样墙钟
  anchorWorldMinutes: number;   // 上次提交的整数世界分钟(内部保存小数累积)
};
// 采样:单调积分(真实时长×speed),内部积累小数,提交整数分钟;paused 不积累。
// 返回 [新状态, 新到达的整数世界分钟]。持久化只存整数(worldTimeMinutes)+anchor。
export function sampleClock(state: LineClockState, now: EpochMs): { state: LineClockState; newMinutes: number[] };
export function createClockState(lineId: string, opts?: Partial<LineClockState>): LineClockState;
// 到期计算:plan 事件中 atMinutes ≤ 当前世界分钟的事件,按序返回。
export function dueEvents(plan: Plan | null, worldTimeMinutes: Minutes): PlannedEvent[];
```

## 4. llm 轨道(D)导出清单与组装输入

```ts
export interface LlmSettings { models: string[]; baseUrl: string; apiKey: string;
  segmentWorldMinutes: number; minIntervalSeconds: number;
  hourlyLimit: number; dailyLimit: number; concurrency: number; }

// 调用:候选模型回退(404/429/503)、尊重 retry-after、等待间隔与请求超时分离、
// 全量审计(经 store.createCall/updateCall)。预算耗尽抛 BudgetExhaustedError。
export interface LlmGateway {
  beat(input: BeatInput): Promise<{ plan: Plan; callId: string }>;
  edit(input: EditInput): Promise<EditProposal>;
}
export type BeatInput = {
  lineId: string; baseRevisionId: string;
  world: WorldState;
  recentEvents: LogEntry[];                       // 近窗 verbatim(默认 12)
  memoryRows: MemoryRow[];                        // store 检索结果(已按可见集过滤)
  reflections: ReflectionRow[];                   // 在场角色的 L2
  worldTimeMinutes: Minutes;
};

// 记忆组装(D 内部,确定性、可复现):score = R + I + Rel×C
//   R = exp(-Δ世界分钟/τ), τ 随 intensity 增大;I = importance;
//   Rel = 实体图两跳(场景实体→about→该行 about 实体);C = valence 与关系极性(聚合推导)同号>1 异号<1
// 裁剪次序:先减检索条数 K(记审计)→ 世界状态与近窗永不裁 → 超预算抛 ContextBudgetError(显式失败)。
export function assembleBeatMessages(input: BeatInput, budgetTokens: number): ChatMessage[];
```

D 对 `StoreApi`/`MemoryRow`/`ReflectionRow` 仅 import 类型(B 的 api.ts 占位);D 自身不打开数据库、不 import domain——载荷校验由调用方(E)用 domain 完成。

## 5. 轨道边界速查

| 轨道 | 目录 | 可 import | 禁止 |
| --- | --- | --- | --- |
| A domain | engine/src/domain | contract | I/O、时间、DB、fetch |
| B store | engine/src/store | contract、domain(校验复用) | 业务决策、LLM |
| C clock | engine/src/clock | contract | 写库、LLM |
| D llm | engine/src/llm | contract、store 的 api.ts 类型 | domain、直接开库、改世界 |

## 6. P2 补充接口:projection(G 轨道实现,E/F 消费)

`packages/engine/src/projection/index.ts` 导出(纯函数,不依赖 three/web):

```ts
// SceneDocument:3D 场景语义文档,形状以 scratch/geometry-lab/src/scene-document.js
// 的 village 子集为准(regions: water/island;objects: library/porch/bridge/tree/
// house/path/character;style.voxelUnit 等),由 WorldState 实体字段(kind/location/
// x/z/width/depth/height/route/position 等开放字段)投影派生。
export type SceneDocument = { /* G 轨道定义并导出完整类型 */ };

// view:契约的轻量 RendererView(shell 总览/连线用);scene:3D 渲染器唯一输入。
// 未知 kind 实体进 view.others,不阻塞投影。
export function projectWorld(world: WorldState, worldTimeMinutes: Minutes,
  revisionId: string, recentText: string | null): { scene: SceneDocument; view: RendererView };
```

runtime(E)通过注入使用 `projectWorld`(可传桩以便测试);web 壳(F)只消费 `view`;3D 渲染器(G 的 web 侧)只消费 `scene` 并按 recipeHash 内容键做部件级增量重建。

## 7. P3-J additive 在场接口（补充 §4）

`packages/engine/src/llm/client.ts` 的 `LlmGateway` 增加：

```ts
export type ChatInput = {
  lineId: string; baseRevisionId: string;
  asEntity: string; otherEntity: string; text: string;
  world: WorldState; visibleMemories: Memory[]; worldTimeMinutes: Minutes;
};
export type ChatResult = {
  text: string; ops?: Op[];
  memories: { asEntity: Memory[]; otherEntity: Memory[] };
};
chat(input: ChatInput): Promise<ChatResult & { callId: string }>;
```

`visibleMemories` 仅含对话对象 owner 的可见记忆；gateway 复用 beat/edit 的 OpenAI 兼容回退、预算、超时与完整 call 审计。
