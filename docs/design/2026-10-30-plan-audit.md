# 实施计划审计（2026-10-30）

本文审计当前工作区的 [`docs/PLAN.md`](../PLAN.md)。本文不改变计划勾选状态，也不把夹具验证写成产品完成。产品提交 `b8cf457` 的回归、世界创建、持久世界和自动客户端验收在 [Actions 41058024437](https://github.com/kikoiio/Wispiva/actions/runs/41058024437) 通过；真实模型补测提交 `281d00e` 的自由社会运行和 1/2/4/8/16 并发 provider 阶梯在 [Actions 41058674691](https://github.com/kikoiio/Wispiva/actions/runs/41058674691) 通过。此前产品与容量基线仍见 `7492eee` 的 Actions 41045295723、41045304874 和 41046819509。首次容量专项 [Actions 41040386531](https://github.com/kikoiio/Wispiva/actions/runs/41040386531) 与 [41040395398](https://github.com/kikoiio/Wispiva/actions/runs/41040395398) 显示 success，但逐项状态均以 exit 2 在启动前退出：客户端验收遗留 Luanti 服务端。进程清理和退出状态已在 `d6cdbe4` 修复。

随后 [Actions 41041685681](https://github.com/kikoiio/Wispiva/actions/runs/41041685681) 完成 5,000／10,000 个规则策略实体（认知开关 false／true，各重复 3 次）：每轮均校验全部实体存活并完成 12 次决策，日志步频最低 10.88–11.03 steps/s。该 run 报告的 17 MiB RSS 和 CPU 值来自 `launch.py` 包装进程，不是 Luanti 引擎，必须作废。`49cb1b0` 首次改为采样引擎 PID；[Actions 41044694644](https://github.com/kikoiio/Wispiva/actions/runs/41044694644) 实测到小场景引擎 RSS 47 MiB，但引擎退出后脚本清空 PID，导致基线失败；[41044701821](https://github.com/kikoiio/Wispiva/actions/runs/41044701821) 因此前置基线失败而未进入规模阶梯。`30d26a1` 修正 PID 保留后，[Actions 41045304874](https://github.com/kikoiio/Wispiva/actions/runs/41045304874) 的 20–1,000 角色／认知开关 8 组全部全员推进、通过 10 steps/s 硬门槛，RSS 为 80–111 MiB；步频 10.85–11.07 仍略低于 11.1 实时参考线。[Actions 41046819509](https://github.com/kikoiio/Wispiva/actions/runs/41046819509) 的 5k／10k 阶梯全部 12/12 决策、3/3 重复通过，引擎 RSS 范围 647–1,493 MiB。对应数据与 10k 模型队列推演见[容量证据](../../evidence/luanti/agent/capacity-2026-10-30.md)。

真实模型行为证据和当前产品代码证据分别指向各自运行提交；容量数据 artifact 链接见[容量证据](../../evidence/luanti/agent/capacity-2026-10-30.md)。历史运行号保留在证据页面中，并按是否真实执行、指标是否有效区分。

## 未勾选项

| 计划项 | 状态 | 当前证据 | 下一步 |
| --- | --- | --- | --- |
| 统一创建与状态契约 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 已实现 `READY`、`PREPARING`、`FROZEN`、准备与提交版本；[Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211) 对复制世界通过地图投影后、环境后、角色后、commit 前、commit 后五个故障窗口的恢复检查。 | 确定跨组件权威归属并完成地图、库存、事件、记忆、环境共同事务设计。当前恢复证据不证明全局原子提交或断电级持久性。 |
| 用户意图到世界起点 | 部分完成 | 两个可编辑非固定题材和四角色 `small frontier settlement` 自由社会世界由意图进入真实模型生成、验证、确认及持久 Luanti 创建链路；[Actions 41058674691](https://github.com/kikoiio/Wispiva/actions/runs/41058674691) 又通过创建与运行。[Actions 41072461877](https://github.com/kikoiio/Wispiva/actions/runs/41072461877) 对中文河谷自由聚落意图重新生成并编译三位居民草稿，usage 完整（2,090 input、734 output tokens）。 | 当前新增的 Actions 验收将尝试把中文草稿送入确认、持久世界和真实角色循环；仍需用户审阅、修改和确认语义，真人 Luanti 体验，且自动私有记忆检查不能替代社会行为质量评估。 |
| 空间与三维体验 | 部分完成 | [`product-world-2026-10-29/README.md`](../../evidence/luanti/product-world-2026-10-29/README.md)记录地面、室内外投影、连接、角色起点、客户端连接、场景互动和引导到达。Actions `40956198179` 是该运行的远端引用；本次提交把 `advance` 接入 [`cognition/navigation.lua`](../../cognition/navigation.lua) 的有界 BFS。 | 完成真人 Luanti 客户端验收，记录用户是否能移动、观察、理解互动及其后果。随后补充真实通行、碰撞、寻路、外观和不同题材的场景验证。当前导航只回读平面节点，实体最终仍用受控 `set_pos` 更新。 |
| 记忆从起点进入主循环 | 部分完成 | `wispiva.model-input` v1、来源和 audience 校验、`store:reflect`、定期真实反思、L2 写回、最新主题版本检索及重启恢复已有实现；[Actions 41063917433](https://github.com/kikoiio/Wispiva/actions/runs/41063917433) 另完成 30 次 FIFO／retrieval 真实模型任务（5 类 × 3 seeds × 2 arms，含中文短线索）和 24 次并发探针，完整 token 审计、零调用错误。逐任务正确率留在 artifact，未据 workflow 成功推断回答正确。 | 复核 artifact 的逐任务正确率；评估长期反思事实性、矛盾信念和长时检索质量；扩大情境覆盖并做真人角色质量评审。当前短时合成运行不证明长时记忆质量。 |
| 真实角色与环境闭环 | 部分完成 | [`environment.lua`](../../cognition/environment.lua) 按逻辑时间推进资源。四轮用户意图自由社会短场景共 96 次真实决策、4 次 `say`、4 次 `give`、32 次 gather、15 次 build，并保存 248 条记忆；正式会议事件为 0。逐轮结果见[证据表](../../evidence/luanti/product-model-2026-10-30/README.md#四次自由社会场景汇总)。 | 增加交流、冲突和共同目标情境，进行多轮重复并由真人评价角色行为。四轮中 say 只在一轮出现、give 只在两轮出现，尚未形成稳定互动证据。 |
| 持续时间与恢复 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 和 Luanti 主循环保存逻辑时钟、环境、角色、事件、长期记忆和产品提交版本；启动时拒绝未完成提交。[Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211) 在五个隔离 checkpoint 故障窗口验证 marker 保留、恢复重试和源世界不变。 | 补充暂停、无客户端运行、重连和离线时间不补算的验收，并明确跨存储事务与真实断电持久性的界限。现有故障注入是隔离复制世界，不证明多个存储的原子提交。 |
| 端到端体验与证据 | 部分完成 | [`genesis/2026-10-29-model/summary.md`](../../evidence/luanti/genesis/2026-10-29-model/summary.md)记录合成题材草稿生成；[`产品模型世界证据`](../../evidence/luanti/product-model-2026-10-30/README.md)记录当前 `6d160dd` 的真实 provider 产品世界、请求／响应审计、私有记忆、反思、用户意图自由社会、受控回放及故障注入。产品 Actions `41037867018` 验证持久 Luanti 世界和自动客户端连接／交互。 | 用真实用户意图创建世界，完成真人 Luanti 三维体验验收；补充长时运行、复杂题材和跨存储一致性证据。 |

## 已完成但证据或文档没有完全同步的内容

2026-10-30 的 [Actions 41072461877](https://github.com/kikoiio/Wispiva/actions/runs/41072461877) 和 [41063917433](https://github.com/kikoiio/Wispiva/actions/runs/41063917433) 新增实时中文世界意图草稿／空间编译和含中文短线索的真实记忆任务。中文草稿生成 usage 完整；记忆任务无 provider 调用错误，但逐任务答案仍应以 artifact 评分为准。中文意图的 Draft 确认、持久 Luanti 角色运行与逐角色记忆边界验收已加入后续 Actions，结果待跑。

1. **产品模型输入边界和反思写回已有集成证据。** `wispiva.model-input` v1、来源、audience、动作反馈、周期反思和 source-grounded L2 写回已进入产品闭环。Actions 41037865211 通过反思及重启恢复；长期质量、冲突信念和真人角色评价仍未完成，因此记忆计划保持部分完成。

2. **产品状态冻结边界与有限故障恢复已有证据。** `product_state.lua`、启动对账、逻辑时钟和失败冻结已有实现；Actions 41037865211 通过五个隔离 checkpoint 故障窗口。这仍不能证明地图数据库、mod storage、角色 checkpoint 和环境快照之间的跨存储原子性。

3. **自动客户端验收已有记录。** `product-world-2026-10-29/README.md` 已补充客户端连接、互动和引导到达，`docs/PLAN.md` 也已有 Actions `40956198179` 引用。该证据应明确归类为自动化路径检查，不能替代真人移动、观察和可理解性评价。

4. **长期记忆文档已同步当前边界。** `cognition/README.md`、`model/README.md` 和产品证据 README 描述周期反思、受控写回及质量评估缺口。最新模型 Actions 已通过运行级写回、版本检索与正常重启保留；长程质量仍待评估。

5. **自动运行不等于真人验收。** 当前产品与真实模型基线通过；5k／10k 初测有实体完整性和步频证据，但 RSS／CPU 采样对象错误。引擎采样改动由 Actions 抓出 PID 生命周期问题，已修正并待重跑。这些结果不能替代真人视觉验收、真实用户确认、长时运行或大规模真实 LLM 容量证据。

## 审计后的推进顺序

1. 在不同云端规格、长时间和多世界条件下复测 5k／10k，并独立评估真实模型角色容量；当前阶梯只测单个规则策略世界。
2. 继续改进真实意图生成与社会观察评估，不把合成自由社会场景等同于稳定涌现。
3. 完成真人 Luanti 客户端验收和真实用户意图确认流程。
4. 分阶段验证真实模型角色服务能力，包括决策频率、队列等待、供应商限流和费用，不以规则实体容量代替。

本审计同步到产品提交 `b8cf457`、真实模型验证提交 `281d00e`、20–10k 规则／认知实体阶梯和真实 provider 并发 1–16 阶梯。并发回放共 120 次、110 次可执行动作；其余均为 `invalid_action`，并发 16 的 24 次样本全部可执行。现有模型阶梯只重放四个角色上下文，不能外推到千级 LLM 角色。仍未完成的计划项保持部分完成：长时及多世界运行、跨存储一致性、真实用户意图审阅、真人三维验收、记忆质量和社会行为评估均需要新的产品证据或用户体验。
