# 核心闭环阶段 0 与阶段 1A Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `api/src/scenes/fallback.ts` | 确定性最小合法场景构造器 |
| 新建 | `scripts/phase1-core-loop-baseline.mjs` | 阶段 0 隔离服务与证据编排 |
| 新建 | `web/scripts/phase1-core-loop-baseline.acceptance.ts` | 阶段 0 页面/视口证据采集 |
| 新建 | `web/e2e/phase1-core-loop.spec.ts` | 阶段 1A 连续创建与恢复旅程 |
| 新建 | `.github/workflows/phase1-core-loop-acceptance.yml` | 云端串行构建、测试和证据上传 |
| 修改 | `packages/voxel-contract/src/scene-compatibility.ts` | fallback/action/脱敏结果类型 |
| 修改 | `api/src/scenes/voxel-draft.ts` | provider 注入、规范化结果和失败计数 |
| 修改 | `api/src/voxel/generate.ts` | 统一生成失败分类与尝试摘要 |
| 修改 | `api/src/voxel/normalize.ts` | 统一规范化结果与哈希输入 |
| 修改 | `api/src/scenes/compatibility/service.ts` | 统一最终 gate 与校验依据 |
| 修改 | `api/src/scenes/compatibility/context.ts` | 服务端绑定/资产/规则摘要 |
| 修改 | `api/src/scenes/compatibility/http.ts` | action 与脱敏响应映射 |
| 修改 | `api/src/scenes/compatibility/routes.ts` | 修复/确认/recover 状态接口 |
| 修改 | `api/src/scenes/routes.ts` | 草稿与修复入口接入统一结果 |
| 修改 | `api/src/worlds/routes.ts` | 创建前最终 gate 与幂等事务 |
| 修改 | `api/src/scenes/error-copy.ts` | 问题类型到用户文案的映射 |
| 修改 | `web/src/pages/WorldCreate.tsx` | 创建页 gate/fallback/恢复状态 |
| 修改 | `web/src/pages/WorldSceneRepair.tsx` | 修复页统一 gate 与保底入口 |
| 修改 | `web/src/components/scene/SceneCompatibilityPanel.tsx` | 问题、建议和 action 展示 |
| 修改 | `web/src/components/scene/SceneRepairPreview.tsx` | 修复差异、过期和提交状态 |
| 修改 | `web/src/scene/create-draft-store.ts` | 持久化请求与候选状态 |
| 修改 | `web/src/api/client.ts` | gate/fallback/recover DTO 调用 |
| 修改 | `web/src/api/types.ts` | 跨 API/UI 类型 |
| 新增测试 | `api/src/scenes/fallback.test.ts` | 保底文档确定性与可进入性 |
| 修改测试 | `api/src/scenes/voxel-draft.test.ts` | provider、规范化和失败上限 |
| 修改测试 | `api/src/voxel/normalize.test.ts` | 规范化与哈希稳定性 |
| 修改测试 | `api/src/worlds/create-voxel.test.ts` | 创建 gate、幂等和权限 |
| 修改测试 | `api/src/scenes/compatibility/routes.test.ts` | 修复、过期和 recover |
| 修改测试 | `api/src/scenes/repair.test.ts` | 修复候选和保底提交 |
| 新增/修改测试 | `web/src/components/scene/*.test.tsx` | action、焦点和文案 |
| 新增/修改测试 | `web/src/scene/*.test.ts` | 创建草稿恢复与请求状态 |
| 证据输出 | `artifacts/phase1-core-loop/<run-id>/` | 矩阵、日志、截图和构建信息 |

## T1: 固化跨层结果类型与 deterministic provider 契约

**文件：** `packages/voxel-contract/src/scene-compatibility.ts`、相关 contract 测试

**依赖：** 无

**步骤：**

1. 为兼容结果增加可序列化的 `actions`、`fallback` 和脱敏摘要字段，保留现有字段兼容。
2. 定义 deterministic provider 的输入、候选输出和调用计数契约，使测试可以注入固定结果或固定失败序列。
3. 为 action 值和 fallback 标记增加解析/序列化测试，确认未知旧字段不会破坏读取。

**验证：** `npm --workspace @possibility/voxel-contract run build` 通过；contract 测试能往返解析新增字段。

## T2: 实现确定性保底场景构造器

**文件：** `api/src/scenes/fallback.ts`、`api/src/scenes/fallback.test.ts`

**依赖：** T1

**步骤：**

1. 根据世界地点、居民绑定和资产清单生成固定入口、道路、最小建筑和可行走空间。
2. 保证相同世界骨架和绑定产生相同文档及内容哈希，输出 `source='fallback'` 和可读说明。
3. 对无地点、绑定冲突或资产不可用返回结构化失败，不能生成半合法文档。

