# T02：左右 pane 读取与权限契约审计

## 范围与基线

- 只读检查当前 `p3-t02-access` 子 worktree 的已提交基线 `ab0911f`（`docs: approve phase three delivery plan`）；没有读取或拷贝 main worktree 的未提交内容。
- 本文是代码路径审计，不代表本次运行了 API、浏览器或集成验证。下面“已支持”表示此基线上有明确实现/测试证据；“候选”表示从调用链可见的限制，尚未作为产品验收实测。
- `task.md` 指定 `/docs/*` 被 `.gitignore` 忽略；本文件需显式 `git add -f` 纳入提交。

## 读取入口和数据流

| 场景 | 客户端入口 | 服务端读取入口 | 身份/范围来源 | 证据结论 |
|---|---|---|---|---|
| 登录账户（owner） | `mapApi.bootstrap(worldId, timelineId?)` → `GET /api/worlds/:worldId/map/bootstrap`；携带 Bearer token | `mapRoutes` → `loadMapBootstrapForAccess` → `resolveWorldScope` → `worldSnapshot`；bootstrap 返回 `access`、世界快照、场景、呈现状态和恢复位置 | `resolveAccessContext` 从有效 session/Bearer 得到 user；`resolveWorldScope` 只在 `world.userId === access.userId` 时视为拥有者；能力由 `capabilitiesFor` 生成 | **已支持**：owner 能读取自己的 bootstrap 和显式时间线；非 owner 被拒。能力和场景均来自服务端，不由 URL 声明。 |
| Guest sandbox | `guestMapApi.bootstrap(worldId, timelineId?)` → 同一 bootstrap 路由，显式发送 `X-Possibility-Guest` 且不发送 Bearer | 同上；Guest `AccessContext` 必须匹配 session 的 `currentSandboxWorldId`，bootstrap 的 world/timeline 仍由 scope 和 snapshot 查询约束 | `resolveAccessContext` 校验 guest token/session 状态；`resolveWorldScope` 要求 worldId 等于 session sandbox 且 world owner 等于 session owner；`capabilitiesFor` 给 sandbox guest observe/participate/fork/compare/resetDemo，但不允许 editScene/persist | **入口已实现；guest bootstrap 专项结果未核验**：Guest 参与测试验证了限定 sandbox 的 world state 读取、越界世界拒绝及参与写入，但没有覆盖 `/map/bootstrap` 本身。 |
| 匿名只读演示（readonly UI） | `readonly && !guest` 时并行调用 `publicApi.snapshot(worldId, timelineId?)` 和 `publicApi.scene(worldId)`；不调用 map bootstrap | `GET /api/public/worlds/:id[?timelineId=]`、`GET /api/public/worlds/:id/scene`；公开子应用只接受 `isDemo = true` 的世界，并对未定义路径/写操作兜底 404 | 无账户身份；服务端用 `world.isDemo` 限定演示公开读取。此响应不包含 `access` capability 对象 | **已支持**：匿名演示快照、场景只读 GET 有测试；**账户型 readonly/只读账号角色未核验**，当前可见的是 UI 布尔分支和公开演示路由，不是账户角色契约。 |

相关实现：`web/src/api/client.ts`（`mapApi`、`guestMapApi`、`publicApi`、`apiFetchAsGuest`）、`web/src/pages/WorldCanvasPage.tsx`、`api/src/map/routes.ts`、`api/src/map/bootstrap.ts`、`api/src/access/middleware.ts`、`api/src/access/world-scope.ts`、`api/src/access/policy.ts`、`api/src/public/routes.ts`、`api/src/worlds/routes.ts`。

## 时间线、simNow 与状态版本

- `worldSnapshot(db, worldId, timelineId)` 先取该 world 下时间线集合；明确传入的 timeline 必须在集合内，否则返回 `null`，不静默切回主线。未指定时选根时间线（否则首条）。输出 `currentTimelineId`、当前 timeline 的 `simNow`、所有 timeline 的 `simNow`，以及当前 revision 的 `stateVersion`（无 revision 时为 `0`）。证据：`api/src/worlds/queries.ts#L64-L78`、`#L170-L190`。
- `loadMapBootstrapForAccess` 在权限 scope 通过后按显式 timeline 或已保存偏好读 snapshot；只有未指定 timeline 且偏好失效时才回退默认 snapshot。`presentation.timelineId/stateVersion/simNow` 直接复制同一个 snapshot；代码注释说明 bootstrap 不推进模拟、不写 scene revision。证据：`api/src/map/bootstrap.ts#L42-L54`、`#L71-L100`。
- owner 的 map resume 按 `userId + worldId` 存储，并验证 world 所有权、timeline 所属和空间 ID；guest resume 按 session 存储，并验证当前 sandbox world 与 timeline 所属。证据：`api/src/map/resume.ts#L16-L55`、`#L57-L83`。readonly public 路径不读写这些偏好。
- `WorldCanvasPage` 对 owner/readonly 的主 snapshot 订阅 stream 后用 stateVersion 防止旧事件覆盖新快照；guest 不订阅该页面的 stream。右侧时间线另有 snapshot 请求和独立 stream 刷新逻辑。证据：`web/src/pages/WorldCanvasPage.tsx#L242-L254`、`#L256-L294`、`#L307-L323`。公开 stream 也要求 timeline 属于 demo world：`api/src/public/routes.ts#L61-L76`。
- 另有 `GET /api/worlds/:id/state?timelineId=...` 返回 `version` 等结构化 world state；该路由经 scoped-user middleware，guest allowlist 限制其精确入口。证据：`api/src/worlds/routes.ts#L40-L44`、`#L254-L265`、`api/src/world-state/query.ts#L8-L36`。

