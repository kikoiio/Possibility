# 阶段 2：可验证的小世界循环 Checklist

> 每一项都要求运行验证或观察实际行为。四份规格文档已获用户批准。

## 阶段 2 协调验收记录（2026-10-07）

| Task | 结果 | 证据/限制 |
|------|------|-----------|
| T0 | 通过 | 基线 `2d9cd68`、批准文档、主工作区既有未提交改动和 worktree 隔离规则已登记。 |
| T1–T7 | 通过 | X1 schema/0038 迁移、adapter、读取/历史/CAS、公共接线由 worker 报告完成；API build 与迁移定向测试通过。 |
| T8–T11 | 通过 | D1 回顾、直接证据、比较和 Web 接线完成；`evidence.test.ts`、`compare.test.ts` 定向测试 41/41 通过。 |
| T12–T14 | 通过 | D3 有限枚举、投影和 `access=closed` 行动阻断完成；环境定向测试 9/9 通过。 |
| T15 | 隔离验收通过；远端未验证 | D4 租约/运行状态脚本完成；GitHub Actions run `37565225272` 以真实 Worker tick/API + 隔离 D1 验证离页推进、暂停冻结、恢复推进。真实部署 scheduler/database 尚未运行验收。 |
| T16–T17 | 通过 | V1 漫游、出生/跌落/居民活动接线完成；Web voxel 定向测试包含 4 个相关文件并通过。 |
| T18–T19 | 通过（SSE 有 mock 边界） | N1 会话 adapter/交互接线和 owner 浏览器旅程完成；run `37565225272` 在 production preview 中验证真实 Worker 登录、读取、干预、分叉、比较。对话 SSE 为 mock。移动触屏 e2e 4/4 通过。 |
| T20–T21 | 通过；归档行为未验证 | N2 布局 API/CAS/迁移测试、owner 保存与 reload/reselect、独立移动上下文从真实 Worker/D1 恢复布局通过，run `37565225272`。 |
| T22 | G0 通过；远端出口受限 | API/Web build、API 定向 67/67、Web 定向 237/237、`git diff --check` 通过；production bundle + Vite preview、真实本地 Worker/D1 owner flow、T15 隔离引擎旅程及 mobile touch e2e 云端通过。远端部署及公开 demo 仍未验证。 |

本轮定向命令均使用单 worker：`vitest run --pool=forks --maxWorkers=1 --no-file-parallelism`。未验证项不能以 mock、单测或构建替代，待真实部署/浏览器环境可用后补证。

### 2026-10-07 补充与更正

| Task | 当前结果 | 证据/限制 |
|------|----------|-----------|
| T8–T11 | 补齐比较回归 | 修复跨时间线事实版本号误比较；产品旅程等 6 个 API 测试文件 115/115 通过。天气测试数据统一为 D3 有限枚举。 |
| T15 | 隔离 Worker 旅程通过；远端部署未实跑 | 最新 run `37565225272` 中 `scripts/verify-deployment-journey.ts` 针对 runner 隔离 D1 world 验证离页推进、暂停冻结、恢复后推进；全部断言通过。真实 Worker tick/API 由测试 pinger 每 5 秒驱动；远端 scheduler 及数据库仍未验证。 |
| T19 | owner 浏览器旅程通过（隔离环境） | production preview 用一次性 owner 账户；真实调用列表、timeline、干预、fork、compare API；对话 SSE 使用 mock。最新 run `37565225272` 通过。 |
| T20 | 实现并通过定向验证 | 新增 D1 native2d head/revision 表与 `0039` 迁移、owner API、布局元数据校验、CAS 和 requestId 重放；路由/仓库/迁移 22/22 通过。 |
| T21 | owner 浏览器生产预览布局保存/跨设备恢复通过 | GitHub Actions production preview 使用 Vite production bundle、Chromium 和真实本地 Worker/隔离 D1：移动 gatehouse、保存至 fork timeline、reload/reselect 后 D1 placements 一致；新建独立 390×844 移动浏览器上下文也从 Worker/D1 读回相同 placements。SSE 仍 mock，归档行为未验证。 |
| T22 | G0 release build + real API 通过；整体出口仍受远端旅程约束 | API 全量 876 passed/1 skipped；Web 单元 536/536；开发服务器 `native2d-desktop` 35/35；latest production preview owner run `37565225272`；隔离 Worker/D1 离页推进/暂停/恢复、移动触屏 4/4、独立移动上下文布局读取均通过。远端部署 scheduler/database 与公开 demo live 仍未验收，不能宣称全部阶段出口完成。逐项证据见 `artifacts/phase2-acceptance-2026-10-07.md`。 |

N2 新路由的认证中间件现在仅覆盖 `/worlds/:worldId/native2d/layout`，不会拦截访客 API。owner 账户旅程在开发服务和 production preview 均完成；latest production preview 有 19 个桌面 Worker 请求和 4 个独立移动上下文 Worker 请求，无 HTTP 失败，对话 SSE 使用 mock。离页推进/暂停/恢复已在 runner 的隔离 Worker/D1 通过；远程部署旅程没有目标环境，所以 T15 远端出口仍受限。

