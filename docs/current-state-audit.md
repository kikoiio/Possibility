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
