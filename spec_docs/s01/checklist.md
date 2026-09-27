# s01｜全局验收收口 Checklist

> 依据：[spec.md](./spec.md)、[plan.md](./plan.md) 和 [task.md](./task.md)。所有条目初始为未验收；只有执行括号中的验证并记录实际证据后才能勾选。远端 D1 与真实模型条目需要单独授权。

> 2026-09-27 最终验收：API 46 文件/344 项、Web 6 文件/20 项及两端 build 通过；staging migration 22/22，本地/远端双 Worker、Root/Child/Grandchild、19 类命令组合重放、完整权限矩阵和两个独立浏览器 profile 均通过。真实浏览器已释放切线前进入缓冲的旧 SSE 半帧；真实模型最终轮 8 次调用覆盖六类渠道、无效合同与恢复，零自动重试、重放零差异。缺少不可变来源的旧 checkpoint 按要求保持 `incomplete/read-only`，没有补造。原 AC01–AC15 全部验收通过。

## 基线与迁移完整性

- [x] 已记录实施前 HEAD、分支、工作区文件清单和既有改动归属。（验证：`git status --short` 与审计记录逐项一致。）
- [x] 全新隔离 D1 能从 0000 应用到最新 migration，且第二次检查无待迁移项。（验证：本地 migration 命令退出码 0，migration ledger 数量与仓库一致。）
- [x] 代表性旧数据库应用新迁移后，原有世界、时间线、人物、消息和历史内容逐表一致。（验证：`legacy-migration.test.ts` 前后快照比较通过。）
- [x] 普通聊天请求表不重复保存聊天正文，且包含完整归属、hash、消息 ID、heartbeat 和终态字段。（验证：schema/migration 检查与迁移测试通过。）
- [x] Universe evidence 和模型调用回执表/字段存在，约束与 schema 一致。（验证：API build 与 migration 测试通过。）
- [x] 聊天迟到回复数据库 fencing 已安装并能拒绝终态后的旧 Worker 写入。（验证：注入 late-worker 完成事务，预期整批失败且无 reply。）

## AC1｜全域独立重建

- [x] reducer 只接收基线、命令和事实，不导入数据库客户端或当前投影读取函数。（验证：模块依赖检查、TypeScript build。）
- [x] Root、Child、Grandchild 的时钟均可从基线和历史重建到当前版本。（验证：24 小时多拍 Root→Child→Grandchild 旅程逐线重放 complete、零差异。）
- [x] 人物位置、活动、心情、目标、对话占用和节拍水位线重建结果等于当前投影。（验证：逐域比较无差异。）
- [x] 当前/未来日程及跨日日程变化可重建。（验证：日程 reducer 与全日 tick 旅程通过。）
- [x] 主事件和 resident-state 派生事件的 ID、时间、正文及行动者可重建。（验证：事件域比较通过。）
- [x] 承诺从提议到接受、拒绝、履约、失约、过期和解释的状态链可重建。（验证：承诺旅程和 reducer 测试通过。）
- [x] NPC 对话、在场场景、对话 turns、参与者占用和关闭状态可重建。（验证：对话 reducer 测试通过。）
- [x] thought、relationship、timeline/world memory、summary、correct、forget 和 summarized 状态可重建。（验证：记忆 reducer 测试通过。）
- [x] persona messages 及其世界、时间线、发送者和接收者归属可重建。（验证：留言域比较通过。）
- [x] knowledge facts 及来源链可重建，不读取当前知识投影填空。（验证：知识 reducer 测试通过。）
- [x] 对每个投影域注入 missing、extra 和 mismatch 后，审计报告正确域、记录和版本。（验证：故障注入矩阵通过。）
- [x] 比较器对全部九个行投影域逐一识别 missing、extra、mismatch；标量时钟 mismatch 单独识别。（验证：`rebuild.test.ts` 的全域差异矩阵与时钟回归。）
- [x] 错版本、错时间线、缺事实、未知动作和历史断档得到稳定诊断码。（验证：projector diagnostic 测试通过。）
- [x] 审计前后所有源表内容完全一致。（验证：只读前后数据库快照相等。）

## AC2｜Legacy 分级与安全降级

