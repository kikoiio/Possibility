# s01｜P1 世界状态一致性与连续推进 Tasks

本任务单执行 [spec.md](./spec.md) 与 [plan.md](./plan.md)。先盘点已存在的实现和验证证据；已有内容满足要求时只补证据，不重复造实现。工作区在本阶段开始前已有大量未提交改动，这些改动不是本阶段成果，执行前后都要与本轮改动区分。不得将验收数据写入默认或远端数据库。

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `api/src/world-state/model.ts` | 根线基线类型、完整域及读取规则 |
| 修改 | `api/src/worlds/routes.ts` | 新建世界时冻结完整根线基线 |
| 修改 | `api/src/persons/routes.ts` | 人物快捷创建世界时冻结完整根线基线 |
| 修改 | `api/src/agent/visibility.ts` | Fork checkpoint 类型与完整性判定 |
| 修改 | `api/src/life/fork.ts` | 捕获多域 Fork checkpoint |
| 新建 | `api/src/world-state/rebuild.ts` | 证据收集、纯投影重建、比较 |
| 新建 | `api/src/world-state/rebuild.test.ts` | 重建、差异定位、legacy 与无副作用验证 |
| 修改 | `api/src/world-state/invariants.ts` | 汇总现有不变量与重建差异 |
| 修改 | `api/src/world-state/invariants.test.ts` | 投影审计故障注入与 Fork 验证 |
| 修改 | `api/src/test/world-fixture.ts` | 固定居民、日程、基线和模拟时间 |
| 修改 | `api/src/test/world-journey.test.ts` | 重复创建、整日推进与多级 Fork 旅程 |
| 修改 | `api/src/engine/tick.test.ts` | 加速时钟连续推进回归 |
| 修改 | `api/src/world-state/commit.test.ts` | 请求重放、冲突与提交失败回滚矩阵 |
| 修改 | `api/src/scene/recovery.test.ts` | 取消、断流、恢复及迟到 worker 回归 |
| 修改 | `api/src/test/legacy-compat.test.ts` | 归属、暂停、归档及越权拒绝边界 |
| 修改 | `api/src/public/routes.test.ts` | 公共演示只读回归 |
| 修改 | `api/src/engine/tick-lease.test.ts` | 多 Worker lease/fencing 约束 |
| 新建 | `scripts/verify-s01-workers.ts` | 隔离 D1、多 Worker 并发验收与清理 |
| 修改 | 根目录 `package.json` | 添加专用本地多 Worker 验收命令 |
| 修改 | `docs/current-state-audit.md` | P1 验收证据与阶段出口记录 |

## T01｜盘点已存在的 P1 实现与证据

**文件：** 修改 `docs/current-state-audit.md`；只读核对 `api/src/world-state/invariants.ts`、`api/src/world-state/invariants.test.ts`、`api/src/engine/tick.test.ts`、`api/src/life/compare.test.ts` 和 `docs/world-quality-report.md`。
**依赖：** 无。

**步骤：**
1. 记录 P1 开始时的 HEAD、分支及已存在工作区改动概况。
2. 按 F1–F7 与 AC1–AC12 列出已有实现、已有测试及证据缺口。
3. 标记可复用的 action/fact 校验和已覆盖的失败边界；不把未提交工作区改动归为本阶段成果。

**验证：** 盘点覆盖每项 F/AC，并把起点与已知缺口写入 P1 证据区；记录可与 `git rev-parse HEAD`、`git status --short` 对照。（AC12）

## T02｜定义投影域与基线完整性类型

**文件：** `api/src/world-state/model.ts`。
**依赖：** T01。

**步骤：**
1. 定义投影域枚举及域到 schema 行类型的映射。
2. 定义 `ProjectionBaseline`，包含来源、版本、模拟时间、捕获时间、完整域列表和各域基线行。
3. 明确“完整的空域”与“没有证据的域”不同。

**验证：** `npm --workspace api run build` 通过；新增类型能表达完整空域与缺失域两种状态。（F1、N4）

## T03｜固定人物快捷建世界的根线基线

**文件：** `api/src/persons/routes.ts`。
**依赖：** T02。

**步骤：**
1. 将快捷建世界当前已有的初始居民状态写入版本 0 基线。
2. 为其他已知为空的投影域写入完整域标记。
3. 保持人物、世界、主时间线、固定模型和 revision 的原子创建边界。

**验证：** `npm --workspace api run test -- src/test/product-journey.test.ts`；创建成功后根线基线完整，基线写入故障时不留孤立世界或人物。（AC1、F1）

