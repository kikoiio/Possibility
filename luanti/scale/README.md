# Luanti 容量阶梯

顺序运行 `bench/init.lua` 的合成实体负载，记录每档步频、RSS、原始日志和环境，供 GitHub Actions 测量。它不是实际 agent、客户端、网络或 LLM 的端到端容量测试。

## 当前实验入口

实际使用的工作流是 [wispiva-validation.yml](../../.github/workflows/wispiva-validation.yml)。在 `validation/luanti-*` 分支 push 触发，`luanti-model-*` 跑真实模型与配对验证，`luanti-agent-*` 跑小阶梯，`luanti-large-*` 跑 5,000／10,000 规则 agent 和队列模拟。全工作流共享 concurrency group，同一时间只运行一组，失败数据仍上传。Actions 为绿色仅表示工作流执行完毕；性能阶梯逐项状态必须看 `ci-*-status.txt` 与报告。

`run.py` 是合成实体基准。真正 agent 的负载含规则决策、邻域查询、接触事件、日志和可选观察／记忆，调用 `agent/run.sh`；“cognition=false”仍有规则策略必需的感知和接触集合，不等于完全无感知。`stepped_delta` 仅证明区间内至少 step 一次，不能证明每个 tick 每人都推进。修正后的集成会在结束时补一条统计，按墙钟采样，并记录每轮 `wall_ms`；新旧采样口径不可直接比较。

## 独立合成测试模板


把本目录的 `workflow.yml` 复制到仓库的 `.github/workflows/luanti-scale.yml` 并提交，再从 Actions 页面手动触发 **Luanti capacity ladder**。运行需要仓库 Actions 权限，会在 GitHub 托管 runner 的 Ubuntu 26.04 容器内安装发行版 `luanti-server`，上传结果 artifact（保留 14 天），并在 job summary 显示结果。GitHub 免费额度和仓库权限由账户决定。模板放在本目录时不会自动注册或执行。宿主 runner 的 Ubuntu 24.04 不负责提供引擎；作业使用 Ubuntu 26.04 容器中的 `luanti-server` 和依赖的 `luanti-game-minetest`。该发行版当前为 5.10 系列，不能用来验证 5.16+ 的空间索引。

配置并提交后，也可使用已认证且有仓库 Actions 访问权限的 `gh` 在云端触发与取回结果：

```bash
gh workflow run luanti-scale.yml --ref <已推送的分支>
gh run list --workflow luanti-scale.yml --limit 5
gh run watch <运行ID> --exit-status
gh run download <运行ID> -n luanti-capacity-results -D ./scale-results-download
```

这些命令会在 GitHub 上运行代码并上传 artifact；先确认仓库代码与账户授权。这里不会自动提交、推送或触发。也可在 Actions 网页手动运行。

默认三种模式、1/5/10/20/100/1000 实体、每档 30 秒、各一次，单进程串行；约需 9 分钟加安装时间。要改变阶梯可修改模板中的命令，例如：

```bash
python3 luanti/scale/run.py --binary /usr/libexec/luanti/luantiserver --output "$GITHUB_WORKSPACE/scale-results" --counts 1,5,10,20 --modes move,perceive --seconds 40 --repeats 3
```

输出目录必须不存在，防止覆盖旧结果。可用 `--help` 查看参数；`--binary` 也可指向已有运行时的 server，相关库和游戏发现环境须由调用方配置。本机运行是重型任务，遵循项目云端优先及授权规则。

## 结果解读

- `metadata.json` 记录版本、二进制和 mod 哈希、平台与参数；`results.json`、`results.csv` 和 `summary.md` 按每档每次列出结果；子目录保存配置、世界和完整日志。
- 必须完成 forceload、零 spawn 失败、存活数校验，并在校验后取得至少两个实体数及 stepped 数均正确的采样；服务端提前退出或无 RSS 使运行无效，脚本以非零退出。RSS 是每秒采样的峰值，可能低于真实瞬时峰值。
- 默认阈值 11.0 step/s（可用 `--threshold` 修改），每个有效采样都达到才标记通过；它接近 `dedicated_server_step=0.09` 的理论 11.11 step/s，阈值是测量约定，不是精确实时保证。汇总的步频是有效采样中位数；单次结果不代表统计稳定，重复测量时应比较各次范围。
- 初始化期间和校验前的采样不纳入统计；`stepped` 是该采样周期内至少被推进过的实体数，并非每步都被推进的证明。`perceive` 是每实体半径查询的压力代理。不同机器、版本、运行时、顺序和背景负载不能直接比较；发行版包版本可能更新，需检查 metadata。5.10 系列不包含后续空间索引优化。

## 模型队列模拟

`queue_sim.py` 使用固定服务时间与并行 worker 数，模拟一人最多一条请求的闭环负载；完成后等 `interval` 再提交，超过排队等待上限才过期。它没有网络、限流、token、供应商并发或真实模型调用，不是服务容量实测。即使无排队，每人决策周期也至少是“服务耗时＋interval”；不能把 interval 解释为端到端决策间隔。旧版提前计算超时的输出已作废，修正后在云端重跑。

串行 worker 观测时延约几秒，远低于“千人每两秒一次”需要的 500 次/秒。应先使用事件触发／较低决策频率、局部观察共享计算与规则执行持续动作，再测有额度限制的并发；这些是下一轮工程方向，本轮没有实现万级模型并发。
