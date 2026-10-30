# 模型桥接

已接入 Luanti 的异步闭环：`observe → wispiva.model-input → 私有文件队列 → Python worker → provider 前 envelope 校验 → Responses SSE → 校验动作 → 引擎执行 → 反馈`。引擎不在 tick 内等待网络。运行器为每次实验创建新的 0700 spool，停止时回收 worker 及其请求子进程；新运行不重放旧响应。

## 配置与运行

Actions 使用 repository variables `XUNFEI_OPENAI_RESPONSE_URL`、`XUNFEI_MODEL` 和 secret `XUNFEI_LLM_API_KEY`，后者映射为进程变量 `XUNFEI_API_KEY`。本轮使用 `spark-x2.6`。不读取 `.env`，不把凭据写入请求或日志。也支持项目的 `WISPIVA_LLM_BASE_URL/MODEL/API_KEY`；同一配置项优先 XUNFEI。

```sh
engine/luanti/run.sh --label model-trial --agents 3 --decisions 8 --interval 1 --seconds 600 --model
```

重型运行应通过 [Actions 工作流](../.github/workflows/wispiva-validation.yml) 执行。`--fake-model` 使用确定性采集／放置夹具，不调用模型，报告明确标记 `deterministic-fixture`，事件 `origin=fixture`。只有 `--model` 的 provider 调用才算真实模型证据。

## 接口与边界

`origin_context.py` 是独立的离线输入原型：校验世界、起源、持久角色映射及临时 Luanti 数字 ID，将单一角色的起始记忆与调用者提供的局部观察、消息和反馈按白名单、预算组合后调用适配器。它未接入 Luanti 运行时；身份认证、角色授权和观察真实性仍由调用方负责，允许的文本也须事先经过授权。现有 `adapter.py` 本身接受额外上下文字段，不能将它当作通用的隐私过滤器。

产品 Lua 运行时生成 `wispiva.model-input` v1。`knowledge.facts`、`experiences`、`rumors`、`unknowns` 分别表达当前事实、本人经历、收到的传闻和有来源但未证实的内容；每项包含稳定 ID、来源和 `access.audience`。`current` 承载观察、库存与可行动作，`feedback` 承载上一次实际执行结果。`model/bridge.py` 在调用 provider 前验证 schema、世界/角色绑定、四类 epistemic 标签、来源及 audience，失败时不产生模型调用；有 envelope 的请求只把 envelope 发送给 provider，legacy 字段只用于本地动作校验。Lua envelope、bridge 和 adapter 测试覆盖了隐私越权、缺来源记录及 provider 载荷隔离。

`model/reflection.py` 提供独立的 `wispiva.reflection-input` v1 桥接：调用方先从一个角色自己的 L1 记录中选出有限经历，保留来源、audience 和 captured time；provider 只能返回同一 topic 的文本解释以及它引用的 source IDs。未知 source、跨角色 audience、重复引用、空引用和额外字段都会在 provider 前或返回后拒绝。它返回上下文／提示哈希和 provider usage，但不会直接写入长期记忆。`model/reflection_host.py` 提供显式的 host writeback 边界：只有 provider 结果通过 source 校验后，才调用宿主提供的 `append(actor, topic, source_ids, text, time, source_id)`，并验证返回的是同一角色、同一 topic、同一来源列表的 L2 记录；provider 失败或持久化返回不一致都不会被伪装成成功。产品 bridge 现在在动作决策前处理可选 `reflection_input`，校验它绑定同一世界和角色；Luanti 通过 `reflection_runtime.lua` 在响应处按原请求来源集合写入认证 owner 的 L2。后续模型输入用独立 `knowledge.reflections`（`epistemic=belief`）携带最新主题版本。`run_product.sh --reflection-every 3` 默认每三次决策反思，设 0 可关闭；集成真实模型与重启证据见 Actions 41025066379 及 `evidence/luanti/product-memory-runtime-2026-10-30/`。

持久起源的 Python 接入点为 `build_manifest_context(manifest, binding, local, ...)`，接受受信任的 `wispiva-world-creation-materials` v1 handoff：检查外层世界身份与绑定，只从其中的 `origin_event` 派生角色上下文，其他全角色材料不会进入提示。`genesis/world_create.py` 发布的 Luanti `wispiva-world-manifest` 由当前产品 Lua 运行时直接投影；后续会把两种 handoff 合并为一个版本化传输协议。文件加载、认证和完整 manifest 校验仍由调用方负责。也可独立调用 `retrieve_genesis_memories(event, binding, query='', max_entries=8, max_bytes=4096)`，从可信的持久 `genesis.created` 载荷检索。返回 `memory`、`memory_query` 和 `memory_scope`，`build_context`／`decide` 已将这份投影用于模型输入。上下文入口接受 `memory_query`、`max_memory_entries`、`max_memory_bytes` 关键字参数；默认查询使用本人私有目标，独立检索接口的空查询则按种子顺序选取。调用方可用当前角色已获授权的局部线索作为查询。

每条记录保留 `world_id`、稳定的 `seed_id`、`owner`、原文以及 `source = {kind: "genesis.seed", event_id, id: seed_id}`；跨世界索引必须使用 `(world_id, seed_id)`。`known_by` 只列拥有者，表示这份种子的授权接收人，不推断其他人的知情状态。`classification = "unknown"`，`time` 和 `importance` 为 `null`：种子没有提供真实性分类、发生时间或重要度，不将起源提交当成种子内容已真实发生的证明，也不生成 L0 事实、L1 存储写入或 L2 反思。

