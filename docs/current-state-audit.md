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

## P2 开发起点与既有覆盖

| 项目 | 记录 |
|---|---|
| HEAD | `6a642f0f0722b7020d13afbfe5d2d14b86704f5e` |
| 分支 | `main` |
| P2 盘点时工作区 | 仅 `spec_docs/s01/spec.md`、`plan.md`、`task.md`、`checklist.md` 四份本轮规格文档为修改状态；产品实现代码无未提交改动。 |
| 归属约定 | 上述规格文档编辑不计入 P2 实现成果；P2 实现从该代码 HEAD 起核算。 |

T01 盘点确认现有实现和证据位置如下。盘点来源包括当前源码、现存测试及截至 2026-09-23 的 `docs/world-quality-report.md`；此表是起点清点，不代替本阶段重新执行的验收命令。

| P2 验收范围 | 起点已有覆盖 | 本阶段仍须提供的证据 |
|---|---|---|
| AC1–AC2：身份、进入、受限提议与确认 | `scene/intent.test.ts` 已覆盖未进入拒绝、move 提议不写入、越权解析澄清、确认后相同 command ID 重放；scene 路由经版本化命令提交。 | 补齐/复核 inform 提议、旧 expectedVersion、无效地点/接收者及确认失败的完整副作用快照；登录态 UI 确认过期提议失效。 |
| AC3：交谈事务与资格 | `world-journey.test.ts` 有睡眠/忙碌传话拒绝；`scene/recovery.test.ts` 有取消、请求失败及迟到提交边界；交谈代码以 conversation command 提交发言、记忆/留言和请求状态。 | 在本阶段定向运行并核对成功交谈所有投影同请求/时间线，且故障注入失败不留半成品。 |
| AC4、AC7：幂等与恢复 | `scene/intent.test.ts` 覆盖同命令 ID 丢响应后重放；`scene/recovery.test.ts` 覆盖 pending 回收及旧 worker fencing；`ScenePanel` 已用 sessionStorage 和 status/history API 恢复交谈。 | 补齐/复核状态矩阵、同 ID 不同载荷、刷新/断流的登录态浏览器实走证据，以及恢复后不重复调用/写入。 |
| AC5：后续推进读取在场证据 | `world-journey.test.ts` 已验证口信成为 rumor、接收者 `EngineContext` 有来源 fact、固定模型 `runTick` 产生版本化居民变化并通过审计。 | 本阶段重跑现有旅程或补最小缺口测试，记录实际命令和来源→结果链证据。 |
| AC6：明确接受约定 | `world-journey.test.ts`/场景路由既有覆盖已测试明确邀请接受、婉拒、无邀请时过滤误接受及原子提交；约定状态转换有规则测试。 | 复核时间线来源、后续履约/到期结果与审计，确认无邀请/接受不产生 accepted commitment。 |
| AC8：权限及状态边界 | `legacy-compat.test.ts`、`public/routes.test.ts`、`world-state/commit.test.ts` 和场景资格测试覆盖归属、公开只读、暂停/归档、预算及忙碌/睡眠边界。 | 按 P2 实际入口重跑关联定向测试，证明每类拒绝均无版本、事实、投影或请求副作用。 |
| AC9：阶段记录与隔离 | P1 已记录隔离 D1 与确定性测试约定。 | P2 每项需补本阶段命令、实际结果及登录态浏览器证据；无证明项保留未通过/未知，不能仅依据 P1 报告关闭 P2。 |

## P2 实施与验收证据

本轮从上表记录的 `6a642f0f0722b7020d13afbfe5d2d14b86704f5e` 开始。初轮补充了 intent 测试；浏览器 SSE 断流复核发现模型连续失败时服务端会把来访者单句误标为 completed。现已修复 `api/src/scene/routes.ts`：没有任何居民回应时，请求转为 failed，整批暂存 turns、记忆和留言不提交。

| AC | 结果 | 本轮证据 |
|---|---|---|
| AC1 | 通过 | `npm --workspace api run test -- src/scene/intent.test.ts`：12/12 通过，覆盖未进入拒绝、有效进入/移动，以及非法和过期请求无额外命令/事实；登录态浏览器在雾影庄的活动主线完成进入大厅和合法移动至图书室。 |
| AC2 | 通过 | 同一 intent 定向测试新增逐字传话提议、缺席接收者澄清、版本过期确认拒绝和同 ID 不同移动载荷冲突；浏览器固定替身生成“前往大厅”提议并显式确认成功，另以 v10 提议后推进世界版本，再确认时界面移除旧提议并提示重新描述。 |
| AC3 | 通过 | `commit.test.ts` 35/35 与 `recovery.test.ts` 2/2 覆盖对话/turn、记忆/留言、事件、约定和请求完成的原子提交与故障回滚。新增 `intent.test.ts` 回归：固定替身连续两次返回无效居民回应时，请求为 failed，conversation command、来访者 turn 和私有副作用均未写入，审计无差异。 |
| AC4 | 通过 | `intent.test.ts` 与 `recovery.test.ts` 的请求重放、载荷冲突、过期版本、完成请求恢复及旧 worker fencing 用例通过；完成对话重开/刷新只恢复现存历史，没有再次发言。 |
| AC5 | 通过 | `npm --workspace api run test -- src/test/world-journey.test.ts`：5/5 通过。固定模型推进读取带 source fact ID/certainty 的口信证据，提交可追溯的新版本居民结果，`auditUniverse` 无差异。 |
| AC6 | 通过 | `commit.test.ts` 与 world journey 覆盖明确邀请/接受、婉拒、无邀请时不采纳模型误报、同事务约定提交及后续履约/到期版本事实；审计通过。 |
| AC7 | 通过 | 本地登录态浏览器完成进入→移动→交谈→刷新/重开面板恢复已完成历史；SSE 请求保持 pending 时刷新/关闭/重开，界面保留原输入并提示复用同一请求 ID。将隔离 D1 中该请求 heartbeat 置旧以模拟 worker 中断，再开面板触发状态查询/回收，显示“上一次尝试未写入世界；可以重新发送”。最终请求 failed；断流请求没有新增 command、turn、memory 或 message。 |
| AC8 | 通过 | `npm --workspace api run test -- src/test/legacy-compat.test.ts src/public/routes.test.ts`：10/10 通过；`commit.test.ts` 35/35 及 scene/recovery 用例另覆盖错配归属、公开只读、暂停/归档、忙碌/睡眠和预算拒绝及无部分写入。 |
| AC9 | 通过 | `intent.test.ts`、`recovery.test.ts`、`world-journey.test.ts`：3 个文件、19/19 通过；commit 35/35、legacy/public 10/10；API 与 Web build 均通过。浏览器使用一次性本地 D1 `/tmp/possibility-s01p2-browser`、API `127.0.0.1:8787`、Web `127.0.0.1:5173`、模型替身 `127.0.0.1:8788` 和合成账号；仅调用本地引擎，无真实模型或远端服务。验收后停止服务并清理临时库与替身脚本。 |

