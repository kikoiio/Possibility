# Minecraft 式 LLM Agent 社会实验

状态：**第一轮已完成；第二轮感知调度优化与检索记忆评估正在执行**。规则策略、异步模型、局部观察、私有记忆、资源采集／放置和快照重置均已接通。服务端 agent 的原始证据见 [agent/evidence/m0-2026-10-27.md](agent/evidence/m0-2026-10-27.md)，当前执行计划见 [PLAN.md](PLAN.md)。

研究背景、候选项目调查与规模估算见 [Minecraft 社会研究](../../docs/research/2026-10-28-minecraft-agent-societies.md)。本目录是该方向在 Wispiva 仓库内的落地位置，项目整体边界见[当前架构](../../docs/architecture.md)，近期进度和待决事项见[工作计划](../../docs/PLAN.md)。

## 定位与边界

- 这是 **Wispiva 的延伸研究**，不是产品主线，也不是第二套体验入口。
- 与唯一原型的边界（2026-10-27 决定）：
  - 不共用 `prototypes/package.json`；Luanti 依赖由本目录的 `runtime/bootstrap.sh` 从系统软件源获取并解包，当前没有依赖锁文件。`.runtime/manifest.sha256` 记录本机产物哈希，并不固定将来下载的版本。
  - 不共用原型的 CI job 与运行时；[实验 CI](../../.github/workflows/society-experiment.yml) 顺序验证 Lua/Python、引擎闭环、快照、资源动作和按分支选择的容量或真实模型实验。服务端 jar／原生二进制、bot 连接、EULA 与账号问题都不进入 Wispiva 的 `verify.mjs` 和原型依赖。
  - 不改变 [Mineflayer / Voyager 研究](../../docs/research/2026-10-28-mineflayer-voyager.md) 得出的“Wispiva 主项目不引入 Minecraft 运行时”结论。
- 为什么不是 `scratch/`：`scratch/` 是 2026-10-27 整理时作为迁移残留被移除的目录；`prototypes/` 是 AGENTS.md 规定的唯一原型入口。实验需要的是**独立运行时**，不是多一层目录。

## 硬约束（用户 2026-10-27 决定）

1. **只能用免费资源**：2026-10-28 用户授权调用 GitHub 配置的模型和使用 GitHub Actions 免费资源，取代此前模型只在本机调用的限制。密钥仅作为运行时 secret 注入，不写进代码或日志，不读取 `.env`。重型测试优先 GitHub Actions。
2. **优先开源**：用户明确不打算为 Minecraft 付费，并倾向用开源项目替代。这条改变了最初的“一定要真 Minecraft”，本轮已选择下表的 C 路线。
3. 任何可能产生费用的服务、任何需要上传密钥或私有数据的云端调用，执行前必须再次取得用户明确许可。

## 环境选型

2026-10-28 用户接受 C 路线的服务端实体形态；A、B 保留作背景，不作为本轮实现目标。

| 路线 | 开源 | 需要 Java | 生态兼容 | 已核实的状态 |
| --- | --- | --- | --- | --- |
| **A. 真 MC（Paper）** | ✗ 本体 proprietary，Paper 是补丁分支 | **要**（OpenJDK 免费开源，本机未安装） | 满配：mineflayer／Mindcraft／Project Sid 全对得上 | 服务端**免费**、离线模式不需账号、无需付费；`fill.papermc.io/v3` 可访问；固定 1.21.11（`minecraft-data` 支持到 1.21.11 与 26.1） |
| **B. flying-squid + mineflayer** | ✓ MIT | 不要 | 与 mineflayer 同属 PrismarineJS | `flying-squid@1.12.0`，2026-04 仍在发版；协议停在 1.12 时代，方块与机制覆盖不全，JS 单进程规模上限低 |
| **C. Luanti（原 Minetest）** | ✓ 引擎 LGPL-2.1+ | **不要** | ✗ 不是 MC，mineflayer 用不上 | **本机实测可运行、可承载万级服务端实体**，见下节 |

Glowstone（另一个开源 MC 协议实现）最后发版为 2021-08，已废弃，不考虑。

### 关于“Minecraft 要付费”

不成立，至少对我们的用法不成立：Java 版服务端官方免费下载（接受 EULA 即可），本地私服 + 离线模式 + 无头 bot 不需要买游戏、不需要账号、零费用。**需要付费的是“正版客户端登录在线模式服务器”**，与实验无关。真正卡住 A 路线的是本机没有 Java 运行时（而 Java 本身也是免费开源的），以及用户对开源的要求——MC 本体并不开源。