**验证：** `npm --workspace api test -- src/scenes/fallback.test.ts` 通过；测试断言重复输入哈希相同，且结果可被兼容 validator 接受。

## T3: 统一生成与规范化输出

**文件：** `api/src/scenes/voxel-draft.ts`、`api/src/voxel/generate.ts`、`api/src/voxel/normalize.ts`、对应测试

**依赖：** T1、T2

**步骤：**

1. 为场景生成入口接入 provider 注入和固定失败序列，记录每次尝试、调用次数和失败分类。
2. 将地点/居民绑定、入口结构、道路和室内可读性检查前置到统一规范化输出。
3. 在达到配置失败上限后调用 T2 保底构造器，并把规范化修复与来源写入候选摘要。
4. 保持现有真实 provider 适配层不变，确保生产调用仍经过预算与权限 guard。

**验证：** `npm --workspace api test -- src/scenes/voxel-draft.test.ts src/voxel/normalize.test.ts` 通过；同一 deterministic 输入的摘要和哈希稳定。

## T4: 抽出统一最终兼容 gate

**文件：** `api/src/scenes/compatibility/service.ts`、`context.ts`、`http.ts`

**依赖：** T1、T3

**步骤：**

1. 让 inspection、preflight、repair candidate 和 create-before-commit 共享同一 candidate/basis 构造与验证调用。
2. 从服务端 world/timeline/space 解析 binding、规则、资产和模板指纹，忽略客户端权威字段。
3. 将无效入口、缺失空间、道路断裂、室内不可读、格式损坏和超时映射为摘要、影响和 action。
4. 将预算/取消/截止原因保持为可查询的 incomplete 结果，并禁止把 incomplete 当作可保存。

**验证：** `npm --workspace api test -- src/scenes/compatibility/service.test.ts src/scenes/compatibility/service.determinism.test.ts` 通过；同一 candidate 在 inspection 和 gate 中得到同一问题集合/basis。

## T5: 在世界创建事务接入最终 gate 与幂等

**文件：** `api/src/worlds/routes.ts`、`api/src/worlds/create-voxel.test.ts`

**依赖：** T4

**步骤：**

1. 在写入世界、主时间线、居民关系和首个场景版本前调用 T4 gate。
2. invalid/incomplete 只返回结构化 action，不写入世界或场景。
3. 使用现有 `sceneRequestId`、fingerprint 和稳定 ID 识别同一创建操作；相同请求重放返回原结果，冲突 fingerprint 返回可重试错误。
4. 允许 valid fallback 以可读来源标记落库，并返回场景版本和进入所需上下文。

**验证：** `npm --workspace api test -- src/worlds/create-voxel.test.ts` 通过；覆盖无效候选拒绝、保底成功、重复并发只生成一个世界、跨用户绑定拒绝和事务回滚。

## T6: 统一修复、确认与 recover 状态

**文件：** `api/src/scenes/routes.ts`、`api/src/scenes/compatibility/routes.ts`、`api/src/scenes/repair.test.ts`、`api/src/scenes/compatibility/routes.test.ts`

**依赖：** T4、T5

**步骤：**

1. 修复草稿返回 T4 使用的 basis、candidate 摘要、变化清单和 action。
2. 确认时重新读取当前版本和上下文指纹；过期时返回重新检查，不覆盖较新场景。
3. 对提交前断流提供 request 查询和 recover；已提交返回 completed，未提交且可重试返回明确状态。
4. 让保底入口复用同一确认流程，不绕过最终 gate。

**验证：** `npm --workspace api test -- src/scenes/compatibility/routes.test.ts src/scenes/repair.test.ts` 通过；覆盖草稿过期、重复确认、丢失响应后的查询和跨世界拒绝。

## T7: 固化用户可理解的错误与 action 映射

**文件：** `api/src/scenes/error-copy.ts`、`api/src/scenes/compatibility/http.ts`、contract/UI 类型

**依赖：** T1、T4

**步骤：**

1. 为每个支持的 issue category/code 定义摘要、影响、是否写入、是否可重试和下一步。
2. 对未知/内部错误提供安全的通用说明，不把 UUID、资产名、枚举或栈信息输出给用户。
3. 将 action 和脱敏摘要在 API response、日志和证据 manifest 中保持一致。

**验证：** 运行 API HTTP 映射测试，断言所有公开 issue 都有非空摘要和 action，且响应不含内部 ID/secret 模式。

## T8: 接入创建页状态机和持久恢复

**文件：** `web/src/pages/WorldCreate.tsx`、`web/src/scene/create-draft-store.ts`、`web/src/api/client.ts`、`web/src/api/types.ts`

**依赖：** T5、T6、T7

**步骤：**