浏览器补充观察：确定性替身用于正常交谈；断流旅程将居民完成请求保持挂起，检查刷新/重开后复用同一请求，再模拟过期 heartbeat 触发失败回收。此过程暴露 visitor-only completed 缺陷，修复后以失败响应回归断言无半成品提交。为按同刻位置规则执行移动，另手动触发本地世界节拍。替身不实现 schedule 所需的 `items` 输出，因此该隔离世界的 schedule 决策被跳过；AC5 后续世界影响来自 `world-journey.test.ts`。浏览器开发者控制台无错误。

### 本轮最终命令结果

| 命令 | 结果 |
|---|---|
| `npm --workspace api run test -- src/scene/intent.test.ts` | 12/12 通过。 |
| `npm --workspace api run test -- src/world-state/commit.test.ts` | 35/35 通过。 |
| `npm --workspace api run test -- src/scene/recovery.test.ts` | 2/2 通过。 |
| `npm --workspace api run test -- src/test/world-journey.test.ts` | 5/5 通过。 |
| `npm --workspace api run test -- src/test/legacy-compat.test.ts src/public/routes.test.ts` | 10/10 通过。 |
| `npm --workspace api run test -- src/scene/intent.test.ts src/scene/recovery.test.ts src/test/world-journey.test.ts` | 19/19 通过。 |
| `npm --workspace api run build` | 通过。 |
| `npm --workspace web run build` | 通过。 |

## P3 开发起点与既有覆盖

### 开发起点

| 项目 | 记录 |
|---|---|
| HEAD | `6a642f0f0722b7020d13afbfe5d2d14b86704f5e` |
| 分支 | `main` |
| P3 开始时工作区 | `api/src/scene/intent.test.ts`、`api/src/scene/routes.ts`、`docs/current-state-audit.md`、`docs/world-quality-report.md` 和 `spec_docs/s01/{spec,plan,task,checklist}.md` 已处于修改状态。前四项中的 API 与报告修改在 P3 开始前已存在；四份 S01 文档由本轮按用户要求重写并逐份审批。 |
| 归属约定 | 已有 API 和报告差异不记为 P3 新实现；P3 实现成果从上述 HEAD 起核算。所有已有差异保留，不重置、不覆盖。 |
| 本轮起点验证 | 通过 `git rev-parse HEAD`、`git branch --show-current`、`git status --short` 记录。T01 为只读盘点，尚未运行 P3 测试或改动产品代码。 |

### AC1–AC6 既有覆盖与剩余证据

| P3 范围 | 起点已有实现/证据 | P3 仍需补齐的证据 |
|---|---|---|
| AC1：多 Worker Fork 并发 | `scripts/verify-s01-workers.ts` 已在同一隔离本地 D1 上启动两个独立 Worker，并覆盖 tick lease 竞争；`api/src/life/compare.test.ts` 已覆盖 Fork 请求重放、数据库活动线数限制、模拟容量竞争、源 revision 前进后的快照拒绝及子线投影事务回滚。 | Worker 脚本尚未对真实 Fork API 执行跨进程竞争；需要覆盖 Fork 同 ID/同载荷幂等、同 ID/不同载荷冲突、Fork 与源写入竞争，并核对最终 revision、checkpoint、子线数量和副作用。现有模拟触发器不等同于多 Worker 实测。 |
| AC2：Root→Child→Grandchild 隔离矩阵 | `compare.test.ts` 已分别覆盖结构化事实/knowledge、accepted commitment、记忆/事件/发言及访客留言的多级 cutoff；`world-journey.test.ts` 也含 Child/Root 后续变化隔离旅程。 | 需把记忆、承诺、知识放入同一可复核组合矩阵，逐个记录 Fork 前继承、祖先 Fork 后新增不下渗、Child Fork 前新增可继承、分支写入不反向污染，并对三线运行只读审计。 |
| AC3：消息送达与获知 | `world-journey.test.ts` 有子线传话隔离旅程，且有接收者后续决策上下文读取带来源/certainty 知识并产生版本化结果的用例；在场提交已有睡眠/忙碌资格拒绝回归。 | 需用一条完整 P3 旅程串起消息提交、接收者上下文、其他居民/Root/旁支不可见及来源审计，并通过登录态页面检查结果提示不夸大为居民已阅读或必然行动。 |
| AC4：Compare 登录态走查 | `compare.ts`/`ComparePanel.tsx` 已返回并呈现共同 Fork 来源、分叉条件、版本/时刻、差异证据、历史完整度及限制说明；API 测试覆盖结构化和 legacy Fork。 | 尚无本阶段登录态浏览器走查记录，需检查正常对照、不同模拟时间、legacy 不完整提示、因果边界文案和返回所选时间线后的状态隔离。 |
| AC5：权限和失败无副作用 | `compare.test.ts` 已覆盖 Compare owner-only、跨世界/用户读取拒绝、Fork 跨用户/跨世界拒绝、重放冲突、活动线数上限、源状态变化和子线复制事务回滚。 | 需将 P3 并发竞争、失效/归档源及事务故障与版本、命令、事实、投影、active timeline 前后快照结合复核；逐项记录 Compare 读取只返回授权线证据。 |
| AC6：P3 出口报告 | 质量报告已有 P3 阶段摘要和缺口概述。 | 需要更新本审计、质量报告和 checklist，记录实际命令、隔离环境、浏览器观察、失败/unknown 范围；AC1–AC5 未全部通过时不得标记 P3 出口通过。 |

以上矩阵记录 P3 开始时的静态盘点，不代表起点已有测试在 P3 本轮通过。实际执行证据如下；所有 Worker 竞争均限定在一次性本地 D1，没有访问远端或生产环境。

### P3 实施与验收证据

