# Minecraft 千级 LLM Agent 社会实验研究

更新时间：2026-10-27。

本研究记录社会模拟的候选项目、规模问题与既有 Luanti 测量；本分支已选 Luanti 作为 Wispiva 的 Minecraft-like 基底，产品计划见[工作计划](../PLAN.md)。本研究的旧项目比较和测量不代表真实模型的万级容量。

## 问题与范围

目标是在 Minecraft 中放入成千上万个由 LLM 驱动的 agent，做社会实验：先让 agent 建造一个世界，再重置 agent 的设定与记忆，进入受控实验阶段。

需要回答：

- 是否有现成开源项目能直接支持？
- 规模、成本、服务器容量和实验可复现性的边界是什么？
- 若以后启动，最小可行路线和决策点是什么？

本文只记录调查结果，不代表已经克隆、运行或验证任何项目，也不代表任何性能与费用数字经过实测。

## 结论摘要

- 没有单一开源项目开箱即用。公开做得最远的是 Project Sid：10–1000+ agents、Minecraft 环境、PIANO 架构；但仓库只有技术报告，没有可复用代码。
- 现实组合是分层的：Mindcraft（LLM agent 循环）+ Mineflayer（玩家 bot 接入）或 Minestom（服务端 NPC）+ Concordia / AgentSociety（实验编排与大规模模拟）。
- 千级真实具身不能靠单服玩家 bot；需要分片、服务端 agent、距离 LOD，或把社会模拟抽象出来、只把关键部分投影到 Minecraft。
- 万级在 Minecraft 内没有公开证据；更现实的路线是抽象社会模拟 + Minecraft 可视化与少量具身 agent。

## 候选项目

下表信息来自 2026-10-27 的 GitHub API、README 或仓库目录读取；没有克隆源码、运行项目或复现论文。

