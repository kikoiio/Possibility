# 候选 C：Electron 风格桌面单应用（Tauri）+ 内嵌引擎

## 总体形态

一个桌面应用包住一切：窗口即 UI，引擎跑在主进程侧常驻，数据存 OS 应用目录。关窗=最小化到托盘时世界继续；退出=冻结。

```
┌Tauri Window┐
│ Webview(SPA) │──IPC──┌Rust core┐──┐
│ 2D/3D/编辑器 │<──────│ clock    │  │ SQLite/FS
└─────────────┘  事件  │ LLM fetch│──┘
                       └──────────┘
```

## 技术栈

- Tauri 2（Rust core + system webview）；前端 Vite/React/TS。
- 存储：SQLite（rusqlite）或 FS JSON；LLM 从 Rust 侧 fetch。

## 卖点

- 桌面体验：常驻托盘、开机自启、离线可用、原生通知（"β线出了大事"）。
- 资源占用小（无完整浏览器捆绑）。
- 单文件安装包分发（自己一台机器装即用）。

## 数据流

- Rust clock 按线推进时间；beat 组 prompt → Rust reqwest 调 LLM → 事件写库 → Tauri event 推给 webview。
- 如果…/对照/渲染投影与候选 A/B 同构；渲染器只吃投影。

## 持久化

SQLite 单文件于 `~/.local/share/wispiva/`；表结构与候选 A 相同（worlds/events/llm_calls）。

## LLM 层

同 A：OpenAI 兼容、每线节拍+cap、全量审计；key 存 OS keychain（Tauri plugin）。

## 部署迁移

- 本机即桌面应用，符合"第一用户自己"。
- 云自托管：Tauri 不能直接搬——需要另做 headless engine 二进制（Rust core 编译为 CLI），web 部分复用。迁移成本 = 维护 GUI 壳与 headless 双入口。

## 阶段顺序

1. Tauri 骨架 + core clock + mock beat。
2. UI 壳 + 2D。
3. LLM + 如果…。
4. 3D + 编辑器 + 托盘常驻。

## Alternatives considered

1. **Node 引擎 + 浏览器 UI**（候选 A/B 形态）：多一步"开服务"，不如桌面应用一体。但桌面形态云迁移要双入口，这是最大代价。
2. **Electron**：内存占用与打包体积大，本机资源有限规则不利。选 Tauri。
3. **纯 CLI + 静态页**：没有桌面常驻语义，暂停/托盘/通知都要另做。否决。