| AC | 结果 | 本轮证据 |
|---|---|---|
| AC1：多 Worker Fork 并发 | 通过 | `npm run verify:s01:workers`：两独立 Wrangler Worker 共用 `/tmp/possibility-s01-U5kGop/d1`，`remote=false`、metrics 关闭，脚本退出码 0 并清理目录。最终记录：tick 竞争 409/200，恰有 1 个 clock fact、revision 2、active lease 0；两个不同 Fork 并发 200/409，完整子线/revision/state 各 1；同载荷重放 200，同 ID 异载荷 409。Fork/源写入竞争为 200/409，来源为 s01-main 的子线 revision/state 各 1，源行动无 command/fact 副作用。容量拒绝 409；注入复制故障返回 500，timeline/revision/state/command/fact 均为 0。脚本多次运行，端口 8787/8788；`npm run verify:s01:workers -- --readiness-only` 亦通过，两 Worker 均以合成账号读到同一隔离世界。 |
| AC2：Root→Child→Grandchild 隔离矩阵 | 通过 | 新增 `compare.test.ts` 跨域组合矩阵：预存记忆、接受承诺及知识进入 Child；Root 后加三类记录不渗入 Child/Grandchild；Child 在 Grandchild 创建前加的记录进入其 checkpoint；创建后各线记忆不反向污染。Root、Child、Grandchild 分别 `auditUniverse` 均为空。既有多级知识、承诺投影和 checkpoint cutoff 用例在 `npm --workspace api run test -- src/life/compare.test.ts src/test/world-journey.test.ts` 中共同重跑。 |
| AC3：消息送达与获知 | 通过 | 新增固定旅程经 API 先 Fork、访客进入 Child 现场，再向 Ada 传话；提交回执为 version 2、certainty `rumor`，fact ID 对应 Child 的版本化 knowledge fact。Ada 的后续 EngineContext 含原文和 sourceFactId；Bo、Root Ada、旁支 Ada 均无该知识；三线审计为空。登录态浏览器实际提交后显示“对方已听到这条消息（v2）；它仍是传闻，不会自动变成世界事实。”该提示没有声称已阅读、相信或行动。 |
| AC4：Compare 登录态走查 | 通过 | 本地 Vite `127.0.0.1:5173` + 两 Worker 本地 API `127.0.0.1:8787`，合成账号登录 `s01-world`。UI 创建带 what-if/改变条件的结构化分支，Compare 显示共同祖先、checkpoint v0、条件和因果限制。临时 D1 将子线置为下一模拟日后，页面显示“两线世界时间尚未对齐”；手工加入无 snapshot 的 legacy Fork 后显示“旧分叉：历史证据不完整”“未记录”，并列出 unknown 限制，不补造共同过去。关闭 Compare 后仍回到已选子线（状态 v1、访客在 Cafe）。 |
| AC5：权限、冲突和失败无副作用 | 通过 | `compare.test.ts` 27/27 与 `world-journey.test.ts` 6/6（合计 33/33）：覆盖缺失登录、跨用户/错配世界时间线、只读 Compare、归档比较、跨用户 Fork、归档源 Fork 400 且 timeline/revision/command/fact 快照不变、活动线容量与注入回滚。Worker 真实竞争的 post-race ledger 也核对时间线、revision、状态、命令和事实成套存在或整体缺失。 |
| AC6：P3 出口报告 | 通过 | 本表与 `spec_docs/s01/checklist.md` 区分自动测试、双 Worker 证据和登录态人工观察；unknown/legacy 边界见下。API 定向测试 33/33，API build 与 Web build 均通过；自动化只使用合成账号、固定模型替身及临时本地 D1，所有服务、进程及临时数据均已关闭/清理。 |

#### 本轮最终命令结果与环境

- `npm run verify:s01:workers -- --readiness-only`：通过，两个 Worker 均认证合成账号并从同一临时 D1 读取 `s01-world`；目录清理完成。
- `npm run verify:s01:workers`：通过（退出码 0）。隔离目录 `/tmp/possibility-s01-U5kGop/d1`；两 Worker 端口 8787/8788；固定本地模型替身；竞争请求 HTTP 结果及最终 D1 账本见 AC1。Workerd 输出的 `SQLITE_BUSY` 和故障注入触发器错误是被断言的竞争/回滚场景，脚本最终退出码为 0。
- `npm --workspace api run test -- src/life/compare.test.ts src/test/world-journey.test.ts`：33/33 通过（27 + 6）。
- `npm --workspace api run build`：TypeScript 检查通过。
- `npm --workspace web run build`：TypeScript 检查与 Vite production build 通过。

本轮新增组合测试夹具、D1 短暂锁竞争分类、认证只读查询的有界重试和在场面板 recipient 列表刷新修复；没有新增业务表或迁移。保留边界：legacy Fork 没有不可变 checkpoint 时仅标记历史不完整；比较仅显示观察到的状态/事实/事件差异，不推断因果；`rumor` 代表进入接收者知识记录，不代表居民已阅读、相信或采取行动。手工 Compare 中用于不同模拟时刻和 legacy unknown 态的行只存在于最终清理的临时 D1。

## S01 P4 开发与验收

### 开发起点

| 项目 | 记录 |
|---|---|
| HEAD | `63c3a2edd2d5af5cd3e6df9622753e958953ba94` |
| 分支 | `main` |
| 本阶段开始时已存在的工作区改动 | `api/src/scene/intent.test.ts`、`api/src/scene/routes.ts`、本报告、`docs/world-quality-report.md`；均在本轮开始前已修改。四份 `spec_docs/s01/` 文档由本任务依次重写并经用户批准。 |
| 归属约定 | P4 实现从上述 HEAD 起核算；既有 API/报告差异继续保留，不清理、不覆盖。 |
| 本阶段基线记录 | 通过 `git rev-parse HEAD`、`git branch --show-current`、`git status --short` 记录。验收数据限定一次性本地 D1、合成账号和本机模型替身。 |

### P4 实施与验收证据

#### 实现内容

- `WorldView` 从 `?timeline=` 恢复并同步所选线，切换时保留其他查询参数；快照和流继续由当前 effect 生命周期、timeline id 与 `stateVersion` 守卫。
- 世界居民抽屉增加“普通聊天”入口，保留世界当前 timeline；人物聊天页“返回世界”链接带回对应 world 与 timeline。
- 普通聊天 API 回归覆盖时间线归属、拒绝无效时间线不创建会话、完整回复持久化及世界事实不因普通聊天而变化；产品旅程串联 tick、普通聊天与 Fork/Compare。
- 本地 Worker 验收替身现为流式请求提供固定 SSE 回复；一次性本地世界标记为 demo，仅为人工核对匿名只读落地页，不改变真实世界配置。

#### 自动化、构建及 Worker 证据

| 命令 | 结果 |
|---|---|
| `npm --workspace web run test -- src/pages/WorldView.test.tsx src/components/world/PersonDrawer.test.tsx` | 2 个文件、9 项通过。覆盖 query 参数保留/清除、聊天与世界链接生成、旧 timeline/清理订阅/错配快照守卫，以及世界只读模式隐藏聊天入口。 |
| `npm --workspace api run test -- src/chat/routes.test.ts src/engine/tick.test.ts src/test/product-journey.test.ts src/test/world-journey.test.ts src/test/legacy-compat.test.ts` | 5 个文件、24 项通过。 |
| `npm --workspace api run test` | 32 个文件、224 项通过。包括公开路由匿名读取/写入拒绝、聊天断流与重试、tick 和产品旅程回归。 |
| `npm --workspace web run test` | 2 个文件、9 项通过。当前 Web workspace 没有 DOM 测试环境；异步归属守卫由独立单元测试验证，页面级延迟快照由本地浏览器代理验证。 |
| `npm --workspace api run build` | TypeScript 检查通过。 |
| `npm --workspace web run build` | TypeScript 检查与 Vite production build 通过。 |
| `npm run verify:s01:workers` | 最新运行退出码 0。两 Worker 读取同一一次性本地 D1；tick lease 竞争返回 409/200，恰 1 条 clock fact、revision 2、模拟时间推进、0 个遗留 lease。两个不同 Fork 并发均成功，重放返回 200、同 ID 不同载荷返回 409；源 Fork/行动竞争仅有一个提交，容量冲突返回 409，注入失败后子 timeline/revision/state/command/fact 均为 0。 |
| `git diff --check` | 通过。 |

