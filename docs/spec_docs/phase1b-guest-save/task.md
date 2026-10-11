# 阶段 1B：访客保存和恢复 Tasks

> 状态：Spec、Plan、Task、Checklist 已批准；实现已完成并进入 T39/T40 验收记录。T1～T38 已实现并通过对应定向验证；T39 正在授权的 GitHub Actions 云端执行，T40 只记录实际结果。未有证据的验收项保持未验证。

## 执行约束与验证位置

- 本清单以已批准的 `spec.md`、`plan.md` 为依据。代码编辑步骤按 2～5 分钟的聚焦单元拆分；真实云端执行 T39 和证据汇总 T40 的等待时间单独记录，不把远端等待算作代码单元。
- 每项先取得实际验证证据，再标记完成；测试失败先修复当前任务，不带着失败进入依赖任务。每项或逻辑相关任务组通过后按 Spec 技能提交，仅提交本阶段文件，保留其他工作区改动。
- 下文 `npm --workspace api test -- ...`、`npm --workspace web test -- ...` 均是单文件定向验证；允许在资源预算适合时轻量执行，固定 `--maxWorkers=1 --no-file-parallelism`。命令中的 `-t` 为本任务必须提供的行为用例名称；若零测试匹配视为未验证。发现其成为重型负载时停止新增负载，迁移经授权的云端执行，不重复盲跑。
- 全量测试、API/Web 构建、依赖安装、Chromium 安装和任何浏览器运行属于重型任务，统一在 T39、用户明确授权的免费 GitHub Actions 执行。本机内存充足不能替代云端优先规则；未授权不执行、不上传代码，记录未验证原因。
- 本机轻量验证也需按需检查 `free -h`、`vmstat 1 5`、`cat /proc/pressure/memory`；判断以 MemAvailable、持续换页与 PSI 为准，不单看 swap。大文件或缓存操作前检查 `df -h /tmp`，临时目录默认项目 `.tmp/phase1b`。不清他人目录、不停其他任务进程。
- 若云端确实不能覆盖，先说明具体原因；本机 GUI 兜底须 MemAvailable ≥4G、PSI 低、单实例，Electron 使用 `--disable-gpu`，Wayland 下 headless Electron 清除 `WAYLAND_DISPLAY` 并加 `--ozone-platform=x11`。所有本任务临时服务在结束后清理，并只处理本任务记录的 PID/进程组与目录。
- 新测试使用独立内存数据库、唯一账号/副本/请求和每任务 fixture；浏览器统一一个 worker、一个实例，认证和认领为真实隔离 API/D1，模型为确定性替身。不得用页面可见性替代认领写入证据。

## 文件清单与所有权

| 操作 | 文件 | 职责／单一编辑所有者 |
| --- | --- | --- |
| 修改 | `api/src/demo/types.ts`、`web/src/api/types.ts` | DTO 契约所有者；T1 |
| 修改 | `api/src/db/schema.ts` | 数据库契约所有者；T2 |
| 新建／修改 | `api/drizzle/0040_guest_claim_operations.sql`、`api/drizzle/meta/_journal.json`、`api/drizzle/meta/0041_snapshot.json` | 迁移所有者；T3→T7→T8；不改旧迁移 |
| 新建 | `api/src/db/guest-claim-migration.test.ts` | 操作表与数据库触发器行为；同迁移所有者 |
| 新建 | `api/src/demo/claim-repository.ts`、`claim-repository.test.ts` | 操作槽、epoch、执行期限与恢复；T4→T5→T6 |
| 修改 | `api/src/demo/world-graph-cloner.ts` | 可选认领暂存上下文与稳定执行 ID；T9 |
| 新建 | `api/src/demo/claim-publication.ts`、`claim-publication.test.ts` | 候选逐条清理保护与原子发布；T10→T11 |
| 修改 | `api/src/demo/clone-verification.ts`、`clone-verification.test.ts` | 暂存完整性、历史证明与最终归属；T9→T12 同测试所有者 |
| 修改 | `api/src/engine/tick.ts`、`tick.test.ts` | 暂存候选排除；T13 |
| 新建 | `api/src/demo/claim-status.ts`、`claim-status.test.ts` | 纯只读公开结果；T14 |
| 新建 | `api/src/demo/claim-error-copy.ts` | 确定失败与未确认错误映射；T16 |
| 修改 | `api/src/demo/session-service.ts`、`session-service.test.ts` | 认领及恢复编排；T15→T16 同服务所有者 |
| 修改／新建 | `api/src/demo/routes.ts`、`routes.test.ts` | GET、POST、recover HTTP 契约；T17→T18 |
| 修改 | `api/src/test/s03-guest-participation.test.ts` | 真实认证、旧 API 与生命周期回归；T19 |
| 修改／新建 | `web/src/api/client.ts`、`client.test.ts` | 明确身份请求及 401 行为；T20 |
| 新建 | `web/src/guest/claim-store.ts`、`claim-store.test.ts` | 上下文持久化与匹配成功清理；T21→T22 |
| 新建 | `web/src/guest/claim-flow.ts`、`claim-flow.test.ts` | 用户事件、超时、核实、恢复、账号切换；T23→T24→T25 |
| 新建 | `web/src/guest/use-guest-claim.ts` | React 订阅和销毁适配；T26 |
| 新建 | `web/src/components/guest/GuestClaimStatusPanel.tsx`、`GuestClaimStatusPanel.test.tsx` | 状态与用户入口；T27，适配检查 T26 |
| 修改 | `web/src/pages/Login.tsx` | 登录注册、目标确认及核实恢复；T28→T29 |
| 修改 | `web/src/pages/DemoLanding.tsx`、`WorldCanvasPage.tsx`、`web/src/components/map/GuestWorldMap.tsx` | 原副本元数据及保存入口；T30；DemoLanding 恢复 T31 同所有者 |
| 新建 | `web/playwright.guest-claim.config.ts` | 三视口、独立数据库/端口、关闭原始敏感产物；T32 |
| 新建 | `web/e2e/phase1b-guest-save.spec.ts` | 本阶段真实页面旅程；T33→T34→T35，同 E2E 所有者 |
| 修改 | `web/e2e/guest-claim-journey.spec.ts`、`guest-claim-recovery.spec.ts` | 旧成功链、先核实再切换及脱敏；T34 |
| 新建 | `web/scripts/phase1b-guest-save.acceptance.ts` | AC 矩阵、受控截图与白名单记录；T36 |
| 新建 | `scripts/finalize-phase1b-guest-save-acceptance.mjs`、`finalize-phase1b-guest-save-acceptance.test.mjs` | 证据版本、关联、重复数量、脱敏、清理核对；T37 |
| 新建 | `.github/workflows/phase1b-guest-save-acceptance.yml` | 可审批的隔离免费云端工作流；T38 |
| 后续阶段修改 | `docs/spec_docs/phase1b-guest-save/task.md`、`checklist.md` | 审批后的任务进度与实际验收证据；T40。Checklist 在 Task 审批后生成 |

