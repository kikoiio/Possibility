// Wispiva v1 契约类型——唯一依据:docs/architecture/CONTRACT-DRAFT.md(2026-10-25 全部裁决)
// 冻结范围与变更协议:docs/architecture/ARCHITECTURE.md §9。改动须独立 PR 并同步 fixtures。
// 本包零运行时依赖;JSON Schema 在 src/schemas/,fixtures 在 fixtures/(由测试校验一致性)。

/** 任意 JSON 值 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** 世界时间,单位分钟。整数(Q8 已决):内部积累小数、事务提交取整 */
export type Minutes = number;
/** 墙钟时间,UTC 毫秒 */
export type EpochMs = number;

/** WorldState:某条世界线在某 revision 时刻的完整事实文档。记忆不内嵌(Q11 已决),存独立表 */
export type WorldState = {
  entities: Record<string, Entity>; // key 即实体 id,实体对象内不重复 id
  [key: string]: Json; // premise/rules/magic/自定义容器均允许
};

/** Entity:世界中的可命名对象(角色/地点/物品/自定义);kind 开放 string + 文档内建议枚举表(Q4) */
export type Entity = {
  kind: string;
  name?: string;
  location?: string; // 引用必须存在的实体 key
  x?: number;
  z?: number;
  width?: number;
  depth?: number;
  height?: number;
} & Record<string, Json>;

/** Op:对 WorldState 的最小修改指令;path 为相对 world 根的 JSON Pointer(RFC 6901 子集) */
export type Op = {
  op: 'set' | 'remove';
  path: string; // set 要求父路径存在;remove 要求目标存在
  value?: Json; // op=set 时必填(Q5 已决:直接 JSON 值);remove 时禁止携带
};

/** Memory:一个角色的一条主观记忆(owner 分行;DESIGN-memory.md);数值由生成方按 appraisal 声明 */
export type Memory = {
  id: string;
  owner: string; // 拥有者实体 id(Q11 已决:knownBy 废除)
  text: string; // owner 的带色要点,非逐字原文
  valence: number; // -1..1 情绪极性
  intensity: number; // 0..1 情绪强度/唤醒度
  importance: number; // 1..10 显著性
  about: string[]; // 实体引用,检索锚点;minItems 1
  emotion?: '喜悦' | '接纳' | '恐惧' | '惊讶' | '悲伤' | '厌恶' | '愤怒' | '期待'; // Plutchik 8 类
  sourceEventId?: string; // 由提交路径回填
};

/** PlannedEvent:计划中的一件未来事件,到 atMinutes 才提交为事实 */
export type PlannedEvent = {
  id: string;
  atMinutes: Minutes; // 世界时间轴上的绝对分钟
  text: string;
  ops: Op[]; // 必填,允许空数组(纯叙述事件)
  memories: Memory[]; // 必填,允许空数组
};

/** Plan:一次被接受的 LLM 推演产出;校验失败整段拒绝,不部分提交 */
export type Plan = {
  fromMinutes: Minutes; // 演算基准(= 当时 line.worldTimeMinutes)
  toMinutes: Minutes; // 末事件之后的时间窗下界
  events: PlannedEvent[];
  callId: string;
};

/** Revision:不可变历史节点,v1 存完整世界快照;event 描述本次如何演化 */
export type Revision = {
  id: string;
  parentId: string | null; // origin 为 null
  worldTimeMinutes: Minutes;
  event: {
    id: string;
    kind: 'origin' | 'edit' | 'story' | 'chat'; // chat:入世对话事件(P3-J 落地)
    text: string;
    ops?: Op[];
    changes?: string[]; // edit 分岔时的 changedPaths(JSON Pointer)
    memories?: Memory[]; // story/edit/chat 当次记忆增量(Q11,供展示;持久层另存表)
    callId?: string; // 仅 edit/story/chat
    atMinutes: Minutes; // 必填:origin=0、edit=分岔时刻、story/chat=事件时刻
  };
  world: WorldState;
};

/** WorldLine:一条持续运转的世界线的运行时元数据;不含 world 本体 */
export type WorldLine = {
  id: string;
  name: string; // 默认 α/β/γ…,可改名
  parentLineId: string | null;
  forkRevisionId: string | null;
  forkTimeMinutes: Minutes | null;
  headRevisionId: string;
  worldTimeMinutes: Minutes;
  speed: number; // 世界分钟/真实分钟,默认 24
  paused: boolean;
  plan: Plan | null;
  status: 'ready' | 'generating' | 'error';
  error: string | null;
  retryAt: EpochMs; // 墙钟毫秒(Q7 已决)
};

