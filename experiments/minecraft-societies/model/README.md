# Responses 模型适配器

这是独立的 Python 3.9+ 桥接模块，不会修改世界，也尚未连接 Luanti 的同步 `policy.decide`。它仅使用标准库。进程需要显式提供 `XUNFEI_OPENAI_RESPONSE_URL`（完整地址）、`XUNFEI_MODEL`、`XUNFEI_API_KEY`；也支持项目已有的 `WISPIVA_LLM_BASE_URL`、`WISPIVA_LLM_MODEL`、`WISPIVA_LLM_API_KEY`（对应项优先 XUNFEI）；URL 也支持 `XUNFEI_BASE_URL`，优先级低于 `XUNFEI_OPENAI_RESPONSE_URL`。不自动读取 `.env`。base URL 必须为 HTTPS，接受 `/v1` 或完整 `/responses` 路径，无 URL 凭据、查询串或重定向。端点须支持 OpenAI 风格的流式 Responses SSE；供应商的具体兼容性尚需实际验证。

```python
from adapter import Config, ModelError, decide_async

context = {
    "observation": {"has_target": False, "nearby_agents": [2, 3]},
    "bounds": {"min": {"x": -32, "y": 1, "z": -32},
               "max": {"x": 32, "y": 1, "z": 32}},
}
try:
    result = await decide_async(Config.from_env(), context)
    action, audit = result["action"], result["audit"]
except ModelError as error:
    # error 是固定错误代码；由调用方记录并决定是否回退。
    pass
```

`decide` 是同步入口；`decide_async` 在线程中调用它，不阻塞事件循环。调用方应自行管理并发、排队和生命周期，不能在 Luanti tick 内等待网络。取消协程不会中止正在运行的线程和网络请求；socket 超时默认 30 秒，是单次阻塞 I/O 超时而非总时限。无自动重试。集成层必须丢弃过期结果，并在执行前按当前世界状态再次验证：邻居可能离开，目标可能变化；将当前 observation 附在 `inspect` 动作上以满足现有执行器。接入时需要单独设计 Lua 与 Python 间的安全通信，本模块未提供服务或 IPC。

仅接受 `inspect`、`mark`、有现存目标时的 `advance`、目标在 `nearby_agents` 中的 `approach`，以及整数坐标在调用方提供的三轴闭区间内的 `wander`。返回的 `why` 固定为 `model`，不信任模型给出的额外字段。完成事件缺失、服务失败、拒绝、无效 JSON 或动作均抛出 `ModelError`，不会自动提交或替换动作。响应和请求有大小限制；不记录原始提示、观察、响应、URL 或密钥。成功审计包含提示和上下文的 SHA-256、延迟与可用 token 数；失败可记录固定错误代码。哈希不能重建输入，若需要完整重放，应由调用方另行安全保管上下文、模型标识和配置，且不要记录凭据。

轻量离线测试：`cd experiments/minecraft-societies/model && python3 -B -m unittest -v`。测试使用模拟传输，不访问模型或读取凭据。

## Lua 桥接协议

在受信任的本地父进程中启动 `python3 -u experiments/minecraft-societies/model/bridge.py`，通过继承的环境传入模型配置，通过私有管道连接 stdin/stdout。每行一个 UTF-8 JSON 请求，必须以换行结束；stdout 每行对应一个 JSON 响应，立即 flush，不包含其他输出。每进程顺序处理请求；网络等待发生在子进程，不应在 Lua 的 server step 中同步读管道。`id` 是调用方生成的 0 至 2^53−1 的整数，同一运行中不要复用；请求：

```json
{"id":1,"context":{"observation":{"has_target":false,"nearby_agents":[2,3]},"bounds":{"min":{"x":-32,"y":1,"z":-32},"max":{"x":32,"y":1,"z":32}}}}
```

成功返回 `{"id":1,"ok":true,"action":{"kind":"inspect","why":"model"},"audit":{...}}`；失败返回 `{"id":1,"ok":false,"error":"provider_failed"}`。无法解析的请求返回 `id:null` 和 `invalid_request`；不回显请求内容。使用非阻塞管道或受控的外部 IPC 适配器收取结果，按照 id 关联 agent、观察版本及请求轮次；过期、重复、agent 消失的响应必须丢弃。校验执行前的世界状态及边界，处理 `inspect` 所需的当前 observation。管道断开时丢弃所有未决请求并记录桥接故障，禁止将失败当作成功；如需回退由集成层明确决定。停止实验时关闭 stdin，等待子进程退出；若仍处于网络 I/O，父进程应按自身生命周期策略处理。切勿把桥接管道暴露为未经认证的网络服务。

这是协议及进程接口，不包含 Lua 端进程管理：Luanti 沙盒和宿主进程 API 各异，需由运行器实现安全的进程/管道接入。测试中的观察、动作、端点和密钥均为合成数据；离线测试覆盖协议错误和供应商失败，不连接服务。

## 文件队列桥接

由运行器创建仅实验进程可访问的私有目录（建议权限 0700），设置上述环境变量后启动一个 worker：

```sh
python3 -B experiments/minecraft-societies/model/spool_worker.py /path/to/private-spool --timeout 30 --poll-interval 0.1
```

Lua 把与 JSONL 协议相同的请求写到该目录内的临时文件，关闭后原子重命名为 `request-<id>.json`；id 必须是 0 至 2^53−1 的十进制整数，与 JSON 中的 `id` 一致，不含前导零。worker 顺序消费并原子发布 `response-<id>.json`，结构与 JSONL 协议相同；读取后由 Lua 删除响应。实验期间每个 id 只能使用一次，避免覆盖旧响应；请求数据应仅包含实验合成观察，不得放入密钥。必须只启动一个 worker 操作该目录，目录也不能被不受信任的进程写入。

每个请求由独立子进程执行，`--timeout` 是实际墙钟截止时间（大于 0 且不超过 300 秒）；截止时终止并回收子进程，响应错误码为 `timeout`。创建目录内的 `STOP` 文件要求 worker 停止：正在执行的请求返回 `stopped`，子进程被终止并回收，之后 worker 退出；尚未开始的请求留在目录。SIGTERM 或 Ctrl-C 也会终止并回收当前子进程，但不保证产生当前请求的响应。父进程应等待 worker 退出，再按需要删除 `STOP`。新一轮运行应使用新目录，或由运行器在确认旧 worker 已退出后检查并清理残留 `.processing-*.json` 与 `.response-*.tmp`；异常终止不保证生成响应，不要在不确认执行结果的情况下自动重放。worker 不自动启动、管理或修改 Luanti；请求的时效与执行前验证仍由 Lua 负责。
