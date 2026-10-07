# 阶段三交付 QA 矩阵与资源计划

> 状态：矩阵仍是完整验收目标；2026-10-07 的云端自动化执行子覆盖见下方“阶段三当前执行记录”。固定覆盖和 pairwise 场景尚未完整执行，fixture 测试不代表真实账号、真实触屏、慢网或真实生成质量通过。
> 基线约定：执行时记录 `phase3` commit、应用/API 版本、浏览器/OS、视口、测试账号与隔离 world/timeline 标识；不记录密钥或原始私人对话。任何结果须附路径、观察、限制及 trace/screenshot/log 证据链接。
> 依据：已批准的 `spec.md` AC1/AC4/AC5/AC7、`plan.md` 的组合/资源决策、`task.md` T04，以及 `/home/neo/Projects/Possibility/docs/DEVELOPMENT_ARRANGEMENT.md` 的阶段门槛、隔离数据和内存调度约定。

## 状态和记录格式

每一行实际执行后标记 `通过`、`失败`、`未运行` 或 `阻塞`；未执行时保持 `未验证`。`未验证` 不得被汇总成通过。失败修复后使用相同触发条件复验，并保留失败样例和成功对照。

建议结果记录字段：

| 字段 | 内容 |
|---|---|
| Case / 状态 | 下方用例 ID；通过、失败、未运行、阻塞之一；本文件当前均未验证 |
| 基线 / 环境 | commit、应用/API 版本、OS/浏览器、桌面或触屏、视口尺寸、DPR、网络档位 |
| 两侧目标 | 单 pane 或左右 worldId/timelineId；是否同 world；presentation 组合 |
| 实际会话 | 左/右服务端返回的 identity、capabilities、simNow、stateVersion；不得从 URL 推断权限 |
| 操作与观察 | 可复现步骤；URL、每侧时间/权限、数据请求、错误与重试结果；是否保留已提交状态 |
| 相机 | 各侧初始/最终快照；联动可用/禁用及原因；保存、恢复、切换/卸载结果 |
| 性能/资源 | 冷热加载、切换、帧表现、内存/renderer/context/监听器/请求清理读数及测量条件 |
| 模型条件 | 固定响应 fixture 或经预算确认的真实模型；配置标识、调用数/耗时（不记密钥） |
| 证据 / 限制 | trace、截图、日志、测量文件路径；未覆盖设备/数据/环境及已知限制 |

## 固定覆盖矩阵

以下是不可被 pairwise 抽样省略的行为锚点。单 pane 的表现分别为 2D 与 3D；双 pane 的四种左右表现组合全部执行。所有条目当前状态为**未验证**。

