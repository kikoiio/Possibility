# 核心闭环阶段 0 与阶段 1A Checklist

> 每项都通过运行代码或观察当前入口来验证。证据统一写入 `artifacts/phase1-core-loop/<run-id>/`，每项记录命令、实际结果、版本和证据路径。

## 实现完整性

- [ ] **C1 基线矩阵完整（AC1）**：运行阶段 0 编排器，观察矩阵包含 BB-01～BB-18 和注册后认领、访客时区、室内 3D、时间线显示补充项；每行有入口、身份、world/timeline/space/simNow、HTTP/页面结果、状态和证据路径。（验证：GitHub Actions 阶段 0 job；检查 `matrix.json`）
- [ ] **C2 证据可重复且脱敏（AC2）**：在同一确定性 fixture 上连续运行两次，比较候选摘要、问题集合、规则/资产摘要和内容哈希；观察调用次数、停止原因和脱敏扫描均存在且一致。（验证：`scripts/phase1-core-loop-baseline.mjs` 两次运行 + JSON diff/secret scan）
- [ ] **C3 规范化与最终 gate 一致（AC3）**：提交含无效入口、缺失空间、道路断裂或室内不可读问题的候选，观察保存被拒绝且不生成可进入世界；检查面板和保存前 gate 返回同一问题集合、版本和 basis。（验证：API 定向测试 + 浏览器日志）
- [ ] **C4 问题反馈可执行（AC4）**：在浏览器打开每类支持的问题结果，观察到原因、影响范围、可执行建议、写入状态、重试状态和下一步按钮；页面不显示 UUID、内部错误码或资产字段。（验证：Web 组件测试 + 桌面/窄屏截图）
- [ ] **C5 修复预览与过期保护（AC5）**：生成修复草稿并打开前后差异，观察依据未变时只提交一个新版本；改变当前版本、规则、绑定或资产依据后再提交，观察服务端拒绝并要求重新检查，刷新仍能读到已提交版本。（验证：`api/src/scenes/compatibility/routes.test.ts` + 浏览器旅程）
- [ ] **C6 确定性保底路径（AC6）**：连续触发生成/编辑失败上限，观察系统保存可进入的最小场景，页面明确保底来源并保留修复/编辑入口；重复运行比较文档哈希。（验证：`api/src/scenes/fallback.test.ts` + 三视口 E2E）
- [ ] **C7 请求恢复与幂等（AC7）**：丢弃创建/确认响应、刷新并重复点击，观察同一 request id 返回 completed、failed-retryable 或 recoverable；数据库中只有一个世界和一个对应场景版本。（验证：`api/src/worlds/create-voxel.test.ts` + Playwright network-drop 场景）
- [ ] **C8 新世界连续路径与响应式入口（AC8）**：在桌面、`485×724`、`390×844` 完成创建→检查→修复或保底→保存→首次进入→刷新再进入；观察主要按钮、错误说明、预览和进入入口均可触达。（验证：云端 Playwright desktop/mobile 项目 + 截图）
- [ ] **C9 服务端权限边界（AC9）**：用不匹配的 world/timeline/space、绑定、版本或权限请求检查/修复/保存，观察请求被拒绝且场景内容、版本和基线不变。（验证：API authorization/scope 测试 + 数据库只读快照）
- [ ] **C10 工作量、截止和取消（AC10）**：运行超出工作量/超时的坏场景并取消，观察流程在边界内返回 incomplete/action，取消后没有继续运行的验证或模型替身任务。（验证：compatibility deadline/cancel 测试 + 运行日志）
- [ ] **C11 隔离云端证据与清理（AC11）**：运行 GitHub Actions `phase1-core-loop-acceptance.yml`，观察使用独立 D1/临时目录、单 worker 完成矩阵，artifact 可下载，step summary 有统计，临时服务退出。（验证：workflow run、artifact 清单、cleanup 结果）
- [ ] **C12 向后兼容（AC12）**：运行既有合法演示世界读取、场景兼容测试、API/Web/contract 构建和受影响浏览器测试；观察通过，并确认矩阵中的其他 BB 仍按实际状态记录。（验证：构建/测试日志 + `matrix.json`）

## 集成