## 两个 worldId 的隔离能力

- **服务端单次读取具有 world/timeline 双重作用域**：owner bootstrap 和 snapshot 每次都接收 `worldId`，且 snapshot 校验 timeline 归属。因而可对两个各自授权的 world 分别发起读取；此项仅说明 API 参数/授权结构，不等于现有界面有两个独立 pane。
- **Guest 被精确限制为当前 sandbox world**；对其他 worldId，world scope 不给 observe，scoped-user 路由也会在 worldId 不匹配时拒绝。不得据此推断 guest 可读取第二个账户 world。
- **现有 WorldCanvasPage 右侧不是另一 world**：页面只接收一个 `worldId`；右侧目标从 `snapshot.timelines` 选择 timeline，并且 `readRightScene`/`readComparison` 均闭包使用同一个 `worldId`。证据：`web/src/pages/WorldCanvasPage.tsx#L42-L54`、`#L256-L294`。因此“左右分别设置 worldId 并独立授权”的 UI/集成路径在本基线未发现，列为 T02 缺口候选。

## 已支持路径与缺口候选

| 项目 | 判定 | 证据与边界 |
|---|---|---|
| Owner 按自身身份读取 map bootstrap，并恢复本账号的 world/timeline/space/mode | 已支持 | `api/src/map/bootstrap.test.ts#L6-L28` 覆盖 owner、非 owner、跨 world timeline 拒绝及 resume；`api/src/access/policy.test.ts#L7-L22` 覆盖能力矩阵。 |
| Guest 只访问当前 sandbox 的 state/参与路径，越界 world 被拒 | 已支持（限已测接口） | `api/src/test/s03-guest-participation.test.ts#L10-L33`、`api/src/access/scoped-user-middleware.test.ts#L10-L36`。Guest 的 map bootstrap / map resume API 虽有实现，未见对应专项 route 测试，标 **未核验**。 |
| 匿名读取公开 demo snapshot/scene，非 demo 私有世界不可由该入口读取，public 写操作被拒 | 已支持 | `api/src/public/routes.test.ts#L7-L40`。public scene 从 world 级 legacy 指针读取；bootstrap 的 timeline scene-head 路径不适用于 readonly UI，不能推断两者完全等价。 |
| readonly 账号入口/能力矩阵 | **未核验** | 本基线可见的 readonly UI 走匿名 `/api/public/*`；公开路由以 `isDemo` 控制，不返回能力对象。未找到独立 readonly 账号身份或其 world 授权契约。 |
| 两个不同 worldId 同时装载并按 pane 独立授权、时间、版本、失败隔离 | **缺口候选** | API 可逐次 scoped 读取；当前 `WorldCanvasPage` 只有一个 `worldId`，右侧只选该 world 的 timeline。当前证据无法证明双 world pane 已接通。 |
| Guest/public readonly 下的右侧 timeline snapshot + compare | **缺口候选 / 未验** | `WorldCanvasPage` 的右侧总走 `worldsApi.snapshot` 和 `lifeApi.compare`（`#L256-L278`）；前者 `/api/worlds/:id` 由 guest allowlist 不开放该路径（`api/src/worlds/routes.ts#L40-L44`），后者比较路由要求 Bearer owner（`api/src/life/compare.ts#L228-L254`）。Guest 专用比较入口存在于 `/api/demo/worlds/:worldId/compare`，但该页面回调未使用它；public API 也没有 compare 路由。source 可证明路由不匹配，具体 UI 失败表现未在本审计运行验证。 |
| Anonymous readonly 的 timeline 初始化读取 | 已支持单侧读取 | `publicApi.snapshot` 传可选 timelineId；`worldSnapshot` 校验 timeline 属于该 world。`api/src/public/routes.test.ts#L17-L28` 覆盖主线和结构化 snapshot；跨 timeline/foreign timeline 的公共路由组合未单独覆盖。 |

## 参考测试索引（本次未运行）

- `api/src/map/bootstrap.test.ts`：owner bootstrap、越界 timeline、resume。
- `api/src/access/policy.test.ts`：public baseline、owner/guest capabilities。
- `api/src/access/scoped-user-middleware.test.ts`：guest route/world allowlist。
- `api/src/test/s03-guest-participation.test.ts`：Guest sandbox state/participation 路径。
- `api/src/public/routes.test.ts`：匿名 public demo GET、私有世界拒绝、写操作拒绝。
- `api/src/life/compare.test.ts`：owner timeline compare 实现测试；不证明 Guest/public UI compare 入口可用。
- `api/src/test/world-journey.test.ts`：同 world 多 timeline 的独立状态和版本读取示例（例如 `#L321-L330`）。
