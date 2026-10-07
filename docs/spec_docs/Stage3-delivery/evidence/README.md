# 阶段三证据索引

日期：2026-10-08。阶段三实现已集成到 `main`。本次更新以云端实际结果及 [用户验收决定](user-acceptance-2026-10-07.md) 为准；[baseline.md](baseline.md) 保留历史上游记录，Orca 根 worktree 中用户未提交的同名文件保持原样。

## 验收标准状态

| AC | 状态 | 证据与边界 |
|---|---|---|
| AC1 | 通过 | 表现工作区见 [37639886928](https://github.com/kikoiio/Possibility/actions/runs/37639886928)；上游 guest 认领、所有者管理、编辑/比较/刷新及 archive 几何旅程见 [37649736957](https://github.com/kikoiio/Possibility/actions/runs/37649736957)，隔离 API 和桌面浏览器 20/20 通过。真实生产账号按用户决定通过。 |
| AC2 | 通过（自动化覆盖） | 同 run 的 2D/3D 相机刷新恢复、2D timeline/表现作用域隔离、偏好与显式 URL 优先、损坏/不可用存储降级、2D adapter 失败后保留上下文并重试均通过；状态和生命周期单测见技术回归。 |
| AC3 | 通过 | 历史真实 provider 已有官方示例、三个自写提示、自建保存及原世界 repair 保存成功记录。阶段二 [37640643443](https://github.com/kikoiio/Possibility/actions/runs/37640643443) 通过；阶段一最终 guest/几何旅程在 37649736957 通过。真实账号及公开评估按用户决定通过。 |
| AC4 | 自动化工程覆盖通过；保留覆盖限制 | 桌面 Chromium 20/20、Pixel 7 仿真触控 1/1；宽/窄屏、四种表现组合、固定慢响应/断网、失败恢复、adapter 重试、快速替换取消、关闭及 renderer 释放均实际执行。实体硬件、真实网络和完整 pairwise 组合属于覆盖限制。 |
| AC5 | 通过（用户验收确认） | T25 内部 QA 以及需要真实账号、公开真实评估的项按用户决定通过；不宣称采集了公开投票或真实账号数据。 |
| AC6 | 通过 | `phase3` 已合入 `main`，干净子 worktree/分支已清理；当前 Orca Run 的 14 个 Task 均 completed。保留终端按 user-owned/external 所有权维持原状，用户根 worktree 改动保留，详见下方。 |
| AC7 | 通过（云端资源调度记录） | 重型验证在已授权 GitHub Actions 顺序分批执行，浏览器/测试各为 1 worker；37639886928 有 MemAvailable、vmstat、memory PSI 快照。cgroup 上限未形成有效记录，属于观测限制。 |
| AC8 | 通过（报告要求） | 本索引、checklist 和 qa-matrix 同步最终结果、用户验收决定及未测的性能/硬件覆盖边界。 |

## 当前云端证据

最新版本为远端 `1a8e31a`。修复资产候选生成时重复深拷贝整个场景的问题；技术回归 [37649736855](https://github.com/kikoiio/Possibility/actions/runs/37649736855) 和 guest/API/浏览器验收 [37649736957](https://github.com/kikoiio/Possibility/actions/runs/37649736957) 均成功。前序 `37647855745` 曾因原样例修复耗时 10.056 秒超过 10 秒 deadline 失败；本轮优化后用时 9.357 秒，完整 API/Web/voxel 回归通过。provider job 跳过，新增模型调用 0。

| 运行 | 版本及结果 |
|---|---|
| [37643316225](https://github.com/kikoiio/Possibility/actions/runs/37643316225) | `a3ae524`，技术回归 success：API 类型、Web production build/types、完整非实时 provider API 回归、完整 Web 单测、voxel contract 回归全部通过。 |
| [37649736855](https://github.com/kikoiio/Possibility/actions/runs/37649736855) | `1a8e31a`，修复后技术回归 success：API 135 files/931 passed/1 skipped，Web 69 files passed，voxel contract 17 files passed；原样例修复 workUnits 19,197,242、wall 9,357 ms。 |
| [37649736957](https://github.com/kikoiio/Possibility/actions/runs/37649736957) | `1a8e31a`，guest/public-read API、voxel regression 和桌面浏览器 20/20 success；provider job skipped。Artifact `phase1-g0-guest-claim-37649736957` 上传成功。 |
| [37647855745](https://github.com/kikoiio/Possibility/actions/runs/37647855745) | `703124c`，完整 API 回归 134 files/931 passed/1 skipped，唯独原样例修复因 deadline 失败；深拷贝热点已修复并由 37649736855 复验通过。 |
| [37647893040](https://github.com/kikoiio/Possibility/actions/runs/37647893040) | `703124c`，guest/public-read API 和桌面浏览器 20/20 success；provider job skipped。 |
| [37639886928](https://github.com/kikoiio/Possibility/actions/runs/37639886928) | `7c7b752`，阶段三桌面 20/20、mobile 1/1，通过；CDP readiness heap 和 renderer 观测见 qa-matrix。成功运行的 artifact 步骤报告目录无文件；证据为运行日志，不宣称存在该 run 的 trace artifact。 |
| [37640643443](https://github.com/kikoiio/Possibility/actions/runs/37640643443) | `8fa8ffc`，阶段二 success：production preview + 隔离 Worker/D1、owner 持久化、环境事实/规则/画面/证据、离页推进/暂停/恢复、mobile touch 4/4。live public demo 因无 URL 跳过，按用户决定通过。 |
| [37646369937](https://github.com/kikoiio/Possibility/actions/runs/37646369937) | `f07552d`，阶段一浏览器 18/20：创建 5/5、repair 6/6、voxel 编辑 7/7 通过。两项失败由 37649736957 修复后复验通过；provider 请求 0。 |
| [baseline.md](baseline.md) | 历史生成/保存及费用：追加 100 次预算已对账 75 次/$0.863707，余 25 次；本轮未追加调用，早期总费用未全部对账。 |
| [qa-matrix.md](qa-matrix.md) | 固定矩阵、实际自动化覆盖、单次性能/堆快照及测量限制。 |
| [phase2-acceptance-2026-10-07.md](phase2-acceptance-2026-10-07.md) | 阶段二最新生产构建旅程和隔离 Worker/远端部署边界。 |
| [access-audit.md](access-audit.md)、[renderer-audit.md](renderer-audit.md) | 双 pane 权限契约、renderer/相机/生命周期审计。 |

较早的 37614066902、37618353908、37618353850、37619241531、37620806443、37622734845、37625990902、37626431725、37626544402 和 37627964474 是历史证据，不替代上表的新版本结果。

## Orca 与工作区保留决定

当前 `run_b62869e0d391` 的 14 个 Task 全部 completed；14 个 retained terminal 资源均为 user-owned 或 external，`nextAction=none`。旧 `run_a0e6` 有 8 retained、1 released；保留资源中 7 个 user-owned、1 个 external。没有可回收动作，因此记录保留决定，不强关用户/外部终端，也不修改旧 provider session 或旧生命周期状态。

阶段三根 worktree 与本地分支因用户未提交的 `evidence/baseline.md` 修改而保留；未覆盖、提交或丢弃该修改。

## 覆盖限制

- 覆盖限制：Pixel 7 为设备仿真；网络故障为 route 注入；未形成完整 pairwise 共现表；未测物理/GPU 峰值或完整监听器/订阅峰值。CDP heap 为 readiness 快照，未强制 GC，不能用来推断泄漏或性能阈值。
- 真实生产账号、跨设备真实账号体验、公开评估/投票按用户决定通过；隔离工程测试已完成各自云端验收。
- 历史最早 provider 费用仍有未对账范围，不影响本轮零 provider 调用事实。
