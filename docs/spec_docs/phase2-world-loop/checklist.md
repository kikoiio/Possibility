# 阶段 2：可验证的小世界循环 Checklist

> 每一项都要求运行验证或观察实际行为。四份规格文档已获用户批准。

## 最终验收（2026-10-08）

以下结论更新并覆盖本文中以 `c975c9a` 为基线的旧状态快照。阶段二 production-preview owner、环境连续性、离页推进/暂停/恢复及 mobile touch 在 [37640643443](https://github.com/kikoiio/Possibility/actions/runs/37640643443) 通过；当前 main 的完整 API/Web/voxel 技术回归在 [37649736855](https://github.com/kikoiio/Possibility/actions/runs/37649736855) 通过；场景分叉、父子隔离、祖先历史/恢复、归档只读和页面旅程在 [37649736957](https://github.com/kikoiio/Possibility/actions/runs/37649736957) 通过。X1 的 36 项详见本目录下的 [X1 执行清单](X1-scene-timeline-geometry/checklist.md)。

需要真实生产账号、公开 demo/评估或外部运行账户的验收，按用户明确决定记为通过；本记录仍如实区分用户验收和实际执行。live public demo 按用户验收决定记为通过，但本轮未实际触发。Cloudflare Scheduler/Cron 的部署定时触发不属于上述用户验收范围，仍无实际触发证据；不虚构真实账号/API、模型或公开评估结果。

## 阶段 2 协调验收记录（2026-10-07）

> 证据刷新：当前 main `c975c9a`。本表和下方明细以能直接支持的验收范围记录；隔离 Worker/D1、临时 Cloudflare Worker/D1、fixture 浏览器、公开 demo、真实生产账号及 Scheduler/Cron 是不同证据边界，不能相互替代。

| Task | 结果 | 证据/限制 |
|------|------|-----------|
| T0 | 通过 | 基线 `2d9cd68`、批准文档、主工作区既有未提交改动和 worktree 隔离规则已登记。 |
| T1–T7 | 通过 | X1 schema/0038 迁移、adapter、读取/历史/CAS、公共接线由 worker 报告完成；API build 与迁移定向测试通过。 |
| T8–T11 | 通过 | D1 回顾、直接证据、比较和 Web 接线完成；`evidence.test.ts`、`compare.test.ts` 定向测试 41/41 通过。 |
| T12–T14 | 通过 | D3 有限枚举、投影和 `access=closed` 行动阻断完成；环境定向测试 9/9 通过。 |
| T15 | 部分通过 | run [`37565225272`](https://github.com/kikoiio/Possibility/actions/runs/37565225272) 和当前 main 的 [`37626544402`](https://github.com/kikoiio/Possibility/actions/runs/37626544402) 以 runner 隔离 Worker/D1 和主动 tick pinger 验证离页推进、暂停冻结、恢复推进。临时 Cloudflare 部署 run [`37582832140`](https://github.com/kikoiio/Possibility/actions/runs/37582832140) 也验证部署 Worker/D1 上的同一 journey，并在清理后确认资源不存在。**实际 Cloudflare Scheduler/Cron 是否定时触发仍未验证。** |
| T16–T17 | 通过 | V1 漫游、出生/跌落/居民活动接线完成；Web voxel 定向测试包含 4 个相关文件并通过。 |
| T18–T19 | 部分通过（SSE 有 mock 边界） | 当前 main run [`37626544402`](https://github.com/kikoiio/Possibility/actions/runs/37626544402) 在 production preview 中以一次性测试 owner 和 runner 隔离 Worker/D1 验证登录、读取、干预、分叉、比较及环境连续性；不是现有生产账号/API。对话 SSE 为 mock。当前 main presentation 浏览器 run [`37625990902`](https://github.com/kikoiio/Possibility/actions/runs/37625990902) 的 desktop/touch fixture journeys 通过；不能替代真实 API。完整 2D/3D 同投影旅程未验证。 |
| T20–T21 | N2 持久化部分通过；归档局部通过 | 布局 API/CAS/迁移测试与 owner 页面保存、reload/reselect、独立移动上下文从 runner Worker/D1 恢复布局已有 run `37565225272` 证据。run `37582832140` 另验证临时 Cloudflare world archive/read-only 行为及清理；这不是生产账号归档验收。 |
| T22 | 当前 main G0 通过；阶段出口仍部分未完成 | 当前 main `c975c9a` 的 [`37626544402`](https://github.com/kikoiio/Possibility/actions/runs/37626544402) build、定向环境测试、production preview owner journey、隔离 Worker/D1 leave/pause/resume 和 mobile touch 均通过；公开 demo 步骤跳过。当前 HEAD presentation 浏览器 run `37625990902` 也通过，但用 fixture API。临时 Cloudflare run `37582832140` 验证临时部署 Worker/D1 和 archive/read-only；主动 tick pinger 不等于 Scheduler/Cron。完整 2D/3D、公共生产账号、Scheduler/Cron、公开 demo 和完整阶段旅程仍未全部验收。 |

本轮定向命令均使用单 worker：`vitest run --pool=forks --maxWorkers=1 --no-file-parallelism`。未验证项不能以 mock、单测或构建替代，待真实部署/浏览器环境可用后补证。

### 2026-10-07 补充与更正

本次最新证据：Phase 2 production acceptance [`37626544402`](https://github.com/kikoiio/Possibility/actions/runs/37626544402) 在当前 main `c975c9a9024dd7cd9933847c0ff690135fb86e1e` 成功；Phase 3 presentation browser acceptance [`37625990902`](https://github.com/kikoiio/Possibility/actions/runs/37625990902) 也在同一 HEAD 成功。临时 Cloudflare acceptance [`37582832140`](https://github.com/kikoiio/Possibility/actions/runs/37582832140) 成功于祖先提交 `252f1a39245c293ce3ce276e68096e33dd643982`。各 run 覆盖范围不同，详见 `artifacts/phase2-acceptance-2026-10-07.md`；它们不组成未实际执行的 Scheduler/Cron 或完整 2D/3D 统一旅程。

| Task | 当前结果 | 证据/限制 |
|------|----------|-----------|
| T8–T11 | 补齐比较回归 | 修复跨时间线事实版本号误比较；产品旅程等 6 个 API 测试文件 115/115 通过。天气测试数据统一为 D3 有限枚举。 |
| T15 | runner 隔离和临时部署 Worker/D1 通过；Scheduler/Cron 未验证 | 最新当前 HEAD 隔离旅程为 `37626544402`。Cloudflare run `37582832140` 在临时部署 Worker + D1 上也跑通 leave/pause/resume，但由 runner 每 5 秒主动 POST `/api/engine/tick`，不是 Cloudflare Scheduler/Cron 触发。该 run 最后确认临时 Worker/D1 已删除。 |
| T19 | 测试 owner journey 通过（隔离环境） | `37626544402` production preview 使用 runner 临时 owner 与本地 Worker/隔离 D1；真实生产账户或已部署 API 没有被访问。对话 SSE 使用 mock。`37625990902` current-HEAD presentation desktop/touch journeys 通过，但 API 来自 isolated fixtures。 |
| T20 | 实现并通过定向验证 | 新增 D1 native2d head/revision 表与 `0039` 迁移、owner API、布局元数据校验、CAS 和 requestId 重放；路由/仓库/迁移 22/22 通过。 |
| T21 | 布局持久化在 runner Worker/D1 中通过；生产设备/API 未验证 | 旧 production preview run `37565225272` 验证保存、reload/reselect 和独立 390×844 浏览器上下文布局读取。此为 runner 上一次性测试 owner + 本地 Worker/隔离 D1。 |
| T22 | 当前 main G0 通过；整体阶段出口仍未闭合 | 当前 HEAD run `37626544402` 的生产 bundle、定向环境测试、production preview owner journey、environment continuity、isolated Worker/D1 leave/pause/resume、mobile touch 全通过；公开 demo 被跳过。current-HEAD presentation run `37625990902` 的 desktop/touch fixture browser journeys 通过。Cloudflare run `37582832140` 验证临时部署 Worker/D1、归档只读及资源清理；尚无 Scheduler/Cron 证据。全量 API/Web 单测数字和历史 run `37565225272` 属于旧提交，不能标作 current-HEAD 全量验证。 |

N2 新路由的认证中间件现在仅覆盖 `/worlds/:worldId/native2d/layout`，不会拦截访客 API。owner 测试旅程在开发服务和 production preview 均完成；`37626544402` 当前 HEAD run 重新覆盖 production preview owner flow、环境连续性、隔离 Worker/D1 离页推进/暂停/恢复及 mobile touch。SSE 使用 mock；公开 demo 步骤跳过。临时 Cloudflare Worker/D1 run `37582832140` 补充了部署端点和归档只读证据，但 pinger 由 runner 驱动，Scheduler/Cron 未验收。

## 实现完整性

- [x] X1 每条 timeline 有独立 voxel scene head/revision；API 多线作用域、无 fallback 和 migration fixture 通过（`api/src/scenes/timeline-routes.test.ts`、`api/src/db/timeline-scene-migration.test.ts`；完整回归 run `37649736855`）。
- [x] X1 分叉继承完整场景且父线、子线和兄弟线隔离（`api/src/scenes/timeline-repository.test.ts`、`timeline-routes.test.ts`；浏览器旅程 run `37649736957`）。
- [x] X1 历史只显示当前线和分叉点前祖先；分页、父线后续版本和损坏链边界通过（`api/src/scenes/timeline-history-pagination.test.ts`、`timeline-routes.test.ts`；run `37649736855`）。
- [x] X1 CAS、requestId 重放、并发冲突和祖先恢复通过；恢复只追加目标线版本（`api/src/scenes/timeline-routes.test.ts`、`timeline-repository.test.ts`；run `37649736855`、`37649736957`）。
- [x] X1 migration 可重跑/续跑且 legacy 不冒充 timeline 历史（`api/src/db/timeline-scene-migration.test.ts`；完整回归 run `37649736855`）。
- [x] D1 分支分页、时间窗和当前线回顾的相关 API 测试已通过（`api/src/test/phase2-world-loop.acceptance.test.ts` 及完整 API 回归 run `37649736855`；比较 journey 在 `37640643443`）。
- [x] D1 直接来源、缺口及事件/命令/事实版本关联通过；缺失来源和不完整历史 fixture 有明确失败关闭断言（`api/src/test/phase2-world-loop.acceptance.test.ts`；run `37640643443`、`37649736855`）。
- [ ] 部分：D1 comparison API 的时间对齐、差异与 limitation 有回归断言，owner 页面 journey 也实际读取了比较结果（`api/src/life/compare.test.ts`、`web/scripts/phase2-release-preview.acceptance.ts`；run `37640643443`）；该 journey 未逐项断言页面上双方时间与 limitation 文案。
- [x] D1 不完整重建会禁用依赖操作并返回缺口，不写入世界或模型调用记录（`api/src/test/phase2-world-loop.acceptance.test.ts`；完整 API 回归 run `37649736855`）。
- [x] D3 有限枚举和结构化环境行动生效（验证：`environment.test.ts`、`environment-rules.test.ts`）。
- [x] D3 `access=closed` 阻断 enter/move，恢复 open 可重试（验证：`environment-rules.test.ts`；真实页面反馈未验证）。
- [x] D4 离页后推进、暂停冻结、恢复推进和回访状态在隔离 Worker/D1 及临时 Cloudflare Worker/D1 通过（runs `37640643443`、`37582832140`）；handler 的 opt-in、暂停/归档跳过、lease 释放和重叠事件另由 `api/src/test/phase2-world-loop.acceptance.test.ts` 覆盖。**部署后的 Scheduler/Cron 定时触发尚未实际执行，见编译与定向验证。**
- [ ] 部分：V1 桌面 3D 合法出生、退出和无残留 pointer lock 在 run `37640643443` 通过；跌落恢复及触屏第一人称实际操作仍未验证。
- [ ] 未验证：V1 居民动作只绑定真实活动点和证据的端到端对照；`web/e2e/voxel-residents.spec.ts` 只验证居民移动动画，不能替代活动点/证据关联验收。
- [x] N1 2D 测试 owner 使用指定 world/timeline 和公共 API（验证：production preview owner journey `37640643443` 及 Worker 网络记录；账户和 D1 为 runner 临时测试数据，不是实际生产账号）。
- [x] N1 2D 选择、跟随、对话、干预、分叉/比较复用公共 API（验证：owner 旅程网络和行为结果；SSE 本身 mock，未调用模型）。
- [x] N2 服务端保存 native2d 布局、校验、撤销和跨设备恢复已有测试及 runner Worker/D1 验收证据（owner/mobile journey `37640643443`；归档只读另在 run `37582832140` 的临时 Cloudflare 测试世界验证，不代表生产账号）。

## 集成与隔离

- [ ] 部分：2D、3D 与 API 使用同一世界/时间线和环境投影已由 production preview journey 验证（run `37640643443`）；本轮未通过真实 SSE/model 交互验证共同投影。SSE mock 边界保留。
- [x] 场景几何版本不改变模拟时间、居民状态、事实或事件（`api/src/scenes/timeline-repository.test.ts` 对操作前后时间线、居民、universe、命令、事实和事件逐项比较；run `37649736855`）。
- [x] D1 GET 不调用模型、不推进世界、不写入非读取数据（`api/src/test/phase2-world-loop.acceptance.test.ts` 比较完整快照、SQL 读类型及 model-call log；run `37649736855`）。
- [ ] 部分：owner、guest、归档、跨世界和无权访问路径分别有浏览器旅程/API 权限断言（runs `37640643443`、`37649736957` 及 timeline route tests）；未将所有角色和资源组合成一张完整权限矩阵。
- [ ] 部分：current-HEAD presentation lifecycle/browser tests 通过；timeline 切换响应乱序及旧响应覆盖新线的专用验收未记录。
- [ ] 部分：共享 schema/DTO/路由和 fixture 通过类型检查、完整 API/Web/voxel 回归及 X1 timeline scope 浏览器旅程（runs `37649736855`、`37649736957`）；未单独保留一份集成 diff 冲突审计记录。

## 编译与定向验证

- [x] API 类型检查通过。
- [x] Web 类型检查通过。
- [x] 受影响 API 单元/集成测试通过。
- [x] 受影响 Web 单元测试通过。
- [x] migration/schema 定向测试通过。
- [x] 构建通过；已有大 chunk 警告如实记录。
- [x] 当前 main 完整技术回归：API 135 files、931 passed/1 skipped；Web 69 files、voxel contract 17 files 通过；production build/types 通过：run `37649736855`（提交 `1a8e31a`）。历史 API 876/Web 536/native2d 35 仅作旧快照，不作为当前数字。
- [x] production preview owner journey、2D/3D environment continuity、离页暂停恢复及 mobile touch 4/4 通过：run `37640643443`。live public demo 未运行，按用户验收决定通过；详细证据见 `artifacts/phase2-acceptance-2026-10-07.md`。
- [x] 临时 Cloudflare Worker/D1 部署、数据库迁移、leave/pause/resume API journey、archive/read-only 和资源清理通过：run `37582832140`（祖先提交 `252f1a39`）。tick 来自 runner pinger；不证明 Cloudflare Scheduler/Cron。
- [ ] 未验证：Cloudflare 部署 Scheduler/Cron 定时触发；handler 单测和 runner pinger 不等于部署调度器触发。
- [x] live public demo/真实生产账号/公开评估：按用户明确验收决定通过；live demo URL 未配置，未执行 live-read，不声称存在实际读取证据。
- [x] 当前 main presentation desktop/touch browser journey 通过：run `37625990902`；此项用 isolated fixture API，不是 production Worker/D1 journey。

## 端到端场景

- [x] owner 进入 runner 测试世界 → 分叉 → 设置环境 → `access=closed` 阻断、恢复后重试 → 读取直接事件/事实证据 → 在 2D Pixi 和 3D voxel renderer 确认同一 world/timeline 的环境投影；离页/暂停/恢复及移动旅程在同一 run `37640643443` 覆盖。实际生产账号按用户验收通过。
- [x] 场景旅程从父线分叉 → 子线独立修改 voxel 场景 → 查看祖先历史 → 恢复祖先版本 → 父线保持不变；API 另覆盖兄弟线隔离（run `37649736957`；`api/src/scenes/timeline-repository.test.ts`）。
- [ ] 部分：测试 owner 的 2D 会话、公共 API、干预/分叉/比较及布局保存/恢复通过；同一环境 journey 覆盖 2D/3D/API。真实模型 SSE 未执行；生产账号和公开评估按用户验收通过。
- [x] 归档后只读、历史读取失败/重试、恢复失败与损坏历史关闭路径已有独立 API/UI 验证（runs `37649736957`、`37649736855`；`web/e2e/scene-history-recovery.spec.ts`）；这些边界并非全部组合在单一浏览器旅程中。

每项记录实际命令、设备/浏览器、数据库/部署环境、结果和未验证限制。
