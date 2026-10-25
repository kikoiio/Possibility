# Wispiva v1 数据契约草案

日期：2026-10-25
状态:**已冻结(M0,门 G0,2026-10-25)**——11 项开放问题全部裁决并落地为 `packages/contract`(类型+Schema+fixtures,提交 36bbb8d/c2ee3ee);此后任何改动走 ARCHITECTURE.md §9 变更协议(独立 PR、同步 fixtures、列出受影响模块)。
与 [ARCHITECTURE.md](ARCHITECTURE.md) §4 的关系：把 §4 的方向性草图细化为字段级定稿建议，补齐草图未定义的 DTO/SSE/投影元素类型，并标注含糊点。与 §4 冲突处以差异表（§7）呈报评审裁决，不在本文擅自定案。

## 1. 基础类型

```ts
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Minutes = number;   // 世界时间，单位分钟；整数（Q8 已决），内部积累小数、事务提交取整
type EpochMs = number;   // 墙钟时间，UTC 毫秒
```

## 2. 核心类型定稿建议（每类型一句话语义；`?` = 可选字段）

```ts
/** WorldState：某条世界线在某个 revision 时刻的完整事实文档；字段开放，不变量属 domain */
type WorldState = {
  entities: Record<string, Entity>;   // key 即实体 id，实体对象内不重复 id
                                       // 记忆不内嵌（Q11 已决）：存独立表,事件仅携带当次增量
  [key: string]: Json;                // premise/rules/magic/自定义容器均允许
};
/** Entity：世界中的可命名对象（角色/地点/物品/自定义），空间字段供投影使用 */
type Entity = {
  kind: string;                       // 建议枚举见 Q4：character/place/item/...，允许自定义
  name?: string;
  location?: string;                  // 必须引用 entities 中已存在的 key
  x?: number; z?: number; width?: number; depth?: number; height?: number;
} & Record<string, Json>;
/** Op：对 WorldState 的最小修改指令；path 为相对 world 根的 JSON Pointer（RFC 6901） */
type Op = {
  op: 'set' | 'remove';
  path: string;                       // set 要求父路径存在；remove 要求目标存在
  value?: Json;                       // op=set 时必填（Q5 已决：直接 JSON 值,非序列化字符串）;remove 时禁止携带
};
/** Memory：一个角色的一条主观记忆（owner 分行,DESIGN-memory.md）;数值由生成方按 appraisal 路径声明 */
type Memory = {
  id: string;
  owner: string;                      // 拥有者实体 id（Q11 已决:knownBy 废除,按人分行）
  text: string;                       // owner 的带色要点,非逐字原文
  valence: number;                    // -1..1 情绪极性
  intensity: number;                  // 0..1 情绪强度/唤醒度
  importance: number;                 // 1..10 显著性
  about: string[];                    // 实体引用,检索锚点
  emotion?: string;                   // Plutchik 8 类词表(可选)
  sourceEventId?: string;             // 由提交路径回填
};
/** PlannedEvent：计划中的一件未来事件，到 atMinutes 才提交为事实 */
type PlannedEvent = {
  id: string; atMinutes: Minutes;     // atMinutes 为世界时间轴上的绝对分钟
  text: string;
  ops: Op[];                          // 必填，允许空数组（纯叙述事件）
  memories: Memory[];                 // 必填，允许空数组
};
/** Plan：一次被接受的 LLM 推演产出的整段未来计划；校验失败整段拒绝，不部分提交 */
type Plan = {
  fromMinutes: Minutes;               // 演算基准（应等于当时 line.worldTimeMinutes）
  toMinutes: Minutes;                 // 末事件之后的时间窗下界
  events: PlannedEvent[];
  callId: string;                     // 指向产生它的 LlmCall.id
};
/** Revision：不可变历史节点，v1 存完整世界快照；event 描述本次如何演化 */
type Revision = {
  id: string; parentId: string | null;   // origin 为 null
  worldTimeMinutes: Minutes;
  event: {
    id: string; kind: 'origin' | 'edit' | 'story';
    text: string;
    ops?: Op[]; changes?: string[];   // edit/story 可有；changes = 分岔时 changedPaths（JSON Pointer）
    memories?: Memory[];              // story/edit 当次记忆增量（Q11,供展示;持久层另存表）
    callId?: string; atMinutes: Minutes;  // callId 仅 edit/story；atMinutes 定稿必填：origin=0、edit=分岔、story=事件（§7）
  };
  world: WorldState;
};
/** WorldLine：一条持续运转的世界线的运行时元数据；不含 world 本体 */
type WorldLine = {
  id: string;
  name: string;                       // 默认 α/β/γ…，可改名
  parentLineId: string | null;
  forkRevisionId: string | null; forkTimeMinutes: Minutes | null;   // 分岔基准
  headRevisionId: string; worldTimeMinutes: Minutes;
  speed: number; paused: boolean;     // speed 默认 24，世界分钟/真实分钟
  plan: Plan | null;
  status: 'ready' | 'generating' | 'error';
  error: string | null;
  retryAt: EpochMs;                   // 定稿为墙钟毫秒（草图只写 number，见 Q7）
};
/** Draft：「如果…」编辑用的固定基准副本；确认后产生新世界线，父线不受影响 */
type Draft = {
  id: string;
  lineId: string | null; baseRevisionId: string | null;   // 均为 null = 纯创世草稿
  worldTimeMinutes: Minutes; speed: number; paused: boolean;
  world: WorldState;
  createdAt: EpochMs;
};
/** LlmCall：一次 LLM 推演请求的全量审计记录，永不删除 */
type LlmCall = {
  id: string; kind: 'beat' | 'edit'; lineId: string;
  baseRevisionId: string; startMinutes: Minutes;
  status: 'pending' | 'accepted' | 'failed' | 'discarded';
  messages: ChatMessage[];            // 发出的完整 prompt 消息
  attempts: {
    model: string; status: number; latencyMs: number;   // status = HTTP 状态码
    raw: string; request: string;     // 原始返回文本 / 序列化请求体（草图 unknown，见 §7）
  }[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: string;
  startedAt: EpochMs; finishedAt?: EpochMs;
};
/** ChatMessage：OpenAI 兼容消息；contract 自带，避免依赖 OpenAI 类型 */
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
/** ViewNode：投影后的地点/泛化节点，空间字段已补默认值，渲染器零判断消费 */
type ViewNode = {
  id: string; kind: string; name: string;
  x: number; z: number;
  width: number; depth: number; height: number;   // 缺失由 projection 填默认值
};
/** ViewCharacter：已解析 location 的角色节点；locationId 供连线/跟随镜头使用 */
type ViewCharacter = ViewNode & { locationId: string | null };
/** RendererView：渲染器唯一输入，由 projection 纯函数产出 */
type RendererView = {
  lineId: string; revisionId: string; worldTimeMinutes: Minutes;
  places: ViewNode[];
  characters: ViewCharacter[];        // location 已解析
  others: ViewNode[];                 // 未知 kind 泛化节点，v1 不生成美术资产
  recentText: string | null;          // 最近确认事件，供字幕/画面说明
};
```