## T04｜固定正式世界创建的根线基线

**文件：** `api/src/worlds/routes.ts`。
**依赖：** T02。

**步骤：**
1. 将新世界、居民初始状态和已存在的初始化投影纳入不可变版本 0 基线。
2. 对未生成的日程、承诺、记忆、对话和留言记录明确保存完整空域。
3. 保持世界、时间线、固定模型及 revision 同批创建。

**验证：** `npm --workspace api run test -- src/test/product-journey.test.ts`；新建根线各基线域可读且初始化失败全量回滚。（AC1、F1）

## T05｜让旧根线缺失基线保持不完整

**文件：** `api/src/world-state/model.ts`、`api/src/world-state/invariants.test.ts`。
**依赖：** T02–T04。

**步骤：**
1. 缺失初始投影扩展字段时，不从当前可变表补造根线基线。
2. 将 legacy 和域不完整状态保留为显式结果。
3. 补充旧模型版本和已有 revision 的兼容回归。

**验证：** `npm --workspace api run test -- src/world-state/invariants.test.ts`；旧线报告不完整/legacy，且基线 JSON 未被改写。（F2、N4）

## T06｜扩展 Fork checkpoint 完整性类型

**文件：** `api/src/agent/visibility.ts`。
**依赖：** T02。

**步骤：**
1. 将投影域完整性及访客留言快照纳入 checkpoint 类型。
2. 区分旧版本 checkpoint 缺字段与完整空集合。
3. 让 checkpoint 解析器拒绝不合法结构，不回退到可变祖先行补历史。

**验证：** `npm --workspace api run test -- src/life/compare.test.ts`；新旧 checkpoint 分别解析为完整或显式不完整。（F2、F7）

## T07｜捕获根线和多级 Fork 的完整 checkpoint

**文件：** `api/src/life/fork.ts`、`api/src/agent/visibility.ts`。
**依赖：** T06。

**步骤：**
1. 捕获 checkpoint 时固定所有规格列出的继承投影与可见事实。
2. 孙线从子线 checkpoint 继承，不重新读取父线当前可变记录。
3. 保留分叉时间、版本、模型版本及祖先 cutoff。

**验证：** `npm --workspace api run test -- src/life/compare.test.ts`；源线分叉后新增数据不进入子线或孙线。（AC4、AC10）

## T08｜建立重建证据与结果类型

**文件：** 新建 `api/src/world-state/rebuild.ts`。
**依赖：** T02、T06。

**步骤：**
1. 定义 `TimelineEvidence`、`ProjectionDifference` 和 `ReconstructionResult`。
2. 覆盖 complete、incomplete、legacy、unsupported 四类结果。
3. 让每个差异携带投影域、记录标识和可得的命令/版本来源。

**验证：** `npm --workspace api run build` 通过；类型能表达 spec 要求的差异类别和来源。（F1、N4）

## T09｜只读收集时间线重建证据

**文件：** `api/src/world-state/rebuild.ts`。
**依赖：** T08。

**步骤：**
1. 在一个 D1 batch 中读取 revision、固定根线模型或 Fork checkpoint、命令、事实及当前投影。
2. 不调用会创建模型版本或 revision 的初始化函数。
3. 以稳定顺序整理命令、事实与投影行。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；收集证据前后表快照相同。（F1、N3）

## T10｜验证版本及命令—事实配对

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T08–T09。

**步骤：**
1. 检查命令与事实按 timeline、source command 和连续版本一一对应。
2. 将缺失、重复、错线和版本不匹配转换为带来源的差异。
3. 未知 action 返回 unsupported，不静默忽略。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；故障夹具分别产生预期诊断。（F1、N4）

## T11｜重建时钟和居民状态投影

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T10。

**步骤：**
1. 从根线/分叉基线初始化模拟时钟与居民状态。
2. 按版本应用 clock、enter、move、resident_state、checkpoint 和 dialogue recovery 变更。
3. 保留每个最终状态字段对应的来源命令/版本。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；正常状态与故障注入差异均可复现。（AC2–AC3）

## T12｜重建日程、事件与环境相关投影

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T11。

**步骤：**
1. 按 schedule_set 命令/事实重建日程域。
2. 重建由命令产生的事件并将 checkpoint 事件作为基线。
3. 检查事件时间线、模拟时间、类型及唯一 ID。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；日程或事件缺失/篡改/无来源均被定位。（AC2–AC3）

## T13｜重建承诺投影

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T10。

