# 真实模型记忆对照与并发探针（2026-10-28）

本目录保存 GitHub Actions 运行 40746181765、源码 `01b91a531158211d88813d666055a37e50ae2098` 的实际配置模型证据。`tasks.json` 与 `concurrency.json` 均标记 `fixture=false`、`evidence_kind=actual_configured_model`，不是离线夹具。模型配置变量为 `spark-x2.6`；其规范 JSON 字符串 SHA-256 与产物中的 `model_sha256` 相同。

记忆任务固定 4 类任务、3 个 seed、FIFO／retrieval 两个交替条件，共 24 次调用，零重试，24/24 provider completion，0 errors。检索条件 12/12 正确；FIFO 条件 0/12 正确。FIFO 的 11/12 输出 abstained，另有 1/12 来源目标错误；检索组没有错误或 abstention。这里的任务评分只覆盖预先定义的合法动作和答案类别，不能推出开放世界记忆能力。

provider 报告的总用量为 13,480 tokens：input 13,049、output 431；24/24 token audit complete。FIFO 为 6,722，retrieval 为 6,758。p95 provider latency 为 2,811 ms，p95 wall latency 为 2,899.7 ms。原始模型回答文本没有归档，产物只保留哈希、净化后的评分类别和 token 审计，因此之后不能独立重评分或重放精确输出。

并发探针在 1、2、4 个 worker 各发 8 个固定请求，共 24 次，全部成功、24/24 正确，总用量 10,152 tokens；但每个级别只有一个小批次，没有交替重复、限流剖析或 provider 配额测量，结论保持 `inconclusive`。它不能证明稳定并发上限，更不能外推 10,000 个角色同时调用模型。

记忆实现仍是有界 FIFO 存储加确定性词项／实体 ID 检索：检索不能恢复已经被 FIFO 淘汰的记录，也没有 embedding、中文分词、摘要、事实冲突裁决或长期计划。
