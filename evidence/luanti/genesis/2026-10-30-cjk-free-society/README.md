# 中文自由聚落草稿生成

[GitHub Actions 41069246124](https://github.com/kikoiio/Wispiva/actions/runs/41069246124) 在 `validation/luanti-genesis-cjk-20261030` 上首次运行真实配置模型。更新后的 [Actions 41072461877](https://github.com/kikoiio/Wispiva/actions/runs/41072461877) 重新验证了两个英文题材和一个中文自由聚落意图；三个草稿均满足 schema 并通过空间编译，三次生成各一次完成响应，token 用量完整。中文生成用了 2,090 input、734 output，共 2,824 tokens。artifact `wispiva-results-0` 附三份草稿和 `genesis-results/results.json`，`unsupported` 字段记录未落地的规则、地形／出生安全、路径语义和角色 runtime 边界。

中文意图：

> 在一处河谷建立自由聚落。三位居民没有指定职业，让他们根据经历自行决定如何分工、交流和应对环境；只描述当前世界和局部目标，不安排剧情结局。地点包括河边空地、旧磨坊和山路入口，每个人有一段只属于本人的私人记忆。

这些自动化记录不是用户编辑或现场语义审阅。随后 [Actions 41075436293](https://github.com/kikoiio/Wispiva/actions/runs/41075436293) 已把生成的三人中文草稿写入 DraftStore，绑定确认 revision 和原始 intent，创建持久 Luanti 世界，并由真实模型完成 18 次角色决策和 checkpoint。三个角色均在自己的模型输入中看到个人起始记忆，逐请求核对没有跨角色泄漏。此 run 的行为分布为 gather 9、build 4、inspect 2、wander 2、advance 1，say/give 均为 0：当前只观察到资源活动，没有观察到角色间直接交流。此结果说明互动动作可用并不代表会自发发生；还需通过多轮题材和环境变化来研究。完整产品摘要不包含私有记忆或对话原文，保存在 Actions artifact。

第二次真实模型运行 [Actions 41076669398](https://github.com/kikoiio/Wispiva/actions/runs/41076669398) 同样通过全量单测、客户端验收及中文持久世界运行。18 次决策分别为 gather 9、build 7、give 1、approach 1；产生 16 个资源事件，直接 message 事件仍为 0。逐角色私有记忆检查再度达到 3/3，串读 0。19 次模型尝试中 18 次成功、1 次 `invalid_action`，之后运行完成；6 次反思也完成。Actions 日志记录 decision 尝试 43,314 input／453 output tokens、反思 2,310／758，中文草稿生成 2,090／697。重复运行间 gather/build 稳定出现，但对话尚未出现，give 仅一轮发生，不能据此判断稳定分工或社会涌现。该 run 的 artifact `wispiva-cjk-product-summary` 记录不含私密原文的行为摘要。

提交 `f9e473701b102220573ff1bd81961fdf53439dfe` 加入了真实 provider usage 汇总、实时 pause／speed／resume 检查和可修订的 Genesis CLI。Actions [41079793257](https://github.com/kikoiio/Wispiva/actions/runs/41079793257) 已通过暂停、暂停中改速、恢复后逻辑时间继续推进，以及中文意图世界创建。后续 [41080849574](https://github.com/kikoiio/Wispiva/actions/runs/41080849574) 的两个英文草稿生成通过，但中文草稿虽结构有效，Luanti 编译报 `out_of_bounds`，因此该轮没有创建并运行中文世界，也没有生成中文产品摘要。随后 [Actions 41083814007](https://github.com/kikoiio/Wispiva/actions/runs/41083814007) 在 `739a434` 上完成真实模型中文草稿生成、持久世界创建及角色循环；安全摘要 artifact 为 [12991067039](https://github.com/kikoiio/Wispiva/actions/runs/41083814007/artifacts/12991067039)。该轮在 artifact 上传路径收紧之前运行，所以含原始草稿的 `wispiva-results-0` 已撤下。修复后的生成器在最多三次模型响应内同时校验编译器边界，并只反馈安全路径／错误码。该题材仍是自动验收样本，不表示用户已审阅草稿或替代真人 Luanti 体验。

另加入针对历史记忆任务 artifact 的无模型评分路径：汇总 FIFO／retrieval 的每任务正确率、配对胜负、错误类别与供应商 token，不输出原始回答。它已在独立 `validation/luanti-memory-audit-*` 分支执行，没有重复模型调用。

该无模型审计已由 [Actions 41082448598](https://github.com/kikoiio/Wispiva/actions/runs/41082448598) 完成，摘要 artifact [ID 12989508878](https://github.com/kikoiio/Wispiva/actions/runs/41082448598/artifacts/12989508878)。Retrieval 在 15 次任务中答对 13 次（86.7%），FIFO 为 0/15；配对结果 retrieval 胜 13、平 2、FIFO 胜 0。delayed recall、source attribution、stale fact 和 avoiding known failure 均为 3/3；中文短线索 retrieval 为 1/3。两个策略的 30 次 provider 调用全部有完整 token 审计且无调用错误，token 分别为 retrieval 10,746、FIFO 10,665。该评分按精确合法消息比较；三 seeds、固定合成题和一组配置模型不能说明长期记忆或真实社会角色的普遍质量。

隐私边界复核发现历史 CJK `wispiva-results-0` 会公开原始角色记忆草稿；产品模型验证 artifact 会公开完整 request／response 审计。Actions 清理已删除这些 CJK 原始 artifact，并撤下四个真实产品模型验证 run 的日志。安全的 CJK 行为摘要仍保留。提交 `bd71910` 将未来上传限制为汇总结果、记忆审计计数和故障结果；CJK 草稿 artifact 现在只上传 `results.json`，其中不含角色文本。模型工作流的公开日志也只打印交流次数，不打印对话文本。公开仓库中仍应使用合成私有记忆，不能把真人记忆放入 CI 样本。
