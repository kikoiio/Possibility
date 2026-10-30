# 真实模型角色与环境闭环验收设计

核对日期：2026-10-30。本文件是产品验收设计和现状审计，不是通过报告，也不把 fixture、规则容量或模型输出文字当成真实模型能力。

## 验收对象

本项验收的最小闭环是：角色获得当时被授权的信息，模型提出一个动作，运行时验证并执行该动作，世界记录实际后果，角色在下一次决策中收到结果和可追查的记忆。验收对象包含以下六个边界：

1. 角色输入是否绑定到正确的世界、角色、起源修订和世界版本。
2. 模型输出是否只表达可验证的动作意图。
3. 环境是否决定动作成功、失败及实际后果。
4. 失败是否被保留为事实并反馈给角色，而不是被改写成成功。
5. 记忆是否保留来源、所有者和知识类型。
6. 停止、重启和再次决策是否使用已保存结果，而不是重新编造历史。

## 当前证据与结论边界

| 证据 | 已证明 | 不能证明 |
| --- | --- | --- |
| [持久产品世界验证](../../evidence/luanti/product-world-2026-10-29/README.md)，Actions 40956198179 | Draft 到 Luanti 世界、起源投影、fixture gather/build、事件、库存、长期记忆、正常停服恢复、客户端连接和场景互动链路 | 当前产品使用真实 provider；角色是否形成稳定目标、计划、协作或长期行为；断电级跨存储原子性 |
| [产品状态与模型输入验证](../../evidence/luanti/product-state-model-input-2026-10-29/README.md)，Actions 40956198179 | `wispiva.model-input` v1 的字段、来源、audience、动作边界和 provider 前校验；fixture 闭环的恢复路径 | provider 真实返回是否遵守这些边界；输入是否足以支持有意义的角色行为；模型不可用时产品是否能等待并恢复 |
| [真实模型配对探测](../../evidence/luanti/model/2026-10-28-memory-paired/summary.md)，Actions 40733909302 | 旧运行中 150 次真实模型动作、6 次 invalid_action 有界重试、消息投递、资源结果和资源守恒 | 当前产品世界的完整真实模型闭环；统计显著的记忆收益；稳定分工、共同结构、自发社会涌现；原始 provider 文本和逐 token 输入回放 |
| [模型桥接说明](../../model/README.md)及 `model/adapter.py` 测试 | HTTPS 配置、SSE 解析、固定错误码、动作白名单、输入隔离和审计字段 | 供应商容量、长期可用性、并发公平性、真实成本和生产级调度 |

因此，当前可以声称“产品运行时已有可审计的模型输入和环境执行边界，并由 fixture 完成纵向验证”；不能声称“当前产品已经通过真实模型角色与环境闭环验收”。后一个结论需要新的真实 provider Actions 证据。

## 角色输入契约

产品 Lua 在 [engine/luanti/mod/society/init.lua](../../engine/luanti/mod/society/init.lua) 组装输入，`cognition/model_envelope.lua` 和 `model/product_envelope.py` 在 provider 边界再次校验。验收时应以发送给 provider 的 `wispiva.model-input` v1 为准，不能以 Lua 内部的兼容 context 代替。

输入必须包含：

| 区域 | 内容 | 验收要求 |
| --- | --- | --- |
| `request` | `world_id`、`origin_event_id`、`actor_id`、`decision_id`、`world_revision`、`observed_at` | 世界和角色绑定正确；决策 ID 唯一；版本不倒退或伪造 |
| `actor` | 角色名、role、goal、各自来源、读取范围和允许动作 | role/goal 来自该角色的起源；权限包含角色本人；不能把其他角色私有字段放入 provider 请求 |
| `knowledge` | `facts`、`experiences`、`rumors`、`unknowns` | 每条有稳定 ID、来源、epistemic 类型和 audience；起源 seed 默认属于私有 unknown，不被当成已验证事实 |
| `current` | 当前观察、库存、可行动作 affordances | 只描述本次观察到的空间对象、库存和当前可达点；范围观察不等于遮挡后的第一人称视觉 |
| `feedback` | 上一次动作的 attempt、请求、状态、原因、event、观察时间和世界版本 | 成功和失败都要可见；无上一次动作时明确 `available=false` |

当前输入的记忆预算是最多 8 条、最多 4096 字节的完整记录，整个 envelope 还有 16000 字节上限。预算溢出时应减少选择结果并记录 omission，不能截断一条记忆、静默删除来源或把未选内容暗中传给 provider。