## T1：固定前后端 DTO 契约

**文件：** `api/src/demo/types.ts`、`web/src/api/types.ts`。**依赖：** 无。
**步骤：**
1. 按 Plan 定义 `DemoClaimOperation`、`ClaimExecution`、`ClaimStatus`、`ClaimSourceBinding`、`ClaimRequest`、`RecoverClaimRequest`；保留既有 GuestSessionResult。
2. 明确 `not-started.safeToSwitch=false`、只有 retryable 允许切换、claimed 才有 worldId；前后端联合类型与字段保持一致。
3. 新请求必带 `expectedBinding={sessionId,worldId,generation}`，作为服务端解析原副本后的比较前提；GET 同样携带查询绑定。不同绑定返回 unavailable/source_changed，不能把浏览器 worldId 当权威选择；旧保存请求缺省 epoch=0 与可选绑定仅供兼容。
**验证：** `rg -n 'ClaimStatus|ClaimSourceBinding|expectedBinding|source_changed|RecoverClaimRequest|safeToSwitch|expectedEpoch' api/src/demo/types.ts web/src/api/types.ts`，两端字段与 Plan 一致；`git diff --check -- api/src/demo/types.ts web/src/api/types.ts` 无格式错误。完整类型检查汇合到 T39，不因未运行构建声称已通过类型检查。

## T2：增加操作槽及暂存世界字段

**文件：** `api/src/db/schema.ts`。**依赖：** T1。
**步骤：**
1. 定义 `demoClaimOperations`，sandboxId 唯一主键，保存 requestId、targetUserId、epoch、executionId/executionNo、state、leaseUntil、candidateWorldId、failureCode 和时间字段。
2. 原副本删除时操作槽级联清理，保留既有 guest session/sandbox 的生命周期定义；避免候选外键阻止失败槽与候选清理。
3. 世界新增可空 `claimStagingExecutionId`，普通世界默认 null；不更改普通状态与有效期默认值。
**验证：** `rg -n 'demoClaimOperations|claimStagingExecutionId|executionNo|onDelete' api/src/db/schema.ts`，字段与 Plan 逐项对应；`git diff --check -- api/src/db/schema.ts` 无错误。真实迁移与约束由 T3 验证。

## T3：创建操作表迁移与最小迁移回归

**文件：** `api/drizzle/0040_guest_claim_operations.sql`、`api/drizzle/meta/_journal.json`、`api/drizzle/meta/0041_snapshot.json`、`api/src/db/guest-claim-migration.test.ts`。**依赖：** T2。
**步骤：**
1. 新增操作表、主键/索引、级联关系和世界暂存字段；新增 journal 序号 41，保留当前所有历史文件、序号和快照。
2. 使用现有真实 SQLite/D1 测试适配验证迁移按顺序应用、普通世界默认无暂存标记、一副本只能有一当前槽。
3. 验证删除原副本可清理操作槽，现有普通访客有效期和待认领保留未改变。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/db/guest-claim-migration.test.ts -t 'operation schema'`，真实迁移成功、唯一约束拒绝第二槽、普通字段默认值与级联结果正确。

## T4：实现只读操作查询及原子取得执行权

**文件：** `api/src/demo/claim-repository.ts`、`claim-repository.test.ts`。**依赖：** T1、T3。
**步骤：**
1. 实现 `readClaimOperation` 纯 SELECT；实现 `acquireClaimExecution` 首次 epoch=0 和 failed 当前 epoch 的条件取得。
2. 服务端每次取得执行权生成 executionId，记录 120 秒期限及 executionNo；运行中重复请求读取同一执行，不另克隆。
3. 候选稳定世界 ID 的计算包含原副本和 executionId；旧 epoch、其他账号争抢及不同 requestId 不覆盖正在运行的槽。取得执行权时条件比较来源绑定，reset/generation 变化后的迟到请求不取得新副本的槽。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/claim-repository.test.ts -t 'acquisition'`，同副本并发只有一个执行，旧 epoch 和变更来源被拒绝，查询 SQL 无写入。

## T5：实现确定失败封闭与 epoch 推进

**文件：** `api/src/demo/claim-repository.ts`、`claim-repository.test.ts`。**依赖：** T4。
**步骤：**
1. 实现 `closeClaimExecution`，以 sandbox、账号、requestId、epoch、executionId 和 running 状态比较后封闭执行。
2. 正常失败原子设置 failed、推进 epoch；关闭失败或数据库结果未知时不能宣称明确未保存。
3. 同旧 epoch 的迟到重复 POST 不重新取得执行权；成功槽和新版执行不能被旧 close 覆盖。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/claim-repository.test.ts -t 'closure'`，失败只推进一次、旧 close 零写、旧请求拒绝、新版用户重试取得新 executionId。

## T6：实现主动恢复及无槽迟到请求阻断

**文件：** `api/src/demo/claim-repository.ts`、`claim-repository.test.ts`。**依赖：** T5。
**步骤：**
1. 仓储主动恢复比较 observedEpoch 和 observedExecutionId；未到 120 秒仍返回运行中，过期后 CAS 封闭并推进 epoch。
2. 原请求尚未到数据库、当前无槽时，原子创建高于旧版本的 failed 阻断记录；竞争中的首次取得执行权不能越过该版本。
3. 观察条件过期要求重查；恢复不克隆、不发布、不写 world facts，不自动跟进新的认领。原副本绑定不一致时拒绝恢复，不能给 reset 后新副本写阻断槽。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/claim-repository.test.ts -t 'manual recovery'`，无槽恢复挡住迟到 epoch=0，期限内不撤销，期限后旧执行不可发布，新 epoch 可手动重试，来源改变不会产生新副本 tombstone。

