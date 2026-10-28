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