## 3. API DTO 与 SSE 事件（§4 末尾仅有名字清单，以下为字段级建议）

```ts
/** LogEntry：对外历史条目 = Revision 去掉 world（StateSnapshot/log 不得携带完整 world） */
type LogEntry = Omit<Revision, 'world'>;
/** StateSnapshot：GET /api/state 全量对齐负载；SSE 重连后先收它再消费增量 */
type StateSnapshot = {
  schemaVersion: number;                        // 见 Q1
  lines: WorldLine[];
  views: Record<string, RendererView>; recentLogs: Record<string, LogEntry[]>;
  // 两者的 key 均为 lineId；recentLogs 每线最近 N 条（建议 12）
};
/** SettingsPayload：POST /api/settings；预算默认值取 §5（60 分钟段/60s 间隔/40 每时/200 每日/并发 2） */
type SettingsPayload = {
  models: string[];                   // 候选模型，按优先级回退
  apiKey?: string;                    // 只写不读；缺省 = 不修改
  segmentWorldMinutes?: number; minIntervalSeconds?: number;    // 默认 60 / 60
  hourlyLimit?: number; dailyLimit?: number; concurrency?: number;  // 默认 40 / 200 / 2
};
/** DraftDto：POST /api/draft 响应；唯一允许携带完整 world 的传输场景 */
type DraftDto = Draft;
/** EditProposal：POST /api/edit 响应；LLM 对草稿的修改提议 + 人工可读说明 */
type EditProposal = {
  schemaVersion: number;
  proposalId: string; draftId: string;    // proposalId 即 LlmCall.id
  baseRevisionId: string;
  ops: Op[];
  summary: string;                    // 给用户看的修改说明
  changedPaths: string[]; memories: Memory[];   // changedPaths 与 Revision.event.changes 同构，预演算得出
};
/** ConfirmPayload：POST /api/confirm 请求体；确认后事务 T3 产生 edit revision + 新线 */
type ConfirmPayload = {
  draftId: string; proposalId: string;
  ifText: string;                     // 「如果…」陈述，写入 revision.event.text
  name?: string;                      // 新线名，缺省自动分配 β/γ…
};
/** ControlPayload：POST /api/control；线级控制，字段全可选，未给不动 */
type ControlPayload = {
  lineId: string;
  speed?: number; paused?: boolean; name?: string;
  retry?: boolean;                    // status=error 时手动重试
};
/** LogPage：GET /api/lines/:id/log 分页响应；沿 revision 父链向过去翻页 */
type LogPage = {
  lineId: string;
  entries: LogEntry[];                // 按时间倒序
  nextBeforeRevisionId: string | null;// null = 已到 origin
};
/** SseEvent：GET /api/events 事件联合；type 为判别枚举（snapshot/line/revision/call） */
type SseEvent =
  | { type: 'snapshot'; data: StateSnapshot }                         // 连接建立先推全量
  | { type: 'line'; data: WorldLine }                                 // 线元数据变化
  | { type: 'revision'; data: { lineId: string; entry: LogEntry } }   // T2/T3 新 revision
  | { type: 'call'; data: CallSummary };                              // LLM 状态变化
/** CallSummary：SSE 推送的裁剪版 LlmCall；messages/attempts 留审计层不进推送（Q9） */
type CallSummary = Pick<LlmCall, 'id' | 'kind' | 'lineId' | 'status' | 'error'>;
```