Worker 脚本中的 `SQLITE_BUSY` 日志来自刻意制造的并发竞争，注入触发器的失败来自刻意制造的 Fork 写入回滚；最终断言与账本审计通过。完整 Worker 验收仅用于后台引擎/Fork 原子性，不代替浏览器竞态验收。

#### 登录态与匿名浏览器观察

- 所有浏览器步骤都在 Codex 内置浏览器、本地 Vite `127.0.0.1:5173`、API `127.0.0.1:8787` 和 `verify-s01:workers -- --manual-ui` 启动的一次性 D1/固定模型替身中进行；登录账号为合成账号 `s01-owner`，世界 `s01-world`。
- 登录后从世界链接打开 `/worlds/s01-world?timeline=s01-main`；页面显示世界名、主线、运行状态、世界时钟、状态版本和地点居民。点击暂停、继续后状态标签分别显示“已暂停”和“运行中”。浏览器刷新后主线参数仍在 URL。
- 本地 pinger 以显式 `ENGINE_API_URL=http://127.0.0.1:8787` 和一次性 tick secret 连接该 Worker。日志显示每 15 秒节拍推进约 90 分钟模拟时间；期间页面世界时间/版本更新，固定 schedule 模型输出最终写出 7 项日程。早期 decide 调用按脚本固定替身输出被安全跳过，未作为成功世界事件证据。
- 从 `/people/s01-resident?timeline=s01-main` 打开普通聊天。页面显示合成居民与世界信息，发送“ S01 P4 普通聊天验收：你好，能介绍一下今天的计划吗？”后展示固定替身完整回复。页面返回链接为 `/worlds/s01-world?timeline=s01-main`；点击并刷新后仍回主线。此聊天回合后的干净 fixture 世界快照仍是状态 v0、事件 0，未把回复说成世界已变化。抽屉中新增入口由 Web 回归断言渲染；本轮由于世界居民卡的可访问性快照未暴露其 button，人工浏览器采用对应人物 URL 验证聊天页和返回路径。
- 登录态浏览器从 `s01-main` 创建 Fork，返回的 timeline 为 `1c28ae48-b178-4369-920d-bb2c8a41cccf`；输入条件“咖啡馆开放时间”及验收假设。Compare 显示共同祖先、分叉时间、条件、共同事件和“记录差异不代表因果证明”。从菜单选择主线后 URL 恢复 `timeline=s01-main`，之后打开普通聊天。
- 本地 fixture 的 `is_demo=1` 只为验匿名 UI。退出登录后 `/` 显示公开世界时钟、状态、地点和居民；匿名页面只有“登录，创建你的世界”入口，没有暂停/继续、交互模式、普通聊天或写入按钮。公开 API 匿名写入拒绝由 `src/public/routes.test.ts` 覆盖。
- 可控本地 SSE 替身注入“部分回复→断流”：页面显示 `Network connection lost.`，刷新后用户消息仍在历史，但半截居民回复不在完成历史。另向一个临时分支会话发出 5 秒延迟的回复，在回复到达前通过页面返回分支世界并切回主线；主线 URL、v0 状态和 0 条事件保持不变，稍后重新打开原分支聊天只在那里看到完整的延迟回复。对应 fixture 模式仅由验收脚本的 `S01 P4 CHAT DROP` / `S01 P4 CHAT DELAY` 输入触发。
- AC6 延迟世界快照：Vite 代理前置本地响应代理，仅把 `GET /api/worlds/s01-world?timelineId=s01-main` 的第二个响应缓冲 12 秒。首个快照已显示主线后，第二个快照尚未返回时创建 Fork `ba6216a9-7570-4372-849d-efc617126ea0` 并进入该线；代理日志确认 `DELAYED`，12 秒后 `RELEASED`。释放后浏览器仍显示该分支 URL 和“平行宇宙”，状态 v0、事件 0。Web 守卫单测另确认选线已变化、effect 已清理或响应 timeline 不匹配时拒绝异步更新；传输层旧世界 SSE 帧未单独延迟注入。
- 页面截图/可访问性树显示页面内容和所需交互控件，无 Vite 错误遮罩；此环境的 CUA 接口未提供 console log 读取，故浏览器控制台错误项没有独立日志证据。

#### 隔离与验证范围

- 临时 D1 路径分别由脚本动态创建于 `/tmp/possibility-s01-*`；API、Web、模型替身、pinger 都只用本机地址。多个 manual-ui 验收实例均在结束时打印 `Cleaned isolated directory ...` 并删除临时库。
- 本轮没有部署、访问远端或生产 D1，也没有使用真实模型；凭据没有写入仓库。
- **AC6 通过：** 刷新、分支/主线切换、URL 同步、延迟聊天隔离、旧主线快照晚于 Fork 到达仍不覆盖当前分支，以及 `WorldView` 的旧结果守卫均有证据。传输层旧世界 SSE 帧未单独注入；其清理订阅与 timeline 错配拒绝由单测覆盖。Web workspace 未安装 DOM/browser test runtime，因此快照竞态以本地浏览器代理实测，回调归属以单测验证。

因此 AC1–AC7 的本轮证据通过；API/Web 全量测试、构建、Worker 集成验收及环境清理完成，S01 P4 AC8 出口记录通过。

## S01 Cloudflare D1 远端验收补充

