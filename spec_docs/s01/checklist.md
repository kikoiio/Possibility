# s01｜P3 Fork 与 Compare 验收清单

> 依据：[spec.md](./spec.md)、[plan.md](./plan.md) 与 [task.md](./task.md)。本清单在开发前审批；执行时填写实际状态和证据。所有自动验证只使用一次性隔离本地 D1、固定时钟/模型替身及合成账号，不连接项目默认库、远端 D1 或部署服务。

> P3 执行结果：AC1–AC5 通过，AC6 报告完整。双 Worker readiness 与并发 Fork 脚本通过；API 定向回归 33/33；API 与 Web build 通过；Compare 登录态本地浏览器走查通过。详细的 HTTP 结果、D1 账本、用户可见文案和遗留边界见 [`docs/current-state-audit.md`](../../docs/current-state-audit.md) 的“P3 实施与验收证据”。

## AC1｜多 Worker Fork 并发

- [x] 两个独立 Worker 进程已启动并连接同一个一次性本地 D1；临时持久化目录位于系统临时目录。（验证：运行 `npm run verify:s01:workers -- --readiness-only`，记录两个 Worker 与数据库目录。N1、N3）
- [x] 两个 Worker 对同一活动源线并发创建不同子线时，每个成功子线的 checkpoint、revision 0、状态副本和源版本均一致且完整。（验证：运行 `npm run verify:s01:workers`，检查请求结果和 D1 子线/checkpoint/revision 查询。F1）
- [x] 两个 Worker 以同一 request ID 和相同载荷重试时返回同一子线，不创建第二条时间线；同 ID 不同载荷返回冲突且没有新增写入。（验证：并发脚本检查 HTTP 响应、timeline 行数与源 revision。F1）
- [x] Fork 与源线版本化写入竞争时，子线只对应有效完整源快照，或请求明确冲突；活动时间线达到上限后的请求被拒绝。（验证：脚本记录竞争请求状态，并比较源/子线版本及 active timeline 数量。F1、F6）
- [x] Fork 初始投影写入失败会整体回滚，不留下 timeline、revision、命令、事实或部分投影。（验证：在隔离 D1 注入失败，比较事务前后关键表快照。F1、F6）
- [x] 并发场景可重复运行；每轮结束 revision 连续、来源边界正确且没有遗留 lease/临时进程。（验证：重复执行脚本并查询最终 D1 状态，确认退出清理。N1、N3）

## AC2｜多级记忆、承诺与知识隔离

- [x] Fork 前存在的合格记忆和开放承诺会进入 Child 的不可变 checkpoint/投影。（验证：Root→Child 固定旅程逐条比较来源 ID/内容及子线投影。F2）
- [x] Child 创建后才写入 Root 的记忆、承诺与知识不会渗入既有 Child；Child 在创建 Grandchild 前新增的合格记录只按 Grandchild 的 checkpoint 边界继承。（验证：Root→Child→Grandchild 矩阵逐条核对各线可见集合。F2）
- [x] Child、Grandchild 或旁支创建后的本线写入不反向改变祖先、既有后代或旁支中的记忆、承诺与知识。（验证：写入前后比较所有相关 timeline 快照和可见记录。F2）
- [x] 知识保留接收者、来源事实和 certainty；不相关居民及不具备该 checkpoint 的时间线不可见，legacy 缺证据时显示未知/不完整。（验证：调用各接收者上下文/可见性读取并检查来源字段，不为旧线补造历史。F2、N5、N6）
- [x] 多级旅程通过只读世界审计，没有未解释的 checkpoint/投影差异。（验证：对 Root、Child、Grandchild 分别运行 `auditUniverse` 并记录结果。F2、N5）

## AC3｜消息送达与接收者获知

- [x] 子线消息提交产生属于该时间线的版本化来源事实；提交结果能定位来源事实 ID、版本和 certainty。（验证：运行 `npm --workspace api run test -- src/test/world-journey.test.ts`，核对 command/fact 与时间线。F3）
- [x] 接收者后续决策上下文包含该消息和正确来源/certainty；其他居民、Root 与旁支上下文不包含该消息。（验证：固定模型旅程分别构造对应上下文并比较 `knownFacts`。F3）
- [x] 用户可见结果文案区分消息已提交/已进入接收者知识与居民实际阅读、相信或采取行动；不承诺居民必然回应。（验证：本地登录态浏览器提交消息并记录显示文案。F3、N4）
- [x] 消息旅程的只读审计通过，未在源线或其他时间线产生泄漏投影。（验证：`auditUniverse` 及 Root/Child/旁支状态前后快照。F3、N5）

