# Wispiva v1 架构综合（Arena 裁决）

> 复核状态（2026-10-24）：本文为历史裁决记录，不作为正式实施依据。第二轮原型已验证时间推进、编辑基准、状态与历史一致性、长期记忆和双渲染投影等关键机制，观察结论已并入正式架构；见 [ARCHITECTURE.md](ARCHITECTURE.md) 与 git 历史 `dea81b8`。

日期：2026-10-24 · 基准：docs/requirements.md · 候选：candidates/{a,b,c}.md（原始文件已删，见 git 历史）

## 评分（1–5）

| 标准 | A Node+SQLite | B Node+FS | C Tauri |
|---|---|---|---|
| 承接已验证概念 | 5 | 5 | 4 |
| 持久化稳健/多线不爆炸 | 5 | 3 | 5 |
| 本机→云迁移 | 5 | 5 | 2 |
| 依赖与实现克制 | 3 | 5 | 2 |
| 双渲染投影分离 | 5 | 5 | 5 |
| LLM 审计与成本控制 | 5 | 4 | 5 |

## 裁决

- **基底：候选 A**。它是唯一在本机体验与云自托管之间零迁移成本的形态，且 SQLite 的崩溃一致性是 B 的手工 FS 协议（原子写+对账）难以等价达到的。
- **从 B 嫁接**：①「世界 = 可整体阅读/替换的 JSON 文档」的存储哲学（A 原表述偏表行，B 更彻底）；② 单命令启动时 engine 直接 serve 前端构建产物，开发用 Vite 代理。
- **从 C 嫁接（延后）**：系统托盘常驻 + 原生通知（"β线出了大事"）列为 v2 增强，不进 v1 关键路径。
- **否决 C 作基底**：云自托管需要另维护 headless 双入口，直接违反需求 7 的迁移承诺。
- **收敛点**：三个候选在「渲染器只消费投影」「LLM 全量审计」「fork 共享前缀不复制历史」上完全一致——视为已定论。

## 综合架构

### 技术栈

- **engine**：Node 22+ 单进程，Hono（HTTP+SSE，轻量且云 Workers 兼容留口）。
- **存储**：`node:sqlite`（Node 内建，零原生依赖；若目标 Node 版本标记实验则退 better-sqlite3，决策点见下）。单文件 `wispiva.db`。
- **web**：React + Vite + TS；2D PixiJS、3D Three.js，双渲染器实现同一 `Renderer` 接口。
- **LLM**：自写薄 fetch client（OpenAI 兼容），不引 SDK。

### 决策点：node:sqlite vs better-sqlite3

环境 Node 24.21 已带 `node:sqlite`。首选内建（零安装、零原生编译）；若遇到实验性限制（flag/稳定性），立即退 better-sqlite3——两者 API 面在本项目用法内几乎等价，切换成本一天内。

### 模块图

```
packages/contract     # 共享类型：WorldState/Event/RendererView/API DTO
engine/
  src/clock.ts        # 每线 真实时钟×speed → 世界时间；暂停语义
  src/beat.ts         # 跨 beat 边界 → 组prompt → LLM → 解析 → 应用+落库
  src/worldline.ts    # 创建/如果…(分岔)/列举/对照(内容级diff)
  src/store.ts        # SQLite 访问唯一入口（worlds/events/llm_calls）
  src/projection.ts   # WorldState+近期events → RendererView（渲染唯一输入）
  src/http.ts         # Hono 路由 + SSE
web/
  src/renderers/{2d,3d}/   # 实现 Renderer { render(view) }
  src/editor/              # LLM 辅助世界编辑器（产出整份 WorldState 提案）
```

### 数据模型（packages/contract）

```ts
type WorldState = {          // 纯 JSON 文档，可整体替换
  premise: string;
  time: { day: number; minutes: number };
  locations: Location[];
  characters: Character[];
};

type WorldLine = {
  id: string; name: string;          // α线/β线…，可改名
  parent: string | null;
  forkedAtSeq: number;               // 与父线共享的事件 seq
  speed: number; paused: boolean;    // 默认 24
  state: WorldState;                 // 当前态（冗余存储，真相之一）
};

type EventRecord = {
  id: string; lineId: string; seq: number;   // 线内单调
  day: number; minutes: number;
  text: string; involved: string[];
  changes?: { who?: string; to?: string; state?: string }[];
  llmCallId?: string;
};

type LlmCall = {                     // 全量审计，永不删
  id: string; lineId: string; ts: number;
  model: string; prompt: { system: string; user: string };
  rawResponse: string; parsed: unknown;
  latencyMs: number; ok: boolean; error?: string;
};
```

### 持久化

- `worlds.state` 存当前 WorldState JSON（编辑器"改任何东西"= 整体替换 + seq 乐观锁）。
- `events` 追加表；fork 只存 `parent + forkedAtSeq`，不复制父历史；读取沿父链拼接，深度 >8 时物化压缩前缀。
- 每次 beat 在单 SQLite 事务里完成：应用状态变更 + 追加事件 + 记录 LlmCall，崩溃不留半拍。
- LLM key 存本地 `config.json`（chmod 600，gitignore），不入库。

### LLM 层

- 每线 `beatMinutes`（默认 60 世界分钟）+ 每小时调用上限；全局并发 ≤2。
- 解析失败重试 1 次，仍失败写 error 事件并继续时钟（世界不因 LLM 故障停摆）。
- seed/温度随线记录在 LlmCall，支持未来复现实验。

### 部署

- 本机：`npm run wispiva` 单命令 = engine + serve web 产物 + 打开浏览器。
- 云：同一 Node 进程 + 卷挂 `wispiva.db` + 反代；无厂商锁定。C 的托盘/通知留 v2。

### 阶段（每阶段可验证）

1. **契约+store+clock+mock beat**：CLI 跑通 α线 24h 世界时间，SQLite 落盘可重启续跑。
2. **HTTP/SSE + React 壳 + 2D**：浏览器实时观看，倍速/暂停。
3. **LLM + 如果… + 多元宇宙对照**：真实推演、分岔、内容级 diff 高亮。
4. **3D 渲染器 + LLM 编辑器**：双渲染切换、自然语言产出 WorldState 提案。
5. **打包单命令 + 云部署文档**。

## Alternatives considered（综合层）

1. **纯 FS 存储（B 原样）**：依赖更少，但崩溃一致性与事务性要自己发明；SQLite 内建后依赖代价已消失。否决。
2. **Tauri 桌面（C 原样）**：体验最佳但违反云迁移承诺。降级为 v2 增强。
3. **浏览器直连 LLM**：key 暴露 + 标签页休眠停转。三个候选一致否决。
