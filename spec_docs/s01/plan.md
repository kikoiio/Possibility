# s01｜P4 世界优先 UI 旅程验收 Plan

> 依据：[spec.md](./spec.md)。计划优先复用世界页、后台引擎与普通聊天现有路径；只有实际旅程或回归验证暴露缺口时，才修改运行时代码。

## 架构概览

- **世界运行与观察**：复用 `WorldView` 的快照、世界流、模拟时钟及暂停/继续控制；世界推进仍由后台 engine pinger 调用 `runTick` 完成。浏览器验收通过本地 pinger 启动/恢复世界并观察时间线和状态变化，不从用户浏览器直接调用内部 tick 接口。
- **普通居民聊天**：复用居民详情页按指定 timeline 创建/恢复对话的路径、`ChatStream` 的 SSE 展示和失败后读取服务端历史的恢复逻辑。若世界页没有清楚的普通聊天入口，只补一个从当前居民及时间线进入该路径的导航；聊天仍按其既有上下文与权限闸门执行。
- **时间线隔离**：复用 `WorldView` 的当前 timeline 标识、切换时重置页面增量状态、订阅清理和请求结果归属检查。人工走查与回归覆盖快速切换、旧流/旧请求迟到及断流后切线。
- **旅程证据**：用现有 API/世界旅程测试验证运行和对话的持久化边界；使用合成账号、本地隔离数据库及固定模型替身完成登录态浏览器主旅程；匿名页沿用 `readonly` 世界视图做只读边界验证。

## 核心数据结构与接口

本阶段沿用现有产品数据契约，不新增持久化业务模型。

### 世界与时间线快照

`web/src/api/types.ts` 中的 `WorldSnapshot` 在一次读取中提供世界状态、时间线列表、当前时间线 ID、模拟时间、`stateVersion`、地点居民分布、可见事实和事件。页面处理任何异步结果时都以当前 `worldId + timelineId` 为归属，并以 `stateVersion` 避免旧快照覆盖新状态。

```ts
interface WorldSnapshot {
  world: WorldSummary
  timelines: TimelineInfo[]
  currentTimelineId: string
  simNow: string
  stateVersion: number
  worldModelVersion: number | null
  evidenceStatus: 'structured' | 'legacy'
  currentFacts: WorldFact[]
  locationBoard: LocationBoardEntry[]
  events: WorldEventItem[]
}
```

现有 `WorldStreamEvent` 表示同步水位、事件、对话回合、居民状态和时钟变更。订阅在世界或时间线切换时清理；事件到达后只更新所属时间线的页面状态。

### 运行契约

`api/src/engine/tick.ts` 中的 `TickSummary` 汇总一次后台节拍对世界、时间线和执行步骤的结果；`runTick(env, db)` 推进所有运行中世界的活动时间线。用户界面的“继续”通过现有世界恢复路径改变运行状态，实际推进由本地/部署环境中的 engine pinger 触发，浏览器不直接调用内部 tick 入口。

### 普通对话契约

现有普通聊天以 `Conversation` 绑定人物和时间线，以 `Message` 表示已持久化的用户消息、人物完整回复或系统提示。居民详情页通过 `POST /api/persons/:id/conversations` 按时间线创建或取得对话；发送消息由 SSE 传回增量，只有完整成功的居民回复才进入持久历史。聊天上下文由 `buildAgentContext(...)` 按 user、person、timeline 和 chat 模式构造。

### 页面与客户端边界

本阶段复用 `worldsApi.snapshot/pause/resume`、`subscribeWorldStream(...)`、`postSSE(...)` 及聊天/人物 API。若新增世界页到普通聊天的入口，路由必须携带当前时间线；不另建聊天协议、运行 API 或旁路时间线状态。

## 模块设计

### 世界观察与操作

**职责：** 在当前世界/时间线下装载快照和增量事件，显示模拟时钟、状态与事件证据，提供暂停/继续、切线、Fork/Compare 等入口。

**对外接口：** `WorldView`；`WorldSnapshot` 和 `WorldStreamEvent`；现有 `worldsApi` 与 timeline API。必要时增加从居民抽屉进入普通聊天的导航，并将 `timelineId` 带入居民详情路由。

**依赖：** 世界快照/订阅 API、时间线选择器、地点面板、事件流、人物抽屉及已有 Fork/Compare 面板。

### 世界推进运行时

**职责：** 按当前运行规则推进世界时钟、日程、居民行为与事件，并回报节拍结果。

**对外接口：** 后台 `runTick` 和 engine tick 路由；浏览器只使用世界暂停/继续及快照/订阅接口。

**依赖：** 本地隔离 D1、engine pinger、固定模型替身、现有版本化世界提交及预算限制。

### 普通居民对话

**职责：** 按当前人物和时间线加载或创建普通聊天，显示已保存历史与流式回复，失败后核对服务端记录。

**对外接口：** 居民详情页、`ChatStream`、`/api/persons/:id/conversations`、`/api/conversations/:id/messages` 及 history 查询。

**依赖：** `buildAgentContext`、聊天预算/世界状态闸门、SSE 解析与当前时间线路由参数。

### 访问模式与旅程验收

**职责：** 确认匿名演示页只读；在合成账号下串起世界入口、运行、普通对话、切线、Fork/Compare 和返回；收集可复核证据。

**对外接口：** `DemoLanding` 的只读 `WorldView`；API 定向回归与本地登录态浏览器步骤。

