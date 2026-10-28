# 当前架构与分支边界

核对日期：2026-10-28。主线正在整理为产品意图、研究、设计与项目记录的入口；旧版已跟踪实现处于未提交删除状态，不能将其视为当前工作区可运行产品。[目标架构](design/2026-10-27-target-architecture.md)描述未来方案，不代表主线已经实现。[工作计划](PLAN.md)记录历史证据和迁移状态。

| 内容 | 位置 | 用途与边界 |
| --- | --- | --- |
| 产品需求 | [intent.md](intent.md) | 作者、世界、模拟与验收目标。 |
| 主线计划与研究 | [PLAN.md](PLAN.md)、[文档索引](README.md) | 保留进展和证据；研究结论不等于实现。 |
| 创世与模拟原型 | `proto/world-genesis`，提交 `40206a2414713b89bfd4e19a7b9347183dec0867` | 保存模型创世、有限规则、角色、3D、测试和原型专用 CI；作为探索证据，不整体合并主线。 |
| Minecraft 社会实验 | `experiment/minecraft-societies`，提交 `7e33189e144d76d5a18a13c462b26c502f74b797` | 独立 Luanti 运行时、Lua 代码、M0 证据和单独语法 CI；不接入原型。 |

分支的提交是对迁移前工作区的快照，并非对上游主线变更的批准。分支可以通过 `git show <分支>:<路径>` 只读查看。分支快照不包含本机 `.env`、`.data/`、`node_modules/` 或实验 `.runtime/`；运行时应在隔离工作区按各分支说明准备。

## 目标、原型证据与缺口

| 产品目标 | 原型证据 | 仍未证明 |
| --- | --- | --- |
| 文本创世与用户确认 | `proto/world-genesis` 的 `prototypes/world-creation.mjs` 和 `tests/dialogue-flow.test.mjs` | 真实模型生成质量与自然语言隐私。 |
| 世界演化与行动后果 | 同分支 `world-definition.mjs` 和 `tests/conditional-world.test.mjs` | 任意物理与完整小说因果。 |
| 角色认知与记忆 | 同分支 `actor.mjs` 和 `tests/red-headed-league.test.mjs` | 长期检索、反思和分岔继承。 |
| 实时 3D | 同分支 `geometry/`、`ui/` 和几何测试 | 目标设备性能、复杂几何及生产级视觉质量。 |
| 社会实验 | `experiment/minecraft-societies` 的 `agent/evidence/m0-2026-10-27.md` | 真实 LLM 社会行为、持久化、长期运行及最终环境选型。 |

2026-10-28 在迁移前对创世原型的离线检查为 73 个 Node 测试、282 项环境检查通过；这不是本轮在分支新工作区重新运行的结果。实验 M0 为此前记录，独立 CI 尚未云端运行。
