# 核心闭环阶段 0 与阶段 1A Checklist

> 勾选项有当前实现或测试证据；未勾选项列出本阶段仍缺的验收证据。最终汇总见 [验收记录](evidence/acceptance-38117909722.md)，artifact 见 [GitHub Actions run 38117909722](https://github.com/kikoiio/Possibility/actions/runs/38117909722)。

## 实现完整性

- [x] **C1 基线矩阵完整（AC1）**：BB-01～BB-18 和注册后认领、访客时区、室内 3D、时间线显示补充项共 22 项全部有结构化结果和证据路径；最终 run 38117909722 为 22/22 passed。
- [x] **C2 证据可重复且脱敏（AC2）**：确定性 service/fallback 测试比较 inspection、draft、report、candidate、changes、文档和 contentHash；基线产物带版本、执行上下文和脱敏结果。API 回归通过。
- [x] **C3 规范化与最终 gate 一致（AC3）**：API create/compatibility 测试覆盖无效候选拒绝写入、scope/basis/version 权威检查；浏览器兼容旅程覆盖阻断和有效修复提交。完整兼容套件累计 25 条用例均有通过记录。
- [x] **C4 问题反馈可执行（AC4）**：组件参数化测试覆盖所有支持的公开兼容问题类别，检查原因、影响、写入状态、重试状态、下一步操作和内部 ID 脱敏；W31 浏览器旅程检查真实问题卡片并打开修复预览。详见验收记录。
- [x] **C5 修复预览与过期保护（AC5）**：API 测试覆盖依据过期拒绝和重新检查；浏览器旅程覆盖预览、依据变化、重试、提交、刷新与历史恢复。
- [x] **C6 确定性保底路径（AC6）**：fallback 测试验证内容和哈希确定性、完整 gate；桌面及两个窄屏旅程验证保底标记、保存、进入和刷新恢复。页面说明保存后仍可继续修复，响应包含 repair action。
- [x] **C7 请求恢复与幂等（AC7）**：API 断流/重试/唯一写入测试通过；浏览器丢响应刷新复用同一 request id/payload，仅产生一个世界/场景结果。
- [x] **C8 新世界连续路径与响应式入口（AC8）**：桌面 4 条阶段旅程和两个窄屏 fallback 旅程通过；窄屏无横向溢出，artifact 保留截图和结果 JSON。
- [x] **C9 服务端权限边界（AC9）**：API scope/owner/binding/version 拒绝与无部分写入测试通过；浏览器访客、跨账号和私有草稿隔离旅程通过。
- [x] **C10 工作量、截止和取消（AC10）**：deadline、incomplete、取消后停止验证等 API 测试通过。
- [x] **C11 隔离云端证据与清理（AC11）**：Actions 使用 ubuntu-24.04、单 worker、隔离 D1/临时目录；artifact 上传成功，`cleanup.json` 确认服务停止、临时路径清理且无错误。
- [x] **C12 向后兼容（AC12）**：API/Web/contract builds、全 API/Web 回归和现有兼容浏览器旅程通过；credentialed G0 与 Phase 2 suites 按凭据要求排除。

## 集成

- [x] **I1 统一 gate 调用链**：determinism 测试比较 inspection/draft 依据、报告和候选；route/create 测试覆盖最终确认和创建 gate。
- [x] **I2 服务端权威上下文**：scope、binding、权限和伪造字段测试验证上下文由服务端解析，错误响应脱敏。
- [x] **I3 保底与修复互通**：同一 fallback 世界完成创建、进入、刷新恢复、AI 修复预览、兼容预检、版本提交和再次刷新读回。
- [x] **I4 创建草稿生命周期**：Web 持久化测试和丢响应刷新 E2E 验证 prompt、居民、候选及 request id 恢复。
- [x] **I5 证据字段贯通**：BB-01 manifest 与 correlation sidecar 校验 runId、生成 request ID、创建 request ID、同一场景文档、API 响应及 world/timeline/space/simNow 上下文；脱敏检查通过。

## 编译与测试

- [x] **B1 Contract 构建通过**：最终 run 38117909722 通过。
- [x] **B2 API 类型检查通过**：最终 run 38117909722 通过。
- [x] **B3 Web 类型检查与生产构建通过**：最终 run 38117909722 通过。
- [x] **B4 API 定向测试通过**：最终全 API 回归中 136 个测试文件通过（936 passed、1 skipped）。
- [x] **B5 Web 定向测试通过**：最终全 Web 回归中 69 个测试文件通过（698 passed）。
- [x] **B6 既有回归测试通过**：run 38117909722 的 contract/API/Web builds 及既有 API/Web 全回归通过；排除需要专用凭据的 G0 provider 和 Phase 2 云验收套件。
- [x] **B7 浏览器/GUI 矩阵通过或有证据标注**：22/22 浏览器矩阵和 6/6 阶段旅程通过；GUI 明确标为 unverified，原因是本阶段没有原生 GUI 目标。

## 端到端场景

- [x] **E1 合法新世界**：有效描述→生成→保存→首次进入→刷新恢复通过；API 创建测试断言 world/timeline/scene/revision 唯一。
- [x] **E2 无效候选修复**：新世界无效候选保留输入和 draft request ID；同一请求重试生成有效场景，创建并进入后在同一世界预览修复、提交新版本、刷新读回版本 2。
- [x] **E3 失败后保底**：确定性 fallback 标记和内容哈希、保存、进入、刷新恢复通过；随后在同一 fallback 世界完成 AI 修复预览、兼容预检、提交新版本并刷新读回。
- [x] **E4 丢响应后恢复**：创建丢响应后刷新并以同一 request id 和 payload 重试；API 测试确认只生成一套创建记录。

## 验收记录

- [x] 每一项均标记为通过或未验证，并附实际运行和证据位置；仅原生 GUI 因本阶段没有 GUI 目标标记为 unverified，详见 [验收记录](evidence/acceptance-38117909722.md)。
- [x] 失败项先保存实际结果，再修正验收断言并重跑：attempt 查询补齐 timeline scope；登出隔离用例更新为当前设置抽屉；两条修正用例最终定向运行 2/2 通过。完整运行中其余 24 条通过，证据和过程见验收记录。