- 用户提供现有 Cloudflare staging 测试库并确认 Wrangler 已登录。`wrangler whoami` 显示当前 account 与用户提供的 ID 一致，且登录 token 含 D1 写权限；`wrangler d1 list` 确认目标名为 `possibility-test`，首次核对时 0 张表、空库。账户 ID、数据库 ID 和 token 均不写入仓库。
- 仓库 `api/wrangler.toml` 保留占位 D1 ID。验收通过临时 `api/wrangler.staging-test.toml` 指向 staging，后续已删除该文件。Wrangler 4.126 原生命令 `d1 migrations apply --remote` 在 0000–0007 成功后，将含多个 `CREATE TRIGGER` 和 `--> statement-breakpoint` 的 0008 migration 作为整段 SQL 发往远端，Cloudflare 返回 `incomplete input` 并回滚 0008；远端账本核实 0000–0007 完整、无 0008 对象残留。
- 新增 `scripts/apply-s01-remote-migrations.ts` / `npm run apply:s01:remote-test-migrations`，要求显式提供 `S01_REMOTE_D1_CONFIG` 与匹配的 `S01_REMOTE_D1_ID`，并要求配置中的数据库名含 test/staging/acceptance；按 migration breakpoint 单条执行，每个文件成功后才写账本。本次确认 migration ledger 19/19、pending 0；该工具再次运行结果仍为 19/19、pending 0。
- 后续重跑时，可从 `api/wrangler.toml` 复制出 `api/wrangler.staging-test.toml`，将 D1 database name/ID 和 account ID 指向专用验收环境；该路径已加入 `.gitignore`。`S01_REMOTE_D1_CONFIG` 指向该文件，`S01_REMOTE_D1_ID` 必须与其中 ID 完全一致。
- 新增 `scripts/verify-s01-remote-workers.ts` / `npm run verify:s01:remote-workers`。两个独立 `wrangler dev --remote` Worker 都通过健康检查并读取合成 owner 会话。预留一个活动 Fork 名额后，最后名额的并发 Fork 返回 200/409；跨 Worker 同 payload 重放 200、改 payload 冲突 409、超容量 409。远端查询得到 2 个活动子线、2 个对应 person_state、2 条 universe_revision。并发两条独立 D1 请求执行 tick lease 条件 UPSERT，仅有一个 owner；另由外部 D1 owner 持锁时，两个真实 Worker `/api/engine/tick` 均返回 409，主线 revision 与 clock fact 数不变。直接越级 revision 被 `universe_revision_step_guard` 拒绝。脚本在退出时删除合成 Fork 和 lease 行并结束远端 dev Worker；`deployments list` 确认临时 Worker 不存在。
- staging 验收库保留完整 19 条 schema migration 和一个根线合成验收世界/人物/固定模型版本；固定模型版本受不可变触发器保护，脚本清理 Fork 子线和 lease 后不能删除此根 fixture。无需生产数据或模型凭据。
- 远端证据补足了 Cloudflare D1 上单次双 Worker Fork 名额竞争、跨 Worker 重放/拒绝、迁移触发器、lease UPSERT 原子竞争及 `/api/engine/tick` 在外部 owner 持锁时的拒绝/no-side-effect。新增 expired-owner 场景将模拟崩溃遗留 lease 设为过期，再由两个真实远端 Worker 同时 tick；返回 200/409，胜者推进 revision 与 clock fact 并释放租约。这一较早记录当时尚未覆盖远端取消/恢复与多级 Fork；后续补充结果见本节的 AC15 组合旅程。该阶段也尚未模拟 Cloudflare edge isolate 在 provider 请求进行中被强制终止；目前已用独立 fixture Worker 证明 runtime failure 后的 D1 恢复，仍未终止正在等待 provider 的产品 API handler。
- 本轮重验：`npm run verify:s01:remote-workers` 通过；远端验收输出 `remoteD1=true`、Fork 竞争 `[200,409]`、held-lease tick `[409,409]`、expired-lease takeover `[409,200]`，成功 tick 推进 revision/clock 并清除 lease。只读复查得到 active child `0`、lease `0`、migration `19`、合成根世界 `1`。临时 staging 配置已删除，配置路径受 `.gitignore` 保护。`npm --workspace api run test` 224/224、API build 通过；`npm --workspace web run test` 9/9、Web build 通过；`git diff --check` 通过。
- 后续 AC15 组合旅程扩展 `world-journey.test.ts`：完整日推进后创建 Child 和 Grandchild，在孙线真实登记来访者、进入现场、开启 SSE 交谈并取消模型请求，再恢复另一条过期 pending 请求；确认没有半成品 conversation command，恢复不增加孙线 revision，Root/Child/Grandchild 的审计继续通过。定向旅程 6/6 通过。
- AC10 共享人物旧数据矩阵扩展 `legacy-compat.test.ts`：同一居民在两个世界拥有各自的固定姓名/模型、地点状态、旧记忆和聊天记录；显式 timeline context 与聊天历史 API 只返回对应世界内容。AC06 新增睡眠/忙碌/两者兼有/异地的无副作用拒绝矩阵，以及跨 UTC 午夜睡眠日程边界测试。AC07 新增提议→接受→赴约窗口拒绝→到点履约→归来回顾完整旅程，逐项核验事件、事实、人物状态和关系记忆。当时全量 API 226/226、Web 9/9，API/Web build 均通过（2026-09-24 后续新增用例后的最新结果见后续记录）。

- **AC15 远端组合旅程补充（2026-09-24）：** 新增 `scripts/verify-s01-remote-journey.ts` / `npm run verify:s01:remote-journey`，使用动态 timeline/request ID 与随机本机端口，显式限制 database config 必须匹配用户给定 ID、数据库名含 staging/test/acceptance、且 D1 必须是唯一 S01 根夹具。两 Worker 在 Cloudflare staging D1 上串联 Root→Child→Grandchild Fork；访客在孙线进入 Cafe 后打开 SSE 请求并由客户端取消，远端状态变为 failed。随后仅为恢复路径将该请求 heartbeat 置过期并恢复为 pending，SIGKILL 原 Wrangler dev Worker 代理，再由第二个 remote Worker 查询 recoverable 并调用 `/recover`。D1 审计确认请求最终 failed、没有 `scene:<requestId>` 完成命令、没有 visitor/resident turns，且恢复没有推进孙线 revision。`wrangler dev --remote` 的 edge isolate 不提供外部强杀接口，因此该次证据只证明代理停止后的跨 Worker 过期恢复路径，不能证明 provider 请求仍执行时产品 API isolate 被强杀；后续补充见下条。
- D1 对 `world_commands` / `world_facts` 的不可变触发器拒绝删除验收历史；测试脚本因此将其唯一 ID 的子线归档以释放 active timeline 名额，保留 synthetic history。结束后的只读账本为 migration 19、active timelines 1、active remote-test timelines 0、tick lease 0、远端测试请求均为 failed。先前失败尝试创建的 synthetic timeline 也已归档。staging 配置文件在验收后删除，未将账号或 D1 标识写入仓库。
- **AC15 Cloudflare runtime 故障注入（2026-09-24 历史阶段）：** `verify:s01:remote-journey` 临时部署独立 staging Worker，针对本轮真实 scene request 将状态置为过期 pending 后执行无限 CPU 循环。Cloudflare Free plan 按默认 CPU 配额终止 invocation，实际响应为 503 `Worker exceeded resource limits`；D1 写入仍可由真实 API remote Worker 查询并经 `/recover` 收敛为 failed。审计确认无 `scene:<requestId>` 完成命令、无 dialogue turns、恢复不改变孙线 revision。脚本退出 0 并执行 Wrangler delete；随后 `deployments list` 返回 Worker 不存在。最终 D1 只读账本为 active timelines 1、active synthetic timelines 0、pending synthetic requests 0、未释放 tick lease 0。该阶段结论后来由本文件末尾最终收口证据覆盖。
- **AC11 Compare 历史/因果文案审查：通过。** 人工逐项复核 `ComparePanel.tsx`、`TimelineSwitcher.tsx` 和 `ConstructPanel.tsx`。检查同模拟时刻/不同模拟时刻、共同祖先未知、legacy 缺 checkpoint、结构化事实无差异、分叉条件/复制时点、环境事实与叙事干预六类文案：均标出证据边界，不将并列差异说成因果、不把未知说成相同，也不把居民后续反应说成必然。既有 P3 登录态浏览器已覆盖分叉条件、共同祖先、共同事件、时间对齐提示与返回主线；本轮源文案审计补齐历史/因果 copy 范围。
- 最终可复核重跑：`S01_REMOTE_D1_CONFIG=api/wrangler.staging-test.toml S01_REMOTE_D1_ID=<staging D1 ID> npm run verify:s01:remote-journey` 退出码 0。输出的本轮分支 ID 为 `s01-remote-child-f11c0df6d542` / `s01-remote-grandchild-f11c0df6d542`，worker 停止信号 `SIGKILL`，取消与恢复状态均为 `failed`，无已提交对话副作用。最后只读 D1 核对为 migration 19、active timelines 1、active remote test timelines 0、lease 0、failed synthetic cancellation requests 3。`api/wrangler.staging-test.toml` 已删除。