## 4. JSON Schema 草案（2020-12）

仅列跨进程校验最关键的三个；其余按同法补齐。枚举字段均已显式列出。

**Op**

```json
{
  "type": "object",
  "required": ["op", "path"], "additionalProperties": false,
  "properties": {
    "op": { "enum": ["set", "remove"] },
    "path": { "type": "string", "pattern": "^(|/(?:[^/~]|~[01])(?:/(?:[^/~]|~[01]))*)$" },
    "value": {}
  },
  "allOf": [
    { "if": { "properties": { "op": { "const": "set" } } }, "then": { "required": ["value"] } },
    { "if": { "properties": { "op": { "const": "remove" } } }, "then": { "not": { "required": ["value"] } } }
  ]
}
```

**Plan**（PlannedEvent 内嵌同构；数组允许为空）

```json
{
  "type": "object",
  "required": ["fromMinutes", "toMinutes", "events", "callId"], "additionalProperties": false,
  "properties": {
    "fromMinutes": { "type": "number" },
    "toMinutes": { "type": "number" },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "atMinutes", "text", "ops", "memories"], "additionalProperties": false,
        "properties": {
          "id": { "type": "string" }, "atMinutes": { "type": "number" },
          "text": { "type": "string", "minLength": 1 },
          "ops": { "type": "array", "items": { "$ref": "#/$defs/op" } },
          "memories": { "type": "array", "items": { "$ref": "#/$defs/memory" } }
        }
      }
    },
    "callId": { "type": "string" }
  },
  "$defs": {
    "op": { "（引用上方 Op schema）" },
    "memory": {
      "type": "object",
      "required": ["id", "owner", "text", "valence", "intensity", "importance", "about"],
      "properties": {
        "id": { "type": "string" }, "owner": { "type": "string" },
        "text": { "type": "string", "minLength": 1 },
        "valence": { "type": "number", "minimum": -1, "maximum": 1 },
        "intensity": { "type": "number", "minimum": 0, "maximum": 1 },
        "importance": { "type": "integer", "minimum": 1, "maximum": 10 },
        "about": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
        "emotion": { "enum": ["喜悦", "接纳", "恐惧", "惊讶", "悲伤", "厌恶", "愤怒", "期待"] },
        "sourceEventId": { "type": "string" }
      }
    }
  }
}
```