检索使用大小写折叠后的完整词项重合度排序，同分按原始种子顺序；无匹配时按原始顺序回退，选中项最终保留种子顺序。它不做中文分词、语义检索或真实性判断。默认最多 8 条、完整 ASCII 转义紧凑 JSON 数组最多 4096 字节，预算可降低；不截断记录，未选中的数量写入 `memory_scope.omitted`，原始持久种子不变。兼容字段 `self.memories` 仅保留同批选中种子，不能绕过检索预算；整个模型上下文仍受 16000 字节上限约束。此切片只完成 Python 投影及模型调用路径，manifest 文件读取、Lua 主循环接线和长期记忆写回由运行时集成负责。

本切片的低资源定向测试：`python3 -B -m unittest model.test_origin_context -v`，使用内存序列化和假 transport，无引擎、网络或真实模型调用。

`adapter.py` 仅使用标准库；HTTPS 地址由受信任配置固定，拒绝 URL 凭据、查询参数和重定向。兼容流式 Responses SSE，请求／响应／文本均有限长。`text.format=json_object`，单次输出最多 256 token，关闭 reasoning。完成事件、错误、拒绝、无效 JSON 与不合法动作均有明确失败码；不自动改成规则策略。

模型输出投影到白名单字段：`inspect/mark/advance`、带 `target` 的 `approach`、带 `point` 的 `wander/gather/build`、带 `target/text` 的 `say`。忽略多余字段，坐标和 ID 允许数学上为整数的 JSON 数字，拒绝布尔、非有限和小数值。未知字段不能改变端点、节点名或审计来源。邻居目标必须来自观察，坐标必须在边界内；执行前再次按当前世界验证。`why` 由代码固定为 `model`。

`spool_worker.py` 顺序处理请求，每次调用独立子进程；单次调用超时后终止并回收。`invalid_action`、`transport_error`、`provider_failed` 和 HTTP 429 `rate_limited` 最多尝试 3 次，重试间隔为 1／2 秒，每次都审计；重试有界，仍失败时停止当前世界并报告固定错误。Lua 的队列总截止时间为 `角色数 × 135 + 30` 秒，并在接受已存在的响应前检查。该队列只是小规模基线，未实现生产级公平调度或供应商并发限额管理。

审计记录请求 ID、角色、动作、origin、耗时、可用 token、重试与固定错误码，不记录密钥或原始 provider 文本。适配器返回上下文与提示 SHA-256；原始合成消息只在显式 `society_log_messages=true` 时记录。本轮实验的世界、角色和消息均为合成数据。

`bridge.py` 还提供 JSONL stdin/stdout 协议：请求 `{"id":1,"context":{...}}`，成功 `{"id":1,"ok":true,"action":{...},"audit":{...}}`，失败 `{"id":1,"ok":false,"error":"固定错误码"}`。ID 在一轮内唯一，失败不回显输入。

## 验证与结论范围

轻量离线测试：`python3 -B -m unittest discover -s model -t . -v`。实际调用记录在 [Luanti 适配层证据](../evidence/luanti/model/) 和 [执行计划](../docs/PLAN.md)。少量串行调用只证明闭环和观测到的时延，不代表供应商最大吞吐、万级 LLM 容量或记忆效果。没有观察到行为时也保留结果；确定性夹具与任务提示诱导的协作不能视为自发社会涌现。

2026-10-30 UTC 的真实模型产品切片见 [证据](../evidence/luanti/product-model-2026-10-30/README.md)。Actions 41010708756 记录了 3 个角色的 18 个决策、对白、资源成功与失败、输入隔离、有限重试和一次 source-grounded L2 反思；该运行仍是受控小规模场景，不代表长期或万级模型容量。


## 受控记忆任务与并发探针

`memory_eval.py` 的默认任务是 4 类 × 3 seeds × FIFO／retrieval，共 24 次真实配置模型调用：延迟回忆、消息来源、过期事实和已知失败后的替代选项报告。共享容量 16、最多 2 条、规范紧凑 JSON 最多 512 UTF-8 字节；这些是相同上限，实际 token 分别审计。每个条件先通过 `cognition/test_retrieval.lua --select` 调用同一份 `memory.lua`；答案仅在评分侧，provider 输入不含答案。消息类任务没有执行世界动作，替代桥名回答不能当作实际避免重复失败的证据。

`--probe` 另做 1／2／4 并发，各 8 次固定请求，共 24 次。主进程用线程协调独立子进程，每次请求包含子进程启动的硬超时 30 秒，零重试；两个命令分别限额最多 48 次，默认合计 48 次。`--fixture` 仅验证协议和评分；输出标明 synthetic。

结果保存固定评分、上下文／事件哈希、源码 SHA-256、实际已知 token 和未知审计缺口，不保存原始 provider 文本。探针只有每级一个小批，含子进程与网络开销，无法证明供应商容量、免费额度或稳定加速比；原有引擎 spool 仍是单 worker。HTTP 429 单独报告 `rate_limited`；其他传输错误仍未细分。畸形 token 字段带 `usage.invalid=true`，不会被当成完整用量。