- **AC06 世界时钟时区语义（2026-09-24）：** `currentScheduleItem` 不再直接截取 `simNow` 的墙钟字符串，而是将含时区 ISO 时间解析为 UTC instant，再用 UTC 小时/分钟与日程比较。同一 instant 的 `Z` 与 `+05:00` 表示得到相同资格；跨午夜的 23:00–07:00 睡眠窗仍按 UTC 正确匹配；无效时间戳不匹配日程。`npm --workspace api run test -- src/agent/engine-context.test.ts` 3/3、API build 与 `git diff --check` 通过。该项缺口已由后文全日程推进证据补充关闭。
- **全量回归收尾（2026-09-24）：** 全量 API 测试发现 `world-journey.test.ts` 在当前 UTC 时刻落于居民睡眠日程时，取消旅程收到“这里现在没有人”后仍等待 provider fetch，导致原测试不稳定。测试现在在孙线通过版本化 `clock_advance` 推进到 10:00 UTC，显式断言收到 `scene_start` 后再注入断流/恢复；定向旅程 6/6 通过。最终 `npm --workspace api run test` 34 文件/229 项通过，API build 通过；`npm --workspace web run test` 2 文件/9 项通过，Web build 通过；`git diff --check` 通过。

- **AC14 预算门禁矩阵补充（2026-09-24）：** 新增 `api/src/engine/guard.test.ts`，基于真实 SQLite migration fixture 验证不存在/暂停/归档/触顶世界拒绝、触顶后次日恢复、世界每日调用封顶与调用账本一致、超拍预算时恢复保留名额、拍内并发只允许一个请求通过，以及预世界并发调用按用户原子封顶并相互隔离。定向 4/4 通过。各旧/新模型入口的完整权限×预算路由矩阵仍需补齐。

- **AC06 全日程推进证据补充（2026-09-24）：** `engine/tick.test.ts` 全日加速旅程新增精确断言：跨日推进实际提交 `Working → Resting → Sleeping` 三项 schedule-caused resident-state facts，模拟时间各异、每拍 revision/clock 一致且 `auditUniverse` 无不变量；定向 tick 用例 5/5 通过。AC06 端到端日程转换缺口关闭。

- **AC08 在场面板关闭/请求恢复验收（2026-09-24）：** 通过登录态浏览器与本地固定模型替身，在一次性 Wrangler D1 中发起 15 秒延迟 scene 调用；等待界面出现 `scene_start` 和“在场的人转过头来…”后关闭面板，再打开。页面恢复原输入并显示“上一次请求尚未到达世界；可以安全重试”。D1 只读查询显示最终取消请求状态为 `failed`，其余唯一已完成交谈保留 `completed`；`world_commands` 中只有先前成功 scene 的命令，`dialogue_turns` 中没有取消请求的消息。关闭按钮现在先 Abort fetch，再 POST `/scene/requests/:requestId/cancel`；该 endpoint 原子将 pending 标为 failed，并由 `scene_request_not_live` trigger 阻止迟到 worker 提交。`scene/recovery.test.ts` 4/4、API build、Web 9/9 与 Web build 通过。隔离服务及 D1 已随脚本退出清理。
- **AC14 路由权限×预算矩阵补充（2026-09-24）：** 新增 `api/src/engine/llm-routes.guard.test.ts`，对 scene intent、scene、普通 chat、catch-up、Fork preview、Fork simulation、chapter 逐个验证 paused/capped/archived world 拒绝；核对没有进入 provider、没有新增 LLM 账目或拒绝消息/对话写入。distill 与 world draft 另验 owner 已触顶时拒绝、另一 owner 的额度隔离、匿名请求 401，以及另一个 owner 的首次 provider reservation 在失败重试时不会超 cap。矩阵发现 archived root 可经默认章节和 Fork preview 路由进入；现章节默认只选 active 时间线，preview 对 archived timeline 返回 409。定向矩阵 4/4 通过。
- **AC15 产品 API isolate 中断验收（2026-09-24）：** 更新 `scripts/verify-s01-remote-journey.ts`，临时部署的 Worker 现在直接导入并运行 `api/src/index.ts`。只有带本次随机验收密钥的合成 scene 请求才启用注入：产品 handler 创建真实 scene reservation 后，wrapper 发起 provider fetch、将该请求 heartbeat 写入 D1，再在同一个 Cloudflare invocation 内触发 CPU 限额终止。另一独立产品 API Worker 将过期请求回收为 `failed`。D1 复核确认该请求无 conversation command、无 dialogue turns，恢复未推进 timeline revision；Root/Child/Grandchild 归档，临时 Worker 已删除，staging 只剩原根时间线 active 且无 pending scene request。该证据关闭此前“仅终止 fixture、未终止产品 API provider 等待 handler”的窄缺口；AC15 其余矩阵及全局未通过 AC 仍保持未关闭。
- **AC05/AC07 真实模型抽样（2026-09-24）：** 新增 `scripts/verify-s01-live-model.ts` 与 `npm run verify:s01:live-model`。它从本地忽略文件读配置，在隔离内存 SQLite 构造两位居民、仅 Ada 可见的 rumor 和后续记忆，实际调用居民对话 prompt；不会写 staging D1。原授权的 3 次调用早先通过程序断言；用户另行授权追加 3 次后，本次追加尝试先有 1 次 provider 请求失败，之后一轮完整使用 3 次调用并输出样本。人工复核：Bo 说明没有确切记录、拒绝猜测；Ada 后续回复明确仍是传闻且尚未核实；Ada 首轮只返回不完整 JSON 前缀，certainty 断言不通过。第三次调用后的 SQLite 清理还触发 `ReferenceError`，尽管验收结果先已打印。脚本已改为隐藏 canary、只显示 utterance 并容忍清理错误；没有进一步调用模型。故这次真实样本不是全通过，AC05/AC07 继续部分，人工 review 发现的问题仍需新授权调用或固定模型回归方案解决。异常请求计入 reservation；不把失败请求描述为零成本。
- **AC14 路由权限×预算矩阵补充（2026-09-24）：** 新增 `api/src/engine/llm-routes.guard.test.ts`，对 scene intent、scene、普通 chat、catch-up、Fork preview、Fork simulation、chapter 逐个验证 paused/capped/archived world 拒绝；核对没有进入 provider、没有新增 LLM 账目或拒绝消息/对话写入。distill 与 world draft 另验 owner 已触顶时拒绝、另一 owner 的额度隔离、匿名请求 401，以及另一个 owner 的首次 provider reservation 在失败重试时不会超 cap。矩阵发现 archived root 可经默认章节和 Fork preview 路由进入；现章节默认只选 active 时间线，preview 对 archived timeline 返回 409。定向矩阵 4/4 通过。
- **AC09 staging 并发压力补充（2026-09-24）：** `scripts/verify-s01-remote-workers.ts` 将两 Worker 竞争从 2 个请求扩展为 24 个并发 Fork 请求。staging D1 返回 1×200、23×409；赢家跨 Worker replay 200，改变载荷和超容量 409。D1 只读审计为 2 条 active child（预留基线 Fork + 唯一竞争赢家）、2 条 person_state 和 2 条 revision；执行后 active timeline 总数 1、压力 Fork 0、tick lease 0、pending scene request 0、migration 19。临时 staging 配置已删除。该结果补上 AC09 高并发名额争抢证据；legacy checkpoint 完整性仍未证明。
- **AC04 写入原子失败矩阵补充（2026-09-24）：** 新增 `api/src/world-state/atomicity-matrix.test.ts`，14 项 trigger 注入回归覆盖 `enter`、`move`、`environment`、`intervention`、`inform`、`schedule_set`、`resident_state`、`dialogue_start`、`scene_open`、`dialogue_turn`、`dialogue_recovery`、`simulation_checkpoint`、`clock_advance`、`memory_summary`、`memory_correct`/`memory_forget`、`commitment_proposal`/`commitment` 等写入域；针对 SQL 失败分别核对 command/fact/event/revision 与 person_state、dialogue、schedule、memory、commitment 均未部分提交。定向 14/14 通过，与既有 move、beat/story event、scene conversation 失败回滚、创建事务回滚、CAS 并发及 late-worker fencing 证据合并后，AC04 的已支持写入家族原子性矩阵通过。
- **AC08 提议跨浏览器恢复补充（2026-09-24）：** 新增 `0019_little_justice.sql` 与 `scene_intent_proposals`，将待确认的意图原文、模型提议、当前版本、user/person/world/timeline 所属关系和 30 分钟有效期保存在 D1。`GET /scene/intent/pending` 可在另一浏览器取回；同 requestId 和同内容返回原提议而不重复调用模型，不同内容冲突；确认只接受所存提议与版本，确认后标记 committed，取消后标记 cancelled。Web 初始化优先恢复服务端提议，sessionStorage 作为本标签页回退。`scene/intent.test.ts` 13/13 通过，覆盖跨会话取回、幂等 replay、内容冲突、取消和确认状态。已将 migration 0019 应用到此前授权的 staging D1；远端迁移账本 20/20、无待迁移项，临时连接配置已删除。旧普通聊天流程仍无跨设备持久 request ID，因此 AC08 整体仍部分。
- **AC08 变更回归（2026-09-24）：** API 意图定向测试 13/13；API TypeScript build、Web TypeScript/Vite build 通过。全量套件与汇总计数待本轮末尾更新。
- **最终回归与 staging 审计（2026-09-24）：** API 37 文件/254 项、Web 2 文件/9 项全部通过；API TypeScript build、Web TypeScript/Vite build、两份远端验收脚本 `node --check` 与 `git diff --check` 通过。staging `0019` 已应用，迁移账本 20/20。双 Worker 复验 24 路 Fork 竞争为 1×200/23×409，跨 Worker 重放 200、冲突与超容量 409；外部 owner 持锁时两个 tick 均 409，过期租约接管为 1×200/1×409、状态推进一次并释放租约。脚本清理后 staging 仅保留一条 active root timeline，pending scene/intent 均为 0、无 live tick lease；已有归档验收分支仍保留用于审计。全局 S01 仍被 AC03 的全域独立重建等价、AC05/AC07 的失败真实模型样本与覆盖不足、AC08 旧普通聊天跨设备精确重试、AC09 legacy checkpoint 完整性、AC14 内部引擎/管理组合矩阵阻塞，不能宣称全局验收完成。模型调用配额已耗尽，本轮未再调用模型。
- **前轮全量验证（2026-09-24）：** `npm --workspace api run test` 37 文件/253 项通过；API build 通过；`npm --workspace web run test` 2 文件/9 项通过；Web build 通过；所有 S01 验收脚本 `node --check` 与 `git diff --check` 通过。AC14 路由矩阵 4 项与 AC04 原子失败矩阵 14 项均包含在本轮全量结果中。本轮 staging 24 并发 Worker 测试退出成功，D1 只读清理审计通过，临时 config 删除。全局 S01 仍未通过：AC03/05/07/08/09/14 的边界仍见验收表，其中真实模型一项存在实际失败，未用更多模型调用重试。