## T7：增加候选 INSERT 数据库执行门禁

**文件：** `api/drizzle/0040_guest_claim_operations.sql`、`api/src/db/guest-claim-migration.test.ts`。**依赖：** T3、T4。
**步骤：**
1. 对带暂存标记的世界 INSERT，触发器确认 candidateWorldId、暂存 owner、当前 executionId/epoch、running 状态与数据库时间下的有效期限。
2. 第一条候选世界 INSERT 门禁失败使用 RAISE(ABORT)，保证后续图写入整批回滚；普通克隆不带标记仍可用。
3. 添加 revoked、expired、错误 owner/候选 ID 及无操作槽的真实数据库用例。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/db/guest-claim-migration.test.ts -t 'candidate insert fence'`，所有失权插入拒绝且整批零候选写入，合法暂存插入成功。

## T8：增加原子发布门禁

**文件：** `api/drizzle/0040_guest_claim_operations.sql`、`api/src/db/guest-claim-migration.test.ts`。**依赖：** T7、T5。
**步骤：**
1. 暂存世界转归属并清空 marker 时，用数据库当前操作与期限确认仍有发布权，不能仅靠应用层预检查。
2. 发布批次内任一槽版本、归属、原副本绑定或 claimed 条件失配均中止整批；succeeded 不能被旧执行覆盖，session current world/generation 变更不能使旧候选发布。
3. 注入批次中途失败，证明世界归属、人物归属、session/sandbox 和操作结果全部回滚。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/db/guest-claim-migration.test.ts -t 'publication fence'`，过期/封闭/旧 epoch 发布拒绝，条件失败无局部归属改变。

## T9：给克隆器接入执行独立的暂存路径

**文件：** `api/src/demo/world-graph-cloner.ts`、`clone-verification.test.ts`。**依赖：** T4、T7。
**步骤：**
1. 增加可选认领上下文，普通访客创建与其他 cloneWorldGraph 调用保持原路径。
2. 认领请求 scope 使用 executionId，四组 userId 暂存于原访客专用 owner；候选强制 paused、带 marker，记录应恢复的源状态。
3. 新执行重新读取原副本，失败返回后新增地点、分支和交互记录会进入新版候选；历史场景 proof 记录克隆时暂存 owner。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/clone-verification.test.ts -t 'claim staging clone'`，候选四组归属正确、paused、执行间 ID 不同、普通克隆兼容、新增进度存在。

## T10：实现逐条候选清理保护

**文件：** `api/src/demo/claim-publication.ts`、`claim-publication.test.ts`。**依赖：** T9。
**步骤：**
1. 实现 `deleteClaimCandidate(db, execution, cloned)`，按现有子表到父表顺序清理完整图。
2. 每一条 DELETE 都以候选世界仍带本 executionId marker 为条件；只给最终世界 DELETE 加条件不足以保护子表。
3. 候选 ID 每执行独立；清理错误单独记录，不更改成功结果或原副本。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/claim-publication.test.ts -t 'candidate cleanup'`，旧清理不删新版候选、不删原副本；marker 清空后子表及世界全部零写入。

## T11：实现四组归属与认领结果同批发布

**文件：** `api/src/demo/claim-publication.ts`、`claim-publication.test.ts`。**依赖：** T8、T10。
**步骤：**
1. 实现 `publishVerifiedClaim(db, execution, cloned)`，同一受保护 batch 转移 worlds、persons、conversations、worldVisits 归属。
2. 同批恢复源世界应有状态、清空 marker、设置 sandbox.claimedWorldId/session.claimed 和操作 succeeded。
3. 验证 worldVisits 的账号/候选 timeline 复合主键无冲突；不同账号及旧执行不能发布第二份结果。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/claim-publication.test.ts -t 'atomic publication'`，批次成功四组一致，故障整批回滚，同副本仅一个发布世界，成功后的迟到 cleanup 无变化。

## T12：核验暂存图及发布后最终归属

**文件：** `api/src/demo/clone-verification.ts`、`clone-verification.test.ts`。**依赖：** T9、T11。
**步骤：**
1. 克隆完整性核验使用暂存 owner，保持地点/时间线/事件/指令、事实、场景和 Native2D 已有核验范围。
2. 发布后读回实际目标账号、结果指针及四组归属，成功报告基于已发布结果；诊断故障不能撤销已经成功的保存。
3. 证明 immutable scene clone proof 不因发布转归属被改写，新增事实不由状态查询或恢复产生。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/clone-verification.test.ts -t 'claim ownership verification'`，暂存和最终归属分别正确、历史证明保持、新旧进度完整。

## T13：引擎排除所有暂存候选

**文件：** `api/src/engine/tick.ts`、`tick.test.ts`。**依赖：** T2、T9。
**步骤：**
1. 引擎初始世界筛选排除非空 claimStagingExecutionId，执行前复查也排除暂存候选。
2. 验证候选即使被状态维护误改 running，也不会推进时间、调用模型或写事实。
3. 普通 running 世界及成功清空 marker 的保存世界继续按既有规则运行。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/engine/tick.test.ts -t 'claim staging exclusion'`，候选事实/时间不变、模型调用为零，普通世界推进保持。

## T14：实现纯只读公开状态映射

**文件：** `api/src/demo/claim-status.ts`、`claim-status.test.ts`。**依赖：** T1、T4。
**步骤：**
1. 实现 `readClaimStatus`，专门解析 token hash、当前原副本与账号；不调用 resumeGuestSession 或会续期的 accessMiddleware。
2. 同归属成功返回原 worldId，其他账号返回 conflict；running 即使期限经过仍 in-progress，只有持久 failed 返回 retryable。
3. 没槽返回 not-started 且 safeToSwitch=false；读取时检查 expectedBinding，reset 或来源变化返回 unavailable/source_changed，不读取新副本替代原结果。副本已确认不可用返回 unavailable，数据库故障不冒充不可恢复。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/claim-status.test.ts -t 'read-only claim status'`，SQL 日志全部 SELECT、expiresAt/事实/世界数量不变，无其他账号 worldId 或执行身份泄露。

## T15：重接认领服务的取得、克隆、核验和发布

