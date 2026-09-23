# s01｜P4 世界优先 UI 旅程验收 Checklist

> 依据：[spec.md](./spec.md)、[plan.md](./plan.md) 和 [task.md](./task.md)。逐项结果与环境证据见 [current-state-audit.md](../../docs/current-state-audit.md) 的“S01 P4 实施与验收证据”。

| 验收项 | 状态 | 结果摘要 |
|---|---|---|
| AC1 世界与时间线定位 | 通过 | 合成用户打开 `/worlds/s01-world?timeline=s01-main`，刷新后仍选中主线；从未带参世界链接进入时页面写回快照默认线。聊天路由拒绝不存在的 timeline，且不创建会话。 |
| AC2 实际运行推进 | 通过 | 本地产品暂停/继续控件状态切换已浏览器确认；本地 pinger 日志记录推进与日程结果，UI 的世界时间/状态版本随之更新。独立双 Worker 集成脚本在隔离 D1 中记录 1 条 clock fact、revision 2、simNow 前进、0 个遗留 lease。 |
| AC3 普通居民对话与失败恢复 | 通过 | 主线普通聊天在浏览器完成，固定模型替身回复进入页面，返回链接和重载保留主线。人工注入 SSE 部分回复后断流，页面显示连接错误并核对历史；刷新后仅用户消息仍在，半截居民文本没有进入完成历史。API 通过完整回复持久化与断流/重试用例。 |
| AC4 对话与世界结果边界 | 通过 | 普通聊天完成后返回世界，主线仍为状态 v0、事件数 0；对话文本没有作为世界事件或已发生行动展示。API 产品旅程也断言普通聊天不会改写世界事实。 |
| AC5 Fork/Compare 往返 | 通过 | 浏览器从主线创建带“咖啡馆开放时间”条件的分支；URL 切到新 timeline id。Compare 显示共同祖先、分叉条件、共同事件及非因果提示；选择主线返回后仍为 `timeline=s01-main`，可以打开居民聊天。 |
| AC6 时间线切换与迟到结果隔离 | 通过 | 本地代理将主线第二次世界快照响应延迟 12 秒；响应到达前创建并选中 Fork，延迟快照返回后 URL、平行宇宙选择、v0 状态和 0 条事件保持不变。另验证延迟分支聊天回复只进入原分支历史；Web 回归覆盖切线后的旧结果、清理订阅后的回调及不匹配快照均被守卫拒绝。未单独对传输层旧 SSE 帧做延迟注入。 |
| AC7 匿名只读边界 | 通过 | 将本地合成世界标记为 demo 后，匿名首页可见世界状态和居民，只提供登录入口；运行、模式切换、普通聊天和写操作控件均不显示。公开 API 路由回归覆盖匿名读取及写入拒绝。 |
| AC8 出口记录 | 通过 | AC1–AC7 均有测试或浏览器证据；API/Web 构建、全量测试、双 Worker 集成验收、隔离环境及清理状态均已记录，未验证的旧 SSE 传输注入范围明确保留。S01 P4 阶段出口通过。 |

## 自动化与构建结果

- `npm --workspace api run test`：32 个文件、224 项测试通过。
- `npm --workspace web run test`：2 个文件、9 项测试通过。前端项目未安装 DOM 测试环境；回归覆盖时间线 URL、旧 timeline/清理订阅/错配快照守卫，以及普通聊天入口显示边界。
- `npm --workspace api run build`：通过。
- `npm --workspace web run build`：通过，包含 TypeScript 检查与 Vite production build。
- `npm run verify:s01:workers`：退出码 0；两 Worker 共享一次性本地 D1，覆盖 tick lease、Fork 竞争/重放/载荷冲突、源写入竞争、容量拒绝和故障注入回滚；最终审计恰有 1 条 clock fact、revision 2、无活动 lease。
- `git diff --check`：通过。

## 环境清理

- 登录态浏览器使用合成账号 `s01-owner`；匿名场景使用同一个一次性数据库中的本地 demo fixture。
- API、Web、pinger 与模型替身仅绑定本机回环地址；没有使用远端或生产数据库、部署服务或真实模型。
- 停止 manual UI、pinger 和 Vite 后，脚本输出 `Cleaned isolated directory ...`；临时 D1、模型替身随脚本退出清理；没有将临时账号凭据写入仓库。

## 阶段结论

S01 P4 AC1–AC7 均通过，AC8 出口记录完整，阶段出口通过。传输层旧世界 SSE 帧没有单独延迟注入；旧订阅清理及错配响应通过 `WorldView` 守卫回归验证。