## S01 全局收口开发基线（2026-09-24）

- 实现开始点：HEAD `abc07e0ec9831542d638aad610e9c0b49f118363`，分支 `main`。
- `task.md` 中的“29 项既有改动”来自较早盘点；四份规格文档获批、且未开始本轮实现时，`git status --short` 的实际基线为 **32 个状态条目**：21 个已跟踪修改、11 个未跟踪路径。后续验收以这份实际清单为准。
- 这些改动均视为用户或前序 S01 工作成果，禁止通过 reset、checkout 或整文件覆盖回退。计划内文件如有重叠，只做局部增量修改并在每组任务后检查 diff。
- 改动归属：P4/远端与真实模型补证主要位于 `scripts/`、`package.json`、Worker/旅程测试和两份报告；普通聊天请求雏形位于 `api/src/db/schema.ts`、0020 migration/snapshot；本轮已批准规格位于 `spec_docs/s01/`；scene intent、时区、权限/预算和原子性用例均为须保留的前序成果。

进入实现前的完整状态：

```text
 M api/drizzle/meta/_journal.json
 M api/src/agent/engine-context.ts
 M api/src/chapters/routes.ts
 M api/src/db/schema.ts
 M api/src/engine/tick.test.ts
 M api/src/scene/intent.test.ts
 M api/src/scene/recovery.test.ts
 M api/src/scene/routes.ts
 M api/src/test/world-journey.test.ts
 M api/src/timelines/routes.ts
 M docs/current-state-audit.md
 M docs/world-quality-report.md
 M package.json
 M scripts/verify-s01-remote-workers.ts
 M scripts/verify-s01-workers.ts
 M spec_docs/s01/checklist.md
 M spec_docs/s01/plan.md
 M spec_docs/s01/spec.md
 M spec_docs/s01/task.md
 M web/src/api/client.ts
 M web/src/components/world/ScenePanel.tsx
?? api/drizzle/0019_little_justice.sql
?? api/drizzle/0020_dizzy_hannibal_king.sql
?? api/drizzle/meta/0019_snapshot.json
?? api/drizzle/meta/0020_snapshot.json
?? api/src/agent/engine-context.test.ts
?? api/src/engine/guard.test.ts
?? api/src/engine/llm-routes.guard.test.ts
?? api/src/world-state/atomicity-matrix.test.ts
?? scripts/fixtures/
?? scripts/verify-s01-live-model.ts
?? scripts/verify-s01-remote-journey.ts
```

基线校验：`git diff --check` 退出码为 0；以上 32 个条目与同一时点的 `git status --short | wc -l` 一致。

## S01 收口续验（2026-09-27）