**文件：** `api/src/demo/session-service.ts`、`session-service.test.ts`。**依赖：** T6、T11、T12、T14。
**步骤：**
1. `claimGuestSession` 先解析凭证、比较 expectedBinding、确认原副本权限及既有成功归属，再按 expectedEpoch 取得操作；重复运行返回状态，不重复克隆。新 caller 必须有绑定，旧首次调用保留兼容。
2. 取得后暂存克隆、完整性核验、受保护发布；所有成功输出来自确认后的同账号归属。
3. 验证同账号同 requestId 并发、不同 requestId 并发、跨账号争抢只有一份发布结果，无可访问候选。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/session-service.test.ts -t 'coordinated claim'`，唯一结果、合法重放同 worldId，其他账号不获结果，原副本数据保留。

## T16：连接手动恢复与确定/未知错误说明

**文件：** `api/src/demo/session-service.ts`、`session-service.test.ts`、`claim-error-copy.ts`。**依赖：** T15。
**步骤：**
1. 对外实现 `recoverClaimOperation` 的身份校验、仓储封闭、最终状态重查及可重试候选清理；仓储同名函数通过 import alias 区分职责。
2. 核验或克隆失败先持久关闭执行并推进 epoch，再返回明确 retryable；关闭结果未知保留未确认说明。
3. 建立有限中文错误类别，区分认证失效、未确认、暂时失败、已被其他账号保存和原副本不可用；日志不得记录凭证。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/session-service.test.ts -t 'recovery and failure classification'`，封闭失败仍未确认，主动恢复无克隆/事实写入，已成功不可撤销，原凭证保持。

## T17：接入 GET 状态及 POST recover HTTP 路由

**文件：** `api/src/demo/routes.ts`、`routes.test.ts`。**依赖：** T14、T16。
**步骤：**
1. 三个认领入口采用账号 authMiddleware 加原副本 guest header；GET 与 recover 不经过自动续期路径。
2. GET 返回公开 ClaimStatus、禁止缓存，query 必须带 expectedBinding 的 sessionId/worldId/generation；recover 校验同一绑定、requestId、非负整数 observedEpoch 和 executionId/null。
3. 映射恢复 200/202/409 与身份 401；伪造请求、错误观察条件及失效账号不能写入或泄露结果。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/routes.test.ts -t 'status and recover HTTP'`，GET 禁缓存且零写入，非法请求被拒绝，recover 只在合法主动动作封闭。

## T18：更新保存 POST 与旧请求兼容

**文件：** `api/src/demo/routes.ts`、`routes.test.ts`。**依赖：** T17。
**步骤：**
1. 保存 POST 接受 expectedEpoch 和 expectedBinding；旧调用缺省 epoch 按 0、绑定可选，新客户端必带。解析凭证后比较绑定，不通过时 source_changed，合法已成功同账号重放仍返回原结果。
2. 成功 200、正在执行 202、版本或归属冲突 409；旧客户端不能绕过 failed 新 epoch。
3. 失败状态与中文说明根据已确认写入/执行封闭结果映射，HTTP 500 本身不被表达成确定没有保存。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/demo/routes.test.ts -t 'claim HTTP compatibility'`，旧首次请求可用、旧 epoch 不重启、202 不重复 clone、他账号冲突不带 worldId。

## T19：补齐真实服务及生命周期兼容回归

**文件：** `api/src/test/s03-guest-participation.test.ts`。**依赖：** T13、T18。
**步骤：**
1. 分别执行正确登录、注册、错误密码后正确登录，认证失败期间认领写入为零，成功保存原副本。
2. 测试两个身份同时存在的访客恢复与认领权限、普通登录不认领、合法旧 API 重放。
3. 测试到期普通副本不可认领、claim_pending 保留、GET 状态不续期、操作槽清理关系与既有参与旅程。
**验证：** `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism src/test/s03-guest-participation.test.ts -t 'phase1b lifecycle'`，真实账号/认领路径与保留期限正确，原副本与目标归属匹配。

## T20：明确认证、访客读取与认领请求身份

**文件：** `web/src/api/client.ts`、`client.test.ts`。**依赖：** T1。
**步骤：**
1. login/register 请求不带访客 header，认证 401 不清理 guest token；账号会话失效只清账号身份。
2. 访客恢复明确用 guest 身份；`claimStatus({requestId,expectedBinding})`、claim、recoverClaim 使用账号 Bearer 加原副本 header，每条请求携带原 session/world/generation 绑定；claim 支持 AbortSignal。
3. 查询请求禁缓存，DTO 解析保留业务状态与有限错误类别，不把所有 401 当访客失效。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/api/client.test.ts -t 'explicit claim identity'`，密码错误保留 guest token、双身份 header 正确、失效账号不抹原副本、三接口方法正确。

## T21：实现有版本的保存上下文读写

**文件：** `web/src/guest/claim-store.ts`、`claim-store.test.ts`。**依赖：** T1。
**步骤：**
1. 定义 GuestClaimContext/GuestClaimPhase/GuestClaimStoreRead 与 store.read/write；凭证继续只在已有 token 键，不复制密码或 token 到意图。
2. 记录 source 的 session/world/generation/fingerprint、requestId、target、confirmationRequired、submitted、epoch、executionId、phase 和 receipt。
3. 兼容旧待保存键与请求键；缺绑定经合法原副本读取补全。损坏/存储不可用返回明确状态，不静默建副本。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-store.test.ts -t 'persistent intent'`，刷新读同上下文、兼容键不丢请求、损坏与 quota/security 异常可理解，意图无 raw token。

## T22：实现匹配成功收据及中断清理恢复

**文件：** `web/src/guest/claim-store.ts`、`claim-store.test.ts`。**依赖：** T21。
**步骤：**
1. 实现 `completeConfirmedClaim`，先持久保存目标/world 收据，再比较捕获 guestToken、requestId 和 targetUserId 清理对应旧状态。
2. 清理中途断点刷新通过收据完成；新副本、换请求或不同目标不得被旧成功响应清理。
3. 写 receipt 失败说明恢复限制，不能假装清理成功；已确认服务端结果仍可显示，不伪装保存失败。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-store.test.ts -t 'confirmed receipt cleanup'`，中断可恢复、成功才清理、旧响应保留新上下文、存储失败返回实际限制。

## T23：建立可测试流程及新认证事件入口

**文件：** `web/src/guest/claim-flow.ts`、`claim-flow.test.ts`。**依赖：** T20、T22。
**步骤：**
1. 实现 `createGuestClaimFlow(deps)`，注入客户端、store、计时器和账号状态，提供 Plan 的 GuestClaimFlow 接口与订阅。
2. 无保存意图的普通认证不认领；仅用户登录或注册成功事件触发 `afterAuthentication` 自动保存路径。
3. 挂载或刷新只恢复上下文与读取状态，已有账号/切换账号处于 confirm-account，不能因 effect 运行自动保存。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-flow.test.ts -t 'authentication entry'`，普通登录零 claim，新认证事件连续原副本，挂载只有 GET，已有账号需确认。

