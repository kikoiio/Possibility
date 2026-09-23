# s01｜基线与兼容闭环 Tasks

本任务单只覆盖 [spec.md](./spec.md) 中的 AC1–AC6。先核实仓库现有实现和证据；已有内容满足要求时只运行并记录验证，不为“完成任务”而重复造实现。遇到范围外缺口时，记录后续归属并停在本阶段边界。每项任务聚焦一个检查或行为；若发现修复超出该范围，先拆项，不继续扩大当前任务。

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 核对；有缺口时修改 | `docs/current-state-audit.md` | 当前代码状态、基线命令、证据与 P0 阶段判断 |
| 核对；仅在用例不足时修改 | `api/src/test/world-fixture.ts` | 稳定小世界夹具 |
| 核对；仅在用例不足时修改 | `api/src/test/world-journey.test.ts` | 夹具重复性与确定性基线旅程 |
| 核对；仅在用例不足时修改 | `api/src/test/legacy-compat.test.ts` | 旧数据读取、时间线边界、归属及只读行为 |
| 核对；仅在用例不足时修改 | `api/src/test/legacy-migration.test.ts` | 旧行保留与迁移 SQL 回归 |
| 条件新建 | `scripts/verify-s01-migrations.*` | 只有现有 Wrangler 命令无法安全隔离时，才增加临时 D1 验证入口 |
| 条件修改 | 根目录 `package.json` | 仅当需要为隔离迁移入口增加明确脚本时修改 |

本任务单不修改数据库 schema 或新增生产迁移。若 P0 证据表明确有代码缺陷，只允许修复满足 AC1–AC5 所需的最小路径，并在对应任务中记录变更；更大改动先停止并另行规格化。

## T01｜记录工作区起点

**文件：** `docs/current-state-audit.md`
**依赖：** 无。

**步骤：**
1. 记录当前分支、HEAD 提交及工作区是否有改动。
2. 区分 s01 开始前已存在的差异与本轮文档/代码变更，不把既有改动归入本轮。

**验证：** 报告记录可与 `git status --short`、`git rev-parse HEAD` 对照。（AC6）

## T02｜记录 API 测试基线

**文件：** `docs/current-state-audit.md`。
**依赖：** T01。

**步骤：**
1. 运行 `npm --workspace api run test`。
2. 记录退出码、测试数及失败摘要；实施前的 79 项只保留为历史基线。

**验证：** 命令可复现，记录反映本次实际输出。（AC1、AC6）

## T03｜记录 API 类型检查基线

**文件：** `docs/current-state-audit.md`。
**依赖：** T01。

**步骤：**
1. 运行 `npm --workspace api run build`。
2. 记录退出码及若有的诊断。

**验证：** 报告结果与命令输出一致。（AC1、AC6）

## T04｜记录 Web 构建基线

**文件：** `docs/current-state-audit.md`。
**依赖：** T01。

**步骤：**
1. 查明并运行 Web workspace 的构建脚本。
2. 记录实际命令、退出码及诊断；不将“构建通过”当作行为验收。

**验证：** 报告记录可按命令复现。（AC1、AC6）

## T05｜列出 P0 数据和路由范围

**文件：** `docs/current-state-audit.md`；只读核对 schema、世界/场景/聊天/Fork/Compare/公开路由。
**依赖：** T01。

**步骤：**
1. 列出本规格覆盖的旧数据种类及对应表。
2. 列出读取/写入入口及其用户、世界、时间线归属来源。
3. 为每个入口标记已有测试、待验证行为或不属于 s01 的范围。

**验证：** 每个列出的入口都能对应到实际路由；未覆盖部分明确标记。（AC2–AC4、AC6）

## T06｜验证小世界夹具重复性

**文件：** `api/src/test/world-fixture.ts`、`api/src/test/world-journey.test.ts`。
**依赖：** T01。

**步骤：**
1. 核对夹具使用固定时间、原创数据和稳定的世界/时间线/地点标识。
2. 连续两次独立创建夹具，比较世界、居民关联、时间线和地点的基线描述。
3. 仅在比较不稳定时补充固定输入或断言。

**验证：** `npm --workspace api run test -- src/test/world-journey.test.ts`；两次描述相同。（AC1）

## T07｜验证基线旅程不依赖真实模型

**文件：** `api/src/test/world-journey.test.ts`。
**依赖：** T06。

**步骤：**
1. 检查夹具旅程调用的模型/网络边界。
2. 确认旅程绕过模型，或使用固定响应替身。
3. 仅补齐本阶段基线所需断言，不扩展为 P1–P4 全旅程。

**验证：** `npm --workspace api run test -- src/test/world-journey.test.ts`；旅程结果不依赖真实模型或外网。（AC1）

## T08｜验证旧数据仍可读取

**文件：** `api/src/test/legacy-compat.test.ts`。
**依赖：** T05、T06。

**步骤：**
1. 建立代表性旧世界/居民状态、对话/消息、事件、记忆和承诺行。
2. 通过现有读取入口分别检查各类数据仍可见。
3. 只为缺失的数据类型补充对应断言。

**验证：** `npm --workspace api run test -- src/test/legacy-compat.test.ts`；各类旧数据都有读取证据。（AC2）

## T09｜验证缺证据历史不会变成确定事实

**文件：** `api/src/test/legacy-compat.test.ts`；必要时核对世界状态查询与 Compare。
**依赖：** T08。

**步骤：**
1. 准备没有完整快照或结构化来源的旧 Fork/历史记录。
2. 检查读取结果明确标记不完整、`legacy` 或 `unknown`。
3. 检查事件/记忆/对话文本没有被推断为确定事实。