## 模型输出与动作执行

provider 只能返回 JSON 动作。允许的动作是 `inspect`、`mark`、`advance`、`approach`、`wander`、`say`、`gather`、`build`，其附加字段由动作类型决定；额外字段不能改变端点、节点名、审计来源或权限。`why` 由本地适配器固定，不能由模型声明自己是 fixture 或真实模型。

模型输出只是候选意图。运行时还要检查：

- `target` 是否在当前观察到的邻居中；
- 坐标是否为整数、在世界边界内，并且对 `gather`／`build` 满足当前可达条件；
- `advance` 是否有已设置的移动目标；
- `say` 的文本长度和控制字符限制；
- 环境当前状态是否仍允许资源读取、库存变化和地图写入。

只有环境返回的实际结果才能产生 `world-event:N`。模型说“成功”、动作 JSON 合法或请求已发送，都不能算世界后果已经发生。

## 模型不可用与动作失败

验收必须把下列情况分开记录，不能统一显示为“模型没反应”：

| 情况 | 当前边界 | 产品验收应断言 |
| --- | --- | --- |
| 配置缺失、URL 不合法、provider 不可达、429、超时、响应不完整 | `adapter.py` 返回固定错误码；Lua 队列记录 `model-response` 或 `model-timeout` 并结束当前运行 | 没有动作事件、没有伪造的成功后果、没有将等待时间补成世界时间；需明确角色线是等待、停止还是由产品控制面恢复 |
| provider 返回非法 JSON 或越权动作 | `invalid_action` 在 worker 中最多有界重试；Lua 对无法接受的响应记录失败或 stale | 每次尝试有审计；最终失败不会执行；重试不能制造重复世界事件 |
| 合法动作但执行前提失败 | `apply` 返回 `ok=false` 和原因，仍提交带 `ok=false` 的世界事件，并把结果放入 `last_action`／`feedback` 和长期 outcome | 地图和库存只反映实际成功；失败原因能在下一次输入中看到；不能把失败动作当作完成目标 |
| 观察、请求写入、响应审计、事件或长期记忆写入失败 | 当前运行记录 `fail=...` 并停止 | 不开放一个状态不完整的世界；失败点、已有提交和待恢复边界可追查 |
| 动作已过时 | 例如目标不再可达、邻居不再在观察范围内；当前路径记录 `ev=model-stale` | 不执行陈旧动作；下一次决策必须基于新观察，不应复用旧响应 |

当前实现对 provider 不可用主要采用 fail-closed 停止语义，而不是已经完成的“角色局部等待、其他世界线继续、恢复后从同一逻辑时刻续跑”产品控制面。后者是验收缺口，不能从 `ModelError` 测试推导为已实现能力。

## 记忆来源和可见性

角色输入中的记忆必须能回答“谁在什么时候从哪里得到这条内容”：

1. 起源 memory seed：来自确认 Draft 的私有材料，保留 `world_id`、seed ID、起源事件和 owner；默认以 private unknown 提供，不证明内容已经在世界中发生。
2. episodic observation：角色自己的局部观察摘要，来源为 observation；它是当时感知记录，不是全局事实。
3. action outcome：资源、移动、交流等动作的实际结果，来源绑定 world event；失败结果同样保留。
4. direct message：收到或发出的消息，来源包含发送者或 message ID，属于传闻或直接信息，不能自动升级为事实。
5. durable long-term memory：由 L0 世界结果和 L1 角色经历形成，按角色 owner 检索；它是保存过的解释和结果，不替代当前世界回读。
6. relation/contact state：已见过谁等运行状态会影响行为，但不应冒充带文本来源的情节记忆。

`fifo` 和 `retrieval` 都是有界选择策略。检索分数、选择顺序和 omitted 数量应进入验收证据；未选中的记录不能被认为已被模型看到。恢复应保留 ID、source、audience、event_id 和失败状态。当前长期记忆尚无完整语义反思、可信度更新、跨角色传播审计和断电级共同提交，这些都属于缺口。

## 世界后果验收

每一个模型决策都要形成一条可关联链：

`model request → model attempt → validated action → environment result → world event → memory/outcome → next feedback`。

最小通过条件如下：