- **最终本地回归：** `npm --workspace api run test` 45 文件/324 项通过；`npm --workspace web run test` 6 文件/20 项通过；API TypeScript build、Web TypeScript/Vite build、全部 S01 Node 脚本语法检查、`git diff --check` 通过。`npm run verify:s01:legacy` 使用 3 个隔离库，完成 complete/upgradeable/incomplete 分类、升级 1 个可升级夹具、拒绝 incomplete 写入，最终 unassessed=0、upgradeable=0。
- **T38 双 Worker 普通聊天：** `npm run verify:s01:workers` 退出码 0。独立 Wrangler Worker 共用一次性本地 D1；同 ID pending replay、completed replay 为 200，异载荷 409，固定 provider 调用一次，账本是 1 条 user、1 条 person 回复、1 条回执。跨 Worker 取消后状态 `cancelled` 且 reply=0；过期请求被另一 Worker 回收为 `failed` 且 reply=0。Fork 并发/幂等/版本竞争、容量限制、事务回滚、一次 clock fact 与无残留 lease 一并通过；脚本清除临时目录。
- **T39/T40：** 延迟 SSE 分片夹具在 Web 全量测试中通过；切线后释放旧分片仍由代次守卫丢弃。API 产品/世界旅程和 Web 回归纳入上述全量测试。
- **T42 浏览器范围（续验历史）：** `agent-browser` CLI 不可用，使用桌面浏览器控制在一次性 D1、loopback Worker/Vite 和本地 12 秒延迟固定 provider 上实走。Chrome 与 Codex 内置浏览器为独立 profile，分别登录同一合成 owner；B 的 localStorage 没有 A 的 request ID，但新增 `/api/conversations/:id/requests/pending` owner/conversation scoped 查询让 B 找到 pending request 并在完成后显示回复。又关闭 A 标签后从 B 重新加载会话；隔离 D1 只读账本显示两条 request 各为 completed、1 user message、1 person reply、1 receipt，0 pending。当时尚缺的旧 SSE 半帧浏览器释放已由本文件末尾最终收口补齐。
- **T43/T44 staging：** staging `possibility-test` migration ledger 22/22；重复迁移检查 pending=0。旧 root evidence 起初为 unassessed，其新格式 projectionBaseline 缺 knowledge 行；增加分类器回归，只有当旧 initialStates 与空 initialEvents 提供唯一 immutable baseline 且全域 replay 匹配时才升级。分类 Worker 最终将 root 审为 complete/replay_verified。远端两 Worker 聊天 pending/completed replay 200、异载荷 409，单请求账本 1 user/1 person reply/1 call receipt；临时确定性 provider 通过 Cloudflare service binding 接入，结束时删除。24 路 Fork 竞争 1×200/23×409；lease 并发单赢家；外部 lease 持有时 tick 2×409 且无副作用；过期 lease 接管 1×200/1×409、时钟推进、租约释放。Root→Child→Grandchild staging 旅程的取消与产品 API provider-wait isolate 中断恢复通过，临时 crash Worker 删除，验收 Fork 归档以保留不可变历史。
- **最终 staging 只读清理：** migrations=22、worlds=1、active timelines=1（仅 root）、active synthetic=0、tick leases=0、pending scenes=0、pending chats=0、root evidence=`complete`。未删除不可变审计事实；合成验收线保留为 archived。多轮 staging 聊天验收产生的 completed/failed synthetic request/message 记录保留作审计，不是 pending。
- **T45/T46 真实模型：** 依用户授权单次启动 `npm run verify:s01:live-model`，实际计 4/8 次可能计费尝试、自动重试 0。Ada 只按 rumor 复述私有标记，Bo 未泄露/猜中；后续及重新构造上下文后都恢复传闻和记忆，所有程序断言通过。输出中的 canary 已脱敏；未打印 credentials、prompt 或原始敏感标识。
- **当时仍未关闭的原全局出口：** AC03/05/07/08/09/14 的历史缺口记录于此；这些结论已由本文件末尾的最终收口证据覆盖。
- **T48 历史审计：** 当时尚未提交；最终已逐项确认全部改动属于 S01，并在全量验证和凭据扫描后创建逻辑提交。

## S01 续验补充（2026-09-27）

- **T49 独立重建旅程：** `product-journey.test.ts` 在创建、进入、行动、Fork、Compare、返回和真实对话后，对 Root/Child 执行纯 reducer 重放；`world-journey.test.ts` 在跨 24 小时、多次日程切换和 Root→Child→Grandchild 分支旅程后，对三线逐一执行 `rebuildProjection`。所有被测线均 `complete` 且差异为空。另加 immutable baseline 日程 reducer 用例；定向旅程分别 3/3 与 6/6、四文件合计 36/36；API 全套最终 45 文件/328 项。
- **T50 权限矩阵：** 内部 LLM 入口拒绝矩阵新增 `unassessed` 与 `upgradeable` evidence 状态；生命周期管理矩阵新增非 owner 对世界 pause/resume/archive、时间线 archive/reactivate 的拒绝与 world/timeline/command/fact/revision 零变化断言。`policy-matrix.test.ts` 12/12 通过。
- **本轮最终自动回归：** API 45 文件/330 项、Web 6 文件/20 项、API 与 Web build、`verify:s01:legacy`、`verify:s01:workers` 全通过。双 Worker verifier 在隔离本地 D1 上重建 22 项 migration；第一次尝试与临时浏览器 Worker 共占 8787 导致 403，第二次遇到 D1 并发写的 transient internal error，第三次在无端口冲突的干净隔离库上退出码 0，聊天/Fork/tick/lease 断言通过且临时目录清理。没有访问 staging。
- **T51 修复后真实模型增量（完成）：** 用户追加授权的隔离旅程硬上限为 8 个 tick、无自动重试，产生 4 个真实 beat 回执，均为 completed 并带 `beat/v1` 与上下文 hash；下一 tick 可从持久状态构造 fresh context。首轮暴露两个问题：日程只在可变投影而不在 version-0 baseline，以及 reducer 把未变化的地点误判为 `location` fact。修正夹具 baseline 与 projector 的事实分类规则后重跑，独立重放 `complete`、差异为零；`projector.test.ts` 15/15、`rebuild.test.ts` 7/7。后续 T52 已补齐真实无效输出后的继续节拍。
- **全域差异矩阵补充：** `rebuild.test.ts` 对全部九个行投影域逐个验证 missing/extra/mismatch 诊断域与 reason code；时钟标量 mismatch 单独覆盖。后续 T52 已补齐全部命令类别和恢复路径组合。
- **S01 最终收口：** `replay-combination.test.ts` 覆盖 19 类 `WorldAction` 并逐命令独立重建；真实浏览器用产品订阅函数验证旧 SSE 半帧切线后释放；`policy-matrix.test.ts` 补齐内部、恢复及管理生命周期矩阵。获授权的 `verify:s01:live-closure` 最终一轮以 8 次真实调用覆盖普通聊天、在场场景、NPC 隔离/多跳、beat、summary、真实合同失败及下一节拍恢复，零自动重试，回执与重放通过。本次授权窗口累计使用 24/50 次。无不可变来源的旧 checkpoint 继续保持 `incomplete/read-only`，未补造。API 46 文件/344 项、Web 6 文件/20 项及两端 build 通过，S01 全局出口通过。
