# GitHub Actions 工作流审计

核对日期：2026-10-30

本文只审计现有工作流，作为后续真模型和 Luanti 验证的注释性设计记录。本次没有启动 Actions，也没有修改现有工作流的执行逻辑。

## 结论

当前 [wispiva-validation.yml](wispiva-validation.yml) 可以继续承担三类工作：

- Lua、Python、起源和世界状态的轻量回归；
- 小规模 Luanti fixture 产品世界的投影、资源动作、正常停服和恢复；
- 三角色真模型的产品冒烟，验证真实 provider 请求、模型动作、角色私有起源记忆和定向消息传播。

它还不适合作为长期的产品验证编排器。当前所有分支先经过同一个 `validation` job 的安装、单测、fixture、产品世界和恢复步骤，再按分支条件进入容量、记忆、真模型或创建实验。这样会让一次真模型验证重复运行大量无关步骤；任何前置步骤失败都会遮蔽目标实验；多个分支也会共享过宽的并发组。

现有工作流可验证规则实体规模和小批真模型闭环，但不能据此宣称千至万级真实 LLM 角色容量、持续运行可靠性、断电级一致性或真人三维体验。`model/spool_worker.py` 当前每个世界只有一个顺序 worker，真模型测试必须继续保持小规模并将供应商限流、等待和费用单独记录。

## 当前工作流的具体观察

### 适合保留的部分

- job 使用固定的 Ubuntu 容器、Luanti 包和 Lua 5.1，能够记录 commit、引擎包版本、CPU 和 cgroup 内存信息。
- `run_product.sh` 和 `view_acceptance.sh` 已有明确的停止、恢复和失败日志；产品世界和客户端验收可以在 Actions 中执行，避免本机启动 Luanti、Xvfb 或 Electron。
- 真模型分支使用专用 secret 环境变量，模型审计目录权限为 `0700`，请求和响应 artifact 通过 `always()` 上传；这对合成场景足够作为审计起点。
- fixture 请求使用 `origin=fixture`，真实 provider 使用 `origin=model`，当前证据边界清晰，继续保持这种区分。

### 需要优先改进的部分

1. **job 过于单体。** 当前一个 job 同时包含单测、普通 Luanti 回归、创建预览、持久产品世界、客户端验收、容量测量、记忆实验和真模型实验。真模型分支仍会先运行 fixture 产品世界；容量和记忆分支也会安装同一套运行时并执行所有公共步骤。

2. **分支条件代替了 job 拆分。** 许多步骤依赖 `startsWith(github.ref_name, ...)`。这使得工作流表面上只有一个 job，实际却包含多个不同资源等级和失败语义的实验。日志中不容易直接看出“哪个实验被执行、哪个实验被跳过、哪个实验尚未开始”。

3. **并发组过宽。** 除 memory/budget 分支外，大多数分支都落入 `wispiva-validation`；`cancel-in-progress: false` 会让连续推送排队。真模型、客户端和容量实验不应与普通回归共享同一个串行组，也不应让多个真模型分支同时消耗同一供应商额度。

4. **安装成本和网络故障混在验证失败里。** 每次 job 都执行 `apt-get update` 和完整安装。包源暂时不可用、Luanti 包变化或安装超时会表现成产品验证失败，且重复消耗启动时间。

5. **失败产物还不够结构化。** 当前有产品日志、worker 日志和模型审计文件，但主要依靠 shell `grep` 断言。模型 provider 失败、响应格式错误、动作校验失败、Luanti 进程退出、超时和最终断言失败需要统一的阶段字段和退出原因，否则只能人工翻日志。

6. **真实模型 artifact 需要隐私边界。** 当前三角色场景是合成数据，上传完整 `model-audit` 可以接受。未来接收用户意图、角色私有记忆或真实对话后，不能默认把完整请求 artifact 上传到公开仓库；应默认上传哈希、字段计数和脱敏摘要，原文仅在受控私有存储中保留。

7. **残留进程检测可以更精确。** 工作流和脚本使用 `pgrep -f luantiserver`。它可能匹配包含该字符串的父 shell 或命令行，导致误判；后续应使用精确进程名、独立端口健康检查和退出后的 PID 二次确认。

