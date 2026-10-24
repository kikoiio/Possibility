# 候选 B：引擎进程与前端静态站分离（文件系统即存储）

## 总体形态

两个可独立部署的单元：`wispiva-engine`（Node 常驻进程，拥有时间与 LLM）和 `wispiva-web`（纯静态 SPA）。存储不用数据库——直接用项目目录下的版本化 JSON 文件 + append-only NDJSON log。

```
┌wispiva-web(static)┐  fetch/SSE  ┌wispiva-engine┐  FS I/O  ┌data/┐
│ SPA（2D/3D/编辑器）│<───────────>│ HTTP API      │────────>│ worlds/*.json│
└───────────────────┘             │ clock loop    │         │ lines/*.ndjson│
                                  │ LLM client    │         │ llm/*.json│
                                  └───────────────┘         └──────┘
```

## 技术栈

- engine：Node 22 原生 `node:http`（零框架）或 Hono；better-sqlite3 都不要——纯 FS。
- web：Vite + React + TS；2D Canvas / 3D Three。
- LLM：fetch 直连 OpenAI 兼容 API。

## 数据布局

```
data/
  config.json                 # LLM endpoint/model/caps（chmod 600）
  worlds/<lineId>/
    world.json                # 当前 WorldState（原子写：tmp+rename）
    events.ndjson             # 本线自有事件（不含父链）
    meta.json                 # id/name/parent/forkedAt/speed/paused
    llm/<callId>.json         # 完整审计
```

## 数据流

- clock：每线独立 setInterval 精度即可（24× 下 1s=24s 世界时间，误差可接受；定时器漂移用绝对墙钟校正）。
- beat：跨界 → 读 world.json + 近 N 条事件 → prompt → LLM → 事件 append 到 ndjson → 状态变更写回 world.json（原子）。
- 如果…：读父线当前 world.json → 深拷贝 → 新目录写 meta(parent/forkedAt) + world.json；父事件不复制，对照时按内容 diff 拼父链。
- 渲染：engine 暴露 `GET /lines/:id/view` 生成投影；SSE 推增量事件。

## 数据模型

同需求：WorldState 是纯 JSON 文档（premise/time/locations/characters…）；EventRecord 一行 NDJSON；MetaRecord 记亲缘。类型草图从略（与候选 A 相同的形状）。

## 持久化

- world.json 每次变更原子写；events 追加即持久。
- 崩溃恢复：world.json + events 尾部可能有一次未完成的 beat——用 meta 里的 `appliedEventSeq` 对账，丢弃未确认事件。
- 备份 = 直接拷目录 / gitignore data/。

## LLM 层

- 每 beat 一次调用；节拍 = 世界时间间隔（beatMinutes），成本上限 = 每小时最大调用数，超限暂停该线并标记"待续"。
- 审计文件按 callId 存全量 prompt/response/model/ts。

## 部署迁移

- 本机：`wispiva engine` 起服务，web 静态可由同一进程 serve。
- 云：engine 跑任意 VPS/容器，data/ 挂卷；web 仍是静态站。零数据库依赖 = 迁移即拷目录。

## 阶段顺序

1. engine 骨架 + FS 布局 + mock beat（CLI 观察一条线跑 24h 世界时间）。
2. HTTP/SSE + React 壳 + 2D。
3. LLM + 如果… + 对照。
4. 3D + 编辑器 + 云部署文档。

## Alternatives considered

1. **SQLite**：多一条原生依赖与 schema migration，而数据量（单用户、几十条线）远不需要。否决，换纯 FS。
2. **浏览器直连 LLM**：key 暴露在前端且标签页休眠停转。否决。
3. **把事件也放进 world.json**：文件越长写放大越大，diff/对照要解析全量。拆 ndjson。否决合并。
