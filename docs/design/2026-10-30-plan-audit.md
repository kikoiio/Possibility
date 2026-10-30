# 实施计划审计（2026-10-30）

本文审计当前工作区的 [`docs/PLAN.md`](../PLAN.md)。本文不改变计划勾选状态，也不把夹具验证写成产品完成。审计基线是当前分支 `wispiva/world-product` 的 `HEAD` `184eade` 加上工作区已有的未提交改动；后续未提交改动新增了 source-grounded L2 provider bridge 和 live intent CLI 入口。

仓库内 `docs/` 和 `evidence/` 的相对 Markdown 链接均能解析到现有文件。GitHub Actions 链接没有在本次网络受限环境中重新打开。产品证据 README 记录的提交 `af2dc82f0dde35dbfd89b8815da1900c39c0e938` 不在当前本地 Git 对象中，因此这些链接只能作为远端运行记录引用，不能作为当前工作区的可复现证明。当前工作区还存在未提交的运行时、模型输入、长期记忆和 Actions 改动。

## 未勾选项

| 计划项 | 状态 | 当前证据 | 下一步 |
| --- | --- | --- | --- |
| 统一创建与状态契约 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 已实现 `READY`、`PREPARING`、`FROZEN`、准备与提交版本。Luanti 启动时会对账起源投影，发现不一致时冻结。对应测试见 [`test_product_state.lua`](../../cognition/test_product_state.lua)，运行范围见 [`产品状态与模型输入证据`](../../evidence/luanti/product-state-model-input-2026-10-29/README.md)。 | 在同一已提交版本上注入地图、角色、库存、事件、记忆和环境的逐阶段中断。确认每个启动路径都能冻结未知状态，并补充精确的权威归属和恢复协议。跨存储原子提交仍未实现。 |
| 用户意图到世界起点 | 部分完成 | [`genesis/2026-10-29-product-intents/summary.md`](../../evidence/luanti/genesis/2026-10-29-product-intents/summary.md)记录两个非固定题材、草稿修订、确认 revision、私有 intent 和公开投影。持久世界证据见 [`product-world-2026-10-29`](../../evidence/luanti/product-world-2026-10-29/README.md)。 | 用真实用户文本或素材完成至少两次确认流程。记录用户看到的草稿、修改、确认、失败回滚和语义隐私审查结果。当前证据仍主要来自合成输入和夹具。 |
| 空间与三维体验 | 部分完成 | [`product-world-2026-10-29/README.md`](../../evidence/luanti/product-world-2026-10-29/README.md)记录地面、室内外投影、连接、角色起点、客户端连接、场景互动和引导到达。Actions `40956198179` 是该运行的远端引用。 | 完成真人 Luanti 客户端验收，记录用户是否能移动、观察、理解互动及其后果。随后补充真实通行、碰撞、寻路、外观和不同题材的场景验证。当前角色仍使用受控投影和 `set_pos`。 |
| 记忆从起点进入主循环 | 部分完成 | [`model_envelope.lua`](../../cognition/model_envelope.lua) 已生成 `wispiva.model-input` v1，并区分 `facts`、`experiences`、`rumors`、`unknowns`。[`product_envelope.py`](../../model/product_envelope.py) 和 [`bridge.py`](../../model/bridge.py) 在 provider 前校验来源、角色绑定和 audience。[`long_term_memory.lua`](../../cognition/long_term_memory.lua) 已增加按 owner、topic 和 L1 经历生成连续版本的 `reflect` API；新增 [`reflection.py`](../../model/reflection.py) 约束 L2 provider 输入和 source IDs。对应 Lua、Python 和 Luanti 夹具证据见 [`产品状态与模型输入证据`](../../evidence/luanti/product-state-model-input-2026-10-29/README.md)。 | 为 `reflect` 接入受控触发器或 reflection worker，并用真实模型运行验证实际输入、token、反馈和 L2 产物。验证恢复后的 inbox、动作反馈、来源、版本和私有 audience。当前 Actions 证据使用 fixture worker，不能证明真实模型体验。 |
| 真实角色与环境闭环 | 部分完成 | [`environment.lua`](../../cognition/environment.lua) 已提供逻辑时间下的资源变化。持久世界证据记录环境事件、fixture gather/build、失败反馈和恢复。模型 envelope 将当前观察、库存、可行动作和上次反馈分开投影。 | 运行真实 provider 的角色场景，覆盖对白、传闻、资源后果、失败、过期响应、冲突和模型不可用。增加至少一种真实通行或交互对象，并证明动作结果同时出现在世界、事件、库存和角色经历中。 |
| 持续时间与恢复 | 部分完成 | [`product_state.lua`](../../cognition/product_state.lua) 和 Luanti 主循环已保存逻辑时钟、环境、角色、事件、长期记忆和产品提交版本；启动时能拒绝未完成提交。持久世界证据记录正常停服和 `--resume`。 | 在 `prepare`、地图写入、checkpoint、环境保存和 `commit` 之间注入退出或崩溃。验证失败后世界保持冻结，重试不重复结算。补充暂停、无客户端运行、重连和离线时间不补算验证。当前实现仍使用多个存储，不能宣称断电级一致提交。 |
| 端到端体验与证据 | 尚未完成 | [`genesis/2026-10-29-model/summary.md`](../../evidence/luanti/genesis/2026-10-29-model/summary.md)只有两次合成题材草稿的真实模型生成。持久产品世界使用 fixture worker；客户端验收是自动化连接和路径检查，不是真人评价。仓库中没有与当前工作区对应的成功真实模型产品世界证据目录。 | 用真实用户意图创建世界，运行真实 provider，保存精确版本、模型调用、可见 envelope、动作、世界事件、私有记忆来源、失败和延迟。完成真人三维体验验收，并把 artifact、模型和 token 信息归档到新的证据目录。 |