## 建议的后续编排

建议以后保留当前工作流作为兼容入口，同时逐步把实验拆成资源等级明确的 job 或独立 workflow。拆分顺序如下：

| 层级 | 内容 | 默认触发 | 并发策略 | 结论范围 |
| --- | --- | --- | --- | --- |
| `checks` | shell/Lua/Python 单测、schema 和静态检查 | 产品代码变更 | 可并发；同一 commit 去重 | 代码回归 |
| `luanti-fixture` | 小规模 fixture 产品世界、资源动作、正常恢复 | cognition、engine、genesis、world、model 变更 | 每个 commit 一个 | Luanti 运行时闭环 |
| `real-model-smoke` | 3 个角色、少量决策、真实请求和私有记忆审计 | 手动或明确的 `validation/luanti-product-model-*` 分支 | 同一 ref 串行；不同 ref 可按预算限制 | 小规模真实模型行为 |
| `visual-acceptance` | 单个客户端、Xvfb、场景进入和交互 | 手动或 Luanti/场景代码变更 | 一次只跑一个 GUI job | 自动化三维连接路径 |
| `capacity-rules` | 100～10,000 规则实体和感知/移动负载 | 手动或性能代码变更 | 低并发，按矩阵分批 | 规则实体容量 |
| `memory-model-eval` | 受控记忆任务和小批并发探针 | 手动 | provider 并发上限明确 | 记忆任务和供应商等待 |

真模型和 GUI job 应使用独立 job 级 timeout；容量实验不能与真模型实验共用 timeout 和 artifact 命名。公共安装和元数据采集可以抽成 composite action 或固定容器镜像，但不要把实验断言重新合并成一个长 shell 脚本。

## 轻量化建议

以下建议可以在后续新增 workflow 时采用，当前不直接修改 `wispiva-validation.yml`：

- 用 `paths` 或 `paths-ignore` 把仅文档、证据和研究材料变更排除出 Luanti 重型验证；产品代码、模型边界、workflow 和验证脚本仍应触发相应 job。
- 固定一个包含 Luanti、Lua 5.1、Python 和必要工具的容器镜像，或至少把 apt 安装拆成一次性的可复用 setup。镜像必须记录 digest 和 Luanti 版本，避免“轻量化”变成环境漂移。
- 公共 job 只做一次 `checkout`、版本记录和内存/磁盘采样；不要在每个实验分支中重复创建完整产品世界。真模型 job 应直接创建自己的隔离目录。
- 对真模型 smoke 将默认决策数保持在 3～6，使用单 worker、单世界、明确的最大 token 和 provider deadline。更高并发只在专门的容量/限流实验中运行，并单独记录请求数、成功数、429、超时、平均和 p95 延迟。
- 对客户端验收只运行一个 Luanti server 和一个 Xvfb client；不要把 GUI job 与容量矩阵并行放在同一个 runner 资源池中。
- 使用 `timeout --signal=TERM --kill-after=15s` 包住长时间命令，脚本内部保留现有优雅停止路径；超时后记录是 provider、worker、Luanti 还是客户端退出。
- artifact 只上传实际存在的目录，名称包含 workflow、ref、run id 和 commit SHA。大日志优先压缩，保留短摘要和结构化 JSON 供快速阅读。

## 并发和供应商额度

建议采用下面的并发规则：

- `checks-${{ github.ref }}`：同一 ref 的新提交可取消旧的轻量检查。
- `luanti-fixture-${{ github.ref }}`：同一 ref 保留一个运行，避免两个 Luanti 世界同时抢 CPU 和磁盘。
- `real-model-${{ github.repository }}`：默认 `cancel-in-progress: false`，一次只运行一个真模型 smoke，避免并发请求造成供应商 429 和不可比较的延迟。
- `capacity-${{ github.ref }}-${{ matrix.count }}`：按规模分组，限制 `max-parallel`，先完成 100/1000，再决定是否进入 5000/10000。
- `visual-${{ github.repository }}`：GUI 一次一个；取消旧的手动验收可以释放 Xvfb 和 Luanti 进程，但自动提交验收应保留其结果。

