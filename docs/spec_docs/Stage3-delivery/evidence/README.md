# 阶段三证据索引

日期：2026-10-07。阶段三实现已合入 `phase3`；自动化浏览器主路径通过。本报告不把 fixture 覆盖、局部资源观察或不同时间的证据拼成完整 P2 矩阵通过。

## 验收标准状态

| AC | 状态 | 证据与边界 |
|---|---|---|
| AC1 | 部分通过 | [run 37614807432](https://github.com/kikoiio/Possibility/actions/runs/37614807432) 覆盖单世界切换、同世界四种组合与联动、跨世界四种组合与相机禁用、右侧失败重试。身份来自 fixtures；未覆盖左侧失败镜像、真实账号授权及所有实际身份/时间断言。 |
| AC2 | 未验证 | E2E 验证 3D↔2D 切换保留 timeline；没有完成刷新后的浏览器偏好与按 world/timeline/presentation 相机恢复，以及损坏存储/adapter 失败退路的全旅程验证。 |
| AC3 | 通过 | 上游阶段一和阶段二出口已分别有正面证据；G0 结果与 gate 放行记录见 [baseline.md](baseline.md)。 |
| AC4 | 部分通过 | 桌面 Chromium 6/6 通过；390×844 使用桌面 Chromium 视口模拟。真实触屏、528×720、慢网/离线、owner/guest/readonly 方向组合、单侧左右故障镜像和完整释放循环未验证。 |
| AC5 | 未验证 | 没有内部人员配对任务、错误/耗时/回访的实际记录。没有开展公开投票或评估。 |
| AC6 | 未验证 | 集成提交已在 `phase3`，但 Orca 当前 Run 仍有 pending Tasks；worker 记录存在 stale/unverifiable terminal。未能证实所有 task/worker 均 settled，故不标通过。 |
| AC7 | 部分通过 | Browser Actions 在重型操作前记录 MemAvailable 14 GiB、无 swap 使用、后续 `vmstat si/so=0` 和 memory PSI 0；每批单 worker。cgroup `memory.max` 没有有效输出，且不能由该单次快照推断其他时段。 |
| AC8 | 部分通过 | 本索引与 [checklist.md](../checklist.md) 给出证据状态与限制；最终 Orca 任务/worktree 收尾及内部 QA 仍未完成。公开评估/投票延期。 |

## 运行与原始证据

| 证据 | 内容 |
|---|---|
| [baseline.md](baseline.md) | 上游 G0、真实 provider 批次、费用和阶段门槛结果。新增真实请求 93 次；累计历史计数 205。新增可核实费用 `$1.011892`，最早 26 次费用未完全对账。 |
| [qa-matrix.md](qa-matrix.md) | 固定覆盖目标、pairwise 计划、本轮实际自动化子覆盖、性能读数和未验证项。 |
| [access-audit.md](access-audit.md) | 双 pane 的读取与身份/权限 API 契约审计。 |
| [renderer-audit.md](renderer-audit.md) | 2D/3D renderer、相机接口和释放生命周期审计。 |
| [phase1-g0-checkpoint.md](phase1-g0-checkpoint.md) | G0 阶段一旅程门槛证据。 |
| [phase2-acceptance-2026-10-07.md](phase2-acceptance-2026-10-07.md) | 阶段二连续旅程与远端部署证据边界。 |
| [GitHub Actions 37614066902](https://github.com/kikoiio/Possibility/actions/runs/37614066902) | 较早集成提交的 Web build/types、119 个定向 Vitest、2 个 fixture tests。 |
| [GitHub Actions 37614807432](https://github.com/kikoiio/Possibility/actions/runs/37614807432) | 当前实现提交的浏览器验收 6/6 与性能/renderer registry 观测；artifact `phase3-presentation-37614807432` 保留 14 天。 |
| [GitHub Actions 37615432126](https://github.com/kikoiio/Possibility/actions/runs/37615432126) | 当前 HEAD `ea6eeb0` 的 build/types、5 个 Vitest 文件 119 tests、2 个 fixture tests 均通过。 |

## 仍需完成

- 新增 ComparisonHost 与原生 2D 测试后的扩展 build/types + Vitest 云端验证结果；新 run 失败时需修复后重跑。
- 完整 AC4 矩阵：左右权限身份镜像、左右侧独立失败、刷新/相机恢复、慢网/离线、真实触屏、完整生命周期循环和混合表现性能。
- AC5 内部测试者配对 QA 与回访记录。
- T27 Orca Run/worker settled 状态核实。保留的 worker/worktree 未被本次清理。
- 历史真实 provider 的最早 26 次费用尚未完整对账；不能宣称累计总费用已全部核实。
