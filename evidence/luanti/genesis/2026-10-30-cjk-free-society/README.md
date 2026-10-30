# 中文自由聚落草稿生成

[GitHub Actions 41069246124](https://github.com/kikoiio/Wispiva/actions/runs/41069246124) 在 `validation/luanti-genesis-cjk-20261030` 上首次运行真实配置模型。更新后的 [Actions 41072461877](https://github.com/kikoiio/Wispiva/actions/runs/41072461877) 重新验证了两个英文题材和一个中文自由聚落意图；三个草稿均满足 schema 并通过空间编译，三次生成各一次完成响应，token 用量完整。中文生成用了 2,090 input、734 output，共 2,824 tokens。artifact `wispiva-results-0` 附三份草稿和 `genesis-results/results.json`，`unsupported` 字段记录未落地的规则、地形／出生安全、路径语义和角色 runtime 边界。

中文意图：

> 在一处河谷建立自由聚落。三位居民没有指定职业，让他们根据经历自行决定如何分工、交流和应对环境；只描述当前世界和局部目标，不安排剧情结局。地点包括河边空地、旧磨坊和山路入口，每个人有一段只属于本人的私人记忆。

这些生成记录使用合成意图，不代表真实用户审阅。上面的更新 run 证明生成和空间编译，也验证了安全 token usage 回调；它没有做用户编辑／确认或持久创建世界。当前正在把同一中文 draft 接入 DraftStore、确认记录、Luanti 持久世界和真实角色循环，并逐请求核查私有记忆是否只进入所属角色输入；此验收尚未由 Actions 执行。