**步骤：**
1. 从 checkpoint 初始化承诺集合。
2. 应用提议及状态转换事实，保留每次状态变化的来源。
3. 将无来源额外行、缺失行和字段偏差分别报告。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；承诺接受、履行、失约及篡改场景都得到正确投影或差异。（AC2–AC3）

## T14｜重建记忆与摘要投影

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T10、T12。

**步骤：**
1. 从基线及居民状态、交谈、约定和摘要事实重建记忆行。
2. 应用校正、遗忘和摘要归档标记。
3. 区分合法 legacy 记忆与结构化基线之后的孤儿记忆。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；记忆内容偏差和无来源行有明确来源/域诊断。（AC2–AC3、N4）

## T15｜重建对话、逐句发言和留言投影

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T10、T12。

**步骤：**
1. 重建 dialogue 与 turn 行及结束/忙碌状态。
2. 重建由交谈命令产生的 persona message。
3. 检查对话、逐句文本和留言行的归属及来源。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；缺失、额外或修改的对话/留言均被检测。（AC2–AC3）

## T16｜重建知识可见集合与证据边界

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T07、T10。

**步骤：**
1. 根据 Fork checkpoint、祖先 cutoff 和子线本地事实建立可见知识集合。
2. 校验接收者范围、来源事实顺序与 certainty 继承。
3. 对无证据历史和缺失来源明确降级。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；传闻、私有知识和分叉后消息均遵守可见边界。（AC4、AC10、N4）

## T17｜实现稳定投影比较

**文件：** `api/src/world-state/rebuild.ts`、`api/src/world-state/rebuild.test.ts`。
**依赖：** T11–T16。

**步骤：**
1. 对各域按稳定 ID 排序并比较语义字段。
2. 将缺失、差异和无来源多余行转换为 `ProjectionDifference`。
3. 排除明确不属于世界状态的运行时字段。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；相同输入顺序变化不会造成误报，语义变更会被检出。（AC2–AC3）

## T18｜把重建差异接入统一审计

**文件：** `api/src/world-state/invariants.ts`、`api/src/world-state/invariants.test.ts`。
**依赖：** T09–T17。

**步骤：**
1. 复用现有命令—事实映射，避免维护第二份 action 语义。
2. 将重建器差异转换为审计问题并保留命令/版本。
3. legacy、不完整和 unsupported 不得转为“无问题/完整通过”。

**验证：** `npm --workspace api run test -- src/world-state/invariants.test.ts`；既有不变量结果保持，新增审计差异可见。（AC2–AC4、N4）

## T19｜验证结构化根线基线和 legacy 降级

**文件：** `api/src/world-state/rebuild.test.ts`、`api/src/world-state/invariants.test.ts`。
**依赖：** T03–T05、T18。