并发实验需要把“请求并发度”和“GitHub job 并发度”分开记录。当前 worker 是单请求顺序处理，因此一次多角色世界运行的 provider 并发并不等于多个 worker；未来增加 worker 前应先定义供应商限流、每角色公平性、重试上限、幂等 request id 和费用预算。

## 失败诊断协议

后续真模型和 Luanti job 应在每个实验开始时写入 `run-metadata.json`，至少包括：

```json
{
  "phase": "real-model-smoke",
  "git_sha": "...",
  "workflow_run_id": "...",
  "container_image": "...",
  "luanti_version": "...",
  "model_name": "...",
  "agent_count": 3,
  "decisions": 6,
  "worker_count": 1,
  "request_deadline_seconds": 45
}
```

不得写入 API key、完整授权 URL、私有用户文本或未经脱敏的 provider 错误正文。环境采样可以包括 `MemAvailable`、memory PSI、cgroup current/max、磁盘和 `/tmp` 余量；这是诊断资源不足的必要信息。

每个阶段应产生一个可机器读取的结果，例如 `validation-result.json`：

```json
{
  "phase": "real-model-smoke",
  "status": "failed",
  "failure_class": "provider_timeout",
  "exit_code": 1,
  "requests": 6,
  "responses": 5,
  "pending_requests": 1,
  "model_actions": 4,
  "fixture_actions": 0,
  "artifact_paths": ["world/private/product.log", "world/private/model-audit"]
}
```

建议固定以下 failure class，并让 workflow summary 同时打印一行：

- `setup_package`：apt、容器、运行时或权限准备失败；
- `resource_pressure`：cgroup、内存 PSI、磁盘或 `/tmp` 余量异常；
- `luanti_start` / `luanti_exit`：服务端没有启动或退出码异常；
- `worker_timeout` / `provider_timeout` / `provider_rate_limit`：模型 worker 及 provider 分类；
- `invalid_context` / `invalid_action`：边界校验拒绝；
- `pending_request`：关服时仍有未完成请求；
- `world_reconcile`：产品状态、地图、环境或角色恢复对账失败；
- `assertion`：实验结果与预期不符；
- `artifact_upload`：验证已完成但证据上传失败。

无论成功还是失败都应上传：`run-metadata.json`、阶段结果、Luanti product log、worker log、最近的引擎 stderr、事件摘要和脱敏后的模型 audit 摘要。失败时额外打印最近 100～200 行日志和当前 spool 文件名；不应把完整请求正文直接写进普通 job log。

## 真模型专用检查清单

真模型 job 通过前，至少应独立检查：

- 每个角色确实产生过 `origin=model` 的动作；fixture 响应不能计入；
- 请求和响应数量、成功/失败/重试数量相互一致；关服时无 `request-*`、`.processing-*` 或未解释的 response 残留；
- 每个角色的模型 envelope 只包含自己的起源私有种子和有授权来源的事实；
- `say` 的接收者后续输入包含对应 rumor，其他角色没有无来源获得该文本；
- 上一次动作的真实成功或失败进入下一次 `feedback`；失败不能被转换为成功；
- token、延迟、重试、provider 错误和等待时间来自审计数据，而不是日志中的估计值；
- artifact 中保留源码 SHA、世界 ID、起源事件 ID 和模型配置名，能把行为对应到同一份代码和世界；
- 任何包含用户私有内容的运行默认只上传脱敏摘要，除非仓库权限和保存策略明确允许原文。

这些检查通过后，结论仍只覆盖“小规模真实模型产品冒烟”。它不能勾选 `docs/PLAN.md` 中的千至万级真实 LLM 容量、L2 反思记忆、断电级跨存储原子提交、真人三维体验或长时间崩溃恢复。

## 本次审计边界

本次只新增本文档；没有启动 Actions、没有安装依赖、没有运行 Luanti、没有修改现有 workflow 核心，也没有改变当前 worktree 中原有的未提交改动。
