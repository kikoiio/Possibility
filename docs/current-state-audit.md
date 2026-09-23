# 当前状态盘点（s01 / P0）

## s01 执行起点（2026-09-23）

- 分支：`main`；HEAD：`03427d9cca6108075171649955cb302e0e43a393`。
- 工作区起点：64 个已跟踪路径有修改/删除，40 个未跟踪路径；这些是本次 P0 执行前已存在的工作区状态，不归为本轮实现产出。未跟踪项包括 `spec_docs/`、世界状态/行动模块、测试、迁移及质量报告等。
- 当前会话在 P0 执行前只改写了 `spec_docs/s01/{spec,plan,task,checklist}.md`；这些文件所在目录在起点已整体处于未跟踪状态，无法用 Git 基线逐文件比较。
- 本节记录时尚未运行本轮 P0 测试、类型检查、Web 构建或 Wrangler 迁移验证；下文历史结果不代表本轮验收通过。

2026-09-22 的历史基线为 API 79/79，并通过 API 类型检查与 Web 构建；旧记录中的 API 195/195 是更早一次实施回归。P0 本轮实测结果见下文，不以这两组历史数字替代当前证据。更广的实现范围和后续阶段缺口仍见 [实施质量报告](./world-quality-report.md)。

## 本轮基线结果

| 检查 | 本轮结果 | 证据 |
|---|---|---|
| API 测试 | 通过，30 个测试文件 / 205 个测试 | `npm --workspace api run test`，Vitest 退出码 0 |
| API 类型检查 | 通过 | `npm --workspace api run build`，TypeScript 退出码 0 |
| Web 构建 | 通过 | `npm --workspace web run build`，TypeScript 与 Vite 退出码 0 |

质量报告中记录的 API 195 项是更早一轮结果；本轮实际 API 测试数为 205。以上结果不包括 Web 单元测试，也不代表 s01 所有兼容和隔离迁移验收已通过。

## P0 数据与入口清单

| 数据/行为 | 主要入口 | 归属或边界 | 已有验证位置 |
|---|---|---|---|
| 世界、居民和当前状态 | `GET /api/worlds/:id`、`GET /api/worlds/:id/state`、`GET /api/worlds/:id/persons/:pid` | 私人世界先按 `worlds.user_id` 校验；显式时间线须属于该世界 | `api/src/test/legacy-compat.test.ts` |
| 对话及逐句历史 | `GET /api/worlds/dialogues/:id`、`GET /api/worlds/:id/scene/history`、`GET /api/conversations/:id/messages` | 由 dialogue/conversation → timeline/world → owner 检查 | `api/src/test/legacy-compat.test.ts` |
| 记忆与事件 | 世界快照、人物焦点、`GET /api/worlds/:id/return` | timeline/人物可见范围；自由文本不构成结构化事实证明 | `api/src/test/legacy-compat.test.ts` |
| 承诺 | `GET /api/worlds/:id/return`、`POST /api/worlds/:id/commitments/:commitmentId` | commitment 同时受 world、timeline 和 owner 约束 | `api/src/test/legacy-compat.test.ts`、`api/src/life/service.test.ts` |
| Fork 与对照 | `GET /api/timelines/:id`、`GET /api/worlds/:id/compare` | timeline 必须属于已授权世界；旧快照可标记历史不完整 | `api/src/test/legacy-compat.test.ts`、`api/src/life/compare.test.ts` |
| 时间线 ID 解析 | 世界快照/状态、注入、场景、章节及公共读取入口 | 合同允许省略时才可默认主线；显式无效或错配 ID 必须拒绝 | `api/src/test/legacy-compat.test.ts` |
| 公开演示 | `GET /api/public/*` 读取路由 | 未认证只读；`publicRoutes.all('*')` 拒绝未定义路径和写入口 | `api/src/public/routes.test.ts` |

## P0 验收结果（2026-09-23）

