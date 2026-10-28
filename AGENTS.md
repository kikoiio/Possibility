# Agent 入口

- 接手仓库任务时，先阅读 [docs/PLAN.md](docs/PLAN.md)，了解当前阶段、已有证据和下一项工作，再按需阅读相关需求、架构与研究。
- 文档和源码追踪入口见 [docs/for_agent/README.md](docs/for_agent/README.md)；当前实现、目标需求和目标架构分别见 [docs/architecture.md](docs/architecture.md)、[docs/intent.md](docs/intent.md) 和[目标架构方案](docs/design/2026-10-27-target-architecture.md)。
- 主原型的使用、配置和验证入口见 [prototypes/README.md](prototypes/README.md)；独立实验的依赖、验证和证据见各自 README，当前为 [experiments/minecraft-societies/README.md](experiments/minecraft-societies/README.md)。
- 执行前核对工作区差异和实际文件；不把计划、设计方案或历史测试结果当作当前实现已经通过验证。
- 任务取得进展或中断时，更新 PLAN 的相关进度、产物路径、验证结果、未完成项和下一步；不要只把交接信息留在对话中。
- 项目级产品需求、架构、计划与研究放在 `docs/`；`docs/source-texts/` 只放原始故事文本。原型代码、测试、夹具、原型说明和原型专属记录放在 `prototypes/`。
- 唯一原型维护在 `prototypes/`：已有的场景生成、编译、模拟、角色与记忆应接入同一入口继续迭代，不为每项能力另建独立体验页、服务或模型配置。旧样例保留作回归夹具。
- 独立实验放 `experiments/<方向>/`，与唯一原型分开：自己的依赖、自己的 CI、自己的说明，不接入原型入口，也不把实验运行时（如 Java、Minecraft 服务端）带进 `prototypes/` 和主项目依赖。实验仍属 Wispiva 的延伸研究，进度与证据同样写进 PLAN。
- 体验从文本创世开始：世界初始定义与场景由 LLM 生成，经程序检查和用户确认后建立起源。固定样例只能用于示例或回归，不得在创世失败时替代模型结果冒充成功。