| ID | 场景与配置 | 操作 / 断言重点 | 状态 |
|---|---|---|---|
| S1 | 单 pane，2D；owner 可访问 world/timeline | 冷启动、刷新和 2D→3D→2D；worldId、timelineId、identity、历史、simNow 不变，不创建世界、不推进时间；偏好与按 world/timeline/presentation 保存的相机恢复 | 未验证 |
| S2 | 单 pane，3D；同一测试数据 | 与 S1 相同的上下文/历史断言；相机恢复；热加载与回访可重复；切回 2D 后状态一致 | 未验证 |
| C1 | 同一 world、左右不同 timeline；2D/2D | 验证各自 timeline、simNow、历史、权限及相机隔离；显式开启联动时才允许同型相机同步 | 未验证 |
| C2 | 同一 world、左右不同 timeline；3D/3D | 与 C1 相同；分别捕获/恢复 3D pose；联动不得造成回声或修改另一侧时间/世界状态 | 未验证 |
| C3 | 同一 world、左右不同 timeline；左 2D / 右 3D | 每侧数据和时间独立；混合表现相机联动不可用；单侧切换表现不重置另一侧 | 未验证 |
| C4 | 同一 world、左右不同 timeline；左 3D / 右 2D | 与 C3 镜像验证，避免只覆盖一个左右方向 | 未验证 |
| W1 | 跨 world、不同 timeline；2D/2D | 各侧真实授权、identity/capabilities、simNow、历史、相机均分离；相机联动禁用 | 未验证 |
| W2 | 跨 world、不同 timeline；3D/3D | 与 W1 相同，确认双 WebGL renderer 独立销毁、重试和恢复 | 未验证 |
| W3 | 跨 world、不同 timeline；左 2D / 右 3D | 混合 renderer 和请求/错误隔离；相机联动禁用；关闭任一侧不影响另一侧 | 未验证 |
| W4 | 跨 world、不同 timeline；左 3D / 右 2D | 与 W3 镜像验证；右侧失败时左侧仍可操作 | 未验证 |
| P1 | 同 world 同表现的联动边界（2D/2D、3D/3D） | 默认独立；明确开启后双向相机传播；关闭后立即停止；切换 world/timeline/presentation 时清理旧订阅 | 未验证 |
| P2 | 跨 world 或混合表现的联动边界 | UI/API 不提供或拒绝联动；不得转换不兼容相机数据 | 未验证 |
| E1 | 左侧拒绝/超时/服务错误，右侧 ready；逐一覆盖四种表现组合中的代表项 | 错误归属左 pane；右侧世界、时间和 renderer 不变；只重试左侧，成功后恢复原目标/上下文 | 未验证 |
| E2 | 右侧拒绝/超时/服务错误，左侧 ready；逐一覆盖四种表现组合中的代表项 | 镜像 E1；关闭或重试右侧不卸载左侧 | 未验证 |
| E3 | 两侧同时加载、先后失败和恢复 | 独立 AbortController/重试状态；迟到响应不覆盖新目标；已提交操作不重复执行 | 未验证 |
| E4 | 目标表现不支持、adapter 加载失败或存储不可用 | 保留当前 world/timeline 上下文，解释原因并给可操作退路；损坏偏好/相机记录回退且不伪报保存成功 | 未验证 |
| R1 | 单 pane → 双 pane → 单 pane；随后替换任一侧的目标 | 卸载前保存该 pane 相机；取消该 pane 请求、释放 renderer/context/监听器/订阅；另一侧保持运行；回访读取正确快照 | 未验证 |
| R2 | 分屏关闭、连续切换 2D/3D、重复挂载/卸载 | 无遗留 renderer、WebGL context、动画帧、事件监听、请求或相机订阅；重复循环后资源回到基线范围 | 未验证 |
| H1 | 冷/热加载、单视口/双视口 | 在同一设备与 fixture 下记录加载耗时、交互可用时刻、帧表现和资源峰值；先建立基线，再决定量化门槛，不预设阈值 | 未验证 |
| H2 | 内部 QA 配对任务，2D 与 3D | 用户于 2026-10-07 明确确认该项按通过处理；仓库未附测试者身份、完成/错误/耗时/性能或回访明细；不做公开投票 | 通过（用户验收确认） |

所有双 pane case 另需覆盖左右身份/权限差异：例如左 owner + 右 guest、左 guest + 右 readonly，以及左右身份镜像交换。验证身份和 capability 由各自服务端会话给出；只读操作被拒时不得影响另一侧。具体账号组合通过下方 pairwise 批次安排。

## Pairwise 覆盖批次

pairwise 只用于压缩设备、网络、身份方向、目标关系与 pane 故障的笛卡尔积；不能替代上表必测的四种 renderer 组合、同/跨 world、联动边界、单侧失败恢复及性能释放锚点。每行是一组计划批次，代表值须在执行记录中展开为实际 case ID。所有计划批次当前均未验证。

### 因子与水平

| 因子 | 覆盖水平 |
|---|---|
| 目标关系 | 单 pane；同 world 双 timeline；跨 world 双 pane |
| presentation | 单 pane：2D、3D；双 pane：2D/2D、3D/3D、2D/3D、3D/2D（四种必测，不抽样） |
| 身份/能力方向 | owner/owner；owner/guest；guest/owner；owner/readonly；readonly/owner；guest/readonly；readonly/guest。用实际返回 capabilities 区分可读/可写 |
| 设备/输入 | 桌面宽屏鼠标键盘；窄屏触控或模拟窄视口；触屏设备/触控输入。记录 viewport，不把桌面缩窗等同真实触屏 |
| 网络 | 正常；慢网/高延迟；请求中断/离线后恢复。固定注入策略并记录超时/恢复方式 |
| pane 故障方向 | 无故障；左拒绝/超时/错误后重试；右拒绝/超时/错误后重试；新目标切换造成旧请求取消 |
| 相机 | 独立；同 world 同表现可联动；跨 world 禁用；混合表现禁用 |