| 项目 | 许可证 | 调查到的能力 | 规模与限制 |
| --- | --- | --- | --- |
| [Project Sid](https://github.com/altera-al/project-sid)（[arXiv:2411.00114](https://arxiv.org/abs/2411.00114)） | 仓库无代码许可信息 | 10–1000+ agents 的 Minecraft 社会模拟；提出 PIANO（Parallel Information Aggregation via Neural Orchestration）架构；报告分工、规则演变、宗教与文化传播 | 仓库只有技术报告和图片；不能作为代码底座。千级以上的具身方式、服务器规模和成本未在公开代码中给出 |
| [Mindcraft](https://github.com/mindcraft-bots/mindcraft) | MIT | LLM + Mineflayer 的 agent 循环；MineCollab 多 agent 任务（[arXiv:2504.17950](https://arxiv.org/abs/2504.17950)）；技能与记忆 | 面向少量 agent；代码执行默认关闭。README 明确提示开启后存在注入风险 |
| [Mineflayer](https://github.com/PrismarineJS/mineflayer) | MIT | 每个 agent 一个 Minecraft 玩家连接；实体、方块、物品、聊天和移动 API；插件生态成熟 | 玩家连接带来网络、实体和 tick 成本；单服承载量需按硬件实测 |
| [Minestom](https://github.com/Minestom/Minestom) | Apache-2.0 | 轻量 Minecraft 服务端库；可写服务端 NPC/实体，不需要每个 agent 一个客户端连接 | 需要 Java 开发；仍受实体、区块与 tick 限制，不是无限扩容 |
| [Concordia](https://github.com/google-deepmind/concordia) | Apache-2.0 | Game Master 模式：agent 提出行动，环境裁定观察与后果；支持记忆、反思与社会实验设计 | 环境无关；仓库目录中未发现 Minecraft 集成，需要自写 MC 适配器 |
| [AgentSociety](https://github.com/tsinghua-fib-lab/AgentSociety) | Apache-2.0 | 面向社会科学实验的 LLM agent 模拟平台；城市级模拟与 Ray 分布式调度 | 不是 Minecraft；可作为实验编排、指标与扩容方式的参考 |
| [OASIS](https://github.com/camel-ai/oasis) | Apache-2.0 | 百万级 agent 的社交网络模拟 | 不是 Minecraft；可参考其规模架构，不能直接提供具身行为 |
| [Voyager](https://github.com/MineDojo/Voyager) | MIT | 自动编写技能、课程式探索、技能库复用 | 单 agent；最后一次提交在 2024 年，适合借鉴循环结构，不适合作为多 agent 运行时 |
| [MineClawd](https://github.com/Zhou-Shilin/MineClawd) | Apache-2.0 | 服务端 mod，把 agent 框架带进 Minecraft；支持建造与 KubeJS 执行 | 面向单 agent/小规模；可作为建造阶段或服务端接入参考 |
| [BuilderGPT](https://github.com/CyniaAI/BuilderGPT) | Apache-2.0 | 用 LLM 生成建筑 schematic / mcfunction | 开发已暂停，作者转向 MineClawd；只解决单建筑生成 |
| [Minecraft Agent Swarm](https://github.com/JesseRWeigel/minecraft-agent-swarm) | MIT | 5 个本地 LLM bot、持久记忆、共享协调、技能系统、可复现评测与世界快照 | 规模为 5；其评测协议、动作/观察溯源和世界快照做法值得借鉴 |
| [VillagerAgent](https://github.com/cnsdqd-dyb/VillagerAgent-Minecraft-multiagent-framework) | **无 LICENSE** | ACL 2024 的图结构 Minecraft 多 agent 框架 | 无许可证即默认保留所有权利，不能直接复制或复用代码；只能阅读方法 |
| [MineDojo](https://github.com/MineDojo/MineDojo) | MIT | 开放式具身 agent 的任务与环境基准 | 偏 RL/基准，不是 LLM 社会模拟；最后一次提交在 2024 年 |
| [MineRL](https://github.com/minerllabs/minerl) | GitHub 识别为 NOASSERTION | 高吞吐 Minecraft RL 环境 | 需单独核对许可证；与 LLM 社会实验路线不同 |
| [Generative Agents](https://github.com/joonspk-research/generative_agents) | Apache-2.0 | 记忆流、重要性/相关性检索、反思 | 25 个 agent 的小镇模拟，不是 Minecraft；可借鉴记忆与反思结构 |

## 规模、成本与工程约束

### 服务器容量

- Mineflayer agent 是一个真实的玩家连接；每增加一个 agent，就增加网络、实体、区块加载和 tick 成本。
- Paper/Spigot 单服能承载多少 bot 取决于硬件、视距、实体数、区块加载和 bot 行为。没有本项目的实测数据；持续活动的 bot 达到数百个时通常已经很重，千级需要分片或服务端 NPC。
- 分片：多服务器/多世界 + 代理；跨片社交需要额外的消息层和一致的世界状态设计。
- 服务端 NPC：Minestom 或自定义 mod 直接在世界里模拟 agent，不需要每个 agent 一个客户端；但仍受实体与 tick 限制。
- 距离 LOD：远处 agent 用抽象状态推进，近处才具身。这是千级以上更现实的关键设计，而不是单纯堆服务器。

#### 2026-10-27 本机实测补充（Luanti 路线）

上面各条是估算。本轮为 Luanti（原 Minetest）路线补了唯一一组本项目实测，机器为 14 GiB 内存的 Ubuntu 笔记本，实时基准 11.1 step/s，细节与原始日志见实测证据（本分支：`validation/luanti/bench/luanti-entity-scale-2026-10-27.txt`）。

- 纯服务端实体（无客户端连接）可以承载远超原先担心的规模：每步 O(1) 工作时 **2 万实体仍保持实时**（11.02–11.04 step/s），峰值 RSS 167 MiB。内存与实体数不是瓶颈。
- 崩塌来自每实体的计算量，而不是实体数量：朴素的 O(N²) 邻域感知在 **1000→5000 之间跌破实时**（4.4 step/s），10000 时降到 0.92 step/s。这给“距离 LOD 是关键设计”一条补上了本项目自己的数字。
- 无玩家时实体不会被 step，必须 `forceload`；且只在区块 emerge 完成后再生成实体，否则实体会被活跃区块管理周期**静默删除**（`add_entity` 不报错）。这是服务端 NPC 路线的硬性工程前提，原先未记录。
- 以上只覆盖 tick 与内存容量，**没有**覆盖 LLM 调用成本、延迟与 agent 行为。Minecraft/Paper 路线（玩家 bot）仍无本项目实测数据。
- 后续已把这条路线推到“有可运行的 agent 闭环”：服务端 agent 能重复启停、每个 server step 被引擎推进、动作在世界里留下真实方块、失败能被程序自己检出并说明原因（5 agent 23 s／45 MiB，20 agent 19 s／46 MiB，step 率 11.08–11.12）。决策仍是 6 条规则的确定性桩，**没有 LLM**。证据见 Luanti 适配层验证说明（本分支：`validation/luanti/README.md`）与 `evidence/luanti/agent/`。

### LLM 调用量

- 假设 1000 个 agent，每 5 分钟决策一次：约 200 次/分钟，约 28.8 万次/天。
- 按每次约 1k tokens 估算：约 2.9 亿 tokens/天。这是算术估算，不是实测。
- 成本随模型差异很大，可能在每天数百到数千美元量级；本地小模型或 vLLM 可改变成本结构，但需要算力和调度。
- 降低方式：事件驱动、分层（LLM 定计划，脚本/寻路执行）、模型分级、缓存、批处理、只让活跃 agent 调用、异步队列。
- 延迟：LLM 秒级响应与 Minecraft tick 不匹配；决策应异步，动作由本地技能立即执行。

### 可复现性与实验设计

- LLM 有非确定性；需要记录模型版本、提示、温度、seed、配置哈希和完整事件日志。
- 世界状态与 agent 状态分离存储；重置要能复现同一初始世界，并只改变实验条件。
- 需要实验 ID、A/B 分组、干预、指标、时间线 fork 和重放。
- 社会实验的效度问题：agent 行为不等于人类行为；模拟结果不能直接当作现实社会结论。

### 安全与合规

- LLM 生成并执行代码的框架存在提示注入和越权风险；代码执行应默认关闭，并在隔离环境中运行。
- Minecraft 本体是 proprietary：私服、Mod 和 bot 可用于研究，但不要分发游戏本体或素材；公开服务注意 Mojang EULA；大量账号与离线模式需谨慎。
- 许可证：VillagerAgent 没有 LICENSE，不能复制；MineRL 的 GitHub 许可证识别为 NOASSERTION，使用前核对；Project Sid 只有报告，没有代码许可。

## 推荐架构（若以后启动）

建议分成五层，避免把 Minecraft 服务器、LLM 调用和实验逻辑耦合在一个进程里：

1. **环境/具身层**：Minecraft 服务器 + bot/NPC 适配器 + 世界快照。
2. **Agent 运行时**：观察 → 记忆 → 决策 → 技能/动作；每个 agent 独立状态；LLM 适配器。
3. **实验编排层**：阶段、配置、干预、指标、日志、重放与 fork。
4. **LLM 服务层**：队列、批处理、模型分级、缓存、本地/远程切换。
5. **观测层**：trace、token/费用、动作日志、世界差异。

### 两阶段流程

- **建造阶段**：agent 用建造技能搭建世界；每完成一个里程碑保存世界快照（Minecraft save + schematic + agent 状态库）。
- **重置阶段**：停服、复制世界存档，重置 agent 的 persona、记忆、关系和目标；分配新的 experiment ID，再按实验条件启动。
- **实验阶段**：控制变量、施加干预、采集指标；保留事件日志和世界快照，支持时间线 fork 与重放。

### 与 Wispiva 的关系

本分支以实现 Wispiva 为目标，使用 Luanti 作为世界基底。社会实验、规模测量与信息隔离研究为产品开发提供证据；`observe / propose / execute / verify / event` 与 revision、记忆和恢复边界应在产品实现中共同考虑。下方阶段与决策问题保留原研究设计，当前实施顺序以[工作计划](../PLAN.md)为准。

## 分阶段计划与决策点

| 阶段 | 规模 | 目标 | 退出条件 |
| --- | --- | --- | --- |
| Phase 0 | 20 agents | 用 Mindcraft + Paper 跑通“建造 → 快照 → 重置 → 实验”闭环，记录 token 与耗时 | 能重复运行并产出可比较的日志 |
| Phase 1 | 100 agents | 加入实验编排、干预、指标和世界快照；验证服务器与 LLM 成本 | 单次实验成本与稳定性可接受 |
| Phase 2 | 500–1000 agents | 在 Minestom 服务端 agent 与抽象模拟 + MC 投影之间做选择；引入 LOD/分片 | 有可复现的规模证据，而非单次演示 |
| Phase 3 | 1000+ | 优化成本、延迟与实验吞吐 | 达到研究问题所需规模且不牺牲可复现性 |

停止条件：

- 20 个 agent 的闭环无法产生可测量的社会行为，不应直接扩规模。
- 单次实验成本超出预算，先转向本地模型或抽象模拟。
- agent 行为主要由手写脚本完成，需要重新评估 LLM 是否真的在承担决策。

## 未决问题

1. “成千上万”是全部真实具身，还是允许 LOD/抽象模拟？
2. 社会实验的具体问题、指标和对照组是什么？
3. 预算、本机算力和云端资源如何分配？本机 14 GB 内存只适合 Phase 0 小规模验证。
4. 使用真实 Minecraft，还是 Luanti/自研体素环境？
5. 账号、EULA、公开服务与数据合规边界。
6. 许可证尽调，尤其是无 LICENSE 或 NOASSERTION 的项目。
7. 是否复用 Wispiva 的世界模型、记忆和验证契约，还是完全独立？
8. LLM 非确定性下的可复现性标准是什么？

## 参考资料

- Altera, *Project Sid: Many-agent simulations toward AI civilization*, [arXiv:2411.00114](https://arxiv.org/abs/2411.00114)，[报告仓库](https://github.com/altera-al/project-sid)。
- Mindcraft，[仓库](https://github.com/mindcraft-bots/mindcraft)；MineCollab 论文 [arXiv:2504.17950](https://arxiv.org/abs/2504.17950)。
- Mineflayer，[仓库](https://github.com/PrismarineJS/mineflayer)。
- Minestom，[仓库](https://github.com/Minestom/Minestom)。
- Concordia，[仓库](https://github.com/google-deepmind/concordia)。
- AgentSociety，[仓库](https://github.com/tsinghua-fib-lab/AgentSociety)。
- OASIS，[仓库](https://github.com/camel-ai/oasis)。
- Voyager，[仓库](https://github.com/MineDojo/Voyager)。
- Minecraft Agent Swarm，[仓库](https://github.com/JesseRWeigel/minecraft-agent-swarm)。
- VillagerAgent，[仓库](https://github.com/cnsdqd-dyb/VillagerAgent-Minecraft-multiagent-framework)。

## 证据边界

- 2026-10-27 通过 GitHub API、README 与仓库目录读取信息；没有克隆、构建、运行**上表列出的第三方项目**，也没有复现论文结果。
- 与本项目自己的实验区分：Luanti 路线的服务端实体容量与 M0 agent 闭环已有本项目实测（见上文“本机实测补充”与 `engine/luanti/`）；**token 用量与费用仍全是估算**，A 路线（Paper/Minecraft）仍无任何本项目实测数据。
- 许可证信息可能变化；实际采用前必须重新核对仓库 LICENSE、素材许可和依赖许可。
- 本文不构成法律意见。
