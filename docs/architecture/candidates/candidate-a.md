# 候选 A：本地优先单进程 + SQLite 文档事件混合

## 总体形态

一个 Node.js 进程承载引擎与 API，前端是 Vite 构建的 SPA。存储是本地 SQLite 单文件：世界状态以 JSON 文档为单元，历史以追加事件表记录。

```
┌Frontend(Vite SPA)┐  SSE/HTTP   ┌Engine(Node)┐   ┌SQLite┐
│ 2D/3D 投影消费    │<───────────>│ 时间循环     │──>│ worlds│
│ 编辑器            │             │ LLM 编排     │   │ events│
└──────────────────┘             │ 世界线管理    │   │ llm   │
                                 └──────────────┘   └───────┘
```

## 技术栈

- 前端：React + Vite + TypeScript；2D 用 Canvas2D/PixiJS，3D 用 Three.js。
- 服务：Node 22 + Fastify（HTTP + SSE）。
- 存储：better-sqlite3（同步、零部署、单文件备份）。
- LLM：自写薄 client（OpenAI 兼容 /chat/completions），不引 SDK。

## 模块与数据流

engine/
- clock.ts：真实时间 × 倍速 → 世界时间；每 worldline 独立 speed/paused。
- beat.ts：世界时间跨过 beat 边界 → 组 prompt → 调 LLM → 解析 events → 应用到 WorldState → 追加 EventLog。
- worldline.ts：创建、如果…（deep clone state + log 共享前缀标记）、列举、对照。
- projection.ts：从 WorldState + 近期 events 生成 RendererView（渲染器唯一输入）。

api/: Fastify 路由，SSE 推送 worldline 的实时事件。

web/: React 壳；Renderer2D/Renderer3D 都实现 `Renderer { render(view: RendererView) }` 接口。

## 数据模型（草图）

```ts
type WorldLine = {
  id: string; name: string; parent: string | null;
  forkedAtEvent: number;      // 与父线共享的事件数
  speed: number; paused: boolean;
  state: WorldState;          // 当前态（JSON 文档，可整体替换）
  createdAt: number;
};

type EventRecord = {
  id: string; lineId: string; seq: number;   // 线内单调
  worldMinutes: number; text: string;
  involved: string[]; changes?: StateChange[];
  llmCallId?: string;
};

type LlmCall = {
  id: string; lineId: string; createdAt: number;
  model: string; prompt: unknown; response: string;
  parsed: unknown; latencyMs: number; costEstimate?: number;
};
```

## 持久化策略

- **当前态存文档**：`worlds.state` 直接存 WorldState JSON。编辑器"改任何东西"= 整体替换该 JSON，天然版本化（配 updatedSeq）。
- **历史存事件**：events 追加表；每条线的 log = 共享前缀（父链）+ 自有 events。
- fork 不复制父历史：子线只存 `parent + forkedAtEvent`，读取时沿父链拼接。N 层嵌套 fork 时读取 O(depth)，用"前缀物化"（深度 > 8 时把父链 log 物化成一行压缩 blob）兜底。
- 重启恢复：worlds 表即真相，启动时读 state、按 worldMinutes 续跑 clock；LLM 表完整审计。

## LLM 层

- provider 只要求 OpenAI 兼容 endpoint；配置存本地配置文件（不入库，避免 key 落盘数据库）。
- 每线可配 beatMinutes（默认 60 世界分钟）与 hourly cap；全局并发上限 2。
- 每次 call 记录完整 prompt/response/model/latency；解析失败重试 1 次后记 error event，不阻塞时钟。

## 部署迁移

本机 = `wispiva` 单命令启动（serve 前端 + engine + SQLite）。云自托管 = 同一镜像 + 卷挂 SQLite 文件 + 反代；无厂商锁定。

## 阶段顺序

1. 数据模型 + SQLite + clock/beat（无 LLM，mock）→ CLI 可跑通一条线 24 小时。
2. LLM 接入 + SSE + 最小 React 壳 + 2D 投影。
3. "如果…" + 多线并行 + 对照视图。
4. 3D 渲染器 + 编辑器。

## Alternatives considered

1. **纯事件溯源（不存当前态）**：编辑器要"整体改世界"时必须重放全部事件才能渲染新态，且 LLM 事件是非确定性的，重放=重推理，成本与语义都不成立。否决。
2. **Client-only（浏览器 IndexedDB + 浏览器定时器）**：标签页休眠即世界停转，与"持续运转"矛盾；SSE 与后台 tick 也不可靠。否决。
3. **Cloudflare Workers + D1（旧项目形态）**：免费层不支持常驻 tick，D1 行级模型与"世界即文档"不匹配。否决。