- `gather` 成功时，资源节点减少、角色库存增加、world event 为 `ok=true`，下一次输入反映新库存；失败时资源和库存不凭空改变，事件为 `ok=false` 并带原因。
- `build` 成功时，目标节点和库存都发生对应变化并能回读；失败时不以模型文本或日志代替地图事实。
- `say` 成功时，接收者 inbox、双方 episodic memory 和消息 event 可关联；发送失败时不能写成已送达。
- `wander`／`approach` 只设置目标或关系意图，`advance` 的位置变化才是移动后果；当前 `advance` 已经过有界 BFS 和节点回读，但最终仍用无物理碰撞的 `set_pos` 更新实体，不能作为完整生存游戏通行证明。
- 同一 `operation_id` 重试返回原事件；不同结果或载荷的同 ID 重试必须拒绝。
- 正常停服后 checkpoint 能恢复角色、库存、inbox、last action、事件和长期记忆；恢复后不重新生成同一历史事件。
- 发生地图、库存、事件或记忆任一提交失败时，世界保持可识别的冻结或待对账状态。当前这些存储仍不是断电级原子事务，因此只能通过正常停服恢复声称有限连续性。

## 建议的产品验收序列

### A. 当前 fixture 基线

保留现有 Actions 产品世界验收，明确标记 `origin=fixture`，验证字段结构、动作执行、资源守恒、失败反馈、checkpoint 和客户端进入路径。它是环境与协议基线，不是模型能力通过。

### B. 真实模型三角色小闭环

在新建的确认产品世界中使用真实 provider，固定 3 个角色、目标、起源 seed、世界版本和运行时配置，至少完成每个角色 8 次决策。证据至少包含：

- 每次 request 的 envelope 摘要、actor/world/decision 绑定和输入来源计数；
- provider attempt 的固定错误码、延迟和 token 审计；
- 真实 `origin=model` 动作及其环境结果；
- gather/build 的地图和库存回读、message 的接收记录；
- 失败动作、stale action、重试和最终停止原因；
- 停服、恢复后再次决策，以及恢复前后 event／memory ID 对账。

原始 provider 文本和私有 prompt 不应默认归档；若需要复核，应保存受控的脱敏输入哈希和字段级证据。

### C. 受控失败组

分别注入 provider 不可用、超时、429、非法 JSON、非法动作、过时目标、资源不存在、库存不足、地图写入失败和长期记忆写入失败。每组都要断言：失败类型可区分、没有伪造成功后果、重试有界、恢复边界明确。

### D. 记忆和知情组

给角色一个私有 seed、一个可验证的世界结果、一个失败结果和一条来自另一角色的消息；让其在恢复前后回答或行动。验收同时检查正确使用、明确未知、来源归属和不向其他角色泄漏。不能只检查模型说出 seed；还要检查世界是否真的产生过对应后果。

### E. 长时和环境后果组

在固定世界种子下重复多轮，检查资源守恒、库存和地图回读、事件幂等、反馈驱动的下一动作以及 checkpoint 后的连续性。只有当后果在世界状态中可读，才计为闭环行为；日志中的叙述和模型自报不计分。

## 通过标准和未通过项

“真实模型角色与环境闭环通过”必须同时满足：真实 provider 调用有明确审计；至少一项模型动作成功改变世界；至少一项动作失败并被角色看到；至少一条消息或记忆跨决策发挥作用；至少一次重启后仍能根据保存结果继续；所有失败注入均没有伪造后果。

以下结果只能标为局部通过：只有 fixture、只有 provider 返回成功、只有日志没有地图／库存回读、只有角色说法没有来源、只有正常停服没有崩溃边界、只有 3D 客户端连接没有模型角色行为。

当前优先缺口是：

1. 在当前产品 manifest 和 `wispiva.model-input` v1 上运行并归档真实 provider 的 Actions 证据。
2. 为模型不可用定义产品级等待／冻结／恢复语义，而不是仅有当前运行终止。
3. 增加地图、库存、事件、角色 checkpoint 和记忆的共同版本或对账验收；正常停服恢复不等于断电原子性。
4. 验证真实模型的长期目标、反馈利用、来源判断和世界后果，避免把动作数量、消息数量或文字连贯性当作自主性。
5. 单独验收真实三维视觉、碰撞和寻路；当前自动客户端夹具只证明进入、互动和引导事件链路。

涉及实现文件：`engine/luanti/mod/society/init.lua`、`cognition/model_envelope.lua`、`cognition/memory.lua`、`cognition/long_term_memory.lua`、`cognition/world_events.lua`、`cognition/persistence.lua`、`model/adapter.py`、`model/bridge.py`、`model/product_envelope.py`；涉及现有证据和执行入口见本文引用的 `evidence/`、`model/README.md` 与 `.github/workflows/wispiva-validation.yml`。