## AC4｜Compare 登录态界面走查

- [x] 结构化 Fork 对照清楚展示分叉条件、共同过去、双方状态/事实/事件差异及证据来源、版本和时间。（验证：本地合成账号打开 Compare，逐项记录页面实际显示。F4）
- [x] 两线模拟时刻不一致时，界面明确提示时刻差异，不把不同时间点的状态当成同刻结果。（验证：选择不同模拟时刻的两线并记录提示。F4、F5）
- [x] 缺少完整 checkpoint 的 legacy Fork 明确显示历史不完整；没有从可变祖先数据补造共同过去。（验证：加载 legacy fixture，在 Compare 与共同事件区核对提示/记录。F4）
- [x] Compare 文案只描述观察到的差异，不声称确定因果、预测或实验结论。（验证：走查标题、提示、差异说明及限制文案。F5）
- [x] 关闭对照并返回选定时间线后，页面、时钟和增量内容属于当前所选线，没有残留另一线的旧状态。（验证：浏览器在两条线之间往返并检查活动 timeline 与页面内容。F5）

## AC5｜权限、冲突和失败无副作用

- [x] 跨用户及错配世界/时间线的 Fork 和 Compare 请求被拒绝，不泄露他人时间线数据。（验证：运行 `npm --workspace api run test -- src/life/compare.test.ts`，检查拒绝状态和响应内容。F6、N6）
- [x] 归档/不可用源线、过期源版本、活动线容量冲突和同 ID 不同载荷冲突被明确拒绝。（验证：API 路由测试与多 Worker 脚本记录响应状态。F1、F6）
- [x] 所有拒绝、冲突及注入事务故障前后，源/目标 revision、命令、事实、投影和 active timeline 集合均无额外变化。（验证：比较数据库关键表快照；Compare 读取前后数据不变。F6、N5）
- [x] Compare 只返回当前账号拥有的世界和请求中的两条有效时间线证据。（验证：跨用户/跨世界读取回归，确认没有未授权字段。F6、N6）

## 自动化回归与构建

- [x] 多 Worker 并发 Fork 场景通过，且报告包含本地 D1、Worker 数、每类请求结果和最终账本状态。（验证：`npm run verify:s01:workers`）
- [x] Fork/Compare 多级隔离、权限和失败回滚回归通过。（验证：`npm --workspace api run test -- src/life/compare.test.ts`）
- [x] 消息来源到接收者后续上下文旅程通过。（验证：`npm --workspace api run test -- src/test/world-journey.test.ts`）
- [x] API 与 Web 构建通过。（验证：`npm --workspace api run build` 与 `npm --workspace web run build`）
- [x] 自动化仅访问一次性本地 D1，固定模型替身未连接真实模型；验收后进程与临时数据库均清理。（验证：验收脚本环境输出、进程列表与临时目录检查）

## 端到端场景

- [x] Root 在分叉前形成记忆、承诺和知识 → 创建 Child → Child 创建后 Root 再写入 → Child 写入并创建 Grandchild → 各线按 checkpoint 展示应继承/隔离的内容，三线审计通过。（验证：固定 API 小世界旅程和逐线只读审计；关联 AC2）
- [x] Child 中向居民传话 → 查看成功提交和来源证据 → 构造接收者后续上下文确认可见 → 检查 Root、其他居民和旁支不可见 → Compare 展示两线观察差异且不声称居民已采取行动。（验证：固定模型 API 旅程加登录态本地浏览器记录；关联 AC3–AC4）
- [x] 两个 Worker 同源线竞争 Fork/源版本更新 → 接受一个或多个完整有效结果、明确拒绝冲突结果 → 数据库没有半成品且审计通过。（验证：隔离多 Worker 脚本和最终 D1 查询；关联 AC1、AC5）

## P3 出口（AC6）

- [x] AC1–AC5 每项都有命令、隔离环境、实际结果与可复核证据；UI 人工走查与自动结果分开记录。（验证：本 checklist、`docs/current-state-audit.md` 和 `docs/world-quality-report.md` 交叉核对）
- [x] legacy/unknown 范围和未通过项均明确保留；只有 AC1–AC5 全部通过且证据完整时，报告才标记 S01 P3 出口通过。（验证：审阅阶段报告和当前 checklist 状态）