### Pairwise 批次定义

| 批次 | 覆盖方式 | 必须保留的代表组合 | 状态 |
|---|---|---|---|
| PW-A 单 pane 基础 | S1/S2 各覆盖 owner、正常/慢网/恢复、桌面/窄屏/触屏；对设备×网络×身份方向做 pairwise，模型固定 | 单 pane 两种表现都在三个设备类别出现；至少一次偏好/相机恢复与一次不支持表现退路 | 未验证 |
| PW-B 同 world 双 timeline | C1–C4 全部组合；在组合之间轮换 owner/guest/readonly 左右方向、三类设备、网络档位和故障侧，使用 pairwise 表覆盖剩余配对 | 两侧不同 timeline 与 simNow；身份/权限镜像；左/右各一次失败重试；同型可联动，混合禁联动 | 未验证 |
| PW-C 跨 world 双 pane | W1–W4 全部组合；身份组合及方向、设备、网络、故障方向 pairwise | 两个真实 world；左右至少各一次失败/恢复；跨 world 联动始终禁用；各侧权限独立 | 未验证 |
| PW-D 生命周期/响应式 | S/C/W 中挑选 2D/2D、3D/3D、两种混合组合各一条，覆盖桌面宽屏、窄屏和触屏；配对慢网与目标切换/关闭 | 关闭、重开、窄屏 pane 切换、触控操作及资源归还；双 3D 场景必须单独排期 | 未验证 |

执行者应在运行前把 PW-A/B/C 因子表展开为 pairwise 用例清单并附在结果证据中，确保每一对水平至少共现一次；测试数据、实际账号权限和浏览器能力不匹配时记录为阻塞/未验证，不降低为通过。四种 presentation × 同/跨 world 的固定锚点仍须完整执行。

## 模型与 API 边界

| 类别 | 响应策略 | 使用范围 / 约束 | 状态 |
|---|---|---|---|
| 确定性回归 | 固定响应/隔离 fixture；左右响应可分别成功、拒绝、超时或失败 | 路由、权限隔离、失败重试、renderer 选择、相机状态、布局及性能基线；记录 fixture 版本，固定响应不得描述成模型质量结论 | 计划，未验证 |
| 本地真实 API + 固定模型响应 | 请求真实本地 API、使用隔离测试数据库/world/timeline；模型端以可重复响应桩固定 | 验证会话、权限、数据加载和端到端状态；不替换用户数据库，不触达生产数据 | 计划，未验证 |
| 真实模型调用 | 仅在需要比较真实生成/对话质量的内部 QA 子项使用；与确定性回归分开执行 | **调用预算上限、模型/配置、测试数据、调用责任人必须在执行前确认**；未确认不得发请求，保留未验证。确认后逐项记调用数、成功/失败、耗时与成本，不记录密钥/原文私人对话 | 未验证；预算待执行前确认 |

AC5 配对比较只有在同主题、人物、检查点、模型条件和核心任务一致时才可比较。若无预算确认，只完成固定响应下的功能矩阵，真实模型质量与真实调用条件明确标为未验证，不以固定响应替代。

## 性能与资源顺序

所有重型验证由协调者集中排期；每个阶段结束后记录资源和进程，再决定是否进入下一阶段。不并发启动多个浏览器、构建、全量测试、容器或双 WebGL 验收。资源紧张时暂停新增负载、缩小批次或分批；不因 swap 使用率单项判停，不执行 swapoff、清缓存或修改系统内存设置。