| AC | 状态 | 本轮证据 |
|---|---|---|
| AC1 | 通过 | API 30 个测试文件 / 205 个测试通过；API `tsc --noEmit` 通过；Web `tsc --noEmit && vite build` 通过。固定世界旅程测试 4/4 通过，比较两次独立夹具的世界、居民关联、时间线和地点数据。 |
| AC2 | 通过 | `npm --workspace api run test -- src/test/legacy-compat.test.ts`：9/9。读取覆盖旧居民状态、事件、场景逐句记录、聊天消息、人物详情中的旧记忆和承诺；无快照 Fork 返回历史不完整；结构化状态读取保持 `evidenceStatus: legacy` 且 `facts: []`。 |
| AC3 | 通过 | 同一回归验证省略 ID 默认到主线、显式旧 Fork ID 精确定位、无效/异世界 ID 拒绝；拒绝请求后事件数不变，且不触发模型调用。 |
| AC4 | 通过 | `legacy-compat.test.ts` 验证跨用户世界/状态/交谈/写入被拒且无新增事实，另一用户不能读取/改动对话、记忆、章节和时间线；`npm --workspace api run test -- src/public/routes.test.ts`：1/1，匿名演示读取可用、写入口拒绝。 |
| AC5 | 通过 | `npm --workspace api run test -- src/test/legacy-migration.test.ts`：4/4，SQLite 行快照保持不变。Wrangler 4.126.0 在两次全新创建的 `/tmp` 隔离目录中各完成 19 条本地 D1 迁移；同一隔离库重复运行显示 `No migrations to apply`。重复运行前后 27 张表/系统表的 schema 与行数快照 SHA-256 均为 `62d3bd409112cd7fb8ae49bbc7057e0c716f1467f6b6bb63dd04dab0b003935a`；临时目录已删除，未指定默认本地库或远端库。 |
| AC6 | 通过 | 本报告区分历史基线、本轮命令结果、既有工作区变更和本轮新增断言；结果均有具体命令或观察证据。 |

**迁移运行说明：** 沙箱内首次 Wrangler 尝试在监听本地端口前失败，没有应用迁移。获准后使用 `--local --persist-to <新建 /tmp 目录>` 完成本地验证；第一次成功运行时 Wrangler 默认 metrics 未关闭，日志显示尝试派发 CLI 使用遥测，实际送达状态无法确认。为获得可复核快照而进行的第二轮完整验证已设置 `WRANGLER_SEND_METRICS=false`。两轮的 D1 目标都在临时 `/tmp` 目录。

**本轮改动边界：** P0 执行只在两个起点时已存在但未跟踪的测试文件 `api/src/test/legacy-compat.test.ts`、`api/src/test/world-journey.test.ts` 中增加了兼容读取和稳定居民关联断言，并更新本未跟踪的本盘点文档；没有改动运行时代码或数据库迁移。执行前后 Git 概览仍为 64 个已跟踪变更、40 个未跟踪路径，未提交既有工作区内容。

**s01 出口：通过。** AC1–AC5 全部通过，AC6 报告完整。P1–P4 的未验收项不影响本 P0 出口。

## 可继续利用的资产

- `api/src/db/schema.ts` 已有世界、时间线、人物状态、日程、事件、对话、记忆、约定与分叉快照。
- `api/src/engine/tick.ts` 已按世界与活跃时间线推进；成本护栏见 `api/src/engine/guard.ts`。
- `api/src/world-state/system.ts` 将引擎虚拟时钟推进与命令版本、事实及 `simNow` 投影原子提交；首次 tick 只建立真实时间锚点，不补造停机期间的世界事件。
- `api/src/scene/routes.ts` 已有在场交谈、请求去重与服务器会话历史；`api/src/life/service.ts` 已有明确接受的约定。
- `api/src/life/fork.ts`、`api/src/agent/visibility.ts` 已支持当前时刻分叉与旧快照降级；`api/src/life/compare.ts` 展示记录差异，未宣称因果。
- `web/src/pages/WorldView.tsx` 已能观察地点、事件、人物并进入世界。

## 当前不能宣称的能力

- `events.title/description` 是叙述记录，不是可校验的统一世界事实。结构化状态集中在 `person_states` 等少数表中。
- `worlds.locations_json`、`persons.model_json` 是共享定义，现有 Fork 没有固定完整的世界规则/居民模型版本。
- `api/src/life/fork.ts` 对带场景的历史时间拒绝创建；当前没有任意历史时刻的完整世界 Checkpoint。
- `api/src/scene/routes.ts` 支持交谈，但在场者的连续位置、通用行动和局部知识约束尚不是统一状态判定。
- `api/src/engine/tick.ts` 的进程内 `tickInFlight` 不能独自保证跨实例的并发互斥。

## P0 已识别并前置修复的范围错误

在本轮开始前，`worldSnapshot`、世界事件注入和章节生成对显式传入的无效时间线 ID 存在回落主线的路径。该行为会使读/写落到错误宇宙。P0 的 `legacy-compat.test.ts` 固定此回归：只有省略 ID 才可使用默认主线；显式无效/异世界 ID 必须拒绝。

## 数据兼容原则

旧事件、旧记忆、旧 Fork 保持可读；缺少结构化证据的地方展示不完整或未知。不得依据既有自由文本批量回填“确定事实”。新增状态从可验证的起点开始；完成隔离本地 D1 迁移与回归后才允许切换权威写路径。
