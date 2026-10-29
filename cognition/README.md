# 观察、动作与记忆

这些 Lua 5.1 模块已接入 `agent/mod/society/init.lua`，在 GitHub Actions 的 Luanti 5.10.0 中验证。规则模式通过 `society_cognition=true` 开启附加观察与记忆；模型模式自动开启。

## 给 LLM 的信息

每次请求包含自己的 ID、persona 标签、时间、目标、位置、移动目的地、私有库存、上次动作实际结果、当前收到的消息，以及范围内的角色 ID／位置和资源／标记。`action_context.lua` 列出此刻够得到的采集点和持有资源时可放置的空位。`wander`／`approach` 设置目的地，后续 `advance` 才移动；模型返回一个动作，由引擎重新校验并执行。

`observation.lua` 的范围为三维球体，返回 `{pos, radius, agents, nodes}`。只公开邻居 ID、位置、距离；不公开别人的记忆、库存或内部实体。节点名由调用方白名单指定。它不检查视线遮挡，因此 `visible_nodes` 这一历史字段表示范围内节点，不能解释为第一人称视觉。世界是无碰撞路径规划的简化平面；角色使用 `set_pos` 移动，不能据此声称能在普通生存游戏中行走。

## 当前记忆实现

`memory.lua` 为每人独立、容量 32 条的 FIFO 事件存储，可选择近期记录或词项检索。每条记录有 `time`、`text`、`source.kind/id`；输入、输出复制，角色间不共享私有记录。内容包括观察摘要、资源动作结果、发出和收到的消息。记录数有上限，消息字节另有限制。规则策略另有接触集合 `memory.met`，它不等同于情节记忆。

`society_model_memory=false` 只从模型请求中去掉历史情节；当前消息和上次动作结果仍提供，两组都能接收即时反馈。消息 inbox 最多 32 条，提交请求后清空；处理请求期间新到消息在下次请求提供。产品 checkpoint 会保存 inbox 和上次动作反馈，恢复后来源与 `event_id` 保留。历史来源只是“谁报告了什么”，不是对陈述真实性的证明。

模型默认 `society_memory_mode=fifo`，可切换为 `retrieval`。两者从同一存储选择最多 8 条、规范紧凑 JSON 最多 4096 UTF-8 字节的完整记录，计入来源、时间与数组标点；不截断单条。这个上限约束记忆投影，不等于整个请求或实际 token 相同。检索查询来自目标、自己上次动作反馈、当前邻居 ID 和观察到的节点名。词项重合、精确数字 ID 与时间影响排序；当前分词面向空格分隔文本，未做中文分词、同义词或跨语言匹配。选中记录仍按原始顺序提供，供模型判断来源和新旧。

当前没有向量检索、长期语义记忆、关系推理、reflection 或持久计划。检索仅从尚未被 FIFO 存储淘汰的事件中选择，不能恢复已遗忘事件；时间只用于相关性相同时排序，不保证解决矛盾陈述。受控评估使用相同 Lua 代码，明确比较“已有事件库如何选入有限上下文”，不代表长期记忆问题已解决。

`world_events.lua` 是独立的世界事实账本。每次角色行动和接触先按
`operation_id` 提交实际执行结果，生成单调的 `world-event:N` 身份；相同操作重试返回原事件，参数变化会失败。长期记忆的 L0/L1 记录引用这个事件身份，因此模型上下文中的经历有稳定来源。账本与角色快照、长期记忆、消息 inbox 一起写入 checkpoint；这仍是正常停服 checkpoint，尚未与 Luanti 地图数据库形成跨存储事务，也尚未覆盖进程崩溃窗口。

产品世界额外使用 `product_state.lua` 记录 `READY`、`PREPARING` 和 `FROZEN`。模型请求由
`model_envelope.lua` 生成 `wispiva.model-input` v1：`facts` 是当前可验证事实，`experiences` 是该角色自己的经历，`rumors` 是消息或转述，`unknowns` 是有来源但未证实的起源种子。
每条记录都带 `source` 与 `access.audience`；当前观察、库存、可行动作和反馈另放在
`current`/`feedback`，避免把动作意图写成世界事实。

## 持久化与资源

`persistence.lua` 保存实体位置、稳定 body ID、库存、RNG、计数、关系、短期记忆、消息 inbox 和上次动作反馈。恢复前验证完整批次；实验运行器的 `--resume` 保留身体与世界，清除记忆、关系和移动目标，并重设 persona 与本轮决策数；产品世界的 `--resume` 保留角色心智。body ID 不变，故不是全新人口。停服写入；异常退出后的世界由产品状态账本冻结，不能自动猜测缺失投影。

`resource_actions.lua` 检查整数目标、1.5 格欧氏距离、已加载节点、库存及实际写入回读。仅操作 `society:resource`，采集增加库存、放置消耗库存；集成停服核对“世界资源＋库存”守恒。`mark` 是独立的调试标记，不消耗资源。模块不提供一般游戏的保护、视线与回调语义。

## 定向验证

在本目录运行 `lua5.1 test.lua`、`test_persistence.lua`、`test_resource_actions.lua` 、`test_action_context.lua`、`test_spatial.lua`、`test_runtime.lua`、`test_retrieval.lua`、`test_product_state.lua` 和 `test_model_envelope.lua`。这些是轻量模拟引擎测试；实际启动、恢复、资源夹具与模型闭环由独立 Actions 工作流验证，结果见 [执行计划](../docs/PLAN.md)。


## 规模运行

产品世界还使用 `environment.lua` 管理可恢复的逻辑时间过程。资源再生或
耗减只在时间推进到新边界时产生一次带稳定 `operation_id` 的结构化结果；
条件变化先结算旧条件，再安装新条件。Luanti 产品运行时把结果提交到世界
事件账本，并将资源节点投影到世界边界区域。模块本身不写地图，宿主负责把
过程快照与事件一起保存；当前运行时在 mod storage 中保存快照，启动时拒绝
损坏状态。

持久产品世界的起点由 `genesis/world_create.py` 生成。角色在
`wispiva-origin.json` 中各自拥有 role、goal 和 genesis seeds；Lua 主循环
只把当前角色的 profile 放进该角色的模型请求，邻居观察不含这些字段。空间
投影由 `engine/luanti/mod/society/world_projection.lua` 生成地点、室内外
结构、连接和角色起点，重复应用会读回并跳过已经正确的操作；冲突或未知
状态会在写入前拒绝。

`spatial.lua` 维护角色位置格索引，按精确球形距离筛选；每次移动后更新。规则与认知在中心一致时共用该次邻居快照。角色私有状态仍在观察投影时移除。`node_cache.lua` 缓存 16³ 节点格，最多 1024 格；所有本 mod 节点写入使对应格失效，未加载格不缓存。它只适用于本实验无外部写入的世界。

`scheduler.lua` 保持每轮 ID 顺序，把决策分到多个 callback，默认软预算 65 ms，不在同一 callback 追赶多轮。该值来自 10,000＋cognition 的 25／50／65 ms、各 5 次完整工作量调优；65 ms 的 5/5 运行通过步率门槛且完整耗时最低，但实际决策间隔仍约 5 秒，因此不是 2 秒硬实时保证。角色动作和单次查询不可抢占；应同时查看 `cadence`、`performance`、步率及完整决策总量。forceload API 接收节点坐标，因此循环区块索引需乘 16。