## T24：实现保存前持久记录与 60 秒等待边界

**文件：** `web/src/guest/claim-flow.ts`、`claim-flow.test.ts`。**依赖：** T23。
**步骤：**
1. `confirmAndSave` 在 POST 前持久记录 submitted、目标、expectedEpoch，并从持久 source 构造 expectedBinding；记录失败暂停保存，正在保存阻止重复点击。
2. 60 秒计时结束忙碌并进入 unknown；AbortSignal 取消、网络异常及响应丢失均不能推断未写入。
3. 用请求捕获的原副本、目标与版本处理结果，迟到响应不覆盖新版上下文；成功调用匹配收据清理。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-flow.test.ts -t 'save wait boundary'`，59 秒仍 saving、60 秒 unknown、无自动重试、POST 前 submitted 已保存、乱序响应不误清理。

## T25：实现只读核实、主动恢复和安全切换

**文件：** `web/src/guest/claim-flow.ts`、`claim-flow.test.ts`。**依赖：** T24。
**步骤：**
1. `refreshStatus` 只 GET 并带原副本绑定；已成功恢复原结果，not-started/expired-running 均保持未确认，retryable 更新可用 epoch，source_changed 明确不能保存替代副本。
2. `recover` 只在用户动作 POST recover，使用原副本绑定与观察 epoch/executionId；返回 retryable 不自动 POST claim。
3. `prepareAccountSwitch` 对已 submitted 原账号先核实，必要时主动封闭后允许切换；无效会话保留旧目标并要求重新认证原账号，不向新账号误存。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-flow.test.ts -t 'safe manual recovery'`，刷新零保存、恢复无跟随保存、没槽旧请求需封闭、账号切换确认明确、暂时查询失败仍保留上下文。

## T26：实现 React 流程订阅适配

