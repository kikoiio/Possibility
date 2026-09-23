# s01｜P4 世界优先 UI 旅程 Tasks

> 依据：[spec.md](./spec.md) 与已批准的 [plan.md](./plan.md)。四份规格文档全部获批前，不开始以下实现任务。

## 执行状态

| 任务 | 状态 | 实际结果 |
|---|---|---|
| T01 基线与隔离约束 | 完成 | 记录 P4 起点 HEAD、分支、既有差异和临时本地服务边界。 |
| T02 URL 时间线恢复 | 完成 | 实现 timeline query 恢复、切线同步及保留其他查询参数；浏览器刷新复测。 |
| T03 普通聊天入口与返回 | 完成 | 人物抽屉增加普通聊天入口，人物页返回链接保留 world/timeline；定向 Web 测试通过。 |
| T04 聊天时间线上下文与失败 | 完成 | API 测试覆盖会话归属/拒绝副作用/完整回复；浏览器完成固定回复与部分回复断流恢复。Web workspace 没有 DOM 测试运行器，未新增不能运行的 `ChatStream.test.tsx`。 |
| T05 tick 与版本保护 | 完成 | 实际 tick、版本与 timeline 门控由 API 单元/旅程、双 Worker D1 审计及浏览器 pinger 观察覆盖。 |
| T06 API 产品旅程 | 完成 | 固定旅程串联 tick、普通聊天及 Fork/Compare，并验证聊天不伪造世界事实。 |
| T07 隔离浏览器环境 | 完成 | manual-ui 临时 D1、本地模型替身与合成账号已启动并清理。 |
| T08 登录态运行与恢复 | 完成 | 浏览器确认暂停/继续、tick 推进、状态版本、模拟时间及刷新后 timeline 恢复。 |
| T09 普通聊天完整/断流旅程 | 完成 | 正常回复完成并重载；断流后只保留用户消息，半截回复未进入完成历史；返回世界仍为原线。 |
| T10 时间线迟到结果隔离 | 完成 | 本地代理将旧主线第二次快照响应延迟 12 秒；创建并选中 Fork 后释放响应，页面仍选择该分支且保持 v0/0 事件。延迟聊天仍只保存在原线；Web 守卫回归覆盖清理订阅与 timeline 错配结果。 |
| T11 Fork/Compare 往返 | 完成 | 登录态浏览器创建带条件分支、进入对照、返回主线并继续普通聊天。 |
| T12 匿名只读边界 | 完成 | demo fixture 下匿名页面只有只读公开视图与登录入口；公开路由回归覆盖拒绝写入。 |
| T13 回归与报告 | 完成 | API/Web 全量测试、构建、Worker 集成脚本、报告和清理状态均有记录；AC1–AC7 均通过，S01 P4 阶段出口通过。 |

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改（如验收发现缺口） | `web/src/pages/WorldView.tsx` | 从 URL 恢复并同步当前 timeline；维持当前线快照、订阅和操作结果的归属。 |
| 修改（如缺普通聊天入口） | `web/src/components/world/PersonDrawer.tsx` | 从世界当前居民进入其普通聊天，并传递 timeline 参数。 |
| 修改（如返回/迟到结果有缺陷） | `web/src/pages/PersonDetail.tsx`、`web/src/components/ChatStream.tsx` | 按路由时间线加载对话；失败后核对已保存历史。 |
| 新建或修改 | `web/src/pages/WorldView.test.tsx` | 覆盖时间线 URL 恢复、切线状态清理和旧结果隔离。 |
| 新建或修改 | `web/src/components/ChatStream.test.tsx` | 覆盖完整回复、断流后历史重读及会话切换隔离。 |
| 新建 | `api/src/chat/routes.test.ts` | 覆盖普通聊天时间线上下文、权限/世界状态闸门和仅完整回复持久化。 |
| 修改 | `api/src/engine/tick.test.ts`、`api/src/test/product-journey.test.ts` | 覆盖实际 tick 推进及推进/聊天/世界证据的组合旅程。 |
| 修改 | `spec_docs/s01/checklist.md` | 按批准的 P4 验收标准记录执行结果。 |
| 修改 | `docs/current-state-audit.md`、`docs/world-quality-report.md` | 记录 P4 起点、实际证据、失败和未知范围。 |

## T01｜记录 P4 验收基线与隔离环境约束

**文件：** 无（只读盘点；之后将摘要写入审计报告）。
**依赖：** 无。

**步骤：**
1. 记录验收开始时的 HEAD、分支和工作区状态，明确 P4 前已存在的改动不归入本轮。
2. 确认本地 D1 使用本轮唯一临时目录；模型替身、API、Web 和 pinger 仅绑定本地验收服务。
3. 确认运行环境不读取项目默认 D1、不访问远端数据库，不把凭据写入仓库或验收报告。

**验证：** `git rev-parse HEAD`、`git branch --show-current`、`git status --short` 有记录；本地服务启动参数指向唯一临时 D1，模型替身地址为本地地址。（N4–N6）

## T02｜让当前时间线可由世界 URL 恢复

