# 当前架构：Wispiva 产品分支

核对日期：2026-10-30。本分支的产品目标与 [Wispiva 项目意图](intent.md)相同，采用 Luanti 作为 Minecraft-like 世界基底，独立发展且不合并到 `main`。本文只描述本 worktree 的现状；[目标设计](design/2026-10-27-target-architecture.md)和[实施计划](PLAN.md)不是已实现能力。产品代码直接位于根目录模块，Luanti 适配层位于 `engine/luanti/`；历史验证属于此适配层的证据，不限定本分支的产品目标。目录职责见[仓库布局](repository-layout.md)。

## 现有组件与数据流

| 组件 | 位置 | 当前能力和限制 |
| --- | --- | --- |
| Luanti 运行时 | [runtime/bootstrap.sh](../engine/luanti/runtime/bootstrap.sh) | 从系统软件源下载并解包引擎和 Minetest Game 到项目内 `.runtime/`，记录哈希；没有锁定未来软件包版本。 |
| 实体与规则调度 | [engine/luanti/mod/society/init.lua](../engine/luanti/mod/society/init.lua)、[policy.lua](../engine/luanti/mod/society/policy.lua)、[cognition/navigation.lua](../cognition/navigation.lua) | 服务端实体、有限 BFS 移动、标记、接触与分帧决策；产品世界启动时读取持久起源 manifest，按空间投影生成地点、连接和角色起点，provider 请求只发送当前角色的 `wispiva.model-input` envelope。导航会在每次移动前回读地面、身体空间、墙体和动态障碍；仍不实现普通生存游戏的碰撞、跳跃或第一人称视觉。 |
| 观察与动作 | [cognition/](../cognition/README.md) | 球形范围观察、空间索引、节点缓存、资源采集与放置、资源回读；无视线遮挡，不是第一人称视觉。资源操作限于实验节点。 |
| 私有记忆与世界事件 | [cognition/memory.lua](../cognition/memory.lua)、[long_term_memory.lua](../cognition/long_term_memory.lua)、[world_events.lua](../cognition/world_events.lua) | 每角色有短期记忆、长期 L0/L1/L2 记录、消息 inbox 和上次动作反馈；产品模型输入明确分为事实、本人经历、传闻和未知，均带来源与 audience。实际行动先进入按运行命名空间和操作键幂等的 `world-event:N` 账本，正常停服 checkpoint 保存事件、记忆、消息与角色状态。真实 provider 的独立 L2 校验已在 Actions 41010708756 通过；当前代码新增主循环定期触发、仅本人持久 L1 来源写回，以及独立 belief 槽位选择最新主题版本，集成云端验收已由 Actions 41025066379 通过；崩溃窗口和地图原子提交仍未完成。 |
| 模型桥接 | [model/](../model/README.md) | Lua 将模型输入 envelope 和兼容上下文提交到私有文件队列，Python worker 在 provider 调用前校验世界、角色、知识分类、来源和 audience，并只发送 envelope；兼容上下文只留在本地做动作结果校验。并非千人模型调度器。夹具和真实模型分开记录。 |
| 持久化和快照 | [cognition/persistence.lua](../cognition/persistence.lua)、[snapshot.py](../engine/luanti/snapshot.py) | 停服保存角色位置、身份、库存、关系、短期记忆、消息 inbox、上次动作反馈、事件账本和长期记忆；产品世界的 `--resume` 保留这些状态，实验运行器的 `--resume-preserve` 仍是独立夹具语义。异常崩溃恢复和跨存储事务未证明。 |
| 创建与状态核心 | [genesis/](../genesis/README.md)、[world/](../world/README.md) | 创建、校验、确认草稿和 SQLite 状态事务已有原型；`DraftStore.create_from_intent` 会持久绑定原始用户意图，确认前允许编辑，`genesis/world_create.py` 将已确认修订发布为带稳定身份、私有 manifest、起源副本和 Luanti mod 的产品世界。两个非 `example.json` 题材案例已有创建入口、修订、确认和私有边界回归证据。产品运行时用 `PREPARING → 投影/回读 → READY` 记录共同提交边界，异常留下冻结证据。地图、事件、库存和角色仍不是跨存储原子事务；真实用户语义确认仍未完成。 |
| 世界身份与受控接入边界 | [launch.py](../engine/luanti/launch.py)、[world_session.py](../engine/luanti/world_session.py)、[world_identity.py](../engine/luanti/world_identity.py)、[world_lock.py](../engine/luanti/world_lock.py) | `launch.py` 在启动 Luanti 前取得 `WorldSession`，运行期间持有 Unix `flock`，转发停止信号并在引擎退出后释放；新世界先建立独立 UUID 身份，非空无身份世界拒绝自动接管。锁仍是协作式的，不能约束未使用该协议的进程、玩家或 mod。世界事件、角色 checkpoint 和记忆已共享事件身份，但地图共同提交尚未完成。 |
| 验证运行器与 CI | [engine/luanti/run.sh](../engine/luanti/run.sh)、[Actions 工作流](../.github/workflows/wispiva-validation.yml) | Actions 负责轻量单测、Luanti 持久世界、重启恢复和容量测量；`run_product.sh --serve` 保持产品服务器可供本地 Luanti 客户端连接，`view_product.sh` 从固定观察者出生点进入三维世界。真实客户端画面仍需真人验收。 |
| 用户意图创建原型 | `proto/world-genesis` 分支的 `prototypes/` | 独立的 Node/Three.js 原型，包含创建对话、世界草稿和有限规则；不在本 worktree 中运行，也尚未与 Luanti 接通。可通过 `git show proto/world-genesis:prototypes/README.md` 查阅。 |

