# 阶段三证据索引

日期：2026-10-07。阶段三实现已从 `phase3` 快进合入并推送到 `main`。当前 main SHA `b47173050ebe222026fef7cb98c12dc4975569bc` 的桌面浏览器 15/15 与 Pixel 7 设备仿真触控 1/1 通过；仍不把 fixture 覆盖、局部资源观察或不同时间的证据拼成完整 P2 矩阵通过。

## 验收标准状态

| AC | 状态 | 证据与边界 |
|---|---|---|
| AC1 | 部分通过 | [run 37627964474](https://github.com/kikoiio/Possibility/actions/runs/37627964474) 覆盖单世界切换、同/跨世界四种表现组合与相机规则、左右 pane 503/403/超时恢复，以及只重试失败侧。身份来自隔离 fixtures；阶段一真实生成 gate 仍未通过，真实账号授权和完整历史/身份/时间断言未全部覆盖。 |
| AC2 | 部分通过 | run 37627964474 验证表现偏好刷新恢复、显式 URL 优先和 3D 相机快照恢复；状态层单测覆盖损坏/不匹配记录及存储异常。2D 相机完整页面恢复、adapter 加载失败 UI 退路和历史全旅程仍未验证。 |
| AC3 | 未通过 | 阶段二当前 main 验收通过，但阶段一真实生成/自建保存/真实 repair 仍有失败证据；不能将 G0 标为已解除。详见 [baseline.md](baseline.md)。阶段三实现已集成，不改变该验收结论。 |
| AC4 | 部分通过 | 当前 main 桌面 Chromium 15/15、Pixel 7 mobile-chromium 设备仿真触控 1/1（run 37627964474）；包括 390×844/528×720、同/跨世界表现组合、左右 pane 403/503/超时、固定 2.5 秒慢响应和 `internetdisconnected` 断网恢复、混合 renderer、热切换和离场释放。真实账号权限镜像、实体触屏、全生命周期、真实网络环境与完整 pairwise 矩阵仍未验证。 |
| AC5 | 通过（用户验收确认） | 用户于 2026-10-07 明确要求将 T25/该项按通过处理。仓库未附测试者身份、成绩和回访明细；没有开展公开投票或评估。 |
| AC6 | 部分通过 | `phase3` 已快进合入并推送到 `main`；远端 `phase3` 和 8 个干净的阶段三子 worktree/本地分支已清理。Orca Run 有 35 个 Task，34 completed、T27 仍 ready；9 个 Dispatch 中 8 个成功、1 个 readiness-failed。8 个保留终端的 worker-show 均报告 exact worker exited，但 7 个资源仍是 user-owned、1 个 external，Orca nextAction 不允许释放。阶段三 root worktree 还保留用户未提交的 `baseline.md` 修改。 |
| AC7 | 部分通过 | run 37627964474 的 Browser Actions 在重型操作前记录 MemAvailable 14 GiB、无 swap 使用、5 个 `vmstat` 后续样本 `si/so=0`、memory PSI avg10/60/300=0；单 worker 顺序执行。cgroup `memory.max` 无有效输出。 |
| AC8 | 通过（报告要求） | 本索引与 [checklist.md](../checklist.md)、[qa-matrix.md](qa-matrix.md) 明确列出 AC1–AC8 结果、限制和未验证项；T25 按用户确认通过，公开评估/投票标为延期。该报告状态不代表所有功能验收通过。 |

## 运行与原始证据

| 证据 | 内容 |
|---|---|
| [baseline.md](baseline.md) | 上游 G0、真实 provider 批次、费用和阶段门槛结果。追加授权的 100 次中，6 个真实 provider runs 已逐 artifact 对账为 99 次、`$1.315873`，尚余 1 次；之前记载的 112/200 次是追加授权前基线，早期总费用仍未完全对账。 |
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
| [GitHub Actions 37625990902](https://github.com/kikoiio/Possibility/actions/runs/37625990902) | main SHA `c975c9a`：桌面 Chromium 13/13、Pixel 7 仿真触控 1/1。runner 快照 MemAvailable 14 GiB、无 swap、vmstat 后续 si/so=0、memory PSI=0。 |
| [GitHub Actions 37626431725](https://github.com/kikoiio/Possibility/actions/runs/37626431725) | main SHA `c975c9a`：production Web build/types、7 个 Vitest 文件 150 tests、2 个 fixture tests 通过。 |
| [GitHub Actions 37626544402](https://github.com/kikoiio/Possibility/actions/runs/37626544402) | main SHA `c975c9a`：production preview + 隔离 Worker/D1 owner journey、环境事实/规则/证据、leave/pause/resume、mobile touch 通过；公开 demo 因未配置 URL 而跳过。 |
| [GitHub Actions 37627964474](https://github.com/kikoiio/Possibility/actions/runs/37627964474) | main SHA `b471730`：桌面 Chromium 15/15、Pixel 7 仿真触控 1/1。新增 2.5 秒延迟和 `internetdisconnected` 单侧失败/恢复用例。Artifact 保留期 14 天。 |
| main 集成与分支清理 | 已完成 | `phase3` 在 `f66e5be` 快进合入 `main` 并推送；远端 `phase3` 已删除。8 个干净的阶段三子 worktree/分支已通过 Orca 清理。当前 phase3 根 worktree 与本地分支保留，因 `evidence/baseline.md` 有用户未提交改动；该改动未被提交或丢弃。 |

## 仍需完成

- 无待补的 T22 build/types 或定向 Vitest 结果；run 37615859235 已验证本次扩展集。
- 完整 AC4 矩阵：真实账号权限镜像、2D 相机完整刷新恢复、实体硬件触控、完整生命周期循环、真实慢网/离线及混合表现统计性能；当前慢响应与断网结果是 route fixture 注入。
- AC5 已按用户明确确认记为通过；仓库没有测试者身份、成绩或回访明细。
- T27 Orca worker ownership/liveness 收尾：所有 Task 结果已核实，8 个 retained terminal 的 exact worker 均已证明 exited；Orca 仍将 7 个资源标为 user-owned、1 个为 external，因此不给出 release action，也没有强行关闭终端。当前 Run 的 T27 保持 ready 并记录该 blocker。
- 历史真实 provider 的最早 26 次费用尚未完整对账；不能宣称累计总费用已全部核实。
