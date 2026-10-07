# 阶段三交付 QA 矩阵与资源记录

日期：2026-10-08。表现矩阵以 [37639886928](https://github.com/kikoiio/Possibility/actions/runs/37639886928) 为准；上游旅程最终复验 [37649736957](https://github.com/kikoiio/Possibility/actions/runs/37649736957) 于 `main` 提交 `1a8e31a` 完成。Ubuntu hosted runner、桌面 Chromium 20/20、provider job skipped。生产真实账号与公开评估按 [用户验收决定](user-acceptance-2026-10-07.md) 通过。

## 当前工程执行记录

| 项目 | 状态 | 实际范围与证据 |
|---|---|---|
| G0 | 通过 | 历史四种提示、自建保存及原世界 repair 保存已有真实成功结果；阶段二 37640643443 通过；guest/API/浏览器最终复验 37649736957 success，20/20。 |
| T22 | 通过 | [37649736855](https://github.com/kikoiio/Possibility/actions/runs/37649736855)，`1a8e31a`：API types、Web production build/types、完整 API 135 files/931 passed/1 skipped、Web 69 files、voxel contract 17 files 均通过；排除实时 provider harness。 |
| T23 | 自动化工程覆盖通过 | 37639886928 的桌面 20/20、mobile 1/1；包括 2D 相机刷新/作用域恢复、存储损坏/不可用降级、adapter 重试、快速目标替换取消及关闭隔离。 |
| T24 | 实测完成 | 下方单次 readiness 时间、CDP heap 快照和 renderer registry 结果；不形成统计性能阈值或物理/GPU 峰值结论。 |
| T25/H2 | 通过（用户验收确认） | 内部 QA、真实生产账号/跨设备账号、公开真实评估按用户决定通过，未采集公开投票或参与者明细。 |
| 阶段二旅程 | 通过 | [37640643443](https://github.com/kikoiio/Possibility/actions/runs/37640643443)，`8fa8ffc`：production preview + 隔离 Worker/D1、owner 持久化、环境共同投影、离页/暂停/恢复及 mobile touch 4/4。live public demo 跳过后按用户决定通过。 |
| 阶段一浏览器 | 通过 | [37649736957](https://github.com/kikoiio/Possibility/actions/runs/37649736957)，`1a8e31a`，guest/API slices、voxel regression、桌面浏览器 20/20 success；provider job skipped，新增 provider 调用 0。Artifact 已上传。 |
| A1 repair 热点 | 修复并通过 | `37647855745` 曾因重复深拷贝使原样例 repair 达 10.056 秒而 deadline；[37649736855](https://github.com/kikoiio/Possibility/actions/runs/37649736855) 验证后降至 9.357 秒，19,197,242 work units 并完整回归通过。 |

## 固定覆盖映射

“自动化通过”表示以下隔离 fixture/实际浏览器断言；不扩大为真实生产账号、实体设备或所有网络组合的执行结论。

| Case | 场景 | 当前结果与边界 |
|---|---|---|
| S1/S2 | 单 pane 2D/3D 往返、世界上下文、偏好/相机恢复 | 自动化通过：query/world/timeline/identity/simNow 保留，显式 URL 优先、2D/3D 刷新恢复和存储降级；上游 guest 历史旅程见 37649736957。 |
| C1–C4 | 同世界不同 timeline，2D/2D、3D/3D、2D/3D、3D/2D | 自动化通过：四种组合均出现，各侧目标 timeline 和上下文独立。 |
| W1–W4 | 跨世界不同 timeline，四种表现组合 | 自动化通过：左右 worldId/timelineId、能力与时间分离，跨世界联动禁用；左右失败/重试隔离。 |
| P1 | 同世界同表现相机联动 | 浏览器验证 3D 相机传播、混合时禁用、恢复同表现后默认关闭；2D/3D 联动规则、关闭/回声/订阅边界由协调器单测覆盖。 |
| P2 | 跨世界/混合表现相机独立 | 自动化通过：联动 UI 禁用，协调器拒绝不兼容目标。 |
| E1/E2 | 左/右拒绝、超时、503 后恢复 | 自动化通过：403 不可重试，超时/503 可重试且兄弟侧不重新读取；固定 2.5 秒延迟及 internetdisconnected 恢复实际执行。 |
| E3 | 迟到响应、切换目标、取消 | 自动化通过：快速替换取消旧侧加载，关闭该侧保持兄弟 pane mounted；生命周期取消/迟到 mount 释放另有单测。未宣称执行全部双侧失败排列。 |
| E4 | adapter 失败、存储不可用/损坏 | 自动化通过：2D adapter 失败显示原因，保留 world/timeline 并重试；存储异常仍能打开请求的世界。 |
| R1/R2 | 单/双 pane、表现切换、关闭与离场 | 自动化通过已执行路径：renderer 2→1→0，快速替换/关闭隔离，相机恢复与 lifecycle 单测。未逐类测全部 DOM listener/订阅/WebGL 峰值。 |
| H1 | 冷/热加载及堆观测 | 已测，下表记录单次结果；峰值/统计基线为测量限制。 |
| H2 | 内部配对 QA | 通过（用户验收确认），无参与者/成绩/回访原始记录。 |

## Pairwise 覆盖边界

原计划因子为目标关系、四种表现组合、左右身份/能力方向、宽/窄/触控设备、正常/慢响应/离线恢复、左右故障与相机联动。当前已执行固定表现组合及代表性故障/设备路径，未形成证明全部因子两两共现的独立表。

| 批次 | 已执行锚点 | 覆盖限制 |
|---|---|---|
| PW-A 单 pane | 两种表现、刷新/偏好/相机、存储降级 | 未枚举全部设备×网络×身份组合。 |
| PW-B 同世界 | 四种组合、timeline 独立、联动规则、窄屏 | 完整身份镜像及两两共现未逐项执行；生产真实账号项按用户确认通过。 |
| PW-C 跨世界 | 四种组合、独立能力/时间、左右失败/重试 | 未证明全部身份/网络/设备两两共现。 |
| PW-D 生命周期/响应式 | 冷/热/关闭/离场、窄屏及 Pixel 7 仿真触控、旧请求取消 | 实体触屏硬件、真实网络、完整资源峰值不在本轮测量环境。 |

这些是覆盖和测量边界，不表示相应功能尚未实现。浏览器 API 由隔离 route fixture 提供；真实 Hono/SQLite/Worker/D1 契约由技术回归和上游旅程分别验证。

## 性能与资源实测

37639886928，桌面 1280×720，GitHub Actions Chromium，单 worker；heap 使用 CDP `Performance.JSHeapUsedSize`，为视口 ready 时快照，未强制 GC。

| 场景 | Ready 时间 ms | JS heap bytes / renderer |
|---|---:|---|
| 单 3D 冷启动 | 2600 | 36,306,672 |
| 单 2D 冷启动 | 2103 | 50,897,816 |
| 2D→3D 热切换 | 989 | 未在该节点单列 heap |
| 3D→2D 热切换 | 1314 | 未在该节点单列 heap |
| 双 2D 冷启动 | 2034 | 52,299,944 |
| 双 3D 冷启动 | 3795 | 90,396,852；renderer 2 |
| 关闭右 pane | 2458 | 62,601,980；renderer 1 |
| 混合 2D/3D 冷启动 | 3192 | 3D renderer 1 |
| 混合 3D/2D 冷启动 | 3246 | 3D renderer 1 |
| 离开世界页 | 5483 | 96,964,628；renderer 0 |

快照受分配、缓存和 GC 时点影响。离场 heap 读数不代表 renderer 泄漏，也不能用未回落读数证明资源全部释放；本轮明确观察到的是 renderer registry 2→1→0。物理/GPU 内存峰值、完整 context/worker/listener/订阅峰值、统计重复测量均未采集。旧 run 37627964474 的 performance.memory 恒定值不再用作有效 heap 证据。

37639886928 在浏览器操作前记录 free/vmstat/memory PSI：MemAvailable 约 14 GiB、swap 0，后续采样 si/so=0，PSI avg10/60/300=0；cgroup memory.max 未形成有效读数。重型任务由协调者在已授权云端分批执行，测试与浏览器使用 1 worker；本轮未在本机启动重型验证服务。

## 证据保留与 Orca 收尾

37639886928 的成功测试与 `PHASE3_PERF_OBSERVATIONS` JSON 可在运行日志复查；artifact 步骤报告 `/tmp/s02-playwright-results/` 无文件，因此该 run 没有上传 trace artifact。阶段二环境连续性证据通过 workflow 上传。早期浏览器及 API 运行留作历史记录，当前状态不由 Playwright --list 或旧证据推断。

当前 `run_b62869e0d391` 的 14 个 Task 均 completed；14 个 retained terminal user-owned/external，nextAction none。旧 `run_a0e6` 8 retained、1 released；7 个 user-owned、1 个 external retained 资源按所有权保留。没有可回收动作，不强制关闭终端或修改旧 provider session/旧 lifecycle。阶段三根 worktree 的用户 baseline 修改与本地分支保留。

## 真实模型与历史证据边界

历史真实 provider 分批验证已包含官方示例、custom-1/2/3、自建保存及原世界 repair 保存，来源见 [baseline.md](baseline.md)。追加预算 100 次已对账 75 次/$0.863707，余 25 次；本轮新增调用 0。早期总费用仍有未对账范围，不能宣称全历史总费用完整。固定草稿 UI/保存验收不替代真实模型质量结论；用户已确认的内部 QA/公开评估范围按其决定记录。
