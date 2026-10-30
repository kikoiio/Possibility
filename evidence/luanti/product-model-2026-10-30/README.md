# 真实模型产品世界证据（2026-10-30 UTC）

本目录记录分支 `validation/luanti-product-model-20261030-e15e52a` 上的真实模型产品切片。模型密钥只通过 GitHub Actions secret 注入，没有写入代码或 artifact。

- 验证运行：[Actions 41010708756](https://github.com/kikoiio/Wispiva/actions/runs/41010708756)
- 提交：[55a5ffa8](https://github.com/kikoiio/Wispiva/commit/55a5ffa8b3dc22e27d3afdb3a7c26f1423168178)
- 原始模型请求／响应 artifact 已于 2026-10-30 隐私复核后撤下；此文仅保留聚合结果。

场景创建一个确认后的 Luanti 产品世界，包含 Alice、Bob、Cora 三个角色、一个共享水井和绿色资源。每个角色收到自己的起始私有种子；模型输入还包含角色局部观察、当前库存、可行动作和上次执行反馈。世界运行完成 18 个真实决策，记录 `say=6`、`gather=6`、`inspect=4`、`approach=1`、`build=1`，并写入产品 checkpoint、世界事件和长期记忆。

审计检查确认：

- 三个角色都产生了真实模型请求；请求保存了角色、`model_input`、输入／输出 token、延迟、响应、动作、失败和重试信息。
- Alice、Bob、Cora 的私有起始种子互相隔离。
- Alice 的消息进入目标角色后续输入；同一消息没有出现在其他角色的 `knowledge.rumors` 中。
- 模型无效动作会有限重试；一次 `transport_error` 在重试后成功，provider 失败不会被改写成规则动作。
- gather 的成功、`resource_mismatch` 失败、行动反馈、环境事件和产品 checkpoint 都保留在世界日志中。

当前工作流还包含一个 source-grounded L2 反思步骤：它从 Cora 已经获得的 4 条 L1 经历中选取有限输入，调用同一配置的真实 provider，返回了同 topic、非空且只引用已提供 source IDs 的反思提案，并保存安全审计。`reflection-result.json` 记录了 841 个总 tokens、4 个来源 ID 和 provider 输入／提示哈希；该结果证明真实 provider 的反思边界已运行，仍不自动写入角色长期记忆，也不证明反思质量或矛盾信念处理。

第一次重跑发现原有验收脚本按消息文本比较，误把同一句话分别发送给两个角色判为越权；运行时的 rumor `source.id` 和 `audience` 已显示为不同消息实例。提交 `3563083e` 改为按稳定消息来源 ID 验收，Actions `41008153510` 和 `41010708756` 均已成功通过。

这项证据证明小规模真实模型闭环、当前输入隐私边界和一次真实 source-grounded L2 provider 调用。它不证明 L2 结果已自动写回主循环、反思质量、断电级跨存储原子提交、长期崩溃恢复、真实用户意图链路、真人三维体验、供应商吞吐或千至万级真实 LLM 角色容量。

## 后续产品验收（提交 `6d160dd`）

- [产品分支 Actions 41037867018](https://github.com/kikoiio/Wispiva/actions/runs/41037867018) 全部通过：Lua/Python 单测、Luanti 持久世界重启、资源动作、一次性预览、产品世界客户端连接和确定性交互。`wispiva-results-0` artifact ID `12968859202`。
- [真实模型分支 Actions 41037865211](https://github.com/kikoiio/Wispiva/actions/runs/41037865211) 全部通过。三角色主场景完成 24 次模型决策（9 say、6 gather、5 inspect、2 advance、2 wander），正常 checkpoint 到 version 2；重启后的反思场景再完成 12 次决策并写入 version 3 checkpoint。
- 同一模型 Actions 使用自然语言“frontier settlement”意图生成并创建四角色世界，完成 24 次真实决策（12 gather、7 build、1 give、2 advance、1 approach、1 inspect），保存 version 2 checkpoint 和 61 条记忆。该回合 0 次 say、0 次 meetings，记录为一次角色资源分工与转移，不视为自发对话或社会涌现证据。
- 模型负载回放对已审计请求做 24 次、并发 4 的受控探测；这不是 24 个具身角色，也不代表 provider 的最大吞吐或万级真实模型容量。
- 五类 checkpoint 故障注入（after_map、after_environment、after_agents、before_commit、after_commit）均验证保留恢复标记、可执行恢复重试且源世界不变。测试针对隔离副本，不证明跨存储原子事务或断电级持久性。
- 历史 `wispiva-product-model-evidence` 原始 artifact 与对应产品模型 run 日志已在隐私复核中撤下，因为原始审计文件可能包含角色私有记忆和对话。本文保留经过汇总的决策、token、恢复和容量结果，不保留可读模型输入／输出。

这些结果验证了当前产品纵向切片可以生成、启动、运行真实模型角色、记录资源交互并恢复；真人进入桌面 Luanti 评价画面、真实用户确认创建草稿、长时运行、更多题材与千级以上角色容量仍待验收。

## 真实模型 worker 阶梯与创建重试（2026-10-30）

- 产品分支 [`b8cf457`](https://github.com/kikoiio/Wispiva/commit/b8cf457) 的 [Actions 41058024437](https://github.com/kikoiio/Wispiva/actions/runs/41058024437) 通过产品 Lua/Python 回归、创建预览、持久世界和 Luanti 客户端连接验收。该产品工作流未加载仓库模型密钥，真实模型步骤按配置跳过。
- 在独立验证分支提交 [`281d00e`](https://github.com/kikoiio/Wispiva/commit/281d00ebd1269cbb85a77a244462acde1027a2fb) 上，[真实模型 Actions 41058674691](https://github.com/kikoiio/Wispiva/actions/runs/41058674691) 全部通过；其含原始私有请求证据的 artifact 和 Actions 日志已撤下。该运行通过真实模型生成自由社会草稿并完成四角色、24 次决策；结果 `advance=6, approach=3, inspect=3, wander=1, gather=8, build=3, say=0, give=0`。这次观察到采集与建造，没有观察到交谈、转移或会议。提交 `281d00e` 同时增加了世界创建对明确瞬时 provider 错误的最多三次调用和 1/2 秒退避；动作无效、配置错误等不在此重试范围。

## 隐私复核与 CI 工件

Genesis 和产品模型 artifact 只保留不含原始提示、回复、角色私有记忆或世界私有目录的汇总文件。历史 CJK 草稿 artifact 已删除，安全的 `wispiva-cjk-product-summary` 保留。五个旧真实模型验证 run 的 `wispiva-results-0` 原始 artifact 和公开日志已撤下；相应原始证据链接已失效。通用 SOCIETY 摘要使用 `--public`，只保留计数和数值测量，代理原始日志不再上传。独立记忆基准 artifact [ID 12983479330](https://github.com/kikoiio/Wispiva/actions/runs/41063917433/artifacts/12983479330) 保留固定合成题目和模型回答以复现评分；它不是用户记忆。所有公开模型测试都应使用合成私有记忆。
- 使用同一批 24 个隔离角色输入分别按并发 1、2、4、8、16 回放，共 120 次 provider 调用，110 次返回可执行动作（91.7%）；其余 10 次均为安全拒绝的 `invalid_action`，没有限流或传输类错误。各级实测吞吐为 0.252、0.598、0.975、1.491、1.957 次/秒；实际峰值并发与设置一致。并发 16 档 24/24 可执行，p50/p95 模型延迟 4.41/9.21 秒；并发 8 档可执行 22/24。
- 按并发 16 的单批观测速率换算约为 117 次模型决策/分钟。若 1,000 个角色平均每分钟各需要一次模型决策，需求是 16.7 次/秒；10,000 个角色则是 166.7 次/秒，分别约为该观测速率的 8.5 倍和 85 倍。这是调度容量的简单算术对比，批次并非持续负载或服务商容量保证；降低每个角色的模型决策频率、让规则/本地策略承担常规行动、按重要事件调用模型，仍是万级世界需要验证的产品策略。
- 阶梯仅在有限时间内重放四个已审计角色上下文，不是 120 个具身 agent、同时生活的 16 个 LLM 角色、持续生产服务或 1,000/10,000 个 LLM 角色能力。结果受 provider、场景提示和动作 schema 影响；`invalid_action` 仍需要模型输出适配或更强的提示／校验后再重测。并发增加让该批次速度提高，但长队列 p95 和有效动作率仍须纳入产品调度。

### 四次自由社会场景汇总

| Actions run | 真实决策 | say | give | gather | build | 保存的记忆记录 | 本轮可观察结果 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| [41053739638](https://github.com/kikoiio/Wispiva/actions/runs/41053739638) | 24 | 4 | 0 | 6 | 2 | 65 | 4 次说话动作；3 条消息进入接收者后续输入并按来源 ID 检查 audience；未观察到会议 |
| [41054466103](https://github.com/kikoiio/Wispiva/actions/runs/41054466103) | 24 | 0 | 3 | 10 | 6 | 61 | 3 次资源转移；未观察到说话或会议 |
| [41055134734](https://github.com/kikoiio/Wispiva/actions/runs/41055134734) | 24 | 0 | 1 | 8 | 4 | 61 | 1 次资源转移；未观察到说话或会议 |
| [41058674691](https://github.com/kikoiio/Wispiva/actions/runs/41058674691) | 24 | 0 | 0 | 8 | 3 | 61 | 未观察到说话、转移或会议 |
| 合计 | 96 | 4 | 4 | 32 | 15 | 248 | 4 轮全部完成四角色决策和 checkpoint；说话只出现在 1 轮，转移只出现在 2 轮，正式 meeting 事件为 0 |

Run 41053739638 与 41054466103 的自由社会步骤成功，但各自后续回放汇总曾因独立 worker 验收问题令整条 Actions 失败；回放脚本已修正，41058674691 全流程通过。四轮显示可交互行为会出现但不稳定：模型有时发送消息或转移资源，也有轮次只采集、建造和移动。记忆记录确实随场景保存，数量不等同于记忆质量；以上短场景仍不能证明角色形成稳定关系、共同制度或自发社会。
