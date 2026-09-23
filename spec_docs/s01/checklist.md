# s01 P1 验收清单

本清单用于验收 `spec_docs/s01/spec.md` 定义的 P1 范围。所有验证均在隔离的本地 D1 和多个 Worker 上执行；每一项都需要记录可复核的命令、结果或证据。P0 遗留数据若无法确定，必须明确标记为 legacy/unknown，不得推测补齐。

## 投影重建与完整性

- [x] 从固定夹具独立创建两次相同的结构化世界，两次得到一致的起点、居民、时间线和日程描述；过程不调用真实模型或外部服务。（证据：`npm --workspace api run test -- src/test/product-journey.test.ts`；固定时钟下两次 API 创建对比基线，2/2 通过。）
- [x] 对 Root 基线和 Fork 检查点重放后，核对时钟、状态、日程、事件、承诺、记忆、对话、逐句发言、访客留言及知识可见集合等投影域均与预期一致。（证据：`npm --workspace api run test`；`world-state/invariants.test.ts`、`world-state/rebuild.test.ts`、`life/compare.test.ts` 和完整旅程回归均通过。）
- [x] 在一次性测试副本中分别注入缺失记录、被修改记录和孤立记录，重建报告准确指出 timeline、领域、记录 ID 及命令/版本来源，原始数据保持不变。（证据：`world-state/rebuild.test.ts` 和 `world-state/invariants.test.ts` 故障注入通过；全表快照断言只读性，诊断保留域、命令及版本。）
- [x] 验证 Root、Child、Grandchild 的历史截止点及隔离规则；无法可靠重建的旧历史明确显示为 legacy/unknown。（证据：`npm --workspace api run test -- src/test/world-journey.test.ts -t "structured full-day journey"`；三层审计通过，分叉后变更不泄漏；旧基线重建状态为 incomplete。）

## 连续运行与故障恢复

- [x] 使用加速测试时钟连续推进至少一个完整模拟日，跨越多个日程边界；每个 tick 的版本、事实和状态连续，日程触发次数符合预期，最终审计通过。（证据：`engine/tick.test.ts` 与 `world-journey.test.ts` 各用 16 个 tick 推进 24 小时；逐拍 revision 与审计通过。）
- [x] 相同请求 ID 和相同载荷的重试只产生一次事实与一次版本推进；相同请求 ID 携带不同载荷或版本时被拒绝；注入中途写入失败不会留下部分事实或时钟变化。（证据：`world-state/commit.test.ts` 与 `product-journey.test.ts` 幂等、冲突、故障回滚用例通过。）
- [x] 对取消、断连、超时和过期请求查询最终状态；不得留下部分投影，使用原请求 ID 重试不得重复调用模型或重复产生副作用，过期 Worker 的迟到提交被拒绝。（证据：`scene/intent.test.ts` 取消/断流和同 ID 重试、`scene/recovery.test.ts` 过期请求、`llm/client.test.ts` 正文超时及 `tick-lease.test.ts` fencing 均通过。）
- [x] 两个独立 Worker 同时操作同一个隔离 D1 时至多有一个有效 tick 副作用；最终时钟、版本、事实和投影一致，过期版本的提交不会生效。（证据：`npm run verify:s01:workers`：Worker 状态 200/409，共享 D1 一条 clock fact、revision=2、租约归零。）

## 权限、Fork 与隔离

- [x] 对未授权用户、World/timeline 不匹配、暂停或归档状态、调用上限以及公开只读路径的写入请求均予以拒绝，且数据库没有副作用。（证据：全量 API 测试中的 `legacy-compat.test.ts`、`public/routes.test.ts`、`world-state/commit.test.ts` 和 `life/compare.test.ts` 拒绝矩阵通过。）
- [x] Fork 在多层历史中覆盖成功、同请求重放、载荷冲突、条件不满足和并发竞争；不得创建重复子节点，Root、Child、Grandchild 的状态、承诺、记忆、知识、对话和事件保持隔离。（证据：`life/compare.test.ts` Fork 场景矩阵、嵌套 checkpoint 测试及 `world-journey.test.ts` 三层端到端审计通过。）
- [x] 从真实 API 写入路径验证基线/检查点、命令或事实、版本和投影在成功时完整一致，在事务失败时整体回滚。（证据：`product-journey.test.ts` API 创建/写入旅程及不可变基线插入故障回滚用例通过。）

## 集成与端到端

- [x] 执行 API TypeScript 构建且无错误。（证据：`npm --workspace api run build`，退出码 0。）
- [x] 执行 API 全量测试且全部通过。（证据：`npm --workspace api run test`，31 个测试文件、214 个测试通过，退出码 0。）
- [x] 执行隔离多 Worker 验收流程，确认临时 D1 路径实际位于临时目录、所有 Worker 使用同一隔离数据目录、清理目标仅限该目录，并且禁用 Wrangler 指标发送；不得触及默认或远程 D1。（证据：`npm run verify:s01:workers`，两 Worker 共用唯一 `/tmp` D1，`WRANGLER_SEND_METRICS=false`，只用 `--local`，运行后目录/进程清理，退出码 0。）
- [x] 完成至少一条端到端旅程：创建 World 及多层 Fork，推进完整模拟日，审计 Root 与所有后代，再修改 Child 并复审；Root 历史不变，Child 仅包含其自身历史和事件。（证据：`world-journey.test.ts` 固定 API 旅程推进 24 小时，Root/Child/Grandchild 审计通过，子线写入后 Root 快照相同。）

## P1 出口

- [x] 汇总 AC1–AC12 的逐项证据、失败与遗留项；每项有明确通过/失败/legacy/unknown 结论，任何未通过的验收条件都不能报告为完成。（证据：`docs/current-state-audit.md` 的 AC1–AC12 表与 legacy/unknown 范围说明。）
- [x] 确认验收仅运行于本地隔离环境，没有部署、远程/生产迁移或真实模型质量测试。（证据：多 Worker 脚本固定 `--local` 和本轮 `/tmp` 路径；连续旅程使用固定本地模型替身；无部署或远端命令。）
