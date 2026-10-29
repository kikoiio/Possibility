# 模型桥接

已接入 Luanti 的异步闭环：`observe → 私有文件队列 → Python worker → Responses SSE → 校验动作 → 引擎执行 → 反馈`。引擎不在 tick 内等待网络。运行器为每次实验创建新的 0700 spool，停止时回收 worker 及其请求子进程；新运行不重放旧响应。

## 配置与运行

Actions 使用 repository variables `XUNFEI_OPENAI_RESPONSE_URL`、`XUNFEI_MODEL` 和 secret `XUNFEI_LLM_API_KEY`，后者映射为进程变量 `XUNFEI_API_KEY`。本轮使用 `spark-x2.6`。不读取 `.env`，不把凭据写入请求或日志。也支持项目的 `WISPIVA_LLM_BASE_URL/MODEL/API_KEY`；同一配置项优先 XUNFEI。

```sh
engine/luanti/run.sh --label model-trial --agents 3 --decisions 8 --interval 1 --seconds 600 --model
```

重型运行应通过 [Actions 工作流](../.github/workflows/wispiva-validation.yml) 执行。`--fake-model` 使用确定性采集／放置夹具，不调用模型，报告明确标记 `deterministic-fixture`，事件 `origin=fixture`。只有 `--model` 的 provider 调用才算真实模型证据。

## 接口与边界

`origin_context.py` 是独立的离线输入原型：校验世界、起源、持久角色映射及临时 Luanti 数字 ID，将单一角色的起始记忆与调用者提供的局部观察、消息和反馈按白名单、预算组合后调用适配器。它未接入 Luanti 运行时；身份认证、角色授权和观察真实性仍由调用方负责，允许的文本也须事先经过授权。现有 `adapter.py` 本身接受额外上下文字段，不能将它当作通用的隐私过滤器。

`adapter.py` 仅使用标准库；HTTPS 地址由受信任配置固定，拒绝 URL 凭据、查询参数和重定向。兼容流式 Responses SSE，请求／响应／文本均有限长。`text.format=json_object`，单次输出最多 256 token，关闭 reasoning。完成事件、错误、拒绝、无效 JSON 与不合法动作均有明确失败码；不自动改成规则策略。

模型输出投影到白名单字段：`inspect/mark/advance`、带 `target` 的 `approach`、带 `point` 的 `wander/gather/build`、带 `target/text` 的 `say`。忽略多余字段，坐标和 ID 允许数学上为整数的 JSON 数字，拒绝布尔、非有限和小数值。未知字段不能改变端点、节点名或审计来源。邻居目标必须来自观察，坐标必须在边界内；执行前再次按当前世界验证。`why` 由代码固定为 `model`。

`spool_worker.py` 顺序处理请求，每次调用独立子进程；45 秒墙钟时限后终止并回收。仅 `invalid_action` 最多尝试 3 次，每次都审计；传输错误、provider 错误不会无界重试。Lua 的队列总截止时间为 `角色数 × 135 + 30` 秒，并在接受已存在的响应前检查。该队列只是小规模基线，未实现生产级公平调度或供应商并发限额管理。

审计记录请求 ID、角色、动作、origin、耗时、可用 token、重试与固定错误码，不记录密钥或原始 provider 文本。适配器返回上下文与提示 SHA-256；原始合成消息只在显式 `society_log_messages=true` 时记录。本轮实验的世界、角色和消息均为合成数据。

`bridge.py` 还提供 JSONL stdin/stdout 协议：请求 `{"id":1,"context":{...}}`，成功 `{"id":1,"ok":true,"action":{...},"audit":{...}}`，失败 `{"id":1,"ok":false,"error":"固定错误码"}`。ID 在一轮内唯一，失败不回显输入。

## 验证与结论范围

轻量离线测试：`python3 -B -m unittest discover -s model -t . -v`。实际调用记录在 [Luanti 适配层证据](../evidence/luanti/model/) 和 [执行计划](../docs/PLAN.md)。少量串行调用只证明闭环和观测到的时延，不代表供应商最大吞吐、万级 LLM 容量或记忆效果。没有观察到行为时也保留结果；确定性夹具与任务提示诱导的协作不能视为自发社会涌现。


## 受控记忆任务与并发探针

`memory_eval.py` 的默认任务是 4 类 × 3 seeds × FIFO／retrieval，共 24 次真实配置模型调用：延迟回忆、消息来源、过期事实和已知失败后的替代选项报告。共享容量 16、最多 2 条、规范紧凑 JSON 最多 512 UTF-8 字节；这些是相同上限，实际 token 分别审计。每个条件先通过 `cognition/test_retrieval.lua --select` 调用同一份 `memory.lua`；答案仅在评分侧，provider 输入不含答案。消息类任务没有执行世界动作，替代桥名回答不能当作实际避免重复失败的证据。

`--probe` 另做 1／2／4 并发，各 8 次固定请求，共 24 次。主进程用线程协调独立子进程，每次请求包含子进程启动的硬超时 30 秒，零重试；两个命令分别限额最多 48 次，默认合计 48 次。`--fixture` 仅验证协议和评分；输出标明 synthetic。

结果保存固定评分、上下文／事件哈希、源码 SHA-256、实际已知 token 和未知审计缺口，不保存原始 provider 文本。探针只有每级一个小批，含子进程与网络开销，无法证明供应商容量、免费额度或稳定加速比；原有引擎 spool 仍是单 worker。HTTP 429 单独报告 `rate_limited`；其他传输错误仍未细分。畸形 token 字段带 `usage.invalid=true`，不会被当成完整用量。
