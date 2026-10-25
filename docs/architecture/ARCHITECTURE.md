# Wispiva v1 正式架构

日期：2026-10-24
状态：修订中。2026-10-25 裁决:3D 采用共享场景语义文档 + 双确定性后端,通用几何(solid)为 v1 主渲染,体素(voxel)为第二后端并承担编辑辅助视图(碰撞/导航/变更可视化候选);体素需补齐表面网格化、非整格部件、材质尺度,在真实模型生成实验后按数据定岗。生成路线及证据见 [文本到 3D 调研](TEXT-TO-3D-RESEARCH.md)。
依据：[requirements.md](../requirements.md) 与第二轮原型机制观察。原型已完成使命并从 main 删除；参考实现可用 `git show dea81b8:prototype/v2/<file>` 查看，真实 Groq 观察见 [Actions run 40083293453](https://github.com/kikoiio/Wispiva/actions/runs/40083293453)。历史裁决见 [SYNTHESIS.md](SYNTHESIS.md)（原始候选已删，可从 git 历史查看）。

## 1. 总体形态

本机优先的单进程 Node 引擎 + 静态 web 前端 + SQLite 单文件。云自托管运行同一进程并挂载数据库文件，不重写、不换栈。

```
┌──────────────── web（静态 SPA）────────────────┐
│ shell │ editor │ renderers/2d │ renderers/3d   │
└───────┬───────────────────────────────────────┘
        │ HTTP + SSE（contract DTO）
┌───────┴───────────────────────────────────────┐
│ http（薄适配）→ runtime（编排）                 │
│   clock   llm   domain   projection            │
│                      ↓                         │
│              store（SQLite 唯一 I/O）           │
└───────────────────────────────────────────────┘
```

## 2. 技术栈

| 层 | 选择 | 说明 |
| --- | --- | --- |
| engine | Node 24 + TypeScript | 单进程常驻；进程退出即世界冻结 |
| HTTP/SSE | Hono | 轻量、SSE 友好；比裸 node:http 少造路由轮子 |
| 存储 | `node:sqlite` | 零原生依赖；若稳定性受限，按预定退 `better-sqlite3`（本项目 API 面小，切换成本低） |
| web | React + Vite + TypeScript | SPA，静态产物可由 engine 托管 |
| 2D | 原生 Canvas 2D 起步 | 零依赖；接口不绑实现，确有需要再评估 PixiJS |
| 3D | Three.js | WebGL；与 2D 消费同一 `RendererView` |
| LLM | 自写薄 fetch client | OpenAI 兼容 endpoint，不引 SDK |
| 仓库 | npm workspaces | `packages/contract`、`engine`、`web`；不引入 monorepo 框架 |

## 3. 模块划分与边界

```
packages/contract     # 共享类型 + JSON Schema + 测试 fixtures，零运行时依赖
engine/
  src/domain          # World 校验、applyOps、changedPaths、revision/plan/fork 纯函数
  src/store           # SQLite schema、事务、重启恢复、日志分页（唯一 I/O 入口）
  src/clock           # 墙钟采样 → 世界时间；到期事件计算
  src/llm             # prompt 组装、OpenAI 兼容调用、预算调度、全量审计
  src/projection      # WorldState → RendererView（渲染唯一输入）
  src/runtime         # 编排：beat 调度、fork、控制、快照
  src/http            # Hono 路由 + SSE，薄适配层
web/
  src/shell           # React 壳、API client、多元宇宙总览
  src/renderers/2d    # 实现 Renderer { render(view) }
  src/renderers/3d    # 同一接口，与 2D 互不依赖
  src/editor          # 草稿、LLM 提议、diff、确认分岔
```

| 模块 | 允许依赖 | 明确禁止 |
| --- | --- | --- |
| `packages/contract` | 无 | 任何运行时逻辑 |
| `engine/domain` | contract | I/O、LLM、时间源、数据库 |
| `engine/store` | contract、domain | 业务决策 |
| `engine/clock` | contract | 直接写库、调 LLM |
| `engine/llm` | contract | import domain；只产出 payload，不改世界 |
| `engine/projection` | contract | 读库、渲染实现细节 |
| `engine/runtime` | 全 engine 模块 | HTTP 细节 |
| `engine/http` | contract、runtime | 业务分支 |
| `web/shell` | contract | 自行推演世界事实 |
| `web/renderers/*` | contract | import WorldState、发网络请求 |
| `web/editor` | contract、shell 的 API client | 绕过 ops 协议直改服务端 |

### 硬边界（review 强制）

1. 渲染器唯一输入是 `RendererView`；2D 与 3D 互不 import，不得各自持有世界状态。
2. 一切世界修改都是 `domain.applyOps(world, ops)` 产出新 revision；禁止 ad-hoc SQL 或私有 patch 格式。
3. `engine/llm` 不 import domain：LLM 层返回 payload，应用与校验由 runtime/domain 完成（原型中 `llm.js → core.applyOps` 的耦合不带入正式版）。
4. `engine/http` 不含业务逻辑，只做 DTO 翻译与转发。
5. `engine/store` 是唯一 SQLite 入口；其他模块不得打开数据库句柄。
6. contract 变更必须走独立 PR 协议（见 §9）。
7. `engine/runtime` 只做编排：调用顺序、事务边界、状态机转换。与调度无关且超过 ~30 行的业务逻辑必须下沉到 domain/llm/store，防止 runtime 退化成新的上帝模块。

建议用 dependency-cruiser（或等价 lint）把上述 import 规则固化为 CI 检查。

## 4. 核心数据契约（packages/contract）

以下为方向性草图，字段级定稿在 M0 完成；一旦冻结，改动走 §9 协议。

```ts
type WorldState = {
  entities: Record<string, Entity>;   // 最小不变量：必须是对象；字段开放
                                      // 记忆不内嵌(Q11 已决),存独立表
  [key: string]: Json;                // premise/rules/magic/自定义容器均允许
};

type Entity = {
  kind: string;                        // character/place/... 允许自定义
  name?: string;
  location?: string;                   // 引用必须存在的实体
  x?: number; z?: number; width?: number; depth?: number; height?: number;
} & Record<string, Json>;

type Op = { op: 'set' | 'remove'; path: string; value?: Json }; // path 为相对 world 根的 JSON Pointer;remove 禁带值(Q5 已决)

type Memory = { id: string; owner: string; text: string; valence: number; intensity: number; importance: number; about: string[]; emotion?: string; sourceEventId?: string }; // owner 分行(Q11 已决),详见 DESIGN-memory.md

type PlannedEvent = { id: string; atMinutes: number; text: string; ops: Op[]; memories: Memory[] };
type Plan = { fromMinutes: number; toMinutes: number; events: PlannedEvent[]; callId: string };

type Revision = {
  id: string;
  parentId: string | null;
  worldTimeMinutes: number;
  event: {
    id: string;
    kind: 'origin' | 'edit' | 'story';
    text: string;
    ops?: Op[];
    changes?: string[];      // 编辑分岔时的 changedPaths
    callId?: string;
    atMinutes?: number;
  };
  world: WorldState;         // v1 存完整快照；仅 store 内部可改表示（见 §6）
};

type WorldLine = {
  id: string; name: string;
  parentLineId: string | null;
  forkRevisionId: string | null;
  forkTimeMinutes: number | null;
  headRevisionId: string;
  worldTimeMinutes: number;
  speed: number;             // 默认 24
  paused: boolean;
  plan: Plan | null;
  status: 'ready' | 'generating' | 'error';
  error: string | null;
  retryAt: number;
};

type Draft = {
  id: string;
  lineId: string | null;
  baseRevisionId: string | null;
  worldTimeMinutes: number;
  speed: number; paused: boolean;
  world: WorldState;
  createdAt: number;
};

type LlmCall = {
  id: string; kind: 'beat' | 'edit'; lineId: string;
  baseRevisionId: string; startMinutes: number;
  status: 'pending' | 'accepted' | 'failed' | 'discarded';
  messages: ChatMessage[];
  attempts: { model: string; status: number; latencyMs: number; raw: string; request: unknown }[];
  usage?: unknown; error?: string;
  startedAt: number; finishedAt?: number;
};

type RendererView = {
  lineId: string; revisionId: string; worldTimeMinutes: number;
  places: ViewNode[];
  characters: ViewCharacter[];   // location 已解析、空间字段已补默认值
  others: ViewNode[];            // 未知 kind 的泛化节点，v1 不自动生成美术资产
  recentText: string | null;     // 最近确认事件，供字幕/画面说明
};
```

API DTO（`StateSnapshot`、`SettingsPayload`、`DraftDto`、`EditProposal`、`ConfirmPayload`、`ControlPayload`、`LogPage`、SSE 事件联合类型）同属 contract，并附带 JSON fixtures 供 engine 与 web 共用测试数据。

## 5. 关键机制

### 时间与计划（原型已验证）

- 每条线独立 `speed/paused`；世界时间 = 对真实时长按倍速积分。采样用单调时钟 + 绝对校正，不累计 `setInterval` 漂移。
- 进程退出即冻结；重启从持久化的 `worldTimeMinutes` 续跑，不补算离线时间。
- LLM 生成的是一段未来计划（`Plan`）；事件到 `atMinutes` 才提交为 revision、改变事实。暂停期间晚到的回复可保存为计划，但不改变世界事实。

### beat 推演

```
clock 发现无计划且未暂停 → runtime 请求预算
  → llm 组 prompt（完整 world + 最近 12 条事件）
  → 返回 payload（events/ops/memories）
  → runtime 校验：baseRevisionId/head/worldTime 未变；逐事件 applyOps 演算整段
  → store 事务 T1：line.plan = plan，call = accepted
clock tick → domain 计算到期事件
  → store 事务 T2：追加 revisions，更新 head/worldTime/plan
  → SSE 推送
```

- 服务端结构化输出不能替代应用侧校验（原型观察到模型会多 `/world` 前缀、返回不合 schema 的输出）；演算失败整段拒绝，不部分提交。
- 失败进入 `status=error + retryAt`；世界停在最后确认时间，不假装故事发生。用户可手动重试。

### 如果…（fork，原型已验证）

- `POST /api/draft` 固定 `baseRevisionId` 与当时 worldTime/speed/paused；父线在编辑期间继续运行。
- `POST /api/confirm` 在一个事务里创建 `kind=edit` 的 revision 与新世界线；新线不继承 base 之后的事件，也不继承父线未到期计划。
- 父历史通过 revision 父链共享，不复制；对照视图用事件/revision ID 判共同前缀，用户修改单独记录，不做文字相似猜测。

### 投影与双渲染（原型已验证）

- `projection(world, worldTime, revisionId, recentEvent) → RendererView` 是纯函数。
- 2D/3D 只消费同一 view；未知实体 kind 进入 `others`，空间字段缺失用默认值，不阻塞画面。

### 世界与 3D 场景的连接（geometry-lab 定向，M0 收口）

- 位置与场景事实属于世界状态：角色在哪、物件尺寸朝向都是可被 `Op` 修改的 WorldState 字段。事件「甲走到桥头」= 一条改 `position` 的 op。
- SceneDocument 由 WorldState 投影派生（场景实体即世界实体的一个视图），渲染只消费其编译产物；3D 端按 recipeHash 内容键做部件级增量重建（geometry-lab 已验证精确重建与移除清理）。
- 编辑器与创世修改一律走 ops → 新 revision → 重投影，不存在绕过 ops 的第二条改世界的路；SceneDocument 不作为事实源存储。
- 生成侧经验（子 agent 实验）：模型输出必须过 JSON Schema + 结构化诊断 + 预算内多轮返修（冷启动首过 4/10 → 返修后 10/10），局部修订后必须全量重校验。这套验收环进 engine/llm 与 runtime，不留给前端。

### LLM 层

- OpenAI 兼容 `/chat/completions`；JSON Schema strict + 应用侧校验；只在用户配置的候选模型内回退（404/429/503），尊重 retry-after；等待间隔与请求超时分离。
- 预算全局跨线：默认每段 60 世界分钟、最短间隔 60s、每小时 40 次、每日 200 次、并发 ≤2。
- 全量审计：每次尝试的 model/status/latency/raw 请求响应与 usage 永久保存；API key 只存本地 `config.json`（chmod 600，gitignore），不入库、不回传网页。
- prompt 组装按分层记忆:完整世界状态 + 近窗 verbatim + owner 可见集内的偏置检索(FTS5+实体图两跳;情绪强度抗衰减 × 心境一致性加权,关系极性由记忆聚合推导)+ 情境触发的 L2 讲法(过去闯入/叙事破裂/闲时/被问及)。超预算先减检索条数(记审计),世界状态与近窗永不裁剪,仍超显式失败。记忆按 owner 分行、按 appraisal 着色。完整设计见 [DESIGN-memory.md](DESIGN-memory.md)(已批准 2026-10-25)。

## 6. 持久化与恢复

```sql
lines(id, name, parent_line_id, fork_revision_id, head_revision_id,
      world_time_minutes, speed, paused, plan_json,
      status, error, retry_at, created_at)
revisions(id, parent_id, line_id, world_time_minutes, event_json, world_json, created_at)
drafts(id, line_id, base_revision_id, world_time_minutes, speed, paused, world_json, created_at)
llm_calls(id, kind, line_id, base_revision_id, start_minutes, status,
          payload_json, started_at, finished_at)
```

事务清单（每个都是单 SQLite 事务，崩溃不留半拍）：

| 事务 | 内容 |
| --- | --- |
| T1 接受推演 | call 状态 + line.plan/inFlight/status |
| T2 到期事件 | N 个新 revisions + line.head/worldTime/plan |
| T3 确认分岔 | 删除 draft + edit revision + 新 line |
| T4 控制/设置 | speed/paused/name/retry 等 |

重启恢复：`inFlight` 的 call 标记 failed、line 回 `ready`（不伪造结果）；已接受 plan 保留；worldTime 不补算；`llm_calls` 永不删除。

容量策略：v1 revision 存完整世界快照（单用户规模下最简单可靠）；M1 后测量 revision 大小与频率，若超阈值仅在 store 内部改为 ops 增量 + 周期物化，contract 与其他模块不变。

fork 深链：历史读取沿 revision 父链拼接，嵌套 fork 越深读取越慢。v1 先测量实际深度与延迟；当任一线的父链深度超过 8 或分页 P95 超标时，由 store 内部把共享前缀物化为压缩快照（对上层仍暴露同一 `LogPage` 契约），不在 M0 预实现。

记忆不内嵌 WorldState 快照（Q11 已决）,按 owner 分行存独立表（`memories` 含 FTS5 虚表）与版本化叙事表（`memory_reflections`）;跨线隔离,fork 按线物化;L2 情境触发、从 L1 幂等重建。详见 [DESIGN-memory.md](DESIGN-memory.md)。

## 7. HTTP API

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/state` | 线元数据 + 每线 `RendererView` + 近期 log；**不含完整 world JSON** |
| `GET /api/lines/:id/log?beforeRevisionId=&limit=` | 分页历史 |
| `GET /api/events` | SSE：`snapshot` / `line` / `revision` / `call` |
| `POST /api/settings` | 写配置；apiKey 只写不读 |
| `POST /api/draft` | 创建固定基准草稿 |
| `POST /api/edit` | 对草稿发起 LLM 提议（ops + 说明 + 预览） |
| `POST /api/confirm` | 确认修改，产生新世界线 |
| `POST /api/control` | speed/paused/name/retry |

SSE 断线重连后客户端先 `GET /api/state` 全量对齐，再消费增量事件。

完整 world 只在编辑场景按需传输：`POST /api/draft` 创建草稿时返回，多元宇宙总览与渲染永远只消费投影。`StateSnapshot` 的形状在 M0 冻结前按此收口。

## 8. 部署

- 本机：`npm run wispiva` 单命令 = engine + serve `web/dist` + 打开浏览器；进程在则世界运转，退出即冻结。
- 云自托管：同一 Node 进程 + 卷挂 SQLite 文件 + 反向代理；无厂商锁定。多用户与鉴权不在 v1。
- 默认运行依赖以 Node 与浏览器为边界。模型通过用户配置的服务调用，基本创世不得要求安装 Blender、CUDA 或下载大型 3D 模型权重。
- 3D 画面在观看端浏览器渲染。无人观看时服务端只推进世界事实，不持续渲染各条世界线。普通云常驻服务不应被迫配备 GPU。
- 场景生成与时间调度隔离，CPU 构造任务设置资源预算。外部网格生成与视觉复核为可选后端，详细约束见 [调研文档的运行环境部分](TEXT-TO-3D-RESEARCH.md)。
- 开发 CI 与产品运行资源分别规划。经授权使用免费 CI 验证，不代表产品可以依赖免费 CI 持续提供生成算力。

## 9. 并行开发计划

依赖关系：contract 是全局关键路径，必须最先稳定；此后 engine 与 web 两侧可并行。

```
contract ──┬── domain ── store
           ├── clock ─── llm        （runtime 统一编排）
           ├── projection
           └── shell ──┬── renderers/2d
                       ├── renderers/3d
                       └── editor
```

| 里程碑 | 内容 | 并行度 |
| --- | --- | --- |
| M0 | contract：类型 + JSON Schema + fixtures；三方认领前冻结。**冻结范围仅限跨模块通信形状**（DTO、Op、Plan、RendererView、SSE 事件）；`WorldState` 的内部不变量属于 domain 私有问题，不进 contract，避免实现期发现新校验规则反复触发契约变更 | 串行，1 人 |
| M1 | domain（从 `git show dea81b8:prototype/v2/core.js` 提纯纯函数）｜store｜clock｜llm client（mock fetch） | 4 路并行 |
| M2 | runtime + http｜web/shell｜renderers/2d；mock beat 驱动实时画面、倍速/暂停 | 3 路并行 |
| M3 | LLM live 接线与预算｜fork + 多元宇宙 UI + 分页 log | 2 路并行 |
| M4 | renderers/3d｜editor | 2 路并行 |
| M5 | 打包单命令、云部署文档、CI 全量 | 收口 |

### contract 变更协议

- contract 改动必须独立 PR，不得与实现改动混合。
- 必须同步更新 fixtures，并列出受影响模块。
- 破坏性变更一次性对齐所有消费者，禁止长期双版本。
- v1 内默认只做 additive 演进（新增可选字段/新事件类型）；字段改名、语义变更、删除一律视为破坏性变更。DTO 带 `schemaVersion`，为未来迁移预留判别位。

### 资源规则

- 本机只跑定向单测/联调；浏览器 E2E、大规模验证、真实 LLM 调用走 GitHub Actions 等云端免费资源（与仓库资源规则一致）。
- 多任务并行时由主协调者集中安排重型验证，避免本机同时起多个构建/浏览器。

## 10. 验证策略

- domain：纯函数单测，覆盖 applyOps 的数组追加、缺失父路径、原型污染路径、location 引用校验；数据取自 contract fixtures。
- store：临时目录 + SQLite，覆盖 T1–T4 与崩溃重启。
- clock：fake timers 验证倍速、暂停、到期顺序。
- llm：mock fetch 验证候选回退、预算、审计、等待与超时分离。
- runtime 集成：把原型 8 个观察场景移植为自动化测试——24× 换算与事件偏移、暂停晚到、固定基准批量编辑、长期记忆与跨线隔离、共享投影与开放事实、provider 回退、重启恢复与密钥不回传、间隔后备用模型续跑。
- web：fixtures 驱动的组件与渲染测试（golden view）。
- E2E（仅云端 CI）：桌面与 390px 手机、2D/3D/并排、编辑器、多元宇宙、暂停；真实 Groq 为可选 workflow_dispatch，最多 6 次调用。

## 11. 风险与开放问题

| 风险/问题 | 判断 | 缓解 |
| --- | --- | --- |
| contract 频繁变动 | 影响最大 | M0 冻结 + 变更协议；fixtures 先行 |
| 完整快照容量 | 中，未长期测量 | store 内部可换增量表示，不改契约 |
| 叙述与事实漂移 | 产品级，原型已观察到 | prompt 改绝对时间窗口；评估「先事实提案、后生成叙述」两段式；编辑器 diff 人工确认 |
| 上下文随时间增长 | 中 | 分层记忆+偏置检索+情境触发 L2（DESIGN-memory.md 已批准）;裁剪只动检索项并记审计,超预算显式停止 |
| 需求持续更新 | 高（产品探索期） | 契约面保持最小；只 additive 演进；缝隙两侧（contract/domain、projection/renderer、llm/runtime）各自有独立测试，需求变化时冲击面可定位 |
| `node:sqlite` 稳定性 | 低-中 | M1 冒烟；API 面小，预定退 better-sqlite3 |
| SSE 断线 | 低 | 重连后全量对齐 |
| 多线写竞争 | 低（单用户单进程） | 短事务串行提交即可 |

## Alternatives considered

1. **纯文件系统存储**：崩溃一致性与事务语义要自造；SQLite 内建后依赖优势消失。否决。
2. **Tauri 桌面**：本机体验好，但云自托管需维护 GUI 与 headless 双入口，违反需求 7。降级为未来增强。
3. **浏览器直连 LLM**：key 暴露 + 标签页休眠即停转。否决。
4. **纯事件溯源重放**：LLM 非确定性导致重放不等于同一历史；编辑器需要整读整改文档。否决，采用「当前文档 + 不可变 revision 链」。
5. **一开始微服务拆分**：单用户本机无收益，增加运维与调用延迟。否决，用模块边界预留拆分能力。