## 已核实：C 路线（Luanti）

完整原始证据见 [bench/luanti-entity-scale-2026-10-27.txt](bench/luanti-entity-scale-2026-10-27.txt)，基准代码为 [bench/init.lua](bench/init.lua) 与 [bench/run.sh](bench/run.sh)。

**可行性与许可证**

- 零 sudo、零 Java 即可运行：把 Ubuntu 的 `luanti`／`luanti-server`／`luanti-data`／`luanti-game-minetest` 四个 deb（共 10.2 MB）与 6 个缺失 `.so` 依赖包下载后 `dpkg-deb -x` 解包到项目目录，`luantiserver` 直接启动成功（`Luanti 5.10.0 (Linux)`，LuaJIT 2.1）。全程未安装系统包、未使用 sudo、未修改系统配置。
- 许可证（读自包内 `copyright`，权威）：引擎 **LGPL-2.1+**；Minetest Game 代码 LGPL-2.1-only、素材 CC-BY-SA-3.0。无 EULA、无账号、无付费点。

**服务端实体规模（本机，实时基准 11.1 step/s）**

| 配置 | 实体 | 全部 step | step/s | 峰值 RSS |
| --- | --- | --- | --- | --- |
| idle / move / perceive | 1000 | 是 | 11.02–11.14 | 64–68 MiB |
| move | 5000 | 是 | 11.03–11.11 | 98 MiB |
| idle / move | 10000 | 是 | 11.02–11.11 | 100–110 MiB |
| move | 20000 | 是 | 11.02–11.04 | 167 MiB |
| perceive（O(N²) 邻域） | 5000 | 是 | **4.39–7.30** | 98 MiB |
| perceive（O(N²) 邻域） | 10000 | 是 | **0.92** | 110 MiB |

结论：**内存与实体数量都不是瓶颈**——每步 O(1) 工作下 2 万实体仍保持实时、167 MiB。**崩塌来自每实体的计算量**：朴素的全局邻域感知在 1000→5000 之间跌破实时。因此千级以上的关键设计是感知的空间分区／LOD，这给研究文档里“距离 LOD 是千级以上更现实的关键设计”提供了本项目自己的数字。

**必须记住的工程陷阱（本轮实测发现）**

- 无玩家时实体不会被 step，必须先 `forceload_block`。
- 但只 forceload 还不够：在区块 emerge 完成前 `add_entity`，实体会在活跃区块管理周期（`active_block_mgmt_interval = 2.0`）中被**静默删除**，且 `add_entity` 返回有效对象、不报错。正确做法是在 `core.emerge_area()` 的 `calls_remaining == 0` 回调里再生成实体。
- 相关默认值：`max_objects_per_block = 256`（每 16³ 区块静态对象上限）、`max_forceloaded_blocks = 16`（可设 `-1` 解除）、`active_block_range = 4`（以玩家为中心）、`dedicated_server_step = 0.09`。

**LLM 接入能力**

- `core.request_http_api()` 提供 `fetch`／`fetch_async`，需将该 mod 列入 `secure.trusted_mods` 或 `secure.http_mods`；cURL 支持已编译进 Ubuntu 包（`ldd` 确认链接 libcurl）。
- `core.handle_async()` 提供独立工作线程环境，可把秒级 LLM 调用放到服务端主循环之外。
- 安全边界：给 mod 开 HTTP 权限后，若 LLM 输出能影响请求目标，即等于打开外发通道（提示注入）。请求目标与请求体必须由程序侧固定。

### 已跑通：M0 服务端 agent 闭环（2026-10-27）

代码在 `agent/`，原始日志与逐条退出条件见 [agent/evidence/m0-2026-10-27.md](agent/evidence/m0-2026-10-27.md)。

| 场景 | 停止方式 | 用时 | 峰值 RSS | 每区间被推进 | 最低 step/s |
| --- | --- | --- | --- | --- | --- |
| 5 agent × 10 决策（连跑两次） | 自行关服 | 23 s | 45 MiB | 5/5 | 11.08 |
| 20 agent × 8 决策 | 自行关服 | 19 s | 46 MiB | 20/20 | 11.08 |
| 5 agent，15 秒后外部 SIGTERM | SIGTERM | 15 s | 45 MiB | 5/5 | 11.08 |
| 反向用例：生成点越出 forceload 范围 | 检出失败后关服 | 5 s | 44 MiB | — | — |

实时基准 11.1 step/s。四条退出条件的状态：

