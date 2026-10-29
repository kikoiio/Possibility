# 仓库布局

本分支按独立产品组织。`experiments/` 不再是源码目录；Wispiva 的产品模块直接位于仓库根目录。Luanti 只作为一个可替换的引擎适配层放在 `engine/luanti/`，验证工具和历史证据单独归档。目录名描述依赖边界，不定义产品名称。

```text
.
├── genesis/                 # 用户意图、世界草稿、确认和一次性预览
├── world/                   # 世界状态、事件和恢复协议
├── cognition/               # 角色观察、行动、短期及长期记忆
├── model/                   # LLM 适配器、请求队列和模型调用
├── engine/luanti/           # Luanti 引擎适配层、mod、运行时和启动器
├── validation/luanti/       # Luanti 容量基准、分析和验证工具
├── evidence/luanti/         # Luanti 运行证据和历史测量
├── docs/                    # 产品意图、架构、计划、研究和证据索引
└── .github/workflows/       # Wispiva 检查和验证工作流
```

`genesis`、`world`、`cognition` 和 `model` 是 Wispiva 的核心产品模块；`engine/luanti` 是当前世界引擎适配实现。未来增加其他引擎时，应新增同级适配层并复用核心模块，而不是把产品搬进新的引擎目录。`validation/luanti` 只负责验证当前适配层与运行时能力；`evidence/luanti` 保存可审计的运行结果。验证结果不会自动变成产品能力。

本分支独立发展，工作流使用 `validation/luanti-*` 临时分支触发，不能通过合并 `main` 更新本分支。生成的 `.runtime/`、世界目录、模型队列和 Actions 下载目录属于本地或 CI 临时数据，不进入版本库。

历史日志可能包含它们生成时的绝对路径，例如旧运行中的 `experiments/minecraft-societies`。这些字符串是原始证据的一部分，不代表当前源码布局，也不应通过批量替换篡改。
