# E1：变化发现、证据追溯与离开期间回顾 — 验收清单

> 状态说明：`[x]` 已由自动化用例或构建验证；`[~]` 已实现或部分覆盖，但缺少完整专项验证；`[ ]` 尚未验证。

## 1. 变化发现与回顾水位

- [x] AC1.1 合成登录账号进入真实 API 支持的世界后，可见回顾摘要。证据：`web/e2e/e1-change-review.integration.spec.ts`。
- [x] AC1.2 环境状态与约定变化均由直接来源事实突出并链接命令。证据：`api/src/life/evidence.test.ts`、`api/src/life/commitment-journey.test.ts`。
- [x] AC1.3 API 无新增记录返回空变化及空摘要；浏览器用例单独验证了空状态文案。
- [x] AC1.4 有界事件分页稳定前进且不重复；API 用例覆盖两页及排序，并确认未来事件未进入当前时刻结果。
- [x] AC1.5 双水位保存在用户+时间线键上；API 测试覆盖已读后回访、页后新增和跨分支进度隔离，UI 提交已加载页水位。
- [x] AC1.6 API 用例在回顾页返回后插入新事件，再标记旧页已读；新事件仍待读，且分支水位独立。不同用户访问同一世界由 owner 权限拒绝覆盖。

## 2. 事件详情与证据完整性

- [x] AC2.1 API/UI 返回并显示事件、来源命令、关联事实、居民名、地点和时间；真实 API/D1 浏览器旅程断言 Cafe、Ada 与日期。
- [x] AC2.2 事实关联只采用显式来源 ID；API 用例验证同一模拟时刻的无来源事件不会误关联无关状态事实，UI 明确说明未知和时间相近不证明因果。
- [x] AC2.3 缺失来源命令/事实时原始事件保留并填入 `gaps[]`；另覆盖不支持的历史重建。缺失字段保持可空，不生成补造关联。
- [x] AC2.4 UI 分区展示记录、可能相关与未知，并明确时间相近不证明因果；浏览器旅程验证了分区标题和说明。
- [x] AC2.5 浏览器故障注入先返回 503，重试后成功显示详情；另一浏览器用例验证不支持重建保留缺口并禁用 F1。API 和 UI 均保持只读实现。

## 3. 权限与知识边界

- [x] AC3.1 非所有者回顾返回 404；兄弟线事件详情也返回 404，作用域 API 用例通过。
- [x] AC3.2 API 用例验证兄弟线事件不会进入回顾或证据详情；真实 D1 浏览器旅程只访问新建世界的当前线。
- [x] AC3.3 API 用例确认私信正文不进入公共事件描述，且仅 owner 保护的证据详情含正文。
- [x] AC3.4 E1 API 用例确认无来源消息为传闻；复用 K1 重建路径。
- [x] AC3.5 回顾/证据 API 受 owner auth 保护，Web 类型检查与生产构建通过；本功能不调用模型。

## 4. 模拟时间与检查点

- [x] AC4.1 API 用例注入未来事件并确认分页不返回；查询同时过滤事件和事实的 `simTime <= simNow`。
- [x] AC4.2 使用三个重建校验函数，并在详情返回状态版本与完整域；完整重建用例通过。
- [x] AC4.3 完整重建时可进入 F1；API 用例确认 unsupported 时 `forkAvailable=false`，浏览器用例确认详情说明缺口且不显示分叉入口。
- [x] AC4.4 真实 API/D1 浏览器旅程从 E1 检查点打开 F1、保留精确时点与假设、编辑动作并完成实际分叉提交；F1 API 用例另验证过期版本冲突无写入。
- [x] AC4.5 E1 详情明确说明时间相近不代表因果；复用既有比较逻辑。

## 5. 兼容性与数据库迁移

- [x] AC5.1 API 全套 682 项回归通过，包含约定及未读消息既有行为；E1 不改变这些权限与计数逻辑。
- [x] AC5.2 0035 在临时 D1 成功应用且二次运行报告无待执行迁移；独立 SQLite 迁移用例确认旧行 `revision_version=0`。
- [x] AC5.3 API 全套回归覆盖访客/demo 既有 fork 路径，F1 浏览器入口与提交旅程通过；demo fork 行为未改动。
- [x] AC5.4 API 用例对比回顾与详情 GET 前后的命令、事实、事件和已读水位，确认没有写入。