目前的实际数据路径是 `Luanti globalstep → 当前角色的观察/授权记忆 → wispiva.model-input envelope → 私有文件队列 → 模型 worker → provider 前校验 → 动作校验 → Luanti 执行 → world-event 与角色记忆`；规则模式使用本地策略而不经过模型。停服时由产品状态账本包住地图回读、环境、角色、事件和记忆的顺序写入；它能发现中断并冻结，仍不是跨数据库原子事务。

## 产品目标与状态

| 产品能力 | 本分支状态 | 主要缺口 |
| --- | --- | --- |
| 从用户想法创建世界 | 草稿生成、验证与确认核心已有原型，尚未接入 Luanti | 创建对话、空间生成、前史运行、语义隐私和用户意图保持一致。 |
| 三维世界中观察 | 有临时 Luanti 实体展示原型 | 可用场景、真实行走、清晰互动、视觉质量和用户体验尚未验收。 |
| 自主角色与环境后果 | 小规模真实模型闭环、持久起点、空间投影、有限资源动作和一个逻辑时间资源过程 | 丰富行动、真实寻路、地图共同提交、可持续生活和真实互动质量尚未证明。 |
| 主观记忆 | 短期经历与可选长期 L0/L1 记录，正常停服保留恢复 | 前史导入、主观解释、反思、长期检索质量、知识传播、崩溃恢复及分岔继承。 |
| 起源到模型输入 | 产品 Lua 主循环生成 `wispiva.model-input` v1，注入当前角色的 role、goal、私有种子、选择后的经历、消息、当前观察、库存、可行动作和上次执行反馈；Python bridge 在 provider 前拒绝越权或缺来源记录，并排除 legacy 私有字段。真实模型产品运行已验证该 envelope、私有 audience、消息来源和 source-grounded L2 输入。并非千人模型调度器。 | Python `origin_context.py` 仍是离线旧入口；两种 handoff 尚未统一，认证、观察真实性、执行时可达性、反思写回恢复和大规模真实模型行为仍需单独验收。 |
| 持续时间与恢复 | 产品服务器支持 `--serve`，正常停止保存逻辑时间、环境、角色、消息、事件和记忆，`--resume` 不补算离线时间；启动时发现 pending/active marker 会拒绝继续。 | 暂停/恢复控制面、真实断电窗口、地图与 mod storage 的共同回滚、观察者重连体验。 |
| 数千至万级 | 有规则实体／感知负载及小批真实模型证据 | 实际模型并发、决策频率、成本、长期运行与社会行为；不可用规则容量代替。 |

[预算调优证据](../evidence/luanti/scale/2026-10-28-budget-tuning/summary.md)中 10,000 角色 65 ms 配置的决策间隔中位约 4.97 秒，未达到 2 秒目标；[受控记忆对照](../evidence/luanti/model/2026-10-28-retrieval/summary.md)只覆盖指定任务。历史结果和本地观察原型不等于产品验收。
