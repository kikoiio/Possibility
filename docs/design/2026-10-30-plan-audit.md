# 实施计划审计（2026-10-30）

本文审计当前工作区的 [`docs/PLAN.md`](../PLAN.md)。本文不改变计划勾选状态，也不把夹具验证写成产品完成。当前审计基线是分支 `wispiva/world-product` 的提交 `85de7985`；真实模型产品运行是 [Actions 41010708756](https://github.com/kikoiio/Wispiva/actions/runs/41010708756)，Lua apply 回归是 [Actions 41012930532](https://github.com/kikoiio/Wispiva/actions/runs/41012930532)。

仓库内 `docs/` 和 `evidence/` 的相对 Markdown 链接均能解析到现有文件。Actions 41010708756 对应真实模型提交，Actions 41012930532 对应当前产品提交；真实模型 artifact 已在产品证据 README 中记录。历史证据中的旧提交仍只作为历史运行记录引用。

## 未勾选项

| 计划项 | 状态 | 当前证据 | 下一步 |
| --- | --- | --- | --- |
| 统一创建与状态契约 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 已实现 `READY`、`PREPARING`、`FROZEN`、准备与提交版本。Luanti 启动时会对账起源投影，发现不一致时冻结。对应测试见 [`test_product_state.lua`](../../cognition/test_product_state.lua)，运行范围见 [`产品状态与模型输入证据`](../../evidence/luanti/product-state-model-input-2026-10-29/README.md)。 | 在同一已提交版本上注入地图、角色、库存、事件、记忆和环境的逐阶段中断。确认每个启动路径都能冻结未知状态，并补充精确的权威归属和恢复协议。跨存储原子提交仍未实现。 |
| 用户意图到世界起点 | 部分完成 | [`genesis/2026-10-29-product-intents/summary.md`](../../evidence/luanti/genesis/2026-10-29-product-intents/summary.md)记录两个非固定题材、草稿修订、确认 revision、私有 intent 和公开投影。持久世界证据见 [`product-world-2026-10-29`](../../evidence/luanti/product-world-2026-10-29/README.md)。 | 用真实用户文本或素材完成至少两次确认流程。记录用户看到的草稿、修改、确认、失败回滚和语义隐私审查结果。当前证据仍主要来自合成输入和夹具。 |
| 空间与三维体验 | 部分完成 | [`product-world-2026-10-29/README.md`](../../evidence/luanti/product-world-2026-10-29/README.md)记录地面、室内外投影、连接、角色起点、客户端连接、场景互动和引导到达。Actions `40956198179` 是该运行的远端引用。 | 完成真人 Luanti 客户端验收，记录用户是否能移动、观察、理解互动及其后果。随后补充真实通行、碰撞、寻路、外观和不同题材的场景验证。当前角色仍使用受控投影和 `set_pos`。 |
| 记忆从起点进入主循环 | 部分完成 | [`model_envelope.lua`](../../cognition/model_envelope.lua) 已生成 `wispiva.model-input` v1，并区分 `facts`、`experiences`、`rumors`、`unknowns`。[`product_envelope.py`](../../model/product_envelope.py) 和 [`bridge.py`](../../model/bridge.py) 在 provider 前校验来源、角色绑定和 audience。[`long_term_memory.lua`](../../cognition/long_term_memory.lua) 已增加按 owner、topic 和 L1 经历生成连续版本的 `reflect` API；[`reflection.py`](../../model/reflection.py) 约束 L2 provider 输入和 source IDs；[`reflection_host.py`](../../model/reflection_host.py) 约束 provider 成功后的写回结果。[`产品模型世界证据`](../../evidence/luanti/product-model-2026-10-30/README.md)对应 Actions 41010708756，已验证真实模型 envelope、消息来源隔离和一次 Cora L2 反思（4 个来源、841 tokens）。 | 把 host adapter 的 append callback 接到 Luanti 认证后的 `store:reflect`，增加反思质量与当前版本选择；验证崩溃恢复后的 inbox、动作反馈、来源和版本。当前运行证明的是小规模 provider 边界，不证明长期反思质量或大规模模型容量。 |
| 真实角色与环境闭环 | 部分完成 | [`environment.lua`](../../cognition/environment.lua) 已提供逻辑时间下的资源变化。Actions 41010708756 的真实 provider 产品世界记录 18 次决策、对白、传闻、资源成功和 `resource_mismatch` 失败、动作反馈、世界事件和 checkpoint；模型 envelope 将当前观察、库存、可行动作和上次反馈分开投影。 | 增加过期响应、冲突和模型不可用的真实场景，增加真实通行或交互对象，并证明动作结果在世界、事件、库存和角色经历中的跨存储一致性。 |
| 持续时间与恢复 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 和 Luanti 主循环已保存逻辑时钟、环境、角色、事件、长期记忆和产品提交版本；启动时能拒绝未完成提交。持久世界证据记录正常停服和 `--resume`。 | 在 `prepare`、地图写入、checkpoint、环境保存和 `commit` 之间注入退出或崩溃。验证失败后世界保持冻结，重试不重复结算。补充暂停、无客户端运行、重连和离线时间不补算验证。当前实现仍使用多个存储，不能宣称断电级一致提交。 |
| 端到端体验与证据 | 部分完成 | [`genesis/2026-10-29-model/summary.md`](../../evidence/luanti/genesis/2026-10-29-model/summary.md)记录两次合成题材草稿的真实模型生成；[`产品模型世界证据`](../../evidence/luanti/product-model-2026-10-30/README.md)现在记录与提交 `55a5ffa8` 对应的真实 provider 产品世界、请求／响应审计、私有记忆隔离、动作结果和 L2 artifact。客户端验收仍是自动化连接和路径检查，不是真人评价。 | 用真实用户意图创建世界，完成真人三维体验验收，并补充跨存储崩溃窗口、恢复和长期运行证据。 |

## 已完成但证据或文档没有完全同步的内容

1. **产品模型输入边界已有实现。** `wispiva.model-input` v1、四类知识、来源、audience、当前状态和动作反馈已经进入 Lua 主循环、Python validator 和 bridge。Actions 41010708756 已用真实 provider 验证小规模输入边界和 source-grounded L2 输出，并把请求／响应和反思审计写入 artifact；`reflection_host.py` 已提供受控 append 边界。`PLAN.md` 仍将整个记忆目标保持未完成是正确的，因为该 callback 尚未接入 Luanti 主循环、长期质量、恢复窗口和真人角色质量还没有验收。

2. **产品状态冻结边界已有实现。** `product_state.lua`、启动对账、逻辑时钟和失败冻结已经有代码与定向测试。Actions 41010708756 与提交 `55a5ffa8` 对应，证据 README 已记录 artifact；这仍不能证明地图数据库、mod storage、角色 checkpoint 和环境快照之间的跨存储原子性。

3. **自动客户端验收已有记录。** `product-world-2026-10-29/README.md` 已补充客户端连接、互动和引导到达，`docs/PLAN.md` 也已有 Actions `40956198179` 引用。该证据应明确归类为自动化路径检查，不能替代真人移动、观察和可理解性评价。

4. **长期记忆文档已同步当前边界。** [`cognition/README.md`](../../cognition/README.md) 记录了 `store:reflect`、真实 provider 的一次 L2 验证和仍待完成的宿主触发、写回与质量评估；`model/README.md` 记录了 `reflection_host.py` 的显式写回边界。

5. **本地链接完整不等于证据新鲜。** 本次静态检查没有发现 `docs/` 或 `evidence/` 中指向不存在文件的相对链接。当前产品模型证据对应提交 `55a5ffa8`，产品分支当前提交 `85de7985` 的 Lua apply 回归已由 Actions 41012930532 验证；这些证据仍不能替代真人体验、跨存储崩溃测试或大规模真实 LLM 容量证据。

## 审计后的推进顺序

1. 为真实 L2 反思增加产品宿主触发、写回、版本选择和恢复验收。
2. 做跨存储中断注入、冻结和恢复验证，保留失败产物。
3. 完成真人 Luanti 客户端验收和真实用户意图链路。
4. 依次验证几十、几百及更大规模角色，区分规则实体容量、真实模型决策频率、队列等待和费用。

本次审计随后已同步实施计划、架构、模型和记忆文档；轻量 Python 测试通过，Lua／Luanti 运行仍由 Actions 验证。