**步骤：**
1. 用完整基线且所有域为空的根线验证可重建通过。
2. 用缺少域的旧固定模型验证结果为 incomplete/legacy。
3. 验证检查旧线不会补写固定模型、命令、事实或投影。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts src/world-state/invariants.test.ts`；两类结果区分明确且数据库快照未改变。（AC1–AC3、N4）

## T20｜验证多域故障注入和只读性

**文件：** `api/src/world-state/rebuild.test.ts`。
**依赖：** T17–T18。

**步骤：**
1. 为状态、日程/事件、承诺/记忆、对话/留言分别注入缺失、篡改和无来源行。
2. 断言差异含投影域、记录标识及可得来源命令/版本。
3. 对审计前后数据库内容做完整快照比较。

**验证：** `npm --workspace api run test -- src/world-state/rebuild.test.ts`；所有故障被分类，原始验收数据库前后相同。（AC3、N3）

## T21｜验证根线到孙线的继承边界

**文件：** `api/src/life/compare.test.ts`、`api/src/test/world-journey.test.ts`。
**依赖：** T07、T16、T18。

**步骤：**
1. 在根线建立承诺、记忆、知识、对话和事件后创建子线。
2. 在根线和子线分别添加只属于分叉后的数据，再由子线创建孙线。
3. 重建三条线并核对各自可见集合及失败 Fork 无副作用。

**验证：** `npm --workspace api run test -- src/life/compare.test.ts src/test/world-journey.test.ts`；孙线仅包含根线/子线各自 checkpoint 前应继承内容。（AC4、AC10–AC11）

## T22｜补齐固定整日旅程夹具

**文件：** `api/src/test/world-fixture.ts`、`api/src/test/world-journey.test.ts`。
**依赖：** T03、T04。

**步骤：**
1. 固定居民状态、至少四个可观察日程边界及模拟起点。
2. 固定模型响应或完全绕过真实模型/外网。
3. 独立创建两次夹具并比较起点和日程描述。

**验证：** `npm --workspace api run test -- src/test/world-journey.test.ts`；两次夹具结果一致且不发生真实模型调用。（AC1、N2）

## T23｜用加速模拟时钟连续推进完整一天

**文件：** `api/src/engine/tick.test.ts`。
**依赖：** T22。

**步骤：**
1. 使用 fake timers 和测试专用倍率，按多个连续 tick 推进至少 24 小时模拟时间。
2. 选择每步间隔以跨越多个日程边界且不改变线上默认倍率。
3. 每步核对模拟时钟、revision 和节拍结果。

**验证：** `npm --workspace api run test -- src/engine/tick.test.ts`；模拟时间达到至少一天且无需墙上时间等待。（AC5、N2）

## T24｜验证整日旅程的状态、事实和审计

**文件：** `api/src/engine/tick.test.ts`、`api/src/test/world-journey.test.ts`。
**依赖：** T23。

**步骤：**
1. 逐拍比较 schedule 变更、居民状态、world facts 和派生 events。
2. 验证同一日程不会在后续 tick 重复记账。
3. 对整日旅程结尾运行 projection rebuild 与 universe audit。

**验证：** `npm --workspace api run test -- src/engine/tick.test.ts src/test/world-journey.test.ts`；最终投影一致且无重复边界事实。（AC5、AC11）

## T25｜验证重复请求、版本冲突与原子回滚

**文件：** `api/src/world-state/commit.test.ts`、`api/src/test/product-journey.test.ts`。
**依赖：** T18。

**步骤：**
1. 核对相同请求 ID/载荷回放同一结果，不增加第二条事实。
2. 核对同 ID 不同载荷和旧 expectedVersion 明确冲突。
3. 在事实或投影插入点故障注入并比较版本、事实和投影快照。

**验证：** `npm --workspace api run test -- src/world-state/commit.test.ts src/test/product-journey.test.ts`；重复与拒绝结果满足 AC6 且失败无部分写入。（AC6）

## T26｜验证取消、过期恢复和迟到提交

**文件：** `api/src/scene/recovery.test.ts`、`api/src/engine/tick-lease.test.ts`。
**依赖：** T18。

**步骤：**
1. 分别覆盖取消、断流、超时/过期请求的状态查询。
2. 用同一 request ID 重试并核对不会重复模型调用或事实。
3. 用过期 lease token 尝试迟到提交并确认被数据库拒绝。

**验证：** `npm --workspace api run test -- src/scene/recovery.test.ts src/engine/tick-lease.test.ts`；未完成请求无半成品，旧 token 无法写入。（AC7）

## T27｜补齐写入归属和拒绝矩阵

**文件：** `api/src/test/legacy-compat.test.ts`、`api/src/public/routes.test.ts`、相关路由测试。
**依赖：** T18。

**步骤：**
1. 逐项覆盖跨用户、错配世界/时间线、暂停、归档和调用额度触顶。
2. 覆盖公开演示只读入口及拒绝的 P1 写请求。
3. 每个拒绝用例比较 revision、facts、projection 和 timelines 前后快照。

**验证：** `npm --workspace api run test -- src/test/legacy-compat.test.ts src/public/routes.test.ts`；拒绝明确且无副作用。（AC9）

## T28｜验证 Fork 成功、拒绝、重复和竞争

**文件：** `api/src/life/compare.test.ts`、`api/src/test/world-journey.test.ts`。
**依赖：** T07、T18、T21。

**步骤：**
1. 覆盖多级 Fork 成功、相同请求重放及同 ID 不同条件冲突。
2. 覆盖无权限、达到 active timeline 上限和源状态变化时的拒绝。
3. 覆盖竞争创建并检查时间线集合与源线状态。

**验证：** `npm --workspace api run test -- src/life/compare.test.ts src/test/world-journey.test.ts`；成功分支可重建，失败/重复分支不污染源线或产生多余时间线。（AC10）

## T29｜建立安全的隔离 D1 验收目录

**文件：** 新建 `scripts/verify-s01-workers.ts`。
**依赖：** 无。

**步骤：**
1. 在系统临时目录生成唯一持久化路径并在启动前核验其不等于默认 Wrangler 路径。
2. 所有 Wrangler 命令固定使用本地模式和该路径，设置 `WRANGLER_SEND_METRICS=false`。
3. 用 `try/finally` 关闭子进程并删除本轮临时目录。

**验证：** `npm run verify:s01:workers -- --dry-run`；日志显示唯一路径，异常退出也执行清理且不启动 Worker。（N1、N3）

## T30｜添加专用多 Worker 命令

**文件：** 根目录 `package.json`。
**依赖：** T29。

**步骤：**
1. 添加 `verify:s01:workers` 脚本指向验收工具。
2. 确认脚本不引用默认数据库、远端标志或项目 `.dev.vars`。

**验证：** `npm run verify:s01:workers -- --help` 显示用法且不启动/访问远端服务。（N1）

## T31｜迁移隔离 D1 并播种固定 Worker 夹具

**文件：** `scripts/verify-s01-workers.ts`。
**依赖：** T29–T30。

**步骤：**
1. 对唯一目录应用本地 D1 迁移，不访问项目默认或远端 D1。
2. 在该隔离库中播种固定用户、世界、时间线、居民和日程。
3. 写入仅供验收的 engine secret 与固定模型替身配置，不读取项目密钥。

**验证：** `npm run verify:s01:workers -- --prepare-only`；记录临时目录及迁移结果，确认目标是本地隔离 D1。（N1–N2）

## T32｜从隔离 D1 启动并清理两个 Worker

**文件：** `scripts/verify-s01-workers.ts`。
**依赖：** T31。

**步骤：**
1. 在不同端口启动两个独立 Wrangler Worker 实例，并指定同一隔离 D1 目录。
2. 轮询两个健康入口直到 ready 或超时。
3. 任一启动失败时停止已启动的进程并清理临时目录。

**验证：** `npm run verify:s01:workers -- --readiness-only`；两个独立实例均连接本地隔离库，完成后进程退出且目录清理。（N1）

## T33｜协调多 Worker tick 竞争并核对结果

**文件：** `scripts/verify-s01-workers.ts`。
**依赖：** T32。

**步骤：**
1. 两个 Worker 对同一固定时间线发出同步 tick 请求。
2. 使用本地固定模型延迟形成可观察的竞争窗口，不访问外部模型服务。
3. 查询 revisions、clock facts、commands、resident projections 和 lease，确认只有一次有效推进且过期 token 不能提交。

**验证：** `npm run verify:s01:workers`；结果包含两个 Worker 标识、隔离路径和状态码，且账本和投影只记录一次推进。（AC8、N1–N2）

## T34｜完成端到端重建与 Fork 旅程

**文件：** `api/src/test/world-journey.test.ts`、`api/src/test/product-journey.test.ts`。
**依赖：** T21、T24、T25、T28。

**步骤：**
1. 从结构化世界推进完整模拟日并审计根线。
2. 从检查点 Fork，在子线写入独立变化，再审计根线、子线及孙线。
3. 断言根线保持不变，子线仅包含继承历史与自身事实。

**验证：** `npm --workspace api run test -- src/test/world-journey.test.ts src/test/product-journey.test.ts`；整段旅程不调用真实模型，所有线的投影审计结果符合预期。（AC11）

## T35｜记录 P1 实际验收证据

**文件：** `docs/current-state-audit.md`。
**依赖：** T19–T34。

**步骤：**
1. 为 AC1–AC12 记录实际命令、环境、退出结果和关键观察。
2. 记录隔离 D1 临时路径的创建、迁移、Worker 数量和清理结果，不记录密钥。
3. 对缺少基线的 legacy 线如实标为不完整；只有所有 AC 有通过证据时才标记 P1 出口通过。

**验证：** 报告中每项状态均能对应实际命令/输出；未通过或未验证项有具体缺口与后续归属。（AC12、N4–N5）

## T36｜运行 API 最终回归与类型检查

**文件：** 无新增文件；验证本任务单所列 API 改动。
**依赖：** T01–T35。

**步骤：**
1. 运行 API 全套测试。
2. 运行 API TypeScript 构建检查。
3. 运行隔离本地 D1 多 Worker 验收命令并保存输出摘要。

**验证：** `npm --workspace api run test`、`npm --workspace api run build`、`npm run verify:s01:workers` 均有实际结果记录；不得用测试总数替代 AC 行为证据。（AC1–AC12）

## 执行顺序

```text
T01 → T02 → T03 → T04 → T05
           ├──→ T06 → T07 ───────────────┐
           └──→ T08 → T09 → T10 → T11–T18│
                                          ├→ T19–T21
T22 → T23 → T24 ─────────────────────────┤
T25 → T26 → T27 → T28 ───────────────────┤
T29 → T30 → T31 → T32 → T33 ─────────────┤
                                          ▼
                                  T34 → T35 → T36
```