1. 将生成后状态拆为 generating、checking、invalid、repairable、fallback-ready、creating、recoverable、completed。
2. 保存 prompt、居民选择、候选摘要、request id 和最后状态；只有创建成功才清理草稿。
3. 创建请求断流/刷新后使用同一 request id 查询服务端状态，并按 action 提供重试、重新检查、使用保底或进入世界。
4. 在桌面和窄屏下保持主要按钮、错误摘要和场景预览可见。

**验证：** `npm --workspace web test -- src/scene/create-draft-store.test.ts` 及 WorldCreate 相关组件测试通过；状态恢复测试确认刷新不会生成第二个请求。

## T9: 接入修复页和兼容面板

**文件：** `web/src/pages/WorldSceneRepair.tsx`、`web/src/components/scene/SceneCompatibilityPanel.tsx`、`web/src/components/scene/SceneRepairPreview.tsx`

**依赖：** T6、T7、T8

**步骤：**

1. 用统一 action 文案显示问题、影响、写入状态、重试/重检/修复/保底入口。
2. 预览显示候选变化和校验结果；basis 过期时保留用户输入并要求重新检查。
3. 提交、断流和 recover 显示 completed/failed-retryable/recoverable，不把未知状态显示为成功。
4. 添加键盘焦点、触摸和 `485×724`/`390×844` 下的可达性处理。

**验证：** `npm --workspace web test -- src/components/scene src/scene` 通过；组件测试覆盖过期、保底和网络恢复分支。

## T10: 增加阶段 1A API 回归矩阵

**文件：** `api/src/scenes/fallback.test.ts`、`api/src/scenes/voxel-draft.test.ts`、`api/src/worlds/create-voxel.test.ts`、`api/src/scenes/compatibility/routes.test.ts`

**依赖：** T2、T3、T5、T6

**步骤：**

1. 将 invalid、incomplete、repairable、fallback 和 completed 分支整理为独立测试 fixture。
2. 对每个分支断言最终 gate、写入状态、版本/hash、调用次数和下一步 action。
3. 加入重复请求、断流查询、权限错配和新版本覆盖保护。

**验证：** `npm --workspace api test -- src/scenes/fallback.test.ts src/scenes/voxel-draft.test.ts src/worlds/create-voxel.test.ts src/scenes/compatibility/routes.test.ts` 全部通过。

## T11: 编写阶段 1A 浏览器连续旅程

**文件：** `web/e2e/phase1-core-loop.spec.ts`

**依赖：** T8、T9、T10

**步骤：**

1. 使用确定性 fixture 覆盖创建成功、invalid→repair→commit、达到失败上限→fallback 三条路径。
2. 模拟丢失创建/确认响应、刷新和重复点击，验证同一 request id 恢复且不重复写入。
3. 在桌面、`485×724`、`390×844` 验证主要控件、错误说明、修复预览和进入按钮可操作。
4. 收集页面 labels、HTTP 状态、场景版本/hash 和截图到运行输出目录。

**验证：** 在隔离环境执行 `npx playwright test --workers=1 web/e2e/phase1-core-loop.spec.ts`；通过标准为三条旅程均完成且无重复世界。

## T12: 建立阶段 0 证据编排器

**文件：** `scripts/phase1-core-loop-baseline.mjs`、`web/scripts/phase1-core-loop-baseline.acceptance.ts`

**依赖：** T10、T11

**步骤：**

1. 复用现有隔离 Worker/D1 启动脚本，生成 run id、git sha、数据模式和视口配置。
2. 为 BB-01～BB-18 和补充项建立矩阵条目，统一收集 API、页面、截图和上下文摘要。
3. 对失败或未验证项记录原因与下一步，不把历史证据合并为当前通过。
4. 在 finally 阶段停止本次启动的服务、清理临时目录并写入 cleanup 结果。

**验证：** 运行编排器的 dry-run/list 模式，确认 18 个 BB 条目和所有补充项均被发现；验证 JSON schema 和脱敏扫描通过。

## T13: 完成阶段 0 BB-01～BB-05 真实入口矩阵

**文件：** `web/e2e/phase1-core-loop.spec.ts`、`web/scripts/phase1-core-loop-baseline.acceptance.ts`

**依赖：** T12

**步骤：**

1. 执行新场景生成/修复、2D/3D 读取、传话事实一致性、访客认领和 Fork 弹窗五项 P1 旅程。
2. 对每项写入身份、world/timeline/space/simNow、响应状态和最终页面状态。
3. 将每项结果映射为 passed/failed/unverified，并保存必要截图和响应摘要。

**验证：** 在 GitHub Actions 隔离环境运行对应 Playwright/API 子集；矩阵 JSON 包含 BB-01～BB-05 且每项有证据路径。