**验证：** `npm --workspace api run test -- src/test/legacy-compat.test.ts`；缺失证据的记录不被补造。（AC2）

## T10｜验证省略和有效时间线 ID

**文件：** `api/src/test/legacy-compat.test.ts`；相关世界/时间线路由。
**依赖：** T05、T06。

**步骤：**
1. 对合同允许省略时间线 ID 的入口验证其默认主线行为。
2. 对显式有效 ID 验证响应来自指定时间线。
3. 仅为实际覆盖不足的入口补充正向断言。

**验证：** `npm --workspace api run test -- src/test/legacy-compat.test.ts`；默认和显式有效 ID 行为有独立断言。（AC3）

## T11｜验证无效时间线 ID 被拒且无回退

**文件：** `api/src/test/legacy-compat.test.ts`；必要时核对相关路由。
**依赖：** T10。

**步骤：**
1. 分别提交不存在、异世界和无权访问的时间线 ID。
2. 验证请求明确失败。
3. 对拒绝写入检查主线及其他相关行没有变化。

**验证：** `npm --workspace api run test -- src/test/legacy-compat.test.ts`；拒绝请求未读写主线作为回退。（AC3）

## T12｜验证私人数据归属边界

**文件：** `api/src/test/legacy-compat.test.ts`、相关 API 路由测试。
**依赖：** T05、T06。

**步骤：**
1. 以另一用户请求私人世界和时间线数据。
2. 以不匹配的世界/时间线组合发起读取及写入。
3. 验证请求被拒；检查写入请求没有数据库副作用。

**验证：** `npm --workspace api run test -- src/test/legacy-compat.test.ts`；越权读取/写入均失败且无副作用。（AC4）

## T13｜验证公开演示只读

**文件：** 公开路由测试；必要时核对 `api/src/public/routes.ts`。
**依赖：** T05、T06。

**步骤：**
1. 验证匿名用户仍可读取公开演示内容。
2. 对公开 API 写入入口提交请求。
3. 验证写入被拒绝，且相关数据没有变化。

**验证：** `npm --workspace api run test -- src/public/routes.test.ts`；公开读取通过、写入被拒。（AC4）

## T14｜验证迁移 SQL 保留旧行

**文件：** `api/src/test/legacy-migration.test.ts`、`api/drizzle/*.sql`（只读核对）。
**依赖：** T01。

**步骤：**
1. 在内存 SQLite 中应用迁移前序并插入代表性旧数据。
2. 保存相关旧表的行快照，再应用待验证迁移。
3. 比较迁移前后的旧行，并单独检查新增结构。

**验证：** `npm --workspace api run test -- src/test/legacy-migration.test.ts`；旧行快照一致。（AC5）

## T15｜预检隔离 Wrangler D1 目标

**文件：** 条件新建 `scripts/verify-s01-migrations.*`；条件修改根目录 `package.json`。
**依赖：** T14。

**步骤：**
1. 查看已安装版本的 `wrangler d1 migrations apply --help`，确认本地持久化目录的指定方式。
2. 若 CLI 可直接安全隔离，记录精确命令；否则增加使用临时配置/目录的单一验证入口。
3. 在预检模式打印并核对配置文件、D1 名称、local 模式和临时持久化路径；默认或不匹配路径必须在迁移前失败。
4. 确认清理动作只会作用于本入口创建的临时目录。

**验证：** 预检能证明目标是新建临时目录；默认路径或错误配置会在迁移前退出。（AC5）

## T16｜重复应用隔离迁移

**文件：** T15 的隔离入口（若新建）、`docs/current-state-audit.md`。
**依赖：** T15。

**步骤：**
1. 创建全新隔离 D1，确认起始状态为空。
2. 应用完整迁移序列一次并记录迁移状态和关键表快照。
3. 对同一隔离库再次执行迁移，检查无待执行迁移且快照不变。
4. 记录临时路径与清理结果；确认没有指定默认本地或远端库。

**验证：** 第二次执行没有新增迁移或额外状态变化；默认/远端数据库未作为目标。（AC5）

## T17｜汇总证据并判定 s01 出口

**文件：** `docs/current-state-audit.md`。
**依赖：** T01–T16。

**步骤：**
1. 为 AC1–AC5 记录当前命令、结果和可复核证据位置。
2. 对未通过/未验证项写明原因、重现步骤和后续归属。
3. 仅当 AC1–AC5 全部通过且 AC6 报告完整时，判定 s01 出口通过；任一 AC1–AC5 失败或未验证都表示阶段未关闭。
4. 汇总本轮工作区差异，并与 T01 记录的起点区分。

**验证：** `git diff --check`；报告中的结论与命令结果一致。（AC6）

## 执行顺序

```text
T01 → T02 → T03 → T04 → T05 → T06 → T07
                         ├→ T08 → T09
                         ├→ T10 → T11
                         ├→ T12
                         └→ T13
T01 → T14 → T15 → T16
T01–T16 完成后 → T17
```

T08–T09、T10–T11、T12、T13、T14 可以在各自依赖完成后分组执行。T16 必须等隔离目标预检通过后进行。T17 最后执行。

## 停线规则

- 发现 P1–P4 缺口时，只记录归属，不在本任务单中实现。
- 若验证需要真实 Cloudflare 远端、多 Worker 压力或真实模型响应，标为“本地未验证”，不得换用默认数据库或外部环境绕过限制。
- 若无法证明 Wrangler 目标数据库与持久化目录已隔离，停止迁移验证并记录阻塞原因。
- 若修复需要超出单项行为的跨模块改造，暂停该项并拆出新任务；不得把大型重构塞入当前子任务。
