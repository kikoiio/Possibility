# Agent 阅读入口

先遵守仓库根目录的 [AGENTS.md](../../AGENTS.md)，再阅读[工作计划](../PLAN.md)，核对工作树和实际文件。[当前实现地图](../architecture.md)描述现有代码；[项目意图](../intent.md)与[目标架构方案](../design/2026-10-27-target-architecture.md)分别描述需求和设计，不能当作实现证据。

| 追踪任务 | 起点 | 相关检查 |
| --- | --- | --- |
| 创世、草稿与确认 | [world-creation.mjs](../../prototypes/world-creation.mjs)、[world-genesis.mjs](../../prototypes/world-genesis.mjs) | [dialogue-flow.test.mjs](../../prototypes/tests/dialogue-flow.test.mjs)、[observe-creation.mjs](../../prototypes/tests/observe-creation.mjs) |
| 世界规则与角色信息边界 | [world-definition.mjs](../../prototypes/world-definition.mjs)、[actor.mjs](../../prototypes/actor.mjs) | [conditional-world.test.mjs](../../prototypes/tests/conditional-world.test.mjs)、[red-headed-league.test.mjs](../../prototypes/tests/red-headed-league.test.mjs) |
| API、事件与 UI | [server.mjs](../../prototypes/server.mjs)、[activity.mjs](../../prototypes/activity.mjs)、[ui/](../../prototypes/ui/) | [observe-experience.mjs](../../prototypes/tests/observe-experience.mjs)、[observe-ui.mjs](../../prototypes/tests/observe-ui.mjs) |
| 场景和空间 | [geometry/](../../prototypes/geometry/)、[ui/world-scene.js](../../prototypes/ui/world-scene.js) | [geometry.test.mjs](../../prototypes/tests/geometry.test.mjs)、[generated-geometry.test.mjs](../../prototypes/tests/generated-geometry.test.mjs) |
| 模型配置与调用 | [model/config.mjs](../../prototypes/model/config.mjs)、[model/model-client.mjs](../../prototypes/model/model-client.mjs) | [model/observe-config.mjs](../../prototypes/model/observe-config.mjs)、[model/observe-client-paths.mjs](../../prototypes/model/observe-client-paths.mjs) |
| 独立实验 | [实验说明](../../experiments/minecraft-societies/README.md) | 与原型分开；语法工作流及 M0 证据见该说明。 |

原型的离线总入口是 [verify.mjs](../../prototypes/verify.mjs)。真实配置和世界存档属于本机数据；按项目规则操作，不把它们当测试夹具。重型验证遵守云端使用和权限规则。
