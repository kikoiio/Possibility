# 实施计划审计（2026-10-30）

本文审计当前工作区的 [`docs/PLAN.md`](../PLAN.md)。本文不改变计划勾选状态，也不把夹具验证写成产品完成。产品提交 `6d160ddff916be78ef8f7c10c8edf64c84e4b343` 的回归 [Actions 41037867018](https://github.com/kikoiio/Wispiva/actions/runs/41037867018) 和真实模型运行 [Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211) 均通过。首次容量专项 [Actions 41040386531](https://github.com/kikoiio/Wispiva/actions/runs/41040386531) 与 [41040395398](https://github.com/kikoiio/Wispiva/actions/runs/41040395398) 显示 success，但逐项状态均以 exit 2 在启动前退出：客户端验收遗留 Luanti 服务端。进程清理和退出状态已在 `d6cdbe4` 修复。

随后 [Actions 41041685681](https://github.com/kikoiio/Wispiva/actions/runs/41041685681) 完成 5,000／10,000 个规则策略实体（认知开关 false／true，各重复 3 次）：每轮均校验全部实体存活并完成 12 次决策，日志步频最低 10.88–11.03 steps/s。该 run 报告的 17 MiB RSS 和 CPU 值来自 `launch.py` 包装进程，不是 Luanti 引擎，必须作废。容量 runner 现已改为采样引擎 PID；修正版的千级和万级测量尚待执行。此前 20–1,000 阶梯因同一指标问题取消。

历史运行号仍保留在各自证据页面中；当前产品和模型结论以 `6d160dd` 对应的上述 Actions 为准。专项容量 Actions 完成后，将更新该审计的容量状态与 artifact 链接。

## 未勾选项

| 计划项 | 状态 | 当前证据 | 下一步 |
| --- | --- | --- | --- |
| 统一创建与状态契约 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 已实现 `READY`、`PREPARING`、`FROZEN`、准备与提交版本；[Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211) 对复制世界通过地图投影后、环境后、角色后、commit 前、commit 后五个故障窗口的恢复检查。 | 确定跨组件权威归属并完成地图、库存、事件、记忆、环境共同事务设计。当前恢复证据不证明全局原子提交或断电级持久性。 |
| 用户意图到世界起点 | 部分完成 | 两个可编辑非固定题材和一个四角色 `small frontier settlement` 自由社会世界均由用户意图进入真实模型生成、验证、确认及持久 Luanti 创建链路；证据见 [Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211)。 | 用真实用户提供的文本／素材走完草稿审阅、修改、确认，并由用户检查语义和私有信息投影。当前世界意图与验收场景仍为合成样本。 |
| 空间与三维体验 | 部分完成 | [`product-world-2026-10-29/README.md`](../../evidence/luanti/product-world-2026-10-29/README.md)记录地面、室内外投影、连接、角色起点、客户端连接、场景互动和引导到达。Actions `40956198179` 是该运行的远端引用；本次提交把 `advance` 接入 [`cognition/navigation.lua`](../../cognition/navigation.lua) 的有界 BFS。 | 完成真人 Luanti 客户端验收，记录用户是否能移动、观察、理解互动及其后果。随后补充真实通行、碰撞、寻路、外观和不同题材的场景验证。当前导航只回读平面节点，实体最终仍用受控 `set_pos` 更新。 |
| 记忆从起点进入主循环 | 部分完成 | `wispiva.model-input` v1、来源和 audience 校验、`store:reflect`、定期真实反思、L2 写回、最新主题版本检索及重启恢复已有实现。[Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211) 通过三角色 24 次真实决策、反思后恢复 12 次决策及四角色自由社会 24 次决策；成功转移会写入双方私有记忆。 | 评估长期反思的事实性、矛盾信念和检索质量；扩大情境覆盖并做真人角色质量评审。当前小批真实调用不证明大规模 LLM 容量或长时记忆质量。 |
| 真实角色与环境闭环 | 部分完成 | [`environment.lua`](../../cognition/environment.lua) 按逻辑时间推进资源。Actions 41037865211 验证三角色真实模型循环、环境行动、结果反馈、记忆写回、反思和恢复；四角色社会运行中 24 次决策产生 12 gather、7 build、1 give、0 say。 | 扩展角色间交流和目标冲突场景，测量多次运行中的社会行为质量；加入交互对象和持久跨存储一致性验证。单次合成运行不能证明自发社会涌现。 |
| 持续时间与恢复 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 和 Luanti 主循环保存逻辑时钟、环境、角色、事件、长期记忆和产品提交版本；启动时拒绝未完成提交。[Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211) 在五个隔离 checkpoint 故障窗口验证 marker 保留、恢复重试和源世界不变。 | 补充暂停、无客户端运行、重连和离线时间不补算的验收，并明确跨存储事务与真实断电持久性的界限。现有故障注入是隔离复制世界，不证明多个存储的原子提交。 |
| 端到端体验与证据 | 部分完成 | [`genesis/2026-10-29-model/summary.md`](../../evidence/luanti/genesis/2026-10-29-model/summary.md)记录合成题材草稿生成；[`产品模型世界证据`](../../evidence/luanti/product-model-2026-10-30/README.md)记录当前 `6d160dd` 的真实 provider 产品世界、请求／响应审计、私有记忆、反思、用户意图自由社会、受控回放及故障注入。产品 Actions `41037867018` 验证持久 Luanti 世界和自动客户端连接／交互。 | 用真实用户意图创建世界，完成真人 Luanti 三维体验验收；补充长时运行、复杂题材和跨存储一致性证据。 |

## 已完成但证据或文档没有完全同步的内容

1. **产品模型输入边界和反思写回已有集成证据。** `wispiva.model-input` v1、来源、audience、动作反馈、周期反思和 source-grounded L2 写回已进入产品闭环。Actions 41037865211 通过反思及重启恢复；长期质量、冲突信念和真人角色评价仍未完成，因此记忆计划保持部分完成。

2. **产品状态冻结边界与有限故障恢复已有证据。** `product_state.lua`、启动对账、逻辑时钟和失败冻结已有实现；Actions 41037865211 通过五个隔离 checkpoint 故障窗口。这仍不能证明地图数据库、mod storage、角色 checkpoint 和环境快照之间的跨存储原子性。

3. **自动客户端验收已有记录。** `product-world-2026-10-29/README.md` 已补充客户端连接、互动和引导到达，`docs/PLAN.md` 也已有 Actions `40956198179` 引用。该证据应明确归类为自动化路径检查，不能替代真人移动、观察和可理解性评价。

4. **长期记忆文档已同步当前边界。** `cognition/README.md`、`model/README.md` 和产品证据 README 描述周期反思、受控写回及质量评估缺口。最新模型 Actions 已通过运行级写回、版本检索与正常重启保留；长程质量仍待评估。

5. **自动运行不等于真人验收。** 当前产品及真实模型 Actions 通过；初次 5k／10k 运行给出了实体完整性和步频证据，但 RSS／CPU 采样对象错误，修正采样后仍需重跑。这些结果不能替代真人视觉验收、真实用户确认、长时运行或大规模真实 LLM 容量证据。

## 审计后的推进顺序

1. 用引擎级资源采样器重跑几十、几百、千级及万级规则／认知实体容量阶梯，分别报告运行吞吐、RSS 和 CPU；真实模型角色容量单独测量。
2. 继续改进真实意图生成与社会观察评估，不把合成自由社会场景等同于稳定涌现。
3. 完成真人 Luanti 客户端验收和真实用户意图确认流程。
4. 分阶段验证真实模型角色服务能力，包括决策频率、队列等待、供应商限流和费用，不以规则实体容量代替。

本审计同步到 `6d160dd` 产品与模型 Actions、`d6cdbe4` 服务端清理修复，以及后续发现的资源采样器问题。引擎 PID 采样修复提交和容量阶梯 Actions 完成后，应继续更新本审计、计划和架构表；Lua／Luanti 执行环境通过云端 Actions 验证。