| 顺序 | 批次 | 启动前 / 执行方式 | 记录与退出条件 | 状态 |
|---:|---|---|---|---|
| 0 | Gate 与轻量准备 | 确认阶段一/二验收证据和 `phase3` 基线；G0 未通过时不执行依赖实现/浏览器验收。整理隔离账号、world/timeline、固定响应与矩阵用例 | 缺失的上游旅程证据列 blocker；不推断通过 | 未验证 |
| 1 | 资源快照 | 重型工作开始前视情况记录 `free -h`、`vmstat 1 5`（看后续采样的 si/so）、`cat /proc/pressure/memory`；受 cgroup 限制时检查自身上限；盘点其他任务/服务 | 记录 MemAvailable 绝对值及趋势、换页、memory PSI、桌面余量、任务预计峰值；据此决定单槽/顺序执行 | 未验证 |
| 2 | 固定响应轻量验证 | 先做静态文档/用例准备和确定性 API/状态验证；若后续运行 Vitest，`--maxWorkers=1`；不启动浏览器 | 保存环境和失败证据；不与构建/浏览器并行 | 未验证 |
| 3 | 单 pane 基线 | 顺序测冷/热单 pane 2D，再单 pane 3D；浏览器单 worker/单实例，复用已存在服务，避免重复 API/Vite | 记录加载、交互、帧表现、峰值与卸载后基线；完成后确认资源释放 | 未验证 |
| 4 | 双 2D | 单独一批 2D/2D，同 world 后跨 world；不同时运行其他重型任务 | 记录双视口开销、会话隔离、请求/renderer 释放；结束并检查后再继续 | 未验证 |
| 5 | 混合渲染 | 单独测 2D/3D，再 3D/2D；交换左右方向；两批间检查回到可用资源状态 | 记录每侧加载/相机边界、单侧失败恢复和卸载；不可把一方向结果代替另一方向 | 未验证 |
| 6 | 双 WebGL | **最高峰值，单独窗口执行** 3D/3D；固定单 browser、单 worker，不并发第二套浏览器/构建/全量测试 | 记录双 renderer 峰值、context 数及卸载后资源；持续内存压力时停止新增负载，标明剩余用例未验证 | 未验证 |
| 7 | 设备/网络 pairwise | 按 PW-A 至 PW-D 串行使用浏览器设备项目或真实触屏设备；注入慢网/中断后恢复；不与性能峰值批次重叠 | 展开组合表、保存 trace/screenshot/log；真实触屏能力无法取得时如实未验证 | 未验证 |
| 8 | 性能、释放与内部 QA | 基础行为矩阵通过且资源快照允许后，完成 H1/R1/R2；真实模型 QA 另开窗口，仅在预算批准后运行 | 先测基线、再测单/双视口；记录回访与限制；每阶段清理本任务启动且不再需要的进程，不终止其他任务 | 未验证 |

## AC 覆盖索引

| 验收标准 | 对应矩阵 | 关键证据 |
|---|---|---|
| AC1：单入口/同世界双 timeline/跨世界；四种组合；时间、权限、失败隔离、相机规则 | S1–S2、C1–C4、W1–W4、P1–P2、E1–E4 | 每侧 world/timeline/identity/capabilities/simNow；联动允许/拒绝；左/右失败复验 |
| AC4：空间、表现、身份、设备、网络、恢复、性能和资源释放 | 全固定覆盖矩阵、PW-A–PW-D、R1–R2、H1 | 实际环境、版本、设备/视口、操作路径、结果、限制、trace 与读数 |
| AC5：内部 2D/3D 配对任务、公平比较和回访 | H2、模型与 API 边界 | 同一任务/模型条件、完成/错误/性能/回访；预算确认或明确未验证 |
| AC7：重型操作前资源评估与有序调度 | 性能与资源顺序 1–8 | MemAvailable、vmstat 后续换页采样、memory PSI、cgroup 上限（若适用）、批次开始/结束记录 |

## 阶段三当前执行记录（2026-10-07）

