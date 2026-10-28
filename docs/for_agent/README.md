# Agent 阅读入口

先遵守仓库根目录的 [AGENTS.md](../../AGENTS.md)，再阅读[工作计划](../PLAN.md)，核对工作树与实际文件。[项目意图](../intent.md)、[当前架构](../architecture.md)和[目标设计](../design/2026-10-27-target-architecture.md)分别描述需求、当前主线状态和未来方案。

| 任务 | 分支与追踪起点 | 验证与边界 |
| --- | --- | --- |
| 世界创建原型 | `proto/world-genesis`：`prototypes/world-creation.mjs`、`world-genesis.mjs`、`server.mjs` | 分支内 `prototypes/verify.mjs`；它是实验性原型，不整体合并到主线。 |
| 世界规则与信息边界 | `proto/world-genesis`：`prototypes/world-definition.mjs`、`actor.mjs` | 分支内 `prototypes/tests/conditional-world.test.mjs` 和 `red-headed-league.test.mjs`。 |
| 三维场景 | `proto/world-genesis`：`prototypes/geometry/`、`prototypes/ui/` | 分支内几何检查与浏览器工作流；浏览器验证遵循项目资源和云端权限规则。 |
| Minecraft 社会实验 | `experiment/minecraft-societies`：`experiments/minecraft-societies/README.md` | 独立运行时、语法工作流和 M0 证据都在实验分支；不接入原型依赖。 |

可用 `git show <分支>:<路径>` 只读查看分支文件，或在合适的隔离工作区检出。运行前检查资源与配置；真实配置、存档、下载的运行时和依赖目录未存入分支快照。