**文件：** `web/src/guest/use-guest-claim.ts`、`web/src/components/guest/GuestClaimStatusPanel.test.tsx`。**依赖：** T25。
**步骤：**
1. `useGuestClaim` 订阅统一 flow，账号身份变化重新读取状态，不在订阅或 effect 中发保存。
2. 卸载取消订阅/计时器并处理异步结果，严格模式重复挂载不产生重复 POST。
3. 以轻量 React harness 验证状态更新、挂载纯读与销毁，不新增测试依赖。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/components/guest/GuestClaimStatusPanel.test.tsx -t 'flow subscription'`，挂载只读、重复挂载零保存、卸载无遗留订阅/计时器。

## T27：制作业务状态与下一步操作面板

**文件：** `web/src/components/guest/GuestClaimStatusPanel.tsx`、`GuestClaimStatusPanel.test.tsx`。**依赖：** T26。
**步骤：**
1. 区分账号认证成功、正在保存、未确认、可重试、冲突、不可用与存储限制，不显示数据库/epoch 等实现细节。
2. 明确提供保存到此账号、核实结果、主动恢复、重试、返回原副本和主动新体验动作，各状态只开放允许入口。
3. 提供状态朗读、错误提示与按钮焦点，移动页允许滚动；未确认不得开放未经核实的账号切换。
**验证：** `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/components/guest/GuestClaimStatusPanel.test.tsx -t 'claim status actions'`，每状态可观察文案和动作正确、无误报成功，按钮可聚焦；三视口实际可达性在 T39 验证。

## T28：登录页接入认证与目标账号确认

**文件：** `web/src/pages/Login.tsx`。**依赖：** T20、T27。
**步骤：**
1. 保留 `/login?claimDemo=1`，读取同一保存上下文，登录/注册切换不重置原副本和 requestId。
2. 正确登录/注册成功事件调用 afterAuthentication；错误密码、用户名冲突、非法输入及网络失败保留上下文。
3. 已登录显示账号与“保存到此账号”，点击前零认领；普通登录保持原导航，不认领未选择副本。
**验证：** `git diff --check -- web/src/pages/Login.tsx` 无格式错误；`npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-flow.test.ts -t 'authentication entry'` 入口行为契约通过。真实 Login 页面绑定由 T33/T39 验证，不以协调器测试代替页面证据。

## T29：登录页接入未确认恢复及账号切换

**文件：** `web/src/pages/Login.tsx`。**依赖：** T28。
**步骤：**
1. 未确认显示核实/主动恢复，刷新只调用 GET；明确失败才显示用户重试及返回原副本。
2. 切换账号先 prepareAccountSwitch；已完成进入原账号结果，未能核实保留原认证能力，安全切换后仍需新目标确认。
3. 清理旧保存页内分散 localStorage/自动认领逻辑，统一使用 flow；成功只清理匹配上下文。
**验证：** `git diff --check -- web/src/pages/Login.tsx` 无格式错误；`npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-flow.test.ts -t 'safe manual recovery'` 行为契约通过。页面未知结果与切换旅程由 T34/T39 验证。

## T30：打通原副本元数据与地图保存入口

**文件：** `web/src/pages/DemoLanding.tsx`、`WorldCanvasPage.tsx`、`web/src/components/map/GuestWorldMap.tsx`。**依赖：** T21、T28。
**步骤：**
1. DemoLanding 将真实 sessionId/worldId/generation 传给 WorldCanvasPage，再传给 GuestWorldMap 保存入口。
2. 点击“登录并保存”先持久记录与当前 credentialFingerprint 匹配的意图，再导航；已有 requestId 保留。
3. 存储失败显示限制、不发认领；元数据缺失通过合法原副本读取补齐，不用当前账号世界或新副本代替。
**验证：** `git diff --check -- web/src/pages/DemoLanding.tsx web/src/pages/WorldCanvasPage.tsx web/src/components/map/GuestWorldMap.tsx` 无错误；`npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-store.test.ts -t 'persistent intent'` 绑定存储契约通过。真实元数据连线在 T33/T39 验证。

## T31：恢复页区分暂时故障与主动新体验

**文件：** `web/src/pages/DemoLanding.tsx`。**依赖：** T30、T29。
**步骤：**
1. `/demo/recover` 明确用 guest 身份读同原副本；暂时故障展示读取重试，不自动 session POST/reset。
2. 原凭证缺失或已确认到期不可恢复时说明原进度无法恢复，只有点击“开始新体验”创建新 session。
3. 创建失败保留旧说明与可用凭证，成功才替换；保存失败返回后可继续原副本交互，再保存读取新增进度。
**验证：** `git diff --check -- web/src/pages/DemoLanding.tsx` 无错误；`npm --workspace web test -- --maxWorkers=1 --no-file-parallelism src/guest/claim-flow.test.ts -t 'safe manual recovery'` 恢复状态契约通过。真实副本读取/主动创建数量在 T34/T35/T39 验证。

## T32：准备真实服务与三视口独立浏览器配置

**文件：** `web/playwright.guest-claim.config.ts`。**依赖：** T1。
**步骤：**
1. 复用现有 `api/scripts/start-s02-e2e.mjs` 与 standard-life-fixture，只用隔离 Worker/D1；显式传独立根文件系统 persistTo、唯一端口及 TMPDIR。
2. 配置桌面、485×724、390×844，workers=1、fullyParallel=false、独立输出目录；复用已有服务前确认本任务标记/模式，不复用他人端口。
3. 禁用 raw trace、video、自动失败截图；只由 T36 记录器在非敏感页面或清空认证输入后截图，失败日志走白名单。
**验证：** `git diff --check -- web/playwright.guest-claim.config.ts` 无错误；`rg -n 'workers|fullyParallel|trace|video|screenshot|persist|TMPDIR|485|390' web/playwright.guest-claim.config.ts` 确认单 worker、无敏感自动产物及独立资源。Playwright 配置加载/浏览器执行统一 T39，不在此启动服务。

## T33：编写独立登录、注册及错误密码页面旅程

**文件：** `web/e2e/phase1b-guest-save.spec.ts`。**依赖：** T19、T28、T30、T32。
**步骤：**
1. 为首次正确登录、注册成功、错误密码后正确登录各建立独立真实 UI 旅程；账号/副本隔离，保存结果关联所选原副本。
2. 补用户名冲突、非法注册及认证网络故障，断言认证失败期间认领写入为零、原请求不变，修复后同副本保存。
3. 切换登录注册及刷新保持意图，普通登录无认领；已有账号显示目标且确认前零保存。直接检查 API 归属与进度，不只检查 canvas。
**验证：** `git diff --check -- web/e2e/phase1b-guest-save.spec.ts` 无错误；`rg -n 'AC1|AC2|AC3|AC5|wrong-password|register|ordinary-login' web/e2e/phase1b-guest-save.spec.ts` 有独立用例标识。经授权的 T39 执行 `npm --workspace web run test:e2e -- --config playwright.guest-claim.config.ts --workers=1 --grep 'AC1|AC2|AC3|AC5'`，预期实际旅程全部通过；当前只准备不运行。

## T34：编写失败返回、丢响应与账号切换旅程

**文件：** `web/e2e/phase1b-guest-save.spec.ts`、`guest-claim-journey.spec.ts`、`guest-claim-recovery.spec.ts`。**依赖：** T33、T29、T31。
**步骤：**
1. 真实服务临时失败后返回同原副本，加入地点/分支/交互新进度，再用户重试保存，读回新旧进度。
2. `route.fetch()` 让真实服务保存后丢弃浏览器响应，刷新仅 GET 恢复同结果；未到 DB 的旧 POST 经 recover 阻断，延迟放行旧请求仍不能保存。另 reset/generation 变化后放行旧 POST/GET/recover，必须 source_changed、零新副本认领/阻断槽写入。
3. 旧 recovery 测试不能把裸 500 当确定未保存后立刻换账号；改为先核实/主动封闭，再切换确认。清理原有 headers/raw body 采集，不上传凭证。
**验证：** `git diff --check -- web/e2e/phase1b-guest-save.spec.ts web/e2e/guest-claim-journey.spec.ts web/e2e/guest-claim-recovery.spec.ts` 无错误；T39 云端执行 `npm --workspace web run test:e2e -- --config playwright.guest-claim.config.ts --workers=1 --grep 'AC4|AC6|AC7|AC9|guest interacts|failed claim'`，真实恢复写入唯一、刷新不 POST、新增进度可读；此任务不本机运行。

## T35：编写权限、不可恢复、存储与三视口边界

**文件：** `web/e2e/phase1b-guest-save.spec.ts`。**依赖：** T34。
**步骤：**
1. 覆盖账号会话失效保留 guest token、双身份恢复、他账号冲突无结果泄露；浏览器存储不可用/损坏不误认领。
2. 缺凭证、已确认过期和临时读取故障分别断言，主动新体验前创建数量为零，点击后明确新体验。
3. 三视口检查关键入口无裁切、页面可滚动、键盘焦点、鼠标与触摸；60 秒边界复用可控计时证据，服务端 120 秒用受控状态/故障验证，不空等长时间实例。
**验证：** `git diff --check -- web/e2e/phase1b-guest-save.spec.ts` 无错误；T39 云端执行 `npm --workspace web run test:e2e -- --config playwright.guest-claim.config.ts --workers=1 --grep 'AC8|AC10|AC11|AC12|AC13'`，权限/存储/生命周期边界与全部三视口符合实际行为。

## T36：实现 AC 矩阵与脱敏记录器

**文件：** `web/scripts/phase1b-guest-save.acceptance.ts`。**依赖：** T1、T32。
**步骤：**
1. 记录 AC1～AC14、当前 commit、runId、原副本/目标账号/操作/保存结果的脱敏关联与重复结果数量；区分真实 API、模型替身及故障注入。
2. 接收浏览器及定向测试结果，只允许明确白名单字段；原认证 body、HTTP headers、localStorage、数据库和密码/token 不进入产物。
3. 只在安全页面或清空认证输入后截图；缺证据标未验证，禁止把上一阶段可见性结果填成本阶段通过。提供 `--validate-manifest` 静态自检模式，不启动浏览器。
**验证：** `npm exec -- tsx web/scripts/phase1b-guest-save.acceptance.ts --validate-manifest`，报告 AC1～AC14 映射完整且零凭证字段，不启动服务/浏览器；真实证据填充与 screenshot 观察在 T39。

## T37：实现证据 finalizer 与清理核对

**文件：** `scripts/finalize-phase1b-guest-save-acceptance.mjs`、`finalize-phase1b-guest-save-acceptance.test.mjs`。**依赖：** T36。
**步骤：**
1. 核对当前版本、测试结果/截图/操作关联、保存 worldId 一致和重复结果数量，缺失或历史版本证据拒绝通过。
2. 对密码、token、headers、raw body/trace、数据库路径等敏感产物采用拒绝和白名单校验；成功/失败/未验证分别保留。
3. 接受本任务进程和目录清理回执并只读核实，清理未确认则 AC14 未验证；支持 `PHASE1B_EVIDENCE_DIR` 输入，不清他人资源。
**验证：** `node --test scripts/finalize-phase1b-guest-save-acceptance.test.mjs`，缺证据、错误版本、重复结果、凭证泄露和清理不明均拒绝通过，完整脱敏 fixture 正常生成报告。

## T38：准备可审阅的免费云端验证工作流

**文件：** `.github/workflows/phase1b-guest-save-acceptance.yml`。**依赖：** T32、T35、T37。
**步骤：**
1. 只开放 workflow_dispatch，不因文件 push 自动执行；contents:read、无需生产/真实模型 secret，锁定本轮 branch/SHA，使用 GitHub Actions 免费 runner 与临时本地 Worker/D1。
2. 准备顺序批次：定向汇合测试→API/Web 全回归→API/Web 构建→单 worker 三视口浏览器→finalizer。用 jobs needs/步骤顺序避免安装、构建和浏览器重负载并发。
3. 所有缓存/数据库/浏览器输出改道 runner 根文件系统本任务目录；trap/always 清理本任务服务，输出真实退出码和清理回执，只上传白名单脱敏产物。
4. 在申请执行前呈现具体 workflow diff、拟上传代码范围、分支/SHA、Actions dispatch/read 权限、免费额度前提、无模型调用和预计批次；不得先 push/dispatch。
**验证：** `git diff --check -- .github/workflows/phase1b-guest-save-acceptance.yml` 无错误；`rg -n 'workflow_dispatch|permissions|contents|needs|workers|trace|artifact|cleanup|TMPDIR' .github/workflows/phase1b-guest-save-acceptance.yml` 对照上述限制；已有 `actionlint` 时执行 `actionlint .github/workflows/phase1b-guest-save-acceptance.yml`，没有时不擅自安装，记录 YAML 检查待云端。本任务完成仅表示准备可审阅，不表示执行获批。

## T39：获明确授权后执行云端汇合与真实验收

**文件：** 不新增实现；读取 `.github/workflows/phase1b-guest-save-acceptance.yml`，产物在授权云端工作流指定目录。**依赖：** T19、T25、T27、T29、T31、T35、T38，以及用户对具体 GitHub Actions/代码上传/dispatch 的明确许可。
**步骤：**
1. 无许可时保留本任务待执行，明确未验证项；许可后仅上传批准分支和代码范围，dispatch 前固定 SHA，并用 `git ls-remote origin <授权分支>` 只读确认远端 SHA。
2. 按工作流执行受影响单文件汇合；随后串行运行 `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism`、`npm --workspace web test -- --maxWorkers=1 --no-file-parallelism`、`npm --workspace api run build`、`npm --workspace web run build`。如修改影响 contract，加入相关 workspace 定向测试；仓库无 lint script 不虚构已通过 lint。
3. 执行 `npm --workspace web run test:e2e -- --config playwright.guest-claim.config.ts --workers=1`，跑当前真实隔离三视口矩阵与调整后的旧旅程；禁止生产部署/远端持久世界/真实模型调用。
4. 每批记录实际退出码；失败先定位本阶段最小修复并跑定向回归，再重跑受影响云端批次，不反复盲跑完整矩阵。结束查询 workflow 状态与 SHA，下载仅脱敏批准产物。
**验证：** 授权后执行 `gh workflow run phase1b-guest-save-acceptance.yml --ref <授权分支>`；随后 `gh run list --workflow phase1b-guest-save-acceptance.yml --branch <授权分支> --limit 5` 找到本次 run，`gh run view <本次run-id> --json headSha,status,conclusion,jobs` 只读二次确认各批实际结果与 SHA。不能仅凭 dispatch/包装命令退出码报告通过；失败/未执行完整记入证据。

## T40：汇总真实证据、清理与验收记录

**文件：** `docs/spec_docs/phase1b-guest-save/task.md`、`checklist.md`；读取 T39 脱敏产物。**依赖：** T39，以及已批准 Checklist。
**步骤：**
1. 执行 finalizer，逐项核对 AC1～AC14 与已批准 Checklist 的可观察实际证据；正确登录、错误密码和注册必须分别有独立真实旅程。
2. 验证本任务临时服务/子进程退出、目录清理及没有上传原凭证；保持用户仍需服务和他任务目录不变。
3. 只依据实际结果登记通过、失败或未验证及原因；列出结果数量、最终进度读回、替身/注入范围、运行版本与云端 run 链接。所有修复定向重验，不虚报全量成功。
**验证：** `PHASE1B_EVIDENCE_DIR=<本次脱敏产物目录> node scripts/finalize-phase1b-guest-save-acceptance.mjs`，证据完整时退出 0 并输出全部关联与清理实际报告；缺失/失败退出非 0，文档如实记录。`git diff --check -- docs/spec_docs/phase1b-guest-save/task.md docs/spec_docs/phase1b-guest-save/checklist.md` 无格式错误。

### T39/T40 实际执行记录（2026-10-11）

- `360d939` 的 run `38125686791`：focused contracts 通过；API 回归因暂存克隆/迁移 fixture 兼容问题失败；finalizer 因缺少 manifest 失败。随后在 `16322c1` 修复并只读确认已推送 SHA。
- `16322c1` 的 run `38126276143`：focused、API/Web 回归通过；API build 因新增 staging 字段 fixture 和 claim response 类型未收窄失败；browser 被依赖跳过；finalizer 无 evidence manifest 失败。
- `e2d58e5` 的 run `38126869047`：focused、API/Web 回归通过；API build 仅剩 recover epoch 类型收窄失败；browser 被依赖跳过；finalizer 无 browser manifest 失败。
- `235b0c1` 的 run `38127264634`：已确认 head SHA 与远端一致，focused contracts 已通过；回归、build、browser、finalizer 结果待云端完成后补录。workflow 已增加 browser 结束时上传脱敏 manifest；未验证案例仍输出为 `partial`，不冒充全通过。
- 本机已通过：`node --test scripts/finalize-phase1b-guest-save-acceptance.test.mjs`（4 tests）、manifest tooling `--validate-manifest`、`git diff --check`。未在本机执行全量测试、build、Chromium 或 GUI。
- `da4c78f` 的 run `38130964273`：focused、API/Web regression、API/Web build 均通过；browser 为 21/24 通过，AC1 在 desktop/compact/mobile 均未渲染保存状态面板并超时；finalizer 成功但报告 `partial`（14 项 unverified，清理已确认）。
- `a926876` 的 run `38132958216`：focused、API/Web regression、API/Web build 均通过；browser 仍为 21/24，AC1 三视口相同未渲染状态面板；finalizer 成功生成 `partial`。当前剩余阻塞是 AC1 真实登录后 flow 面板未出现，需要后续单独修复并重验，不能标记 T39/T40 完成。

## 执行顺序与安全并行

```text
T1 → T2 → T3 → T4 ┬→ T5 → T6 ──────────────────┐
                  ├→ T7 ┬→ T8（另需T5）────────┤
                  │     └→ T9 → T10 → T11 → T12┤→ T15 → T16 → T17 → T18 → T19
                  │         └→ T13 ────────────┘                 （T19另需T13）
                  └→ T14 ──────────────────────┘