**EditProposal**（无独立 enum 字段；要求各 id 非空且 ops 全部通过 Op schema）

```json
{
  "type": "object",
  "required": ["schemaVersion", "proposalId", "draftId", "baseRevisionId", "ops", "summary", "changedPaths", "memories"],
  "additionalProperties": false,
  "properties": {
    "schemaVersion": { "type": "integer", "minimum": 1 },
    "proposalId": { "type": "string", "minLength": 1 }, "draftId": { "type": "string", "minLength": 1 },
    "baseRevisionId": { "type": "string", "minLength": 1 },
    "ops": { "type": "array", "items": { "$ref": "op.schema.json" } },
    "summary": { "type": "string", "minLength": 1 },
    "changedPaths": { "type": "array", "items": { "type": "string" } },
    "memories": { "type": "array" }
  }
}
```

## 5. Fixtures 清单（随 contract 提交）

| 文件（`packages/contract/fixtures/`） | 覆盖场景 |
| --- | --- |
| `origin-revision.json` | 创世 revision（kind=origin，parentId=null）+ 初始 WorldState（含 premise 自定义容器） |
| `plan-accepted.json` | beat 计划接受：line.plan + LlmCall(accepted) + 事务 T1 前后状态 |
| `plan-due-commit.json` | 到期事件提交：按 atMinutes 顺序产出 N 个 story revisions + head/worldTime/plan 更新（T2） |
| `fork-confirm.json` | fork 确认：draft + EditProposal + ConfirmPayload → edit revision + 新线（T3），含 changedPaths |
| `sse-reconnect-snapshot.json` | SSE 重连对齐：StateSnapshot（lines/views/recentLogs）+ 重放用 SseEvent 序列 |
| `ops-invalid.json` | 非法 ops 拒绝：缺 value、坏 JSON Pointer、原型污染路径、location 引用不存在、remove 目标缺失、remove 携带 value，各带期望错误 |
| `renderer-view-golden.json` | projection golden：同 WorldState → 2D/3D 共享 view，含默认值补齐与 others 节点 |
| `llm-call-audit.json` | 全量审计：多 provider 回退 attempts、usage、failed/discarded 状态 |
| `world-open-fields.json` | 开放字段世界：未知 kind 实体、空 about 数组与可选 emotion 缺省，验证开放性不被校验误杀 |

## 6. 开放问题（M0 评审拍板）