- **可重复启停**：自关服与 SIGTERM 两条路径都留下完整账、进程退出经复核；同配置两次运行的确定性事件序列逐行一致（73 行）。注意比对**不含**墙钟与 step/s 统计行——真实时间本来就不可复现。
- **每步被推进**：每个统计区间 `stepped_delta` 等于 agent 数（5/5、20/20），step 率 11.08–11.12。
- **世界真的变了**：关服时用 `find_nodes_in_area` 回读地图，标记方块数与 mod 自记计数一致（`marks_counter=6 marks_in_world=6 ok=true`）。
- **失败说得清**：反向用例里 5 个实体被静默清掉、`add_entity` 却全部返回有效对象，程序自己检出并报出 `fail=agents-lost-after-spawn alive=1 expected=5`。`run.sh --expect-fail` 要求"检测到失败才算通过"，没有这个用例，这条就只是自述。

跑法（**不用 sudo、不装 Java、不装系统包**，运行时由脚本就地解包，约 60 MB）：

```bash
runtime/bootstrap.sh                                      # 幂等：缺什么补什么
agent/run.sh --label m0 --repeat 2                        # 5 agent，各 10 次决策，跑两次比对
agent/run.sh --label m0-n20 --agents 20 --decisions 8     # 换规模
agent/run.sh --label m0-stop --decisions 0 --seconds 15   # 走 SIGTERM 停止路径
agent/run.sh --label m0-negative --set society_spacing=64 \
  --expect-fail agents-lost-after-spawn                   # 反向用例
```

M0 的代码分工如下；后续模型接入还需要异步队列、校验和运行器，不能只替换策略文件：

```text
agent/
  mod/society/init.lua    # 引擎胶水：forceload/emerge、生成、推进、执行、记账、事件格式
  mod/society/policy.lua  # M0 的规则策略；模型模式由独立桥接实现
  run.sh                  # 启停夹具与硬校验（一次只跑一个服务端）
  evidence/               # 原始日志、逐项报告、M0 证据文档
```

两条设计决定，改之前先想清楚为什么：

- **决策由一个 `globalstep` 按 agent id 排序驱动，不写在实体的 `on_step` 里**。引擎遍历活跃区块的顺序不保证稳定，写在 `on_step` 里日志交错就会随机化，可重复性直接没了。`on_step` 只用来记步数，作为"被推进"的证据。
- **随机性来自固定种子的 LCG，不用 `math.random`**。后者受引擎与调用顺序影响，两次运行不一定给出同一序列。

### C 路线的生态核查（只读检索，未克隆、未运行第三方代码）

- **Luanti 引擎不自带任何可玩游戏**，只带 `devtest`（引擎自测用）。官方定位是“平台 + 从 ContentDB 下载游戏与 mod”。Debian/Ubuntu 包额外打包了 Minetest Game，而 Minetest Game 处于**仅维护**状态，不再新增玩法。
- **VoxeLibre（原 MineClone2）** 是在 Luanti 里复刻 Minecraft 玩法的旗舰游戏包：权威仓库在 Mesehub（GitHub 只是镜像），仍在维护（0.92.4，2026-10-18），代码 **GPL-3.0-or-later**、媒体 CC BY-SA 4.0，要求 Luanti ≥ 5.10（本机 apt 的 5.10.0 满足）。自述 **beta、未 feature-complete**；没有官方维护的“与 Minecraft 的缺口清单”。
- **LLM agent / 多智能体社会模拟在 Luanti 生态基本空白**：没有可核实的规模化先例，arXiv 标题与摘要对 minetest／luanti **零命中**，能查到的都是玩具级或停更实验（如 `minetest_llm` 4 个文件、2023 年后未更新）。这既意味着无先例可借鉴，也意味着方向未被占据。
- **外部客户端路线被两件事堵住**：官方 `doc/protocol.txt` 仍是 **2011 年的未完成草案**（无成文协议规范，自研客户端需逆向 wire format），且现存客户端协议库孱弱——多个无 LICENSE、多数已停更，没有可与 Mineflayer 相提并论的库。Luanti 也没有 JS/Node 生态。
- **官方客户端 mod（CSM）无法操纵玩家**：`LocalPlayer` 只有 getter，没有 `set_pos` / `set_control`。因此“agent 作为玩家客户端”在 Luanti 里只有自研协议客户端一条路。
- **结论**：C 路线的现实形态是**全程服务端 Lua mod 实体**——agent 不是玩家、没有玩家视角，直接对世界执行动作。用户已接受这一差异。
- 待补：ContentDB 于 2026-10-26 因安全事件下线维护（<https://blog.luanti.org/2026/10/27/contentdb-security-incident/>），包搜索核实与 VoxeLibre 实际安装验证需等其恢复后再做。