**依赖：** 临时本地数据库、两个以上时间线、引擎 pinger/模型替身及浏览器验收记录。

### 需求归属

| Spec 需求 | 负责模块与接口 |
|---|---|
| F1 世界入口与当前时间线 | 世界观察与操作；`WorldSnapshot`、世界页 URL 及快照加载。 |
| F2 运行推进与可观察变化 | 世界推进运行时 + 世界观察与操作；`runTick`、engine pinger、`WorldStreamEvent`。 |
| F3 普通居民对话 | 普通居民对话；`PersonDetail`、`ChatStream`、聊天路由与 `buildAgentContext`。 |
| F4 对话与世界结果边界 | 普通居民对话 + 世界观察与操作；仅以可追溯世界状态/事件证据呈现变化。 |
| F5 Fork/Compare 路径衔接 | 世界观察与操作；`TimelineSwitcher`、`ComparePanel` 和带 timeline 的往返路由。 |
| F6 切换时间线隔离 | 世界观察与操作；清理订阅、重置增量状态、检查请求结果的时间线和版本。 |
| F7 访问模式边界 | 访问模式与旅程验收；公开 `DemoLanding` + `readonly` `WorldView`，服务端继续执行现有权限检查。 |

## 模块交互

```text
登录用户打开世界
  → WorldView 从 URL/快照解析 worldId 与 timelineId
  → 拉取 WorldSnapshot，并订阅该时间线的 WorldStreamEvent
  → 用户继续运行世界
  → 世界 resume 路由恢复运行状态
  → 本地 engine pinger 调用内部 tick 路由
  → runTick 推进活动时间线并提交版本化状态
  → 世界流发送 clock/state/event/sync
  → WorldView 只接纳当前时间线且版本未倒退的数据
```

```text
用户从世界页打开居民普通聊天
  → 居民抽屉导航至 /people/:personId?timeline=:timelineId
  → PersonDetail 按该时间线创建或恢复 Conversation
  → ChatStream 读取历史并发送消息
  → chat API 基于固定 world/person/timeline 构造上下文并流式返回
  → 仅完整回复进入已保存历史；失败后重新读取服务端消息
  → 返回 /worlds/:worldId?timeline=:timelineId
  → WorldView 重新载入该线快照与订阅
```

```text
用户切换时间线 / Fork / Compare
  → 更新所选 timelineId（并同步到世界 URL）
  → 关闭旧订阅、清空旧线增量状态
  → 载入新线快照并建立新订阅
  → Compare 关闭或聊天返回时仍恢复指定时间线
```

匿名入口继续由 `DemoLanding` 加载公开快照并以只读 `WorldView` 展示，不开放写入控件或调用用户写入接口。

## 文件组织

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改（若缺入口/切线状态问题） | `web/src/pages/WorldView.tsx` | 同步 URL 的 `timelineId`，衔接世界运行状态与当前居民详情入口。 |
| 修改（若缺少导航） | `web/src/components/world/PersonDrawer.tsx` | 提供进入当前居民普通聊天的入口，并携带所选时间线。 |
| 修改（若返回或异步归属有缺陷） | `web/src/pages/PersonDetail.tsx`、`web/src/components/ChatStream.tsx` | 保证普通聊天使用路由时间线，失败/返回状态与服务端历史一致。 |
| 新建或修改测试 | `web/src/pages/WorldView.test.tsx`、`web/src/components/ChatStream.test.tsx` | 覆盖 URL 恢复、切线迟到结果及对话中断/历史恢复。若现有测试设施不能稳定挂载这些页面，再按实际结构调整位置。 |
| 修改或新增测试 | `api/src/chat/routes.test.ts`、`api/src/engine/tick.test.ts`、`api/src/test/product-journey.test.ts` | 验证聊天上下文/完成回复持久化、真实 tick 推进以及跨 API 主旅程中的世界证据。现有 `chat/routes.test.ts` 不存在时新建。 |
| 修改 | `spec_docs/s01/checklist.md` | 在 checklist 阶段把批准后的 AC1–AC8 转为逐项可执行检查并记录结果。 |
| 修改 | `docs/current-state-audit.md`、`docs/world-quality-report.md` | 记录 P4 起点、实际验收环境/结果及未通过或未知范围。 |

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 世界推进触发 | 复用世界暂停/继续和后台 engine pinger；不让浏览器直调内部 tick 接口。 | 与现有运行和租约模型一致，真实验证产品的后台推进路径。 |
| 当前时间线保存 | 将 `timelineId` 放入世界页 URL；进入居民聊天时传递到现有 `timeline` 参数，返回时恢复相同 timeline。 | 让刷新、返回、深链和聊天往返都指向明确上下文。 |
| 普通对话入口 | 从世界当前居民打开标准居民详情聊天；保持它与在场交流模式分开。 | 普通聊天和在场交流的身份、地点、资格、保存及知识规则不同。 |
| 流式回复恢复 | 保持服务端“仅完整居民回复入历史”的规则；前端断流后重新读取会话历史。 | 防止把半截输出显示为已完成回复，并尊重现有持久化事实。 |
| 验收运行环境 | 合成账号 + 一次性本地 D1 + 本地 engine pinger + 固定模型替身。 | 可重复验证真实运行/聊天集成，同时避免依赖真实模型、远端数据库或生产数据。 |
| 修复范围 | 先复测现有功能；仅对 AC 失败暴露的缺口做最小修改。 | 保持 P4 限定为旅程验收，不扩成 UI 重做。 |