| 项目 | 状态 / 结果 | 范围与证据 |
|---|---|---|
| G0 阶段门槛 | 通过 | `evidence/baseline.md` 记录阶段一/二正面出口及真实 provider 结果；新增真实请求 93 次，累计旧计数 205，新增可核实费用 `$1.011892`，早期 26 次费用未完整对账。 |
| T22 构建与定向验证 | 通过 | [run 37618353850](https://github.com/kikoiio/Possibility/actions/runs/37618353850) 在提交 `0bdb13a7511833755b803fb9d0f50e786abf0335` 上 Web production build/types、7 个 Vitest 文件 150 tests、fixture 2 tests 通过。构建日志有 Vite 大 chunk 提示，不影响退出码。较早的 `37615859235`（150 tests）、`37615432126` 和 `37614066902`（各 119 tests）也通过。 |
| T23 自动化子覆盖 | 通过（不代表完整 P2 矩阵） | 最新 [run 37627964474](https://github.com/kikoiio/Possibility/actions/runs/37627964474)，commit `b47173050ebe222026fef7cb98c12dc4975569bc`，Ubuntu 24.04，1 worker；桌面 Chromium 15/15 passed，Pixel 7 mobile-chromium 1/1 passed。保留 run 37622734845 的同/跨 world 四种组合与相机规则、左右 503/403/超时隔离、query/identity/simNow、偏好/URL优先、3D相机刷新恢复、窄视口与触控；新增固定 2.5 秒响应延迟和 `internetdisconnected` 断网恢复，两例均断言另一侧可用且只重试失败侧。Pixel 7 是设备仿真，不是实体硬件；真实慢网/账号/触屏仍未验证。 |
| T24 性能与资源释放观测 | 测量完成；峰值指标未验证 | run 37627964474 在单 worker 下记录 ready 时间：单 3D 冷 2151 ms、单 2D 冷 1691 ms、2D→3D 热切换 759 ms、3D→2D 热切换 942 ms、双 2D 冷 1651 ms、双 3D 冷 3061 ms、关闭右 pane 1949 ms、混合 2D/3D 冷 2591 ms、混合 3D/2D 冷 2579 ms、离开世界页 1517 ms。双 3D renderer 从 2 关闭右侧后降至 1，离场后降至 0；混合方向各有 1 个 3D renderer。`usedJSHeapSize` 单次测量保持 60,300,000 bytes，不能表示有效堆差值；未采集峰值物理/GPU 内存及 worker/订阅清理读数，耗时也不构成统计基线或性能阈值。 |
| Actions runner 资源快照 | 通过（本轮云端批次） | run 37627964474 浏览器工作前 MemAvailable 14 GiB、swap 0；5 个 `vmstat` 后续样本 `si/so=0`；memory PSI avg10/60/300=0。runner cgroup `memory.max` 命令未产生可记录值。 |
| T25 内部配对 QA | 通过（用户验收确认） | 用户于 2026-10-07 明确要求将该项按通过处理；仓库未附测试者身份、成绩或回访明细。没有开展公开评估或投票。 |
| Orca T27 收尾 | 受限 | `phase3` 已快进合入并推送 `main`，远端分支删除；8 个干净的阶段三子 worktree/本地分支已通过 Orca 移除。当前根 worktree 保留用户未提交的 `baseline.md` 改动及本地分支。Run 有 35 个 Task：34 completed、T27 ready；9 个 Dispatch 含 8 成功、1 readiness-failed。8 个 retained terminal 的 `worker-show` 均证明 exact worker exited，但 7 个资源标 `user_owned/user_takeover`、1 个 `external`，Orca `nextAction` 仍为 none；未关闭终端。 |

run 37627964474 的浏览器 trace/log 由 Actions 上传为 artifact `phase3-presentation-37627964474`，保留 14 天，入口为上方 run。E2E 身份来自隔离 fixture；慢响应/断网由 route 注入，不代表真实网络；实体设备、真实 owner/guest/readonly 权限组合和完整生命周期循环仍未验证。

## T04 规划阶段未执行项（历史记录）

- 上述“未执行”内容仅反映 T04 矩阵编制时的状态；当前执行结果以本文件“阶段三当前执行记录”为准。
- 完整固定矩阵与 pairwise 项仍需逐项核验；历史真实生成证据与本次 fixture E2E 分别记录，不互相替代。


## 执行补充：Phase 1 G0 旅程中的分屏 smoke

- **run/commit**：GitHub Actions [37570453870](https://github.com/kikoiio/Possibility/actions/runs/37570453870)，`phase3` commit `1b96beca8cf2a62586f09884b356debffb62ddf1`，workflow revision 14；job `112627651680`。同一已认领 world、不同时间线、桌面 Chromium 1280×720、3D/3D。API 历史 clone 回归 **4/4 passed**，浏览器同账号旅程 **1/1 passed**，provider calls 0。证据明细见 [`phase1-g0-checkpoint.md`](phase1-g0-checkpoint.md) 与 [`phase1-guest-claim.log`](phase1-guest-claim.log)。
- **实际覆盖**：分屏入口、左右真实 timeline 标题及两个 `VoxelViewport` canvas；在分屏仍打开时刷新，断言两侧恢复；正常返回在场视图后验证多空间居民和对话记录。场景编辑修订也跨刷新保留。
- **矩阵映射与边界**：这仅是 C2（同 world、不同 timeline、3D/3D）和 R1（单 pane→双 pane→单 pane / 回访）的旅程 smoke。未观察相机隔离或联动、单侧切换/失败重试、权限差异、renderer/context/订阅释放、资源峰值、热/冷性能；因此 C2、R1、H1/R2 状态保持**未验证**。C1、C3、C4、W1–W4、P1/P2、E1–E4、其他 PW 批次及真实触屏/慢网也仍未执行。

## 非 provider API slice 执行结果

- GitHub Actions [run 37571095445](https://github.com/kikoiio/Possibility/actions/runs/37571095445)，`phase3` commit `96e6e8d7a1f0e77f52dbc5f7537859204f1a44db`，job `112629670488`，workflow revision 15：4 个 API 文件 **10/10 tests passed**，浏览器 journey **1/1 passed**，provider calls 0。
- `api/src/map/bootstrap.test.ts` 新增真实 Hono route + SQLite migration-backed fixture，验证 Guest 当前 sandbox bootstrap、resume save/restore 与跨 world bootstrap/resume 拒绝；同批复验 `api/src/public/routes.test.ts` 匿名 demo 只读/禁止写入、`api/src/access/policy.test.ts` owner/guest capabilities，以及历史 clone 回归。
- 这只证明 API 路由/权限/数据契约，不替代双 pane UI identity、failure isolation 或 renderer 矩阵。账户型 readonly 未发现独立产品身份，仍未验证；上方 C/W/P/E/PW/H/R 固定矩阵未由本次完整覆盖，状态不升为通过。


## 独立非 provider 创建与补建 smoke（已执行）

专用 Actions workflow 已执行 `api/src/worlds/create-voxel.test.ts`、`api/src/scenes/routes.test.ts` 与 `web/e2e/scene-create.spec.ts`、`web/e2e/scene-repair.spec.ts`。API 使用固定合法体素文档实测 world + 初版场景保存、原 worldId 补建 revision 幂等及居民/timeline 保持；浏览器的草稿生成由 Playwright route fixture 响应，用于验证创建/补建 UI、保存和重试流程。无 provider 调用；真实生成后成功创建/补建仍是独立 G0 gate，未核验。

- **run/commit**：GitHub Actions [run 37571774129](https://github.com/kikoiio/Possibility/actions/runs/37571774129)，`phase3` commit `548de701fdfbb0f53ab0bbbd809647e2983ad090`，job `112631785249`，workflow revision 16；job 4m18s，结论 success，provider calls 0。
- **API 通过**：6 个测试文件 / 33 tests passed。包含 guest participation/clone、Guest bootstrap、anonymous public routes、access policy、`worlds/create-voxel.test.ts` 与 `scenes/routes.test.ts`。创建/补建 API 使用固定合法文档，验证保存契约，不涉及 provider 生成。
- **Browser 通过**：Playwright 10/10 passed（3 files，1 worker），包括 `guest-claim-journey.spec.ts`、`scene-create.spec.ts`、`scene-repair.spec.ts`。guest fork/claim 全旅程通过 1/1；创建和补建用 route fixture 提供 draft 响应。
- **Artifact**：`phase1-g0-guest-claim-37571774129`（ID `11460956808`，2,887 bytes，未过期）；run 页面日志和 artifact 可复查 API/browser 输出。
- **限制/G0**：本项只证明隔离 API 与 fixture-backed UI 行为。真实 custom prompts/official example 生成、自建单空间生成后保存、原 worldId 真实 repair 生成后保存仍未通过。矩阵中的其他固定 2D/3D、跨 world、混合 renderer、权限隔离、设备/性能与生命周期场景仍按矩阵状态保留未验证。

## 上游 G0 汇总

- **阶段一仍 blocked**：缺真实 provider 对 3 条自写 prompt + 官方示例的有效生成、有效生成后自建单空间保存，以及在既有原 `worldId` 上真实 repair 生成后保存。先前 26 次调用结果见 [`phase1-generation-results.json`](phase1-generation-results.json)；本轮未调用 provider。
- **阶段二仍待部署验收**：部署环境 progression / pause / resume 未验证；已通过的 production preview 使用 hosted runner 上的 local Worker/D1，不是远端部署 world。由另一 session 负责，证据见 [`phase2-acceptance-2026-10-07.md`](phase2-acceptance-2026-10-07.md)。
