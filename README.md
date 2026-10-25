# Wispiva

一个给第一用户（作者本人）的平行世界模拟器：世界线持续运转，随时问一个"如果…"、修改任意设定，在多元宇宙里观察命运分岔。

## 核心需求

- 持续运转的世界，时间与真实时钟耦合（默认 24 倍速起，可加速、可暂停）。
- 任意时刻可 fork；可自由批量修改角色、事件、世界设定，确认后生成新分支继续运行。
- 角色由 LLM Agent 自主决策；环境模拟探索 LLM Simulator + Verifier，推演并验证环境变化与行动后果（设计讨论中）。
- 实时观看使用 3D 画面，视觉必须有吸引力；用户可通过文本创建和修改世界。
- 完整历史 log，可回查任何分支（包括离开观看的分支）。
- 带 LLM 的世界/角色编辑器。
- 默认本机运行（进程不在则世界冻结）；支持自托管云服务器实现 7×24 常驻。
- LLM 调用节拍与成本上限由用户配置。

完整需求见 [docs/requirements.md](docs/requirements.md)。世界模型的资料出处、讨论记录、表示设计与计划入口见[世界模型讨论与资料导航](docs/architecture/DISCUSSION-world-model.md)。

## 状态

从零重建中。旧实现（世界/人物/时间线分叉/场景展示）已删除，可从 git 历史 `f0c207e` 查看。第二轮可玩原型于 2026-10-24 完成机制验证后删除，参考实现保留在 git 历史 `dea81b8`。

v1 架构：[docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)，视觉走共享语义文档 + solid 主渲染/voxel 副岗（几何原型见 [调研文档](docs/architecture/TEXT-TO-3D-RESEARCH.md)）。[SYNTHESIS.md](docs/architecture/SYNTHESIS.md) 为架构竞赛的历史裁决记录（原始三份候选已删，见 git 历史）。

## 开发

monorepo 已有 `packages/contract`、`packages/engine`、`packages/web`；根目录提供 `npm test` 与 `npm run typecheck`。当前 beat 路径仍统一生成事件与 ops，独立环境 Simulator / Verifier 尚未实现。执行计划（轨道/依赖/决策门）见 [docs/PLAN.md](docs/PLAN.md)。

## 本地模型配置

两种方式,任选(引擎优先读配置文件,key 为空时回退环境变量;实验脚本只读环境变量):

1. **环境变量**:复制 [`.env.example`](.env.example) 为 `.env`(已被 gitignore),填 `GROQ_LLM_API_KEY`;
2. **配置文件**:复制 [`config.example.json`](config.example.json) 到 `.data/wispiva/config.json`(目录与文件引擎会以 600 权限自动创建),可调 baseUrl/models 与预算(节拍分钟数/最短间隔/每小时/每日/并发)。

apiKey 只写不读,不入库、不进 git。云端 CI 的真实调用走仓库 secret(`llm-live.yml` 手动触发),须仓库主人显式授权后才会运行。
