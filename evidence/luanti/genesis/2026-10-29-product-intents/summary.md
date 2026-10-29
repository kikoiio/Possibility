# 两个非固定题材的用户意图创建案例

本组记录覆盖 `canal-dye-house` 和 `desert-observatory` 两个独立题材。每个案例保存用户意图、可编辑草稿 v1、编辑后的草稿 v2、确认期望和公开／私有边界；它们不读取或改写 `genesis/example.json`。

`genesis.test_product_intents` 对每个案例执行：生成并持久保存 intent，确认前编辑到 revision 2，确认并发布产品世界目录，检查私有 manifest 和 `creation.json` 保留 intent 及摘要，以及 `public_view` 不含角色目标或角色记忆。

这证明了两个具体题材的创建数据边界、编辑和确认记录可以回归验证。它不证明任意题材的语义忠实、模型输出质量、用户界面确认、真人隐私审查、Luanti 客户端体验或规则执行。`example.json` 仍只用于既有离线单元和兼容性夹具。

案例记录：

- [Canal Dye House](canal-dye-house/record.json)
- [Desert Observatory](desert-observatory/record.json)