/** Draft:「如果…」编辑的固定基准副本;确认后产生新世界线,父线不受影响 */
export type Draft = {
  id: string;
  lineId: string | null;
  baseRevisionId: string | null; // 均为 null = 纯创世草稿
  worldTimeMinutes: Minutes;
  speed: number;
  paused: boolean;
  world: WorldState;
  createdAt: EpochMs;
};

/** ChatMessage:OpenAI 兼容消息;contract 自带,避免外部类型依赖 */
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** LlmCall:一次 LLM 请求的全量审计记录,永不删除 */
export type LlmCall = {
  id: string;
  kind: 'beat' | 'edit' | 'chat';
  lineId: string;
  baseRevisionId: string;
  startMinutes: Minutes;
  status: 'pending' | 'accepted' | 'failed' | 'discarded';
  messages: ChatMessage[];
  attempts: {
    model: string;
    status: number; // HTTP 状态码
    latencyMs: number;
    raw: string;
    request: string; // 序列化请求体
  }[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: string;
  startedAt: EpochMs;
  finishedAt?: EpochMs;
};

/** ViewNode:投影后的地点/泛化节点,空间字段已补默认值 */
export type ViewNode = {
  id: string;
  kind: string;
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
};

/** ViewCharacter:已解析 location 的角色节点 */
export type ViewCharacter = ViewNode & { locationId: string | null };

/** RendererView:渲染器唯一输入,projection 纯函数产出 */
export type RendererView = {
  lineId: string;
  revisionId: string;
  worldTimeMinutes: Minutes;
  places: ViewNode[];
  characters: ViewCharacter[];
  others: ViewNode[]; // 未知 kind 泛化节点,v1 不生成美术资产
  recentText: string | null;
};

/** LogEntry:对外历史条目 = Revision 去掉 world(快照与 log 不携带完整世界) */
export type LogEntry = Omit<Revision, 'world'>;

/** StateSnapshot:GET /api/state 全量对齐负载;SSE 重连后先收它再消费增量 */
export type StateSnapshot = {
  schemaVersion: number;
  lines: WorldLine[];
  views: Record<string, RendererView>; // key = lineId
  recentLogs: Record<string, LogEntry[]>; // 每线最近 N 条(建议 12)
};

/** SettingsPayload:POST /api/settings;apiKey 只写不读 */
export type SettingsPayload = {
  models: string[]; // 候选模型,按优先级回退
  apiKey?: string; // 缺省 = 不修改
  segmentWorldMinutes?: number; // 默认 60
  minIntervalSeconds?: number; // 默认 60
  hourlyLimit?: number; // 默认 40
  dailyLimit?: number; // 默认 200
  concurrency?: number; // 默认 2
};

/** DraftDto:POST /api/draft 响应;唯一允许携带完整 world 的传输场景 */
export type DraftDto = Draft;

/** EditProposal:POST /api/edit 响应;LLM 对草稿的修改提议 + 人工可读说明 */
export type EditProposal = {
  schemaVersion: number;
  proposalId: string; // 即 LlmCall.id
  draftId: string;
  baseRevisionId: string;
  ops: Op[];
  summary: string;
  changedPaths: string[];
  memories: Memory[];
};

/** ConfirmPayload:POST /api/confirm 请求体 */
export type ConfirmPayload = {
  draftId: string;
  proposalId: string;
  ifText: string; // 「如果…」陈述,写入 revision.event.text
  name?: string; // 新线名,缺省自动分配
};

/** ControlPayload:POST /api/control;字段全可选,未给不动 */
export type ControlPayload = {
  lineId: string;
  speed?: number;
  paused?: boolean;
  name?: string;
  retry?: boolean;
};

/** LogPage:GET /api/lines/:id/log 分页响应;沿 revision 父链向过去翻页 */
export type LogPage = {
  lineId: string;
  entries: LogEntry[]; // 按时间倒序
  nextBeforeRevisionId: string | null; // null = 已到 origin
};

/** CallSummary:SSE 推送的裁剪版 LlmCall(Q9 已决) */
export type CallSummary = Pick<LlmCall, 'id' | 'kind' | 'lineId' | 'status' | 'error'>;

/** SseEvent:GET /api/events 事件联合 */
export type SseEvent =
  | { type: 'snapshot'; data: StateSnapshot }
  | { type: 'line'; data: WorldLine }
  | { type: 'revision'; data: { lineId: string; entry: LogEntry } }
  | { type: 'call'; data: CallSummary };

/** 契约版本号,additive 演进判别位 */
export const SCHEMA_VERSION = 1;