**文件：** `web/src/pages/WorldView.tsx`、`web/src/pages/WorldView.test.tsx`。
**依赖：** T01。

**步骤：**
1. 读取 `timeline` 查询参数并校验它属于当前世界；无参数时继续使用快照返回的默认时间线。
2. 用户切线和 Fork 成功选中子线时同步 URL；刷新或重新进入时按 URL 恢复该线。
3. 每次切换继续重置旧线本地增量状态并清理旧订阅。
4. 增加测试覆盖无参数默认、有效 timeline 恢复、无效/无权时间线错误和切线 URL 更新。

**验证：** `npm --workspace web run test -- src/pages/WorldView.test.tsx`；刷新后恢复同一线，无效时间线显示明确错误，切线不保留上一线增量内容。（AC1、AC5、AC6）

## T03｜从世界居民详情进入普通聊天并保留时间线

**文件：** `web/src/components/world/PersonDrawer.tsx`、`web/src/pages/WorldView.tsx`；必要时修改 `web/src/pages/PersonDetail.tsx`。
**依赖：** T02。

**步骤：**
1. 在可操作模式的人物抽屉提供普通聊天入口；匿名只读视图不显示该入口。
2. 导航到 `/people/:personId?timeline=:timelineId`，并确认居民详情页以此 timeline 取得/创建会话。
3. 提供返回当前世界的路径，包含原 `worldId` 与 `timelineId`。
4. 覆盖世界页→居民聊天→返回的路由参数与时间线恢复。

**验证：** `npm --workspace web run test -- src/pages/WorldView.test.tsx`；普通聊天请求绑定所选线，返回世界后 URL、标题和快照仍对应原线。（F1、F3、F5）

## T04｜固定普通聊天失败与时间线上下文回归

**文件：** `api/src/chat/routes.test.ts`、`web/src/components/ChatStream.test.tsx`；若复现缺陷，再最小修改 `api/src/chat/routes.ts` 或 `web/src/components/ChatStream.tsx`。
**依赖：** T03。

**步骤：**
1. 在 API 测试中建立同一居民的两条时间线会话，确认聊天上下文、历史查询和提交均使用会话绑定时间线。
2. 覆盖跨用户、归档线、暂停/触顶拒绝路径，并核对被拒请求没有写入用户消息或人物回复。
3. 让固定模型替身完整结束一次回复，再让其输出部分文本后断流；确认仅完整回复写入历史。
4. 在前端测试中核对断流后重读服务端消息，未持久化的半截回复不会作为完成记录保留。

**验证：** `npm --workspace api run test -- src/chat/routes.test.ts` 与 `npm --workspace web run test -- src/components/ChatStream.test.tsx`；完整消息和失败边界与数据库历史一致。（AC3–AC4）

## T05｜覆盖真实运行入口与时间线更新保护

**文件：** `api/src/engine/tick.test.ts`、`web/src/pages/WorldView.test.tsx`；若复现缺陷，再修改对应运行/视图代码。
**依赖：** T02。

**步骤：**
1. 使用固定时钟和模型替身运行一次实际 tick，断言活动时间线模拟时刻推进，并通过快照/账本得到可追溯结果。
2. 覆盖没有新事件但时钟/推进结果有效的情况，不要求生成固定叙事事件。
3. 测试旧版本快照、旧线世界流事件和当前线新版本到达时的接受/丢弃规则。
4. 复用 pause/resume 与 pinger；不增加浏览器直调 tick 的路径。

**验证：** `npm --workspace api run test -- src/engine/tick.test.ts`、`npm --workspace web run test -- src/pages/WorldView.test.tsx`；模拟时间确有推进，旧线/旧版本数据不能覆盖当前线。（AC2、AC6）

## T06｜串联 API 世界运行、对话与证据旅程

**文件：** `api/src/test/product-journey.test.ts`；必要时修改 `api/src/test/world-journey.test.ts`。
**依赖：** T04–T05。

**步骤：**
1. 在固定世界和 timeline 中提交一次真实引擎推进，读取更新后的世界快照与可见证据。
2. 为当前居民创建普通聊天并完成一轮回复，确认对话时间线归属。
3. 核对仅有可追溯事实/事件时才把它们作为世界变化证据；聊天文本本身不创建未记录的世界变化结论。
4. 再 Fork 子线，验证主线与子线的返回标识和状态没有串线。

**验证：** `npm --workspace api run test -- src/test/product-journey.test.ts src/test/world-journey.test.ts`；旅程结果包含运行前后时间线/版本、聊天历史及可追溯证据。（AC2、AC4–AC5）

## T07｜启动隔离浏览器验收环境

**文件：** 无新增产品文件；将实际浏览器步骤和观察结果写入 `docs/current-state-audit.md`。
**依赖：** T01。

**步骤：**
1. 运行 `npm run verify:s01:workers -- --manual-ui`，记录脚本输出的一次性 D1 路径、API 地址、合成账号和验收世界。
2. 在独立终端以显式本地 API 地址和验收专用 tick secret 启动 `scripts/engine-pinger.ts`；不读取 `api/.dev.vars`。
3. 确认浏览器、API、固定模型替身和 D1 全部位于本机验收环境。

