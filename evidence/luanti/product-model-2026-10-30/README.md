# 真实模型产品世界证据（2026-10-30 UTC）

本目录记录分支 `validation/luanti-product-model-20261030` 上的真实模型产品切片。模型密钥只通过 GitHub Actions secret 注入，没有写入代码或 artifact。

- 验证运行：[Actions 40996501320](https://github.com/kikoiio/Wispiva/actions/runs/40996501320)
- 提交：[08d5dd3f](https://github.com/kikoiio/Wispiva/commit/08d5dd3f085eb45312ffa5de014aa16ba0a85122)
- 原始 artifact：`wispiva-product-model-evidence`，ID `12951159605`

场景创建一个确认后的 Luanti 产品世界，包含 Alice、Bob、Cora 三个角色、一个共享水井和绿色资源。每个角色收到自己的起始私有种子；模型输入还包含角色局部观察、当前库存、可行动作和上次执行反馈。世界运行完成 18 个真实决策，记录 `say`、`gather`、`inspect`、`approach`、`wander`，并写入产品 checkpoint、世界事件和长期记忆。

审计检查确认：

- 三个角色都产生了真实模型请求；请求保存了角色、`model_input`、输入／输出 token、延迟、响应、动作、失败和重试信息。
- Alice、Bob、Cora 的私有起始种子互相隔离。
- Alice 的消息进入目标角色后续输入；同一消息没有出现在其他角色的 `knowledge.rumors` 中。
- 模型无效动作会有限重试；一次 `transport_error` 在重试后成功，provider 失败不会被改写成规则动作。
- gather 的成功、`resource_mismatch` 失败、行动反馈、环境事件和产品 checkpoint 都保留在世界日志中。

当前工作流还包含一个 source-grounded L2 反思步骤：它从某一角色已经获得的 L1 经历中选取有限输入，调用同一配置的真实 provider，要求返回同 topic、非空且只引用已提供 source IDs 的反思提案，并保存安全审计。只有对应 Actions 成功并生成 `reflection-result.json` 后，才能把它列为本目录的实际证据；该步骤仍不自动写入角色长期记忆。

2026-10-30 的第一次重跑发现原有验收脚本按消息文本比较，误把同一句话分别发送给两个角色判为越权；运行时的 rumor `source.id` 和 `audience` 已显示为不同消息实例。脚本现按稳定消息来源 ID 验收，下一次成功运行才更新本目录的真模型结论。

这项证据只证明小规模真实模型闭环和当前输入隐私边界。它不证明 L2 反思已进入 Luanti 主循环、断电级跨存储原子提交、长期崩溃恢复、真人三维体验、供应商吞吐或千至万级真实 LLM 角色容量。
