# 中文自由聚落草稿生成

[GitHub Actions 41069246124](https://github.com/kikoiio/Wispiva/actions/runs/41069246124) 在 `validation/luanti-genesis-cjk-20261030` 上首次运行真实配置模型。更新后的 [Actions 41072461877](https://github.com/kikoiio/Wispiva/actions/runs/41072461877) 重新验证了两个英文题材和一个中文自由聚落意图；三个草稿均满足 schema 并通过空间编译，三次生成各一次完成响应，token 用量完整。中文生成用了 2,090 input、734 output，共 2,824 tokens。artifact `wispiva-results-0` 附三份草稿和 `genesis-results/results.json`，`unsupported` 字段记录未落地的规则、地形／出生安全、路径语义和角色 runtime 边界。

中文意图：

> 在一处河谷建立自由聚落。三位居民没有指定职业，让他们根据经历自行决定如何分工、交流和应对环境；只描述当前世界和局部目标，不安排剧情结局。地点包括河边空地、旧磨坊和山路入口，每个人有一段只属于本人的私人记忆。

这些自动化记录不是用户编辑或现场语义审阅。随后 [Actions 41075436293](https://github.com/kikoiio/Wispiva/actions/runs/41075436293) 已把生成的三人中文草稿写入 DraftStore，绑定确认 revision 和原始 intent，创建持久 Luanti 世界，并由真实模型完成 18 次角色决策和 checkpoint。三个角色均在自己的模型输入中看到个人起始记忆，逐请求核对没有跨角色泄漏。此 run 的行为分布为 gather 9、build 4、inspect 2、wander 2、advance 1，say/give 均为 0：当前只观察到资源活动，没有观察到角色间直接交流。此结果说明互动动作可用并不代表会自发发生；还需通过多轮题材和环境变化来研究。完整产品摘要不包含私有记忆或对话原文，保存在 Actions artifact。

第二次真实模型运行 [Actions 41076669398](https://github.com/kikoiio/Wispiva/actions/runs/41076669398) 同样通过全量单测、客户端验收及中文持久世界运行。18 次决策分别为 gather 9、build 7、give 1、approach 1；产生 16 个资源事件，直接 message 事件仍为 0。逐角色私有记忆检查再度达到 3/3，串读 0。19 次模型尝试中 18 次成功、1 次 `invalid_action`，之后运行完成；6 次反思也完成。Actions 日志记录 decision 尝试 43,314 input／453 output tokens、反思 2,310／758，中文草稿生成 2,090／697。重复运行间 gather/build 稳定出现，但对话尚未出现，give 仅一轮发生，不能据此判断稳定分工或社会涌现。该 run 的 artifact `wispiva-cjk-product-summary` 记录不含私密原文的行为摘要。

提交 `f9e473701b102220573ff1bd81961fdf53439dfe` 加入了真实 provider usage 汇总、实时 pause／speed／resume 检查和可修订的 Genesis CLI。Actions [41079793257](https://github.com/kikoiio/Wispiva/actions/runs/41079793257) 已通过暂停、暂停中改速、恢复后逻辑时间继续推进，以及中文意图世界创建。后续 [41080849574](https://github.com/kikoiio/Wispiva/actions/runs/41080849574) 的两个英文草稿生成通过，但中文草稿虽结构有效，Luanti 编译报 `out_of_bounds`，因此该轮没有创建并运行中文世界，也没有生成中文产品摘要。新提交让 `generate` 在最多三次模型响应内同时校验编译器边界，并用安全路径／错误码反馈重试；修复后的真实模型复验待 Actions 给出结果。该题材仍是自动验收样本，不表示用户已审阅草稿或替代真人 Luanti 体验。

另加入针对历史记忆任务 artifact 的无模型评分路径：汇总 FIFO／retrieval 的每任务正确率、配对胜负、错误类别与供应商 token，不输出原始回答。它将在独立 `validation/luanti-memory-audit-*` 分支运行，以避免重复付费／消耗模型调用。