T1 ┬→ T20 ──────────┐
   ├→ T21 → T22 ────┴→ T23 → T24 → T25 → T26 → T27 → T28 → T29
   │                                                T21+T28 → T30 → T31（另需T29）
   └→ T32 → T36 → T37

T19+T28+T30+T32 → T33 → T34（另需T29+T31）→ T35
T32+T35+T37 → T38 可审阅工作流
T19+T25+T27+T29+T31+T35+T38 + 明确云端许可 → T39 → T40
```

下表为依赖满足后的最大轻量批次；可按队列滚动启动已经就绪的任务，不必等待本批无关慢任务。共享文件所有权仍优先于并行机会。当前团队可用槽有限时，从本批选资源互不冲突者执行，余者排队，不能将图中所有分支同时启动重型验证。

| 批次 | 就绪任务（可安全并行准备/轻量验证） | 汇合或共享限制 |
| --- | --- | --- |
| B1 | T1 | 两端 DTO 单 owner，先固定契约 |
| B2 | T2、T20、T21、T32 | 四个文件组独立；按可用 agent 槽/内存选择 |
| B3 | T3、T22、T36 | migration 与 store 各自独占；记录器只准备 |
| B4 | T4、T23、T37 | repository/flow/finalizer 独立 |
| B5 | T5、T7、T14、T24 | 仓储、迁移、状态、flow 独立；测试运行统一调度 |
| B6 | T6、T8、T9、T25 | cloner 与 migration 不同 owner，schema/DTO 不再并发改 |
| B7 | T10、T13、T26 | publication/engine/React 适配独立 |
| B8 | T11、T27 | 同 publication 测试文件不与 T10 同时改 |
| B9 | T12、T28 | clone 核验测试与 Login 独立 |
| B10 | T15、T29、T30 | 三文件组独立；T30 等 T28，无需等 T29完成 |
| B11 | T16、T31 | session-service 与 DemoLanding 独立 |
| B12 | T17 | routes 单 owner |
| B13 | T18 | routes 单 owner，不能与 T17同时编辑 |
| B14 | T19 | 真实参与回归准备/定向验证 |
| B15 | T33 | 主 E2E 文件单 owner，不能并发增加用例 |
| B16 | T34 | 主 E2E 与两旧旅程同 owner；共享端口只云端统一执行 |
| B17 | T35 | 主 E2E 文件继续单 owner |
| B18 | T38 | 工作流准备，可审阅后才申请具体云端许可 |
| B19 | T39 | 获授权才执行；全测试→构建→浏览器按需串行，不并发重负载 |
| B20 | T40 | 最后汇合证据与 Checklist，不提前标通过 |

## 覆盖与文档自检

| Plan 模块 | 对应任务 | Spec 验收归属 |
| --- | --- | --- |
| M1 操作仓储与数据库门禁 | T1～T8 | AC5、AC6、AC7、AC10、AC13 |
| M2 服务、状态与 HTTP | T14～T19 | AC1、AC2、AC5～AC10、AC13 |
| M3 候选克隆、核验、发布、清理 | T9～T13、T15～T16 | AC4、AC6、AC9、AC13 |
| M4 身份客户端、store、flow | T20～T26 | AC1～AC7、AC9～AC11 |
| M5 保存与恢复 UI | T27～T31 | AC1～AC5、AC7～AC12 |
| M6 真旅程、证据与资源 | T19、T32～T40 | AC1～AC14，三视口与资源清理 |

- 40 项均有具体文件、直接依赖、操作步骤与命令；任务依赖无环，单文件顺序与独立分支在 DAG/批次中明确。
- 数据库 epoch tombstone、失败推进 epoch、原副本 expectedBinding 比较、候选 INSERT/发布触发器、四归属同批、每条 cleanup marker 条件、前端 60 秒/后端 120 秒均有独立行为验证。原副本绑定补充已批准，仍须全部四份文档获批后才实现。
- GET 全只读、手动 recover 不跟随保存、认证失败保持 guest、未确认先核实原账号、存储异常、成功匹配清理及旧响应隔离均有定向任务。
- 所有 Plan 文件有实施或验证归属；未增加生产部署、账号转移、有效期延长、真实模型或跨设备恢复。
- 重型云端执行与可审阅工作流准备分离。Task 审批后进入 Checklist 设计；四文档获批前上述任务只作为待执行计划，不写实现、不启动验证、不登记通过。