- [x] 完整结构化时间线被分类为 `complete`。（验证：classification 测试。）
- [x] 只有可由不可变证据唯一补齐的数据被分类为 `upgradeable`。（验证：可升级/歧义对照夹具。）
- [x] 缺基线、缺 Checkpoint 或历史含歧义的数据被分类为 `incomplete`。（验证：Root/Fork legacy 夹具。）
- [x] 升级计划逐项带有不可变来源，且不从当前投影反向生成命令或事实。（验证：升级计划断言与迁移前后命令/事实比较。）
- [x] 可升级时间线事务升级后重新审计为 `complete`。（验证：legacy classification/migration 测试。）
- [x] 升级中途失败时所有补齐数据和 evidence 状态回滚。（验证：数据库 trigger 故障注入。）
- [x] `unassessed` 和 `upgradeable` 在最终分类脚本结束后均为 0。（验证：`npm run verify:s01:legacy` 输出和只读查询。）
- [x] `incomplete` 数据仍可读取和 Compare，但页面明确显示“历史证据不完整，只读保留”。（验证：登录态浏览器与公共只读页面观察。）
- [x] `incomplete` Universe 的运行、聊天、场景、记忆修改、承诺、Fork 和恢复均被拒绝，且无预算或历史副作用。（验证：API 矩阵与前后账本快照。）
- [x] 对 `incomplete` Universe 的暂停/归档安全冻结可用，但恢复和重新激活被拒绝。（验证：管理操作矩阵。）

## AC3｜多渠道知识与可信度矩阵

- [x] 私有 knowledge fact 只进入目标居民上下文，不进入同地点其他居民上下文。（验证：knowledge/context 测试。）
- [x] 普通聊天上下文不会泄露另一居民的私有 canary。（验证：固定模型与真实模型断言。）
- [x] 在场传话生成带接收者、来源和 `rumor` certainty 的版本化事实。（验证：scene inform 旅程。）
- [x] NPC 对话只能引用说话者可见的知识链。（验证：NPC dialogue 提示与执行测试。）
- [x] 引擎 beat/injection/director 只能读取当前居民可见的知识。（验证：knowledge journey 与 engine context 测试。）
- [x] 记忆摘要保留来源集合和最低可信度，不把 rumor 升级为 fact。（验证：summary 合同及真实模型测试。）
- [x] 两跳及以上转述保持来源链；链上任一步为 rumor 时最终仍为 rumor。（验证：多跳矩阵及真实模型测试。）
- [x] 跨时间线 source、来源环、断链和无权来源均被拒绝且无写入。（验证：knowledge 故障注入。）
- [x] 公共快照、公开人物详情和日志不包含私有 canary。（验证：public API 测试和日志扫描。）

## AC4｜模型异常输出安全

- [x] 流式文本只有收到明确完成标志才被视为成功。（验证：LLM client 完成帧测试。）
- [x] 已收到部分文本后 EOF 被标记为 `truncated`，不形成完成回复。（验证：截断 SSE 测试和聊天历史查询。）
- [x] 无效 JSON、缺字段和错误类型被标记为稳定合同错误码。（验证：contracts 测试与真实 `contract_violation` 回执。）
- [x] 矛盾可信度或越权知识被知识链验证拒绝。（验证：知识合同测试。）
- [x] 业务越界动作被模型/业务合同拒绝。（验证：scene/engine 合同测试。）
- [x] 超时、取消和传输失败进入对应终态，不自动无限重试。（验证：受控 transport 测试与调用计数。）
- [x] 任何失败都不会产生完整消息、世界命令、事实、投影变化或错误知识升级。（验证：失败前后全账本快照。）
- [x] 每次模型尝试都有一条脱敏调用回执，状态和错误码正确，且无 prompt/output/canary。（验证：`llm_call_log` 查询与敏感值扫描。）

## AC5｜真实模型连续生活旅程（授权门）

- [x] 未显式提供授权变量时，真实模型脚本在调用前安全拒绝。（验证：无授权执行退出码 1、调用计数为 0。）
- [x] 脚本硬限制最多 8 次可能计费尝试且没有自动重试。（验证：静态检查与运行输出：4 次真实调用、上限 8、自动重试 0。）
- [x] 真实模型对无知识居民不泄露 canary，对有知识居民保留来源和 rumor 状态。（验证：本轮程序断言与人工复核全通过。）
- [x] 真实模型完成多个连续决策点，每项结果都能追溯到回执、上下文 hash、命令、事实和版本。（验证：隔离账本审计。）
- [x] 离开页面或停止客户端后世界继续推进，重新进入可恢复正确时间线和结果。（验证：登录态浏览器、pinger 与 fresh context 旅程。）
- [x] 真实模型返回无效结果时按 AC4 失败，后续新节拍可继续且不污染历史。（验证：真实 `failed/contract_violation`、历史不变及下一 beat completed。）
- [x] 真实模型收口脚本最终轮 8 次调用全部符合预期：7 completed、1 个预期合同失败、零自动重试，最终重放 complete/零差异。

## AC6｜普通聊天跨设备精确恢复