- [ ] **I1 统一 gate 调用链**：场景检查、修复预检、修复确认和世界创建前检查使用同一 candidate/basis/report 语义；同一输入的结果摘要和哈希一致。（验证：API 服务测试及请求日志对比）
- [ ] **I2 服务端权威上下文**：客户端请求不携带可覆盖的 bindings、basis 或权限字段；服务端从当前 world/timeline/space 解析并在响应中返回脱敏摘要。（验证：篡改请求测试 + 响应字段审计）
- [ ] **I3 保底与修复互通**：fallback 提交后的世界可正常进入、刷新和读取场景历史，修复入口使用当前版本继续生成草稿。（验证：fallback E2E + 场景历史 API）
- [ ] **I4 创建草稿生命周期**：断流、刷新和失败时 prompt、居民选择、候选和 request id 保留；只有 completed 后清理本地草稿。（验证：`create-draft-store` 测试 + 浏览器 localStorage/请求记录）
- [ ] **I5 证据字段贯通**：gate、提交 API、页面状态和基线 manifest 能关联同一 run id/request id/world/timeline/space/simNow，且日志脱敏。（验证：artifact JSON 交叉检查）

## 编译与测试

- [ ] **B1 Contract 构建通过**：运行 `npm --workspace @possibility/voxel-contract run build`，观察退出码为 0。
- [ ] **B2 API 类型检查通过**：运行 `npm --workspace api run build`，观察无 TypeScript 错误。
- [ ] **B3 Web 类型检查与生产构建通过**：运行 `npm --workspace web run build`，观察无 TypeScript/Vite 错误。
- [ ] **B4 API 定向测试通过**：运行 `npm --workspace api test -- src/scenes/fallback.test.ts src/scenes/voxel-draft.test.ts src/voxel/normalize.test.ts src/worlds/create-voxel.test.ts src/scenes/compatibility/routes.test.ts src/scenes/repair.test.ts`，观察全部通过。
- [ ] **B5 Web 定向测试通过**：运行 `npm --workspace web test -- src/scene src/components/scene`，观察创建草稿、action、修复预览和恢复测试全部通过。
- [ ] **B6 既有回归测试通过**：运行受影响的现有 API/Web/contract 测试集合，观察没有因统一 gate 或 fallback 引入回归。（验证：云端 workflow 定向测试 step）
- [ ] **B7 浏览器/GUI 矩阵通过或有证据标注**：运行 GitHub Actions 浏览器/GUI jobs，观察桌面、两个窄屏和 GUI 结果逐项为 passed/failed/unverified，未运行项有原因，不允许空白结论。（验证：workflow summary + screenshots）

## 端到端场景

- [ ] **E1 合法新世界**：用户选择居民并提交有效描述 → 生成候选 → 最终检查通过 → 保存并首次进入 → 刷新页面；预期看到同一 world/timeline/space 的可进入场景，数据库只有一个创建结果。（验证：`phase1-core-loop.spec.ts` happy path）
- [ ] **E2 无效候选修复**：生成包含无效入口或道路断裂的候选 → 页面显示问题和建议 → 生成修复草稿 → 预览变化 → 提交 → 刷新；预期看到新版本通过同一 gate 并能进入，旧版本保持历史记录。（验证：`phase1-core-loop.spec.ts` repair path）
- [ ] **E3 失败后保底**：连续返回确定性失败序列 → 达到上限 → 保存最小合法 fallback → 进入并刷新 → 打开修复入口；预期看到保底标识、稳定文档哈希和可继续修复的当前版本。（验证：`phase1-core-loop.spec.ts` fallback path）
- [ ] **E4 丢响应后恢复**：服务端处理创建或确认但浏览器丢弃响应 → 用户刷新并重试 → 查询原 request id；预期显示已完成或可恢复状态，不创建第二个世界/场景版本。（验证：`phase1-core-loop.spec.ts` network-drop path）

## 结果记录

- [ ] 每一项勾选都附有实际命令、退出码/页面观察结果、运行版本和 artifact 路径。（验证：验收报告审阅）
- [ ] 失败项先记录实际结果，再按 task.md 修复并重新执行对应条目；未处理的 BB 保留 failed/unverified 状态。（验证：验收报告与 git diff）
