# 仓库布局

本分支按产品运行时组织。`experiments/` 不再是源码目录；历史测量作为验证证据保留在 `luanti/` 和 `docs/research/` 中。

```text
.
├── docs/                 # 产品意图、架构、计划、研究和验收证据索引
├── luanti/               # Luanti 基底上的 Wispiva 运行时
│   ├── genesis/          # 用户意图、世界草稿、确认和一次性预览
│   ├── world/            # 世界状态、事件和恢复协议原型
│   ├── agent/            # 服务端角色、调度、启动器和运行记录
│   ├── cognition/        # 观察、行动、短期及长期记忆
│   ├── model/            # LLM 适配器、请求队列和模型证据
│   ├── runtime/          # 可复现的 Luanti 就地运行时引导
│   ├── bench/            # 引擎和实体容量基准
│   ├── scale/            # 容量、队列和记忆验证工具
│   └── analysis/         # 验证结果汇总工具
└── .github/workflows/    # Wispiva 检查和验证工作流
```

`luanti/genesis`、`luanti/world`、`luanti/agent` 和 `luanti/cognition` 属于产品实现路径；`bench`、`scale`、`analysis` 以及各组件下的 `evidence` 属于支持产品决策的验证资料。它们共享实现代码，但验证结果不会自动变成产品能力。

当前分支独立发展，工作流使用 `validation/luanti-*` 临时分支触发，不能通过合并 `main` 来更新本分支。生成的 `.runtime/`、世界目录、模型队列和 Actions 下载目录属于本地或 CI 临时数据，不进入版本库。

历史日志可能包含它们生成时的绝对路径，例如旧运行中的 `experiments/minecraft-societies`。这些字符串是原始证据的一部分，不代表当前源码布局，也不应通过批量替换篡改。
