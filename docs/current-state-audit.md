# s01 P1 开发起点与验收证据

## 开发起点

| 项目 | 记录 |
|---|---|
| HEAD | `5c81c76c6b47a7b631cfc3ae2ba6643bad713510` |
| 分支 | `main` |
| P1 开始时工作区状态 | `git status --short` 共 106 项：已跟踪修改、删除和未跟踪文件均存在；范围包括 API、web、迁移、文档及测试。 |
| 归属约定 | 上述代码、迁移、测试和报告均视为 P1 本轮开始前已经存在的工作区内容。本审计记录其存在及缺口，不将它们记为本轮新实现。 |
| 本轮验证状态 | 截至起点盘点，未运行构建、测试或 Worker 验收；源码存在不等于验收通过。 |

起点通过 `git rev-parse HEAD`、`git branch --show-current` 和 `git status --short` 记录。修改前工作区已非干净状态；之后只对明确列入本阶段的文件进行增量修改，不清理或重置既有改动。

## P1 现有实现和证据缺口

| 需求 / 验收项 | 起点已有内容 | 仍需补齐或复核 |
|---|---|---|
| F1、AC1–AC3：结构化基线、投影重建与只读审计 | `api/src/world-state/model.ts` 已有固定模型解析；`api/src/world-state/invariants.ts` 已包含时钟、状态、事件、承诺、记忆、对话、留言和日程的内嵌重建/差异校验；`api/src/world-state/invariants.test.ts` 有基线与多域异常用例；`api/src/test/product-journey.test.ts` 有基线写入失败回滚用例。 | 尚无独立 `rebuild.ts` 证据收集、纯 reducer 和统一差异结果；逐域完整性、缺失/篡改/无来源诊断及审计前后数据库快照需补齐。AC1 两次真实创建的结构化基线与固定日程描述也需核验。 |
| F2、F7、AC4、AC10–AC11：Fork checkpoint 与继承隔离 | `api/src/agent/visibility.ts` 有 Fork 快照及祖先 cutoff；`api/src/life/fork.ts` 已捕获继承状态；`api/src/life/compare.test.ts` 已有多级知识、承诺、记忆、事件、日程和并发 Fork 覆盖；`api/src/world-state/invariants.test.ts` 有 checkpoint 审计用例。 | checkpoint 完整域、访客留言以及孙线基于子线不可变 checkpoint 的重建一致性尚无统一重建器验证；需检查缺字段旧 checkpoint 的显式不完整结果。 |
| F3、AC5、AC11：至少一整天连续旅程 | `api/src/engine/tick.test.ts` 已覆盖 fake timers、加速时钟、日程边界和重复触发；`api/src/test/world-journey.test.ts` 有固定夹具及无需 LLM 的旅程。 | 当前已读到的 tick 旅程为有限拍数，尚未证明覆盖至少 24 小时模拟时间、逐拍重建审计及完整端到端 Fork 旅程。 |
| F4、AC6：幂等、冲突与原子回滚 | `api/src/world-state/commit.test.ts` 已包含相同 ID 重放、载荷/版本冲突、事务故障和多域原子写入用例。 | 需在本轮规定的测试集和完整重建器接入后复核所有受管理投影与时钟均无部分提交。 |
| F5、AC7：取消、恢复与迟到提交 | `api/src/scene/recovery.test.ts` 已覆盖崩溃预留恢复及过期 worker 提交限制；`api/src/engine/tick-lease.test.ts` 有 lease 过期和 fencing 用例。 | 需补齐或核实取消、断流、超时各自的请求最终状态查询，以及相同请求 ID 恢复时不重复调用和副作用的证据。 |
| F6、AC8：共享本地 D1 的多 Worker 并发 | `api/src/engine/tick-lease.ts` 和 `api/src/engine/tick-lease.test.ts` 已有租约实现与数据库级测试；tick 测试有同进程重叠请求覆盖。 | 未发现 `scripts/verify-s01-workers.ts` 或 `verify:s01:workers` 命令；尚无两个独立 Worker 共享同一隔离持久化 D1 的实测证据。 |
| F6、F7、AC9：权限、状态与公开只读边界 | `api/src/world-state/commit.test.ts`、`api/src/test/legacy-compat.test.ts`、`api/src/public/routes.test.ts` 和 `api/src/life/compare.test.ts` 已有归属、暂停/归档、公开写入及 Fork 限制用例。 | 需用完整回归复核所有拒绝均不更改版本、事实、投影、时钟或子线集合。 |
| N1–N6、AC12：隔离环境和阶段证据 | 已有 `docs/world-quality-report.md` 描述质量阶段目标；项目有现存测试和本地数据库配置。 | 尚无本阶段命令、环境、结果与证据的验收记录；隔离目录的安全创建、清理及禁用 metrics 需要专用 Worker 验收脚本。所有 legacy/unknown 范围必须显式记录，AC 未全部通过前不得关闭 P1。 |