## T14: 完成阶段 0 BB-06～BB-14 真实入口矩阵

**文件：** `web/e2e/phase1-core-loop.spec.ts`、`web/scripts/phase1-core-loop-baseline.acceptance.ts`

**依赖：** T12

**步骤：**

1. 执行 Fork 过期、pane 恢复、时间线同步、访客时区、人物推断、示例失败、窄屏、无人地点和时间叙述旅程。
2. 对尚未处理的项只记录当前行为，不修改其业务实现。
3. 对室内 3D、窄屏和时间线补充项写入独立 case id，避免与历史截图混淆。

**验证：** 在 GitHub Actions 隔离环境运行对应子集；矩阵包含 BB-06～BB-14 和补充项，未运行项显式为 unverified。

## T15: 完成阶段 0 BB-15～BB-18 与补充矩阵

**文件：** `web/e2e/phase1-core-loop.spec.ts`、`web/scripts/phase1-core-loop-baseline.acceptance.ts`

**依赖：** T12

**步骤：**

1. 执行 What-if 入口、工程字段暴露、首次到场叙述和 paused/archived 状态语义旅程。
2. 汇总注册后自动认领、访客时区、室内 3D、时间线显示等补充回归项。
3. 生成完整基线矩阵，不将阶段 1A 修复结果外推到其他 BB。

**验证：** 在 GitHub Actions 隔离环境运行对应子集；矩阵恰好包含 BB-01～BB-18 和补充项，并记录当前版本 git sha。

## T16: 添加云端隔离验收工作流

**文件：** `.github/workflows/phase1-core-loop-acceptance.yml`

**依赖：** T11、T12、T13、T14、T15

**步骤：**

1. 使用 `ubuntu-24.04`、Node 24、`npm ci` 和 Chromium 安装步骤。
2. 串行执行 contract build、API/Web 定向单测、阶段 1A Playwright、阶段 0 矩阵和构建检查。
3. 使用独立 D1 持久目录、临时端口和单 worker；记录 runner 资源、`/tmp` 余量和清理状态。
4. 上传 `artifacts/phase1-core-loop/<run-id>/` 证据并在 always 步骤停止本次启动的服务。

**验证：** 用 `workflow_dispatch` 运行一次，检查 workflow 成功、artifact 可下载、临时服务退出且 step summary 包含矩阵统计。

## T17: 汇合回归与验收准备

**文件：** 受影响的 API/Web/contract 文件及 `docs/spec_docs/phase1-core-loop/checklist.md`

**依赖：** T1–T16

**步骤：**

1. 运行受影响的 API 单测、Web 单测、contract build、API build 和 Web build。
2. 对照 checklist 逐项检查 gate、fallback、恢复、权限、视口和证据字段。
3. 只修复本轮 scope 内的失败；将其他 BB 的实际结果保留为 baseline 状态。
4. 汇总本地/云端命令、artifact 路径和未验证项，准备验收报告。

**验证：** 所有 checklist 条目都有通过/失败/未验证证据；失败项在修复后重新执行对应验证，不以“应该通过”替代输出。

## 执行顺序

```text
批次 A（可并行）
  T1 ─┬─ T2 ─┐
      └─ T3 ─┴─ T4

批次 B（API 串行门禁；T7 可在 T4 后与 T5 并行，但共享兼容文件时合并提交）
  T4 ─┬─ T5 ── T6 ─┐
      └─ T7 ───────┼─ T8 ── T9 ─┐
                   └─ T10 ──────┤
                                 └─ T11 ── T12

批次 C（共享 e2e/矩阵文件，必须串行）
  T12 ── T13 ── T14 ── T15

批次 D（唯一重型批次）
  T15 ── T16（云端重型验证） ── T17（回归与验收）
```

- T2 与 T3 都依赖 T1，分别负责 fallback 和生成/规范化；它们不同时修改同一实现文件，可并行。
- T4–T7 修改同一 API 兼容链，按依赖合并提交；T7 可在 T4 后准备，但若触及同一 HTTP 映射文件必须串行落盘。
- T8/T9 修改不同 UI 文件但共享 DTO，先完成 T7 后按文件所有权实施；T10 只增加 API 回归测试，可与 UI 实现并行。
- T11 汇合 T8/T9/T10 后编写浏览器连续旅程；T12 再把该旅程和 API fixture 编排成阶段 0 证据运行器。
- T13、T14、T15 共享 e2e 规格和矩阵汇总文件，必须串行写入；运行时统一由 T16 单 worker 执行。
- T16 是唯一的重型浏览器/GUI 云端批次；本机不与其并行启动 GUI 或完整构建。
- T17 是所有实现和验证的汇合点，完成前不得进入阶段 6 验收结论。
