# 已退役：寒夜小屋模型实验

日期：2026-10-26。旧场景已按用户要求删除，本页仅保留历史结论。现用客户端位于 `prototypes/model/`，当前场景见[苔背上的日常](../../README.md)。

## 请求失败定位与流式

- 最初真实请求有 HTTP 404 和 30 秒超时，不能据此认为 key 无效。
- 用户授权的最小 curl 请求成功：HTTP 200、输出 OK、9.732 秒；同样的 Node 最小请求 3.710 秒成功。
- 完整推演在延长观察窗口后，服务明确返回 `incomplete / max_output_tokens`，原 2048 token 预算耗尽且没有最终答案。
- 8192 token 的对照在 98.922 秒后完成，输出 7662 token，逐分钟候选检查通过。
- 后续遵照用户要求，移除程序总超时与输出 token 参数，改用流式 Responses；一次完整推演 244.140 秒完成，2605 个事件，首事件 106.087 秒，首最终文本增量 227.907 秒，输出 10760 token，逐步检查通过。流式提高可观察性，不保证服务立刻返回事件。

历史脱敏报告：`.tmp/simulation-core/curl-latest.json`、`node-minimal-latest.json`、`node-full-latest.json`、`node-full-expanded-latest.json`、`stream-live-latest.json`。调用审计不自动删除。

## 角色实验

旧角色 Wisp 在全新公开夹具中选择添柴 0.25 kg，实际库存扣减、热学后果和一条本人经历保存恢复成功，49.383 秒完成。证据为 `.tmp/simulation-core/actor-public-latest.json`。这只证明一次真实选择，不是长期自主性验收。

原拟发送用户存档副本的外发验证被自动审批拒绝，没有执行；随后改用不包含用户存档和记忆的公开初始夹具获准验证。后续外发测试继续使用公开夹具，agent 不直接打开或展示 `.env` / `config.json`。