- [x] 首次发送原子创建一条 pending 请求和一条用户消息。（验证：本地/远端 Worker 在 provider 完成前查询 pending。）
- [x] 请求绑定用户、会话、人物、世界、时间线和内容摘要。（验证：请求表 schema、迁移和 recovery API 测试。）
- [x] 两 Worker 并发使用同一 ID/同载荷时只有一个模型调用。（验证：本地和 staging D1 双 Worker 脚本均只记 1 条回执。）
- [x] 同一 ID/不同载荷返回冲突且无新消息。（验证：本地/远端 Worker 返回 409，原请求账本不增行。）
- [x] 成功回复与 completed 状态原子提交，只出现一个预定 reply ID。（验证：本地/远端账本每个验收 request ID 各 1 user、1 person reply、1 receipt。）
- [x] 客户端 A 断开后，客户端 B 能查询 pending/completed/failed/cancelled 状态并恢复历史。（验证：两个独立浏览器 profile。）
- [x] 取消请求后旧 Worker 的迟到回复被数据库拒绝。（验证：本地双 Worker delayed provider，状态 cancelled、reply 0。）
- [x] 过期 pending 被回收为 failed，旧 Worker 不能提交，新尝试使用新 ID 后可以成功。（验证：本地双 Worker recovery 账本 failed、reply 0；新 ID 路由由 recovery API 测试覆盖。）
- [x] 断流、超时和失败保留真实用户消息，但不留下半截人物回复。（验证：刷新后的服务端历史。）
- [x] 已完成/失败/取消请求的同 ID replay 不再次调用模型。（验证：跨 Worker completed replay 和 provider 调用计数；终态 fencing 测试通过。）

## AC7｜权限、状态与预算全矩阵

- [x] 所有用户入口均出现在显式门禁清单中。（验证：矩阵枚举与路由清单对比。）
- [x] tick、director、schedule、beat、dialogue、injection、summary 均出现在内部入口矩阵中。（验证：`policy-matrix.test.ts`。）
- [x] 管理操作、恢复任务和时间线生命周期操作均出现在矩阵中。（验证：`policy-matrix.test.ts`。）
- [x] 匿名、跨用户、错世界和错时间线请求均被拒绝。（验证：逐入口 HTTP 状态与零副作用。）
- [x] paused、capped、archived、unassessed、upgradeable、incomplete 均按策略拒绝运行和写入。（验证：状态矩阵。）
- [x] 拒绝发生在模型调用和预算预留之前。（验证：provider 调用数与 `llm_call_log` 均为 0。）
- [x] 拒绝不会改变版本、命令、事实、投影、请求状态或预算账本。（验证：全账本前后快照。）
- [x] 世界预算和用户预世界预算在并发下原子封顶。（验证：并发 guard 测试。）
- [x] 不同用户、世界和时间线的预算及请求相互隔离。（验证：双 owner 矩阵。）
- [x] 安全冻结操作只改变控制状态，不创建 Universe 历史。（验证：pause/archive 前后命令/事实不变。）

## AC8｜旧结果与 SSE 传输隔离

- [x] 每个非心跳世界流帧含 world ID、timeline ID、stream ID、sequence 和 state version。（验证：API stream 测试。）
- [x] sequence 在单连接内严格递增，版本不倒退。（验证：连续帧断言。）
- [x] SSE parser 能处理任意分片边界和多个帧合并读取。（验证：纯 parser 测试。）
- [x] 切线后，旧订阅回调和旧快照不能更新当前页面。（验证：WorldView/timeline guard 测试。）
- [x] 旧帧已有半段进入缓冲时切线，释放剩余分片后仍被 generation guard 丢弃。（验证：传输延迟夹具及真实浏览器产品订阅观察。）
- [x] 旧聊天或场景请求最终完成时，只能在原世界、时间线和会话中查询到。（验证：延迟请求切线旅程。）
- [x] 当前 URL、时间线选择、版本、事件、人物和对话在旧结果到达后保持一致。（验证：浏览器状态记录和账本。）

## AC9｜兼容、迁移与完整旅程回归