## 复现步骤（C 路线，无 sudo）

已经脚本化，不需要照着手抄命令：

```bash
cd experiments/minecraft-societies  # 从仓库根目录出发
runtime/bootstrap.sh    # 下载 11 个 deb -> 解包到 .runtime/root -> 修软链 -> 记录哈希 -> 自检
```

脚本做的事（也就是唯一的复现要点）：把 `luanti`／`luanti-server`／`luanti-data`／`luanti-game-minetest`
与 6 个缺失 `.so` 包 `apt-get download` 后 `dpkg-deb -x` 解包到 `.runtime/root`；
补一条 `root/usr/libexec/share -> ../share` 让引擎找到内置 `builtin/` 与 `games/`；
把 `minetest_game` 放到 `$HOME/.luanti/games/` 并让 `$HOME/.minetest/games` 指向它；
用 `HOME` 与 `LD_LIBRARY_PATH` 隔离，最后跑一次 `--version` 自检并写 `manifest.sha256`。

已知的环境问题：镜像会间歇性连不上（实测 `cn.archive.ubuntu.com` 超时、`security.ubuntu.com` 正常），
脚本对缺失的包重试三次、并且从不重下已有的包，网络恢复后重跑即可。


## 后续里程碑

执行进度与新的验证记录见 [PLAN.md](PLAN.md)；每个里程碑都要产出可重复运行的日志与数字。下表保留立项时的划分，新增实现与云端证据以执行计划为准。

| 里程碑 | 内容 | 退出条件 | 状态 |
| --- | --- | --- | --- |
| M0 地基 | 选定环境的启停、版本与产物哈希记录、单个 agent 生成／连接并产生一次可观察行为 | 可重复启停；失败有明确原因；agent 确实每步被推进 | **已完成（C 路线，2026-10-27）** |
| M1 容量实测 | 合成实体与实际规则 agent 分层至 10,000 | 步频、存活、决策、内存与原始证据 | 已完成短阶梯；重复测量见执行计划 |
| M2 运行闭环 | 规则与异步模型共用观察／行动执行器 | 日志、实际写入回读、失败可检出 | 已实现并在 Actions 验证 |
| M3 快照与重置 | 停服复制、内容哈希核对、重置角色心智 | 独立副本；错误恢复不破坏原检查点 | 已实现；保留 body ID 与库存 |
| M4 真实 LLM | GitHub 配置模型，3 人实验与记忆对照 | token、延迟、重试、消息、资源动作 | 已接通，结果见执行计划；不能由夹具推断模型行为 |

实现和测量范围以 [PLAN.md](PLAN.md) 及其证据链接为准。当前没有证明万级 LLM 实时运行、长期语义记忆或自发社会结构。

本轮范围、停止条件与结果以 [PLAN.md](PLAN.md) 为准。规则负载用于容量测量，真实模型与夹具分开计数。没有把规则行为解释为模型涌现。

### 2026-10-28 新增实验能力