## 实现完整性

- [ ] X1 每条 timeline 有独立 voxel scene head/revision（验证：多线 API/数据库夹具）。
- [ ] X1 分叉复制完整场景且父线、子线和兄弟线隔离（验证：fork 后分别编辑并读取）。
- [ ] X1 历史只显示当前线和分叉点前祖先（验证：构造父线分叉前后版本、兄弟线和损坏链）。
- [ ] X1 CAS、requestId 重放和祖先恢复正确（验证：并发提交、重复请求和恢复测试）。
- [ ] X1 迁移可重跑/续跑且 legacy 不冒充 timeline 历史（验证：迁移夹具）。
- [ ] D1 回顾只显示当前线分叉后变化，分页/时间窗稳定（验证：插入新变化、旧游标和重复事件）。
- [ ] D1 证据只使用直接来源，缺口可见（验证：命令/事实/事件缺失夹具）。
- [ ] D1 比较显示双方当前 `simNow`、时间差、差异和 limitations（验证：两线不同时间的比较响应和页面）。
- [ ] D1 不完整重建禁用依赖操作（验证：损坏/部分历史证据详情）。
- [x] D3 有限枚举和结构化环境行动生效（验证：`environment.test.ts`、`environment-rules.test.ts`）。
- [x] D3 `access=closed` 阻断 enter/move，恢复 open 可重试（验证：`environment-rules.test.ts`；真实页面反馈未验证）。
- [ ] D4 离页后持续推进、回访可读新增结果（runner 隔离 Worker/D1 行为通过；真实部署 scheduler/database 旅程仍未验证）。
- [ ] V1 合法出生、跌落恢复和可退出输入控制（验证：桌面/触屏实际操作）。
- [ ] V1 居民动作只绑定真实活动点和证据（验证：有/无对象场景对照）。
- [x] N1 2D 使用正确真实账户 world/timeline 和公共投影（验证：production preview owner 账户旅程及 Worker 网络记录）。
- [x] N1 2D 选择、跟随、对话、干预、分叉/比较复用公共 API（验证：owner 旅程网络和行为结果；SSE 本身 mock，未调用模型）。
- [x] N2 服务端保存 native2d 布局、校验、撤销和跨设备恢复（API/CAS、迁移及 owner 页面保存/reload/重选、独立移动上下文恢复已验证；归档行为仍未验证）。

## 集成与隔离

- [ ] 2D、3D、API、SSE 使用同一环境投影（验证：同一 timeline 快照对比）。
- [ ] 场景几何版本不改变模拟时间、居民状态、事实或事件（验证：操作前后计数和版本对比）。
- [ ] D1 GET 不调用模型、不推进世界、不写入非已读数据（验证：请求前后数据库和模型调用计数）。
- [ ] owner、访客、非 owner、归档线和跨世界访问边界正确（验证：权限矩阵）。
- [ ] timeline 切换后旧响应不会覆盖新线（验证：页面请求乱序测试）。
- [ ] 共享 schema、DTO、路由、fixture 和数据库没有并行覆盖（验证：集成 diff/所有权登记）。

## 编译与定向验证

- [x] API 类型检查通过。
- [x] Web 类型检查通过。
- [x] 受影响 API 单元/集成测试通过。
- [x] 受影响 Web 单元测试通过。
- [x] migration/schema 定向测试通过。
- [x] 构建通过；已有大 chunk 警告如实记录。
- [x] API 全量 876 passed/1 skipped；Web 单元 536/536；`native2d-desktop` 35/35。
- [x] Vite production build + preview 上的 owner 浏览器旅程通过；实际 API 为 runner 上的 Cloudflare Worker/isolated D1，未连远端部署。独立移动上下文布局读回通过，移动触屏项目 4/4 通过。完整记录见 `artifacts/phase2-acceptance-2026-10-07.md`。
- [ ] 远端部署推进/暂停/恢复及公开 demo live 验收未执行；隔离 Worker/D1 行为验证通过，不替代部署验收。

## 端到端场景

- [ ] 主旅程：owner 进入真实世界 → 发现变化 → 查看直接证据 → 从有效时点分叉 → 在子线设置环境 → `access=closed` 阻断行动 → 恢复后重试 → 比较父/子线 → 离页 → 回访读取新增结果。
- [ ] 场景旅程：从父线分叉 → 子线独立移动 voxel 建筑 → 查看祖先场景历史 → 恢复祖先版本 → 父线/兄弟线保持不变。
- [ ] 2D 旅程：owner 打开真实账户 2D → 选择/跟随居民 → 观察室内 → 对话或干预 → 分叉/比较 → N2 保存布局 → 刷新或换设备恢复。
- [ ] 失败旅程：模拟读取失败、冲突、损坏历史、非法条件和归档写入，确认错误可理解、旧画面保留且可恢复。

每项记录实际命令、设备/浏览器、数据库/部署环境、结果和未验证限制。