- [x] 原全局 AC01、AC02、AC04、AC06、AC10–AC13、AC15 的既有回归继续运行；未关闭的原全局出口仍在 AC10 明确列为部分。（验证：全量测试与既有旅程脚本。）
- [x] 本地 `npm run verify:s01:legacy` 退出码 0。（验证：3 个隔离库；complete/upgradeable/incomplete 分类、1 项升级、incomplete 写入拒绝；unassessed/upgradeable 均 0。）
- [x] 本地 `npm run verify:s01:workers` 退出码 0。（验证：双 Worker chat/fork/tick/lease 与故障注入通过，临时 D1 清理。）
- [x] API 全量测试通过并记录文件数和用例数。（验证：45 文件/330 项。）
- [x] Web 全量测试通过并记录文件数和用例数。（验证：6 文件/20 项。）
- [x] API TypeScript build 通过。（验证：`npm --workspace api run build`。）
- [x] Web TypeScript/Vite build 通过。（验证：`npm --workspace web run build`。）
- [x] CREATE→RUN→OBSERVE→ENTER→ACT→CHAT→FORK→COMPARE→RETURN 登录态旅程完整通过。（验证：固定模型自动旅程和浏览器实走。）
- [x] 返回主线后可以继续推进和聊天，全部新 Universe evidence 为 complete。（验证：快照、请求和审计查询。）
- [x] 匿名 demo 仍只读，不能运行、聊天、Fork 或写入。（验证：浏览器控件和 public API 拒绝。）
- [x] [授权] staging D1 应用全部迁移且重复执行无待处理项。（验证：远端 ledger 22，重复检查 pending 0。）
- [x] [授权] staging 双 Worker 的分类、聊天恢复、Fork、tick 和故障旅程通过。（验证：双 Worker 与 Root→Child→Grandchild 远端脚本退出码 0。）

## 端到端场景

- [x] 场景 1：新用户创建世界并运行一天，离开后重新进入，完成聊天、行动、Fork、Compare 和返回；所有投影可独立重建且无审计差异。（验证：本地隔离浏览器 + API 账本。）
- [x] 场景 2：打开证据不完整的 legacy 世界，只能读取和 Compare；任何写入均明确拒绝且数据不变。（验证：浏览器 + API 前后快照。）
- [x] 场景 3：浏览器 A 发送普通聊天后断开，浏览器 B 恢复同一请求；最终仅一条用户消息、一条回复和一次模型调用。（验证：双 profile + D1 查询。）
- [x] 场景 4：聊天 pending 时取消/过期回收并释放迟到 Worker；请求为 cancelled/failed，历史无半截回复。（验证：双 Worker 故障夹具；新 ID API 回归。）
- [x] 场景 5：时间线 A 的 SSE 帧进入半包后切到 B；释放旧帧，页面仍完整属于 B，A 的结果只留在 A。（验证：传输延迟真实浏览器旅程。）
- [x] 场景 6：[授权] staging Root→Child→Grandchild 经过迁移、并发、取消和恢复后，审计通过且临时资源清理。（验证：远端账本与 cleanup。）
- [x] 场景 7：[授权] 真实模型多渠道知识与连续生活旅程在 8 次调用内全部通过。（六类渠道、真实无效合同、下一节拍恢复、回执与重放均通过。）

## 安全、隐私与环境清理

- [x] 本地验收只使用一次性 D1、合成账号和回环地址。（验证：脚本参数及输出；退出删除临时目录。）
- [x] 远端脚本只接受显式 staging/acceptance 名称和匹配数据库 ID。（验证：运行前配置/名称/ID guard。）
- [x] 真实模型脚本不打印 canary、prompt、原始响应、API key 或账号标识。（验证：本轮输出人工扫描，canary 显示为占位符。）
- [x] Git 差异中不存在凭据、远端配置、canary 或临时数据库文件。（验证：`git diff`、`git status --short` 和敏感模式扫描。）
- [x] 所有本地验收服务、临时目录、Worker 进程、请求和 lease 已清理。（验证：脚本终态查询和进程/目录检查；被忽略的开发 `.wrangler/state` 不进入提交。）
- [x] [授权] staging 清理后无 pending scene/chat、活动 synthetic timeline 或 live lease。（验证：只读审计 migrations=22、active=1/root、synthetic active=0、leases=0、pending scene/chat=0。）

> 最终说明：T49–T52 已补齐独立重建、完整状态/管理矩阵、真实浏览器 SSE 半帧和真实模型多渠道失败恢复。本次真实模型授权窗口累计使用 24/50 次；最终通过轮为 8 次，零自动重试。

## AC10｜S01 全局出口

- [x] 收口 AC1–AC9 的每一项都有实际命令、结果或浏览器证据，不以“应该通过”代替执行。（验证：本 Checklist 与审计逐项交叉引用。）
- [x] 原全局 AC01–AC15 在 `world-quality-report.md` 中全部为“通过”（AC09 为“通过（安全保留）”）。（验证：状态表无“部分/未通过/未知”。）
- [x] `spec.md`、`plan.md`、`task.md`、`checklist.md`、审计和质量报告对范围与状态描述一致。（验证：文档交叉检查。）
- [x] `git diff --check` 通过，最终工作区归属已审计并创建 S01 逻辑提交。（验证：T48。）
- [x] 未执行或未授权的远端/真实模型条目不会被标记为通过。（验证：T44/T46/T52 授权与执行证据。）
- [x] 只有本 Checklist 全部必需项通过后，S01 才标记为完成。（验证：无未勾选必需项。）