最新结果见 [万级重复容量](scale/evidence/2026-10-28-large-repeated/summary.md) 和 [真实模型记忆对照](model/evidence/2026-10-28-memory-paired/summary.md)。完整规则负载的万级实时验收未通过，记忆收益尚未证实。规则 agent 的早期短时容量测量见 [阶梯结果](scale/evidence/2026-10-28-agent.md)。真实模型在 [40729157211](https://github.com/kikoiio/Wispiva/actions/runs/40729157211) 中产生六个有效动作；在 [40730088350](https://github.com/kikoiio/Wispiva/actions/runs/40730088350) 中自主采集两次资源。两次均为三个角色的小样本，不代表大规模模型吞吐或可复现的社会行为。

`agent/run.sh --model` 使用单个独立进程、私有文件队列和受约束动作连接模型；环境变量 `XUNFEI_OPENAI_RESPONSE_URL`、`XUNFEI_MODEL`、`XUNFEI_API_KEY` 由调用方提供，不读取 `.env`。参数 `--fake-model` 使用完全确定性的测试夹具，不调用模型；新事件明确记录 origin，旧证据须结合运行配置区分两者。每个格式无效的模型决策最多尝试三次，逐次记录错误、延迟和可用 token 数；当前桥接是串行的，并非千人模型调度器。

每个角色只能接收局部半径内的公开对象和节点、自己的有界记忆与库存；采集和建造会检查距离、库存与世界回读。范围感知没有遮挡或视野方向；采集／建造不模拟玩家物理，也没有通用保护权限。`snapshot.py` 在停服后复制世界并核对文件哈希；`--resume` 在指定副本上恢复角色并清空记忆和目标，因此应先复制原世界再恢复。

手动触发实验请参阅 [执行计划](PLAN.md) 和 [GitHub Actions 工作流](../../.github/workflows/society-experiment.yml)。模型模式只发送合成实验观察；GitHub 运行所需密钥通过 Actions secret 注入，不写入事件文件。当前免费额度及其计费状态需以供应商账户为准。

本轮研究问题、指标与对照已写入 [PLAN.md](PLAN.md)：分层容量、局部信息如何支持行动、FIFO 记忆与即时反馈的配对探测。

## 目录现状

```text
experiments/minecraft-societies/
  README.md                      # 本文件
  .gitignore                     # 忽略 .runtime/、agent/worlds/、bench/run/
  runtime/bootstrap.sh           # 无 sudo 物化 Luanti 运行时（幂等）
  bench/init.lua                 # Luanti 实体规模基准 mod（一次性核实代码）
  bench/run.sh                   # 顺序跑阶梯、采 RSS、抽 BENCH 日志
  bench/luanti-entity-scale-2026-10-27.txt   # 原始证据与结论
  agent/mod/society/init.lua     # M0 agent 运行时（引擎胶水）
  agent/mod/society/policy.lua   # 规则策略；模型另走异步桥接
  agent/run.sh                   # M0 启停夹具与硬校验
  agent/evidence/                # M0 原始日志、逐项报告与证据文档
```

`.runtime/`（就地解包的运行时）与 `agent/worlds/`（每次运行生成的世界）都不入库，可由脚本重建。
新增 `cognition/`（观察／记忆／资源／持久化）、`model/`（异步桥接）、`scale/`（容量与队列模拟）、`analysis/`（汇总工具）和 `snapshot.py`；运行与结果由 PLAN.md 索引。

## 合规

- Minecraft 本体与素材是 proprietary（若最终选 A）：仅在本地用于研究，不分发本体 jar 与素材；不使用公开在线模式服务。
- Luanti（若选 C）：引擎 LGPL-2.1+，Minetest Game 素材 CC-BY-SA-3.0；若引入第三方游戏包或 mod，逐个核对其许可证。
- 不复制无 LICENSE 项目的代码（如 VillagerAgent）；使用前核对每个依赖的 LICENSE。

## 证据边界

- 容量部分**只覆盖 Luanti 5.10.0 的服务端实体 tick 与内存**：合成实体、`singlenode` 地图、无客户端连接、无网络 IO、单次运行。
- M0 部分**只覆盖"能起停、被推进、失败说得清"**：决策是 6 条规则的确定性桩，**没有 LLM**、没有持久化、没有玩家在场、规模只到 20、引擎是 5.10.0（不含上游 2025-04-08 的 k-d 树空间索引），且全部只在本机跑过。
- **没有**验证：多人／客户端在场时的表现、长时间稳定性、A 路线（Paper）的任何数据、大规模真实模型吞吐及长期社会行为。新运行中的模型动作、资源操作和快照重置证据分别见上文与 [执行计划](PLAN.md)。
- 容量、token 与费用在研究文档中的估算仍**未被本项目实测推翻或确认**。


## 第二轮复现入口

`experiment/cloud-run-opt-*` 运行新旧完整规则负载的五次交替对照（1000／5000／10000 各占一台 runner）；`experiment/cloud-run-memory-*` 运行四类受控记忆任务和有界模型并发探针。模型任务有单独串行组，可与容量任务在独立 runner 并行。新 artifact 名为 `society-results-1000`、`society-results-5000`、`society-results-10000`，记忆任务和其他单任务为 `society-results-0`。用 `gh run download <ID> -D .tmp/<新目录>` 下载全部，需先创建项目 `.tmp` 并设置 `TMPDIR="$PWD/.tmp"`。

默认 `society_optimized=true`；设为 false 使用保留的旧扫描／追赶调度进行对照。两侧都以角色 ID 稳定排序邻居。索引在角色移动后立即更新；节点缓存仅用于本实验无外部写入的世界，所有本 mod 写入都会失效对应 16³ 格，未加载格不缓存。预算是每 callback 25 ms 的软上限，单次动作无法被抢占；角色全部完成一轮后才进入下一轮。

`model/memory_eval.py` 通过 Lua 桥接直接调用运行时的同一份 `memory.lua`；模型用量、任务评分与调用错误单独归档。词项检索不提供语义理解、长期总结或事实真伪判断。
