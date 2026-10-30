# 中文自由聚落草稿生成

[GitHub Actions 41069246124](https://github.com/kikoiio/Wispiva/actions/runs/41069246124) 在 `validation/luanti-genesis-cjk-20261030` 上首次运行真实配置模型。更新后的 [Actions 41072461877](https://github.com/kikoiio/Wispiva/actions/runs/41072461877) 重新验证了两个英文题材和一个中文自由聚落意图；三个草稿均满足 schema 并通过空间编译，三次生成各一次完成响应，token 用量完整。中文生成用了 2,090 input、734 output，共 2,824 tokens。artifact `wispiva-results-0` 附三份草稿和 `genesis-results/results.json`，`unsupported` 字段记录未落地的规则、地形／出生安全、路径语义和角色 runtime 边界。

中文意图：

> 在一处河谷建立自由聚落。三位居民没有指定职业，让他们根据经历自行决定如何分工、交流和应对环境；只描述当前世界和局部目标，不安排剧情结局。地点包括河边空地、旧磨坊和山路入口，每个人有一段只属于本人的私人记忆。

这些自动化记录不是用户编辑或现场语义审阅。随后 [Actions 41075436293](https://github.com/kikoiio/Wispiva/actions/runs/41075436293) 已把生成的三人中文草稿写入 DraftStore，绑定确认 revision 和原始 intent，创建持久 Luanti 世界，并由真实模型完成 18 次角色决策和 checkpoint。三个角色均在自己的模型输入中看到个人起始记忆，逐请求核对没有跨角色泄漏。此 run 的行为分布为 gather 9、build 4、inspect 2、wander 2、advance 1，say/give 均为 0：当前只观察到资源活动，没有观察到角色间直接交流。此结果说明互动动作可用并不代表会自发发生；还需通过多轮题材和环境变化来研究。完整产品摘要不包含私有记忆或对话原文，保存在 Actions artifact。

第二次真实模型运行 [Actions 41076669398](https://github.com/kikoiio/Wispiva/actions/runs/41076669398) 同样通过全量单测、客户端验收及中文持久世界运行。18 次决策分别为 gather 9、build 7、give 1、approach 1；产生 16 个资源事件，直接 message 事件仍为 0。逐角色私有记忆检查再度达到 3/3，串读 0。19 次模型尝试中 18 次成功、1 次 `invalid_action`，之后运行完成；6 次反思也完成。Actions 日志记录 decision 尝试 43,314 input／453 output tokens、反思 2,310／758，中文草稿生成 2,090／697。重复运行间 gather/build 稳定出现，但对话尚未出现，give 仅一轮发生，不能据此判断稳定分工或社会涌现。该 run 的 artifact `wispiva-cjk-product-summary` 记录不含私密原文的行为摘要。

当前又把精确 provider usage 汇总加入摘要，准备再跑一次来形成可下载的 usage artifact。这个题材仍是自动验收样本，不表示用户已审阅该草稿或替代真人 Luanti 体验。