## 已完成但证据或文档没有完全同步的内容

1. **产品模型输入边界已有实现。** `wispiva.model-input` v1、四类知识、来源、audience、当前状态和动作反馈已经进入 Lua 主循环、Python validator 和 bridge。`PLAN.md` 仍将整个记忆目标保持未完成是正确的，因为 L2 反思触发、真实模型输入和真人角色质量还没有验收。当前证据只覆盖 fixture worker，不能覆盖工作区新增的 `reflect`、模型审计文件和最新未提交改动。

2. **产品状态冻结边界已有实现。** `product_state.lua`、启动对账、逻辑时钟和失败冻结已经有代码与定向测试。已有证据仍不能证明地图数据库、mod storage、角色 checkpoint 和环境快照之间的跨存储原子性。下一次 Actions 应使用包含当前改动的已提交 SHA，并在证据 README 中记录该 SHA，而不是继续沿用无法在本地解析的 `af2dc82…`。

3. **自动客户端验收已有记录。** `product-world-2026-10-29/README.md` 已补充客户端连接、互动和引导到达，`docs/PLAN.md` 也已有 Actions `40956198179` 引用。该证据应明确归类为自动化路径检查，不能替代真人移动、观察和可理解性评价。

4. **长期记忆文档存在陈旧表述。** [`cognition/README.md`](../../cognition/README.md) 仍称当前没有 `reflection`，但 [`long_term_memory.lua`](../../cognition/long_term_memory.lua) 已提供 `store:reflect`。这不会改变本次审计范围，也不应通过修改 `PLAN.md` 解决。后续提交反思实现或证据时，应同时更新该 README。

5. **本地链接完整不等于证据新鲜。** 本次静态检查没有发现 `docs/` 或 `evidence/` 中指向不存在文件的相对链接。证据的新鲜度仍取决于 Actions 运行是否对应当前提交，以及证据是否覆盖当前未提交的行为；两者目前都不能从当前工作区完全证明。

## 审计后的推进顺序

1. 先提交并运行当前产品状态、模型 envelope、L2 API、客户端验收和模型审计改动，生成与该提交完全对应的 Actions 证据。
2. 在同一次产品世界验证中加入真实 provider 的受控社会场景，检查四类知识、私有 audience、消息传闻、动作反馈和真实 L2 反思。
3. 再做跨存储中断注入、冻结和恢复验证，保留失败产物。
4. 完成真人 Luanti 客户端验收和真实用户意图链路后，才重新评估 `PLAN.md` 中的完成勾选。

本审计只新建本文档。没有修改 [`docs/PLAN.md`](../PLAN.md)，也没有运行测试、Actions、Luanti、客户端或其他重型任务。