## P1 实施与验收证据

以下均为本轮实际执行结果。起点工作区已有的实现不记为本轮新增成果；它们只有在本轮回归命令覆盖并通过后，才作为当前行为的验收证据。

| AC | 结果 | 本轮证据 |
|---|---|---|
| AC1 | 通过 | `npm --workspace api run test -- src/test/product-journey.test.ts`：固定测试时钟下两次经 API 创建相同结构化世界，比较基线、居民、位置和完整域描述；2/2 通过。全量测试再次覆盖。 |
| AC2 | 通过 | `npm --workspace api run test`：31 个测试文件、214 个测试通过。`world-state/invariants.test.ts`、`world-state/rebuild.test.ts`、`product-journey.test.ts` 覆盖状态、日程、事件、承诺、记忆、对话/轮次、留言、知识证据和比较结果。 |
| AC3 | 通过 | `rebuild.test.ts` 验证基线投影篡改可定位到域、基线命令和版本，且收集/审计前后源表快照不变；既有不变量故障注入覆盖其他投影类别。全量 API 测试通过。 |
| AC4 | 通过 | `npm --workspace api run test -- src/test/world-journey.test.ts -t "structured full-day journey"`：Root→Child→Grandchild 重建审计通过；分叉后的 Root 事实不进入 Child，Child 分叉后的变化不进入 Grandchild。`life/compare.test.ts` 的多层 checkpoint 回归也通过。 |
| AC5 | 通过 | `engine/tick.test.ts` 和 `world-journey.test.ts` 使用测试时钟每 15 秒推进 90 分钟，共 16 个 tick；模拟时间至少前进 24 小时，每拍检查 revision 和完整审计，并覆盖多个日程边界。无需等待墙上时间一天。 |
| AC6 | 通过 | 全量 API 测试覆盖 `world-state/commit.test.ts`：重复请求、载荷冲突、版本冲突和事务故障回滚；214 个测试全部通过。 |
| AC7 | 通过 | 全量 API 测试覆盖 `scene/intent.test.ts` 的取消/断流、请求状态查询和相同 ID 重试，以及 `scene/recovery.test.ts`、`engine/tick-lease.test.ts` 的过期恢复和迟到提交拒绝。 |
| AC8 | 通过 | `npm run verify:s01:workers`：Wrangler 4.126.0，本地隔离 D1，两个独立 Worker 共用 `/tmp/possibility-s01-Z0F8tJ/d1`；租约 Worker 200、竞争 Worker 409；共享库恰有 1 条 clock fact、revision=2、active lease=0。执行后目录与进程均清理。 |
| AC9 | 通过 | 全量 API 测试覆盖 `legacy-compat.test.ts`、`public/routes.test.ts`、`world-state/commit.test.ts` 与 `life/compare.test.ts` 的跨用户、错配范围、暂停/归档、额度及公开写入拒绝，检查无部分写入。 |
| AC10 | 通过 | 全量 API 测试覆盖多级 Fork 成功、重复、冲突、拒绝、竞争及隔离；本轮新增三层访客留言 checkpoint 测试和完整日 Root/Child/Grandchild 重建旅程。 |
| AC11 | 通过 | `world-journey.test.ts` 通过真实 API 创建结构化世界、16 个加速 tick、Root 审计、Fork、Root 后续变化、Child 独立变化、Grandchild Fork 和三线复审。子线变化后 Root 投影/事实保持不变。 |
| AC12 | 通过 | 本报告列出 AC1–AC12 的环境、命令和结果；本轮没有远程数据库、生产迁移、部署或真实模型验收。缺少结构化基线的 legacy 线由 `rebuildProjection` 返回 `incomplete`，未知动作返回 `unsupported`。 |

### 最终命令结果

- `npm --workspace api run test`：31 个测试文件、214 个测试通过，退出码 0。
- `npm --workspace api run build`：TypeScript 检查通过，退出码 0。
- `npm run verify:s01:workers`：退出码 0；本地迁移、种子、双 Worker 竞争及清理全部完成。`WRANGLER_SEND_METRICS=false`，所有 Wrangler D1/Worker 命令显式使用 `--local` 与本轮临时 `--persist-to`。
- `git diff --check`：通过。

legacy/unknown 的覆盖范围：无结构化根线基线的旧时间线和缺少完整域记录的旧 Fork checkpoint 保持不完整，不根据可变行或叙述文本补造历史；未支持的 command action 明确报告 unsupported。P1 出口所需 AC1–AC12 均有通过证据。