## 6. 端到端旅程

- [x] AC6.1 真实登录浏览器旅程与 D1 持久化覆盖地点状态变化；约定变化及重点摘要由真实 API 旅程验证，两类变化分别验证。
- [x] AC6.2 真实 D1/API 浏览器旅程覆盖来源事实、居民名、模拟时刻、历史状态；API 用例补充居民知识确定性，UI 展示事实/关联/未知分区。
- [x] AC6.3 真实浏览器旅程验证标记旧页已读后，新写入的变化仍出现；API 用例验证兄弟线水位独立，非 owner 被拒绝。
- [x] AC6.4 真实 API 浏览器旅程从可重建检查点打开 F1、预填时点/假设并提交环境动作；过期版本由 F1 API 原子冲突用例验证。
- [x] AC6.5 API 用例覆盖原始事件与来源缺口及 GET 前后无写入断言；Playwright 覆盖证据读取失败后重试。

## 7. 验证记录

| 检查 | 状态 | 日期/环境 | 命令或操作 | 结果与证据 |
| --- | --- | --- | --- | --- |
| API 全套与定向回归 | 通过 | 2026-10-04 / B worktree | `api/npm test -- --pool=threads --maxWorkers=1 --no-file-parallelism`；最新专项 `src/life/evidence.test.ts src/db/e1-migration.test.ts` | 104 个文件、682 项通过，1 文件/1 项跳过；最新 evidence 专项 5 项通过。 |
| Web 单测与生产构建 | 通过 | 2026-10-04 / B worktree | `web/npm test -- --pool=threads --maxWorkers=1`；`web/npm run build` | 47 文件、272 项通过；TypeScript 与 Vite 生产构建通过。 |
| D1 迁移与旧行兼容 | 通过 | 2026-10-04 / B worktree | 临时本地 D1 启动并二次执行 `wrangler d1 migrations apply`；`api/src/db/e1-migration.test.ts` | 0035 成功应用且二次执行无待迁移；SQLite 用例确认已有行新字段默认为 0。 |
| 浏览器旅程 | 通过 | 2026-10-04 / B worktree | `PLAYWRIGHT_API_PORT=18877 PLAYWRIGHT_WEB_PORT=15201 npm --prefix web run test:e2e -- --project=desktop-chromium --workers=1 e1-change-review.spec.ts e1-change-review.integration.spec.ts` | 2 项通过：stub 旅程覆盖证据失败重试、空状态和 unsupported 检查点禁用 F1；集成旅程通过真实注册、世界/事实/回顾/证据/已读 API 与临时 D1，验证页后新增记录、地点/居民/时点证据、F1 时点/假设预填、动作编辑与真实原子分叉提交。场景渲染使用 fixture；预览草稿为合成响应。 |
| 代码边界回归 | 通过 | 2026-10-04 / B worktree | `api/npm test -- --pool=threads --maxWorkers=1 --no-file-parallelism src/life/evidence.test.ts`；`web/npm test -- --maxWorkers=1 --no-file-parallelism src/components/world/forkMoment.test.ts` | E1 evidence 5 项、时点解析 6 项通过；覆盖同时间无关事实不误关联及毫秒精度检查点预填。 |
| 既有 fork/约定/未读消息回归 | 通过 | 2026-10-04 / B worktree | API 全套单 worker 回归；F1 stale-source 与原子提交用例；真实约定 API 旅程 | API 全套 682 项通过、1 项跳过；访客/demo fork、约定、未读及兼容路径保持通过。 |

## 8. 实施结论

- 当前整体状态：E1 实现、API/Web 构建、全量 API 回归及两条浏览器旅程完成；真实 E1→F1 浏览器旅程包含动作编辑、提交与成功回执。
- 覆盖说明：环境变化浏览器旅程与约定变化 API 旅程分别验证；所有规格验收项均有对应证据，逐项记录见本清单。
- 风险/限制：历史旧记录可能没有来源或完整状态快照；按规格显示证据缺口，不追补或改写历史。