| # | 问题 | 起草倾向 |
| --- | --- | --- |
| Q1 | `schemaVersion` 放哪：所有 DTO 顶层，还是 WorldState/Revision.world 内也带？ | 仅 DTO 顶层；WorldState 内部不变量属 domain（§9 冻结范围条款） |
| Q2 | WorldState 是否固定单文档根 id（如 `doc.id`），还是 entities 顶层即根？ | 不引入 doc.id，entities 即根，少一层间接 |
| Q3 | RendererView 是否需要 `schemaVersion`？渲染器消费形状，冻结后同样走变更协议 | 加上，成本一行 |
| Q4 | Entity.kind 注册机制：开放 string + 文档内建议枚举表，还是 contract 定义 union？ | 保持 string + 建议表；枚举进 contract 会让自定义 kind 频繁触发契约变更 |
| Q5 | `Op.valueJson` 为 string 的理由不充分：改 `value?: Json` 可免二次解析与转义错误 | **已决（2026-10-25）：改 `value?: Json`，remove 禁带值** |
| Q6 | Revision.world 完整快照与 §7「StateSnapshot 不含完整 world」矛盾 → `LogEntry = Omit<Revision,'world'>` 是否进 contract 正式类型？ | 进，本文已按此起草 |
| Q7 | `WorldLine.retryAt` 语义：墙钟 epoch 毫秒还是世界分钟？ | epoch 毫秒（重试间隔是真实时间语义） |
| Q8 | `worldTimeMinutes` 整数还是浮点？24× 下 2.5 真实分钟 = 60 世界分钟，粒度够用 | **已决（2026-10-25）：整数分钟**——到期比较精确、日志可读、分岔点对齐；内部积累小数、事务提交取整 |
| Q9 | SSE `call` 事件推完整 LlmCall 还是裁剪版？完整版含 raw prompt，体积大且含用户设定 | 裁剪版 CallSummary，审计走日志查询 |
| Q10 | id 格式：uuid v7 / 雪花 / 自定义前缀（`ln_` `rev_` `evt_`…）？ | 自定义前缀 + 随机后缀，log 可读性优先 |
| Q11（主线补充） | `WorldState.memories` 内嵌快照 = 每次 revision 复制全部记忆，规模增长后快照膨胀；改为仅存 store 表（line 归属 + sourceEventId），WorldState 删除该字段。涟漪：Revision.event 增 `memories?: Memory[]`（当次增量），LogEntry 随之可展示。Memory 字段（如 `about`/可见性相关）待记忆讨论收敛后定（DISCUSSION-memory.md） | **已决（2026-10-25）：单独存表**；Memory 重构为 owner 分行（knownBy 废除）+ valence/intensity/importance/about/emotion（DESIGN-memory.md 已批准） |

## 7. 与 ARCHITECTURE.md §4 的差异表

| 位置 | §4 草图 | 本文建议 | 性质 |
| --- | --- | --- | --- |
| `Op.valueJson` | `valueJson?: string` | **已决改** `value?: Json`（Q5），schema 与原型输出对齐 | 已拍板 |
| `Revision.event.atMinutes` | `atMinutes?: number` 可选 | 必填：origin=0、edit=分岔时刻、story=事件时刻 | 可选性收紧 |
| `PlannedEvent.ops/memories` | 未标可选性 | 必填数组，允许空 | 可选性收紧 |
| `WorldLine.retryAt` | `retryAt: number` | 明确为 `EpochMs`（墙钟） | 语义澄清 |
| `Draft.createdAt` | `number` | 明确为 `EpochMs` | 语义澄清 |
| `LlmCall.attempts[].request` | `unknown` | `string`（序列化请求体） | 类型收紧 |
| `LlmCall.usage` | `unknown` | token 计数字段（均可选） | 类型收紧 |
| `ChatMessage` / `ViewNode` / `ViewCharacter` | 未定义 | 本文 §2 补齐 | 新增 |
| `LogEntry` / 全部 DTO / `SseEvent` / `CallSummary` | 仅名字清单或缺失 | 本文 §3 补齐字段 | 新增 |
| `Entity.id` | 无 id 字段（key 即 id） | 维持，注释显式化 | 澄清 |
