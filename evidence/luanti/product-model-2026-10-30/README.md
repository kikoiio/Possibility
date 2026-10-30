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

## 更长自由社会回放（2026-10-30）

[Actions 41088765681](https://github.com/kikoiio/Wispiva/actions/runs/41088765681) 通过真实模型生成四角色起源并运行 24 决策／角色，共 96 次决策；安全摘要记录 gather 27、build 17、inspect 17、wander 21、advance 14，`say`、`give`、message 和 meeting 均为 0。checkpoint 保存 version 2 和 241 条记忆；四个角色均完成 24 次决策，worker 峰值为 4。这次更长回放仍只观察到个人探索和资源行动，没有可见的角色间交流或转移。

同一 run 的 24 次并发 4 负载重放中，23 次返回可执行动作，1 次为 `invalid_action`，没有 provider 或传输错误；该步骤因要求 24/24 可执行而失败。它不否定世界回放本身已完成，但说明动作格式可靠性仍有缺口。该 run 的原始模型请求 artifact 和公开日志已按隐私复核撤下，安全聚合 artifact 保留为 [12994790473](https://github.com/kikoiio/Wispiva/actions/runs/41088765681/artifacts/12994790473)。

### 四次自由社会场景汇总

| Actions run | 真实决策 | say | give | gather | build | 保存的记忆记录 | 本轮可观察结果 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| [41053739638](https://github.com/kikoiio/Wispiva/actions/runs/41053739638) | 24 | 4 | 0 | 6 | 2 | 65 | 4 次说话动作；3 条消息进入接收者后续输入并按来源 ID 检查 audience；未观察到会议 |
| [41054466103](https://github.com/kikoiio/Wispiva/actions/runs/41054466103) | 24 | 0 | 3 | 10 | 6 | 61 | 3 次资源转移；未观察到说话或会议 |
| [41055134734](https://github.com/kikoiio/Wispiva/actions/runs/41055134734) | 24 | 0 | 1 | 8 | 4 | 61 | 1 次资源转移；未观察到说话或会议 |
| [41058674691](https://github.com/kikoiio/Wispiva/actions/runs/41058674691) | 24 | 0 | 0 | 8 | 3 | 61 | 未观察到说话、转移或会议 |
| 合计 | 96 | 4 | 4 | 32 | 15 | 248 | 4 轮全部完成四角色决策和 checkpoint；说话只出现在 1 轮，转移只出现在 2 轮，正式 meeting 事件为 0 |

Run 41053739638 与 41054466103 的自由社会步骤成功，但各自后续回放汇总曾因独立 worker 验收问题令整条 Actions 失败；回放脚本已修正，41058674691 全流程通过。四轮显示可交互行为会出现但不稳定：模型有时发送消息或转移资源，也有轮次只采集、建造和移动。记忆记录确实随场景保存，数量不等同于记忆质量；以上短场景仍不能证明角色形成稳定关系、共同制度或自发社会。

## 当前公开世界上下文与重复自由社会（Actions 41099553897）

[Actions 41099553897](https://github.com/kikoiio/Wispiva/actions/runs/41099553897) 使用产品提交 `83e34c5` 上的 `genesis.public` fact 和真实模型运行。私有记忆审计通过，确认每个模型请求恰有一条与当前 origin 对应的公开标题／描述 fact，audience 只含当前角色；原始 intent、私有 goal 和其他角色种子没有放进这条共享 fact。产品世界和自由社会世界均正常 checkpoint。

自由社会场景完成四角色各 24 次真实决策，共 96 次请求。安全摘要记录 `gather=36`、`build=28`、`say=15`、`give=3`、`approach=4`、`advance=5`、`inspect=2`、`wander=3`；有 15 个 message 事件、3 个资源转移事件、0 个正式 meeting 事件，worker 峰值为 4。整个场景的 `run_exit_code=0`。尝试过程中计数到 4 次 `invalid_action`、2 次 `invalid_response` 和 3 次 `provider_failed`，均在有界重试下未阻止 96 次决策完成。

同一 run 后续的独立并发 4 负载回放为 23/24 可执行，1 次 `invalid_action`；吞吐 1.108 次/秒，模型延迟 p50/p95 为 3.20/3.77 秒，队列等待 p50/p95 为 7.05/17.26 秒。由于该 gate 要求 24/24 可执行，Actions 总体失败；不要把它写成模型服务负载验证通过。它只说明这一短场景中出现了对白和物品转移，单轮结果不证明稳定的社会演化。安全聚合 artifact 为 [ID 12999250945](https://github.com/kikoiio/Wispiva/actions/runs/41099553897/artifacts/12999250945)。

## 中文记忆线索对照与回归（2026-10-30）

产品分支回归 [Actions 41105474566](https://github.com/kikoiio/Wispiva/actions/runs/41105474566) 在提交 `1a7af3c` 上通过：8 组 Python/Lua 套件共运行 392 项，1 项跳过，其余通过；上传的产品 artifact 为 [ID 13001795429](https://github.com/kikoiio/Wispiva/actions/runs/41105474566/artifacts/13001795429)。

真实模型记忆对照 [Actions 41105494227](https://github.com/kikoiio/Wispiva/actions/runs/41105494227) 使用 6 类固定合成任务、3 个 seeds、FIFO 与 retrieval 两种策略，36/36 次调用完成，provider errors 为 0，token 审计完整。FIFO 正确 0/18；retrieval 正确 15/18（83.3%），并且 18/18 次都选择了含目标证据的记忆。四种英文基础任务与中文明确逐字提取各 3/3；中文短线索任务 0/3，尽管对应证据已选入上下文。配对场景固定问题、答案和事件流，只改提问目标的明确程度：结果将错误定位到模型使用含蓄中文线索，而不是记忆检索遗漏。FIFO/retrieval 输入输出合计 tokens 为 13,935/14,305；安全摘要 artifact [ID 13001097625](https://github.com/kikoiio/Wispiva/actions/runs/41105494227/artifacts/13001097625) 只保留任务聚合分数、选择布尔计数和 token 总量。

该实验只有每任务三个 seeds，答案是固定合成事实，短线索不代表自然中文理解的全面测量；它没有验证长时间世界中的事实更新、矛盾反思、人物关系记忆、恢复窗口或用户主观质量。下一步是增加语义改写与真实世界事件序列，并保持提示与记忆文本不公开；在更多 seeds 和真人评估前，不应把这类小样本准确率当作产品记忆可靠性指标。

### 信息投影提示改进复验

为明确角色收到的 JSON 输入及记忆证据如何使用，模型系统提示现在解释 `actor`、`knowledge`、`current` 和 `feedback` 各字段，并要求将短 query 当作检索线索；有直接个人证据时逐字提取，无证据不猜；来源／访问标签只描述证据边界，运行时 validator 才是授权边界。回归 [Actions 41107576079](https://github.com/kikoiio/Wispiva/actions/runs/41107576079) 通过 393 项（1 项跳过）。真实模型复验 [Actions 41107598621](https://github.com/kikoiio/Wispiva/actions/runs/41107598621) 再跑 36 次，无 provider error：retrieval 16/18、FIFO 0/18，目标证据选择仍为 18/18；中文短线索从上一批的 0/3 变为 1/3，明确逐字提取仍为 3/3。每种提示只有一轮三 seeds，模型输出存在抽样不确定性；这不是提示改进的因果证明。

## Luanti 客户端画面验收（Actions 41110698741）

[Actions 41110698741](https://github.com/kikoiio/Wispiva/actions/runs/41110698741) 在 CI 的 Xvfb 中启动真实 Luanti 客户端，连接合成产品世界，验证 scene-ready、玩家加入、互动和引导到达，并在到达后捕获 1280×720 客户端画面。安全产品 artifact [ID 13002868352](https://github.com/kikoiio/Wispiva/actions/runs/41110698741/artifacts/13002868352) 包含 `view-acceptance.png`；上传 allowlist 只加入这张合成场景画面。它为人查看 Minecraft-like 世界提供实际客户端截图，但不能替代真人进入游戏的交互评价；本机没有 Luanti 客户端，因此没有声称完成本地视觉验收。


## 四角色长自由社会与恢复边界（Actions 41113101332）

运行在产品树 `7ccd1ff` 的四角色世界，每角色最多 24 次真实模型决策。最终 91/96 次完成，动作数为 `advance=5, approach=7, build=11, gather=14, give=2, inspect=13, say=32, wander=7`；消息事件 32、资源转移 2、meeting 0。错误共计 `invalid_response=8`、`provider_failed=2`、`invalid_action=3`。最后一次请求在 3 次有界重试后仍返回无效响应，因此场景以失败退出，没有 checkpoint，且世界未完成。安全摘要 artifact [13004204099](https://github.com/kikoiio/Wispiva/actions/runs/41113101332/artifacts/13004204099)；额外验证 artifact [13006260146](https://github.com/kikoiio/Wispiva/actions/runs/41113101332/artifacts/13006260146)。

同次 Actions 的测试和较短的三角色模型运行／恢复阶段通过；长场景的失败不是回归测试失败。恢复 marker 被保留，资源结算审计未通过，因为没有完成的 checkpoint。现有实现选择冻结而非猜测部分存储状态，保护了安全边界；目前没有自动协调并继续的协议。此轮显示角色能发消息和转移资源，但不足以证明稳定互动，也不能被记作完成的持久世界。恢复实现必须先明确 checkpoint 边界，并验证回滚／幂等恢复、事件与库存无重复结算、逻辑时间不前跳。


### 已提交 checkpoint 的 marker 恢复命令

产品 launcher 增加 `--recover-committed-checkpoint`。它先检查 Luanti server 停止，并在世界锁、产品契约和完整 checkpoint 校验后清除遗留 marker。验证条件包括 `READY`、无 pending commit、无 `product_active_run`、时钟一致以及记忆／事件计数一致。若 marker 指向活动或不完整运行，命令失败并保留 marker。它只恢复 commit 成功后 marker 未清理的崩溃窗口，不修复 41113101332 的部分推进世界，也不代表跨存储原子事务；对应 Actions [41115517669](https://github.com/kikoiio/Wispiva/actions/runs/41115517669) 仍在队列中。


### 恢复测试夹具修正

[Actions 41115517669](https://github.com/kikoiio/Wispiva/actions/runs/41115517669) 在新增恢复用例处失败，原因是测试夹具先写 map/mod-storage、再初始化 world identity；产品的身份协议会拒绝在非空目录创建新身份。夹具已调整为先创建身份，再填入模拟的 `READY` checkpoint。此结果不是恢复入口的通过证据；修正版仍待云端 Actions 重跑。
