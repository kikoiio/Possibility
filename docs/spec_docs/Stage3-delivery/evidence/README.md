# 阶段三证据索引

日期：2026-10-07。阶段三实现已合入 `phase3`；自动化浏览器主路径通过。本报告不把 fixture 覆盖、局部资源观察或不同时间的证据拼成完整 P2 矩阵通过。

## 验收标准状态

| AC | 状态 | 证据与边界 |
|---|---|---|
| AC1 | 部分通过 | [run 37619241531](https://github.com/kikoiio/Possibility/actions/runs/37619241531) 覆盖单世界切换、同世界四种组合与联动、跨世界四种组合与相机禁用、左右 pane 503 单侧重试、右侧 403 不可重试及右侧超时恢复。身份来自 fixtures；未覆盖真实账号授权及所有实际身份/时间断言。 |
| AC2 | 部分通过 | run 37619241531 验证刷新后浏览器表现偏好恢复、显式 URL 优先和 3D 相机快照恢复；2D 相机、切换历史、损坏/不可用存储及 adapter 失败退路尚未完成全旅程验证。 |
| AC3 | 通过 | 上游阶段一和阶段二出口已分别有正面证据；G0 结果与 gate 放行记录见 [baseline.md](baseline.md)。 |
| AC4 | 部分通过 | 最新桌面 Chromium 11/11、Pixel 7 mobile-chromium 设备仿真触控 1/1 通过；包括 390×844/528×720、左右 pane 503 重试、右侧 403/超时、身份/时间标签和混合 renderer。慢网/离线、真实账号的 owner/guest/readonly 镜像组合、实体设备及完整生命周期循环未验证。 |
| AC5 | 通过（用户验收确认） | 用户于 2026-10-07 明确要求将 T25/该项按通过处理。仓库未附测试者身份、成绩和回访明细；没有开展公开投票或评估。 |
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
| [GitHub Actions 37618353908](https://github.com/kikoiio/Possibility/actions/runs/37618353908) | 当前实现提交的浏览器验收：桌面 8/8、Pixel 7 mobile-chromium 1/1，以及性能/renderer registry 观测；artifact `phase3-presentation-37618353908` 保留 14 天。 |
| [GitHub Actions 37618353850](https://github.com/kikoiio/Possibility/actions/runs/37618353850) | 当前提交 `0bdb13a` 的 build/types、7 个 Vitest 文件 150 tests、2 个 fixture tests 均通过。 |
| [GitHub Actions 37619241531](https://github.com/kikoiio/Possibility/actions/runs/37619241531) | 提交 `81d4c77` 的桌面 11/11、Pixel 7 仿真触控 1/1；包括刷新恢复、失败分类/单侧重试、双向混合 renderer 性能与 registry 观测。 |
| [GitHub Actions 37620806443](https://github.com/kikoiio/Possibility/actions/runs/37620806443) | 提交 `50ebac8` 的最新桌面 13/13、Pixel 7 仿真触控 1/1。覆盖左右 403/超时和单侧重试、query/identity/simNow 保持、偏好/URL 优先及 3D 相机刷新恢复；Artifact `phase3-presentation-37620806443` 保留 14 天。 |
| [GitHub Actions 37622734845](https://github.com/kikoiio/Possibility/actions/runs/37622734845) | 提交 `409eccf` 的桌面 13/13、Pixel 7 仿真触控 1/1；记录冷启动、热切换、pane 关闭与离场 renderer 释放。Artifact `phase3-presentation-37622734845` 保留 14 天。 |

## 仍需完成

- 无待补的 T22 build/types 或定向 Vitest 结果；run 37615859235 已验证本次扩展集。
- 完整 AC4 矩阵：真实账号权限镜像、刷新后的相机恢复、慢网/离线、实体硬件触控、完整生命周期循环和混合表现性能。
- AC5 已按用户明确确认记为通过；仓库没有测试者身份、成绩或回访明细。
- T27 Orca Run/worker settled 状态核实。保留的 worker/worktree 未被本次清理。
- 历史真实 provider 的最早 26 次费用尚未完整对账；不能宣称累计总费用已全部核实。