**验证：** `npm run verify:s01:workers -- --manual-ui` 显示本地 API、合成登录和临时 D1；pinger 输出本地 API tick 结果；确认未启动远端服务。（N1、N5）

## T08｜验证登录态世界推进与恢复

**文件：** 无新增产品文件；将实际浏览器步骤和观察结果写入 `docs/current-state-audit.md`。
**依赖：** T05、T07。

**步骤：**
1. 在浏览器中以合成账号登录并打开验收世界。
2. 通过产品界面继续运行世界，并由本地 pinger 调用后台 tick。
3. 观察世界模拟时间、状态面板、事件流和证据；记录至少一次 tick 前后的 timeline、版本和模拟时间。
4. 刷新或离开后重新进入，确认世界和所选时间线可恢复。

**验证：** 浏览器记录包含实际运行前后可见时间/状态及 timeline；本地 pinger 日志和隔离 D1 快照相互印证。（AC1–AC2、N1、N6）

## T09｜验证普通聊天完成、断流和返回世界

**文件：** `web/src/pages/WorldView.test.tsx`；人工观察写入 `docs/current-state-audit.md`。
**依赖：** T03–T04、T08。

**步骤：**
1. 从当前世界居民抽屉打开普通聊天，确认 URL 和人物详情显示同一 timeline。
2. 用本地固定模型替身完成一轮聊天；重载会话并确认完整用户/居民消息仍在历史中。
3. 使用可控替身断流一次，检查界面提示与服务端记录；确认半截居民回复不显示为完成历史。
4. 返回世界并检查所选 timeline、世界证据和状态没有被聊天响应串线。

**验证：** 浏览器观察和临时 D1 消息记录一致；完成回复已保存，断流回复未伪装为完成，返回后恢复原 timeline。（AC3–AC5、N3、N6）

## T10｜验证快速切线与迟到结果隔离

**文件：** `web/src/pages/WorldView.test.tsx`；人工观察写入 `docs/current-state-audit.md`。
**依赖：** T02、T08–T09。

**步骤：**
1. 在两条活动时间线间快速切换，并人为延迟旧线快照/订阅响应。
2. 在聊天请求进行中切线，确认旧对话响应只影响旧会话，不覆盖新线页面。
3. 切线后检查时钟、事件、居民详情、对话和状态面板均属于当前选择。

**验证：** `npm --workspace web run test -- src/pages/WorldView.test.tsx`；浏览器记录证明旧结果未覆盖新线，且断流后切换不会污染当前线。（AC6）

## T11｜验证 Fork/Compare 往返衔接

**文件：** 无新增产品文件；人工观察写入 `docs/current-state-audit.md`。
**依赖：** T02、T08–T09。

**步骤：**
1. 从世界观察页创建带明确条件的 Fork。
2. 打开 Compare，确认可进入对照并关闭面板。
3. 返回用户指定时间线，继续观察或打开居民普通聊天。

**验证：** 浏览器记录包含 Fork 子线 ID、URL timeline、Compare 返回线及之后观察/聊天所处的 timeline，均与用户选择一致。（AC5）

## T12｜核对匿名只读与拒绝路径

**文件：** 若现有路由测试未覆盖本阶段入口，则修改 `api/src/public/routes.test.ts`；浏览器观察写入 `docs/current-state-audit.md`。
**依赖：** T03、T07。

**步骤：**
1. 匿名打开公开首页，确认可查看允许公开的世界信息且没有运行、普通聊天或写入操作入口。
2. 对匿名运行/聊天/写入请求逐项确认服务端拒绝。
3. 比较请求前后的版本、命令、事实及投影数量，确认无副作用。

**验证：** `npm --workspace api run test -- src/public/routes.test.ts`；浏览器页面为只读，API 拒绝写请求且隔离库账本不变。（AC7）

## T13｜运行 P4 回归并记录出口结论

**文件：** `spec_docs/s01/checklist.md`、`docs/current-state-audit.md`、`docs/world-quality-report.md`。
**依赖：** T01–T12。

**步骤：**
1. 运行本任务单所列 API/Web 定向测试及 API/Web 构建，记录实际命令和退出结果。
2. 为 AC1–AC7 汇总自动化结果、登录态浏览器观察、环境信息和可复核账本证据。
3. 记录服务关闭、临时 D1/模型替身清理以及未能验证的范围。
4. 只有 AC1–AC7 全部通过且证据完整时，才将 P4 标记为出口通过；失败和 unknown 保持显式状态。

**验证：** `npm --workspace api run build`、`npm --workspace web run build` 及所有指定定向测试均有结果记录；报告与 checklist 的 AC 状态一致。（AC8、N4–N6）

## 执行顺序

```text
T01 → T02 → T03 → T04 ─┐
        └────→ T05 ────┼→ T06 → T07 → T08 → T09 → T10 → T11 ─┐
                       └──────────────→ T12 ──────────────────┴→ T13
```
