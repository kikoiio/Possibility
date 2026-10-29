# 当前架构：Luanti 世界分支

核对日期：2026-10-29。本分支的产品目标与 [Wispiva 项目意图](intent.md)相同，采用 Luanti 作为 Minecraft-like 世界基底，独立发展且不合并到 `main`。本文只描述本 worktree 的现状；[目标设计](design/2026-10-27-target-architecture.md)和[分支计划](PLAN.md)不是已实现能力。本分支名为 `wispiva/luanti-world`，代码位于 `luanti/`；历史实验属于此路线的证据，不限定本分支的产品目标。

## 现有组件与数据流

| 组件 | 位置 | 当前能力和限制 |
| --- | --- | --- |
| Luanti 运行时 | [runtime/bootstrap.sh](../luanti/runtime/bootstrap.sh) | 从系统软件源下载并解包引擎和 Minetest Game 到项目内 `.runtime/`，记录哈希；没有锁定未来软件包版本。 |
| 实体与规则调度 | [agent/mod/society/init.lua](../luanti/agent/mod/society/init.lua)、[policy.lua](../luanti/agent/mod/society/policy.lua) | 服务端实体、移动、标记、接触与分帧决策；规则模式并非 LLM。角色通过 `set_pos` 移动，无真实寻路、碰撞或玩家视角。当前 worktree 的可选 `society_visual` 提供临时草地、人形和英文动作标签，属于观察原型。 |
| 观察与动作 | [cognition/](../luanti/cognition/README.md) | 球形范围观察、空间索引、节点缓存、资源采集与放置、资源回读；无视线遮挡，不是第一人称视觉。资源操作限于实验节点。 |
| 私有记忆 | [cognition/memory.lua](../luanti/cognition/memory.lua)、[long_term_memory.lua](../luanti/cognition/long_term_memory.lua) | 旧模式每角色最多 32 条。可选长期模式在角色循环记录 L0 行动结果与参与者私有 L1，并支持有来源的 L2 结构；正常停服快照可保留和恢复。尚未完成模型反思、前史导入、长期检索质量、崩溃恢复或与地图原子提交。 |
| 模型桥接 | [model/](../luanti/model/README.md) | Lua 将局部观察提交私有文件队列，Python 串行 worker 异步调用已配置模型，校验有限动作后由引擎执行；并非千人模型调度器。夹具和真实模型分开记录。 |
| 持久化和快照 | [cognition/persistence.lua](../luanti/cognition/persistence.lua)、[snapshot.py](../luanti/snapshot.py) | 停服保存角色快照并校验复制；`--resume-preserve` 能恢复已保存的角色与记忆，`--resume` 仍是清空心智的实验重置。异常崩溃恢复和跨存储事务未证明。 |
| 创建与状态核心 | [genesis/](../luanti/genesis/README.md)、[world/](../luanti/world/README.md) | 创建、校验、确认草稿和 SQLite 状态事务已有独立原型；Luanti 地图接入与跨存储恢复尚未完成。 |
| 实验夹具与 CI | [agent/run.sh](../luanti/agent/run.sh)、[Actions 工作流](../.github/workflows/society-experiment.yml) | 创建实验世界、启动并结束服务器、检查日志与世界；Actions 分支条件运行离线测试、引擎和按配置的模型／规模测量。 |
| 用户意图创建原型 | `proto/world-genesis` 分支的 `prototypes/` | 独立的 Node/Three.js 原型，包含创建对话、世界草稿和有限规则；不在本 worktree 中运行，也尚未与 Luanti 接通。可通过 `git show proto/world-genesis:prototypes/README.md` 查阅。 |

目前的实际数据路径是 `Luanti globalstep → 局部观察与有限记忆 → 文件队列 → 模型 worker → 动作校验 → Luanti 执行与事件日志`；规则模式使用本地策略而不经过模型。停服时可写角色状态；实验日志、世界目录和模型队列不是已经提供一致事务的产品历史系统。

## 产品目标与状态

| 产品能力 | 本分支状态 | 主要缺口 |
| --- | --- | --- |
| 从用户想法创建世界 | 草稿生成、验证与确认核心已有原型，尚未接入 Luanti | 创建对话、空间生成、前史运行、语义隐私和用户意图保持一致。 |
| 三维世界中观察 | 有临时 Luanti 实体展示原型 | 可用场景、真实行走、清晰互动、视觉质量和用户体验尚未验收。 |
| 自主角色与环境后果 | 小规模真实模型闭环和有限资源动作 | 丰富行动、对话、可靠的环境过程、可持续生活和真实互动质量尚未证明。 |
| 主观记忆 | 短期经历与可选长期 L0/L1 记录，正常停服保留恢复 | 前史导入、主观解释、反思、长期检索质量、知识传播、崩溃恢复及分岔继承。 |
| 持续时间与恢复 | 有停服快照、保持记忆恢复和实验重置 | 世界时钟、无观看运行、故障一致性和不重复结算。 |
| 数千至万级 | 有规则实体／感知负载及小批真实模型证据 | 实际模型并发、决策频率、成本、长期运行与社会行为；不可用规则容量代替。 |

[预算调优证据](../luanti/scale/evidence/2026-10-28-budget-tuning/summary.md)中 10,000 角色 65 ms 配置的决策间隔中位约 4.97 秒，未达到 2 秒目标；[受控记忆对照](../luanti/model/evidence/2026-10-28-retrieval/summary.md)只覆盖指定任务。历史结果和本次未提交的本地观察原型不等于产品验收。
