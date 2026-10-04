# K1：分叉设定与居民知识、时间线隔离 Checklist

> 状态：AC1–AC10 验收完成；AC10 为有限真实模型样本，不代表对所有模型输出的保证。
> 输入：已批准的 [spec.md](spec.md)、[plan.md](plan.md)、[task.md](task.md)。四份文档全部批准后才开始实现。
> 工作区：`/home/neo/.codex/worktrees/b-trust-branching/Possibility`，分支 `codex/b-trust-branching`。

## 使用与证据规则

- 每项通过真实运行、检查模型请求前的实际输入或观察持久化结果来验证；代码存在不代表通过。
- 每条证据记录检查 ID、状态（通过/未通过/未完成/不适用）、日期、提交、环境、命令或操作、实际结果和 trace/日志位置。
- 测试使用隔离世界、居民、时间线和数据库；不得用可变真实用户进度。修复任务使用预算护栏，不能启动额外模拟节拍器。
- 自动化测试按 task 约定使用单 worker。集成构建、API 完整测试和真实模型对话串行排程；重型验证前按 AGENTS.md 检查 MemAvailable、后续 si/so、memory PSI 及适用的 cgroup 上限。
- 夹具或 stub 证明确定性过滤行为；它们不代替模型请求前输入检查、真实持久化或 AC10 的有限真实对话复核。
- 只在实际运行并记录证据后勾选；未完成的项保持未勾选并说明原因。

## 实现完整性与需求覆盖

- [x] **AC1 / F1：** 将唯一甲可知的秘密放入构造者分叉设定，捕获甲、乙实际收到的居民模型输入；输入中均没有完整 `forkScenarioJson`，乙也没有甲的秘密。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/agent/prompt.security.test.ts`，另检查隔离场景中的模型请求前输入和 canary 断言。）
- [x] **AC2 / F2：** 为甲建立私人事实和世界可见环境事实，分别装配甲、乙上下文；甲可见私人事实、乙不可见，符合现有可见范围的居民能看到环境事实。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/agent/knowledge.test.ts src/agent/resident-evidence.test.ts`，检查来源、接收者和可见范围。）
- [x] **AC3 / F3：** 甲在实际对话轮次中向乙传达传闻后，乙仅在对应分支收到已保存发言；乙的后续提示带有传闻边界且生成的后续记忆保持传闻表述，父线/兄弟线看不到该对话，合法后代可从快照继承。（验证：`npm --prefix api test -- --maxWorkers=1 src/test/k1-knowledge-fork-journey.test.ts src/engine/steps/dialogue.test.ts`；模拟 provider 经 `dialogueExecutor.perceive/decide/act` 写入对话轮次及记忆，再比较父线、兄弟线、子线和后代居民上下文。）
- [x] **AC4 / F4：** 分叉前合法且甲可见的共同记忆被子线继承；分叉后只在子线出现的信息不进入父线、兄弟线或其他居民上下文，并按规则进入合法后代。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/life/compare.test.ts src/agent/resident-evidence.test.ts`，逐时间线比对实际上下文。）
- [x] **AC5 / F5：** 为存在越界风险的分叉后原始记忆和摘要执行重建；来源可验证的内容产生合格替代项，无法核实的内容标记未能重建且不进入居民输入；重复运行不重复创建替代项。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/agent/memory-repair.test.ts`，比对来源 ID、状态、替代 ID 和原始行。）
- [x] **AC6 / F6：** 检查普通聊天、在场交谈、居民间对话、日程、生活节拍、自主决策、突发事件反应、记忆压缩和摘要提示词；每种居民输入都不含完整构造者设定或无权信息。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/agent/prompt.security.test.ts src/engine/steps/schedule.test.ts src/engine/steps/beat.test.ts src/engine/steps/dialogue.test.ts src/engine/steps/summary.test.ts`，同时检查生成的 system/user 消息。）
- [x] **AC7 / F7：** 对持有不同私人信息的多位居民从同一模拟快照分别构造提示输入；逐人检查实际 system prompt，确认私人知识隔离。引擎逐居民构造上下文并分别构造提示，不存在将多位居民合并到一个模型请求的批量接口。（验证：`npm --prefix api test -- --maxWorkers=1 src/world-state/commit.test.ts`；`only gives a resident their own knowledge...` 为同一快照构造 A、B 提示并断言 A 的私人消息不会出现在 B 输入。）
- [x] **AC8 / N1、N4：** 分别制造缺失来源、坏载荷、旧快照和截止版本缺失；请求不会回退到完整分叉设定或未经筛选的记忆，并产生可诊断状态。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/agent/prompt.security.test.ts src/agent/memory-repair.test.ts src/test/s4-migration.test.ts`，检查失败响应和日志状态。）
- [x] **AC9 / N3、N5：** 在隔离数据库中开始多批次重建，中断后续跑并重复已完成游标；进度可读、替代行不重复、原数据不变，模型调用经过既有预算预留。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/agent/memory-repair.test.ts src/admin/memory-repair-routes.test.ts`，比较计数、游标、数据库行和 llmCallLog。）
- [x] **AC10 / N6：** 在隔离测试世界中执行两位居民各一轮的真实对话，保存请求前实际输入并复核结果；记录居民、时间线和调用路径。有限样本仅报告实际观察，不宣称绝对防止模型输出泄漏。（验证入口：本机创建权限为 600 的 `api/.dev.vars.k1-test`，填入 `K1_TEST_LLM_BASE_URL`、`K1_TEST_LLM_API_KEY`、`K1_TEST_LLM_MODEL`，然后显式运行 `K1_RUN_LIVE_MODEL=1 npm --prefix api test -- --maxWorkers=1 src/test/k1-live-model.test.ts`；文件已加入忽略规则。2026-10-04，隔离世界中的 Ada、Bo 各完成一轮真实模型对话，2 次请求均返回 HTTP 200、调用记录均为 `completed`，持久化两条发言。两人输入均未包含构造者 scenario canary，Bo 提示包含传闻边界；有限样本中 Ada 没有说出其私人 canary。测试通过。证据：`/tmp/possibility-k1-live-model-2026-10-04T04-06-41-240Z.json`（权限 600，含合成提示、模型观察结果及脱敏调用状态；不含凭据）。)

## 集成与恢复检查

- [x] 居民输入类型边界不允许提示词构造器接收原始时间线/完整分叉场景；普通聊天与所有引擎提示词都经居民上下文投影。（验证：`npm --prefix api run build` 通过，并运行全部居民提示词安全测试。）
- [x] 记忆读取、检索、L1/L2 压缩共享同一资格规则，待审和不可重建原记录不能经任何候选路径重新进入提示词。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/agent/memory.test.ts src/agent/memory-retrieval.test.ts src/agent/memory-hierarchy.golden.test.ts src/engine/steps/summary.test.ts`，检查各层选择结果。）
- [x] 数据库迁移在隔离测试 D1 上创建重建状态及来源表并登记旧线安全水位；原始对话、事实、事件和记忆行保持不变。（验证：应用 0034 迁移后查询前后行数与原始内容，并运行 `npm --prefix api test -- --maxWorkers=1 src/test/s4-migration.test.ts`。）
- [x] 管理员可以只处理有界批次、读取进度并续跑；普通用户不能启动或读取其他用户修复状态，错误参数不能扩大批次范围。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/admin/memory-repair-routes.test.ts`，检查状态码和响应内容。）
- [x] 迁移水位之前的分叉后旧记忆先退出提示词和压缩候选；水位后的安全新记忆可用；不完整分叉时间或快照的历史线保持待审且失败关闭。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/test/s4-migration.test.ts src/agent/memory.test.ts`，比对水位边界两侧记录。）
- [x] 分叉预览和面向用户的章节回顾仍使用各自数据路径，不依赖居民上下文，也不会被测试所用的居民知识筛选意外改写。（验证：运行 `npm --prefix api test -- --maxWorkers=1 src/worlds/fork.test.ts src/chapters/generate.test.ts`；若文件名不同，执行前按实际测试入口更新本项并保留范围。）

## 编译、回归与资源检查

- [x] API 类型检查和构建通过。（验证：按资源规则确认可运行后执行 `npm --prefix api run build`，记录退出码。）
- [x] K1 定向回归全部通过。（验证：串行执行 `npm --prefix api test -- --maxWorkers=1 src/agent/knowledge.test.ts src/agent/resident-evidence.test.ts src/agent/resident-context.test.ts src/agent/memory.test.ts src/agent/memory-retrieval.test.ts src/agent/memory-repair.test.ts src/agent/prompt.security.test.ts src/admin/memory-repair-routes.test.ts src/test/knowledge-journey.test.ts src/life/compare.test.ts src/test/s4-migration.test.ts`。）
- [x] API 全量测试通过；如因资源压力、外部模型配置或测试环境失败，记录实际阻塞项，不将其计为通过。（验证：检查内存趋势后以单 worker 执行 `npm --prefix api test -- --maxWorkers=1` 并保存完整结果。）
- [x] 已配置的 lint 检查通过；若仓库没有 API lint 脚本，记录不适用及查验脚本的依据。（验证：检查根与 API `package.json` 的 scripts，按存在的脚本执行。）

## 端到端场景

- [x] **私人消息传播与分叉隔离：** 在隔离 SQLite 中创建带私人传闻的主线、子线和兄弟线，通过居民对话轮次传递信息；确认乙在听到前没有该私人知识，听到后只在子线获得实际发言并在记忆中标记为传闻；父线、兄弟线不可见，后代快照可见。（验证：`npm --prefix api test -- --maxWorkers=1 src/test/k1-knowledge-fork-journey.test.ts`，捕获模拟 provider 提示输入、已存对话轮次、记忆和各时间线居民证据。）
- [x] **历史记忆修复与续跑：** 准备旧分叉摘要与可验证/不可核实来源，经管理员路由启动一条记录后停止，在后续请求按持久游标续跑；核对替代内容、隔离状态、原始行不变及普通用户拒绝访问。（验证：`npm --prefix api test -- --maxWorkers=1 src/test/k1-knowledge-fork-journey.test.ts src/agent/memory-repair.test.ts src/admin/memory-repair-routes.test.ts`；重建不调用模型，llm_call_log 未变化。）

## 验收汇总

- AC1–AC10 均有自动化、模拟模型及有限真实模型证据；所有已定义验收项均完成。AC10 仅覆盖本次两位居民的有限样本，不宣称绝对防止模型输出泄漏。
- 验收项统计：22 项通过、0 项未通过、0 项未完成。端到端证据包括隔离 SQLite 的传闻传播/父子兄弟线隔离与管理员记忆修复续跑，以及 AC10 两位居民各一轮真实模型对话；实时模型证据路径见 AC10 条目。
- 任何未完成、未配置真实模型验证或受资源限制跳过的项目继续保持未勾选，并附实际原因。
- 所有实现验收完成后，汇总通过/未通过/未完成数量，列出端到端实际结果和证据路径。


## 实现证据（2026-10-04）

- 工作区：`/home/neo/.codex/worktrees/b-trust-branching/Possibility`；分支 `codex/b-trust-branching`；基线提交 `74d01b4`；实现尚未提交。
- 构建：`npm --prefix api run build` 通过（TypeScript 无输出错误）。
- 全量自动化回归：`npm --prefix api test -- --maxWorkers=1` 通过，99 个测试文件、660 个测试通过；该次 AC10 live-provider 文件因未设置显式运行开关而跳过。运行前 MemAvailable 约 5.1 GiB、memory PSI 为 0；单 worker 完成。
- K1 定向回归：居民证据、提示词 canary、知识/传闻链、分叉比较、记忆读取/检索/压缩、修复续跑、管理员路由和 0034 迁移相关测试通过；单次定向批次为 16 个文件、119 个测试通过。最终类型边界整理后，另有 6 个相关测试文件、11 个测试通过；新增居民上下文投影测试 1 个测试通过。补入快照对话继承与双居民提示隔离断言后，`src/agent/resident-evidence.test.ts src/world-state/commit.test.ts` 通过，2 个文件、41 个测试通过。
- 历史修复用隔离 SQLite 验证两批游标续跑、来源逐字匹配、不可核实内容隔离、原记录保留、替代记录检索和重复请求幂等。重建按确定性证据摘录执行，不发模型请求，因此无模型预算调用。
- 迁移回归确认 0034 为每条旧分叉线建立安全水位，未修改既有记忆行；水位前记录从上下文、检索与压缩候选中排除。
- 提示输入回归确认构造者 scenario 与快照字段被居民上下文投影移除；聊天和引擎提示只含逐居民事实、发言证据；发言记录明确不证明内容属实，传闻不可升级。补充测试确认后代仅从自身不可变分叉快照继承参加过的祖先对话，父线和兄弟线不可见。证据读取限最近 20 场居民参与对话和 32 条发言；修复候选来源亦设 500 条事实、500 条本人行动、200 场对话/最多 1600 条发言上限。
- 根目录与 API 的 `package.json` 均未配置 lint 脚本，lint 标记为不适用。
- AC3 已通过真实持久化的模拟居民轮次验证；两条综合端到端场景均已在隔离 SQLite 中通过。AC10 使用 B worktree 专用测试配置，在隔离世界中让 Ada、Bo 各完成一轮真实对话；模型请求前输入通过 canary 边界断言，2 条发言已持久化，证据中的调用状态为 `completed`、HTTP 状态为 200。观察到 scenario canary 未进入两位居民输入、Bo 提示保留传闻边界，Ada 本轮未说出私人 canary。测试通过，证据文件为 `/tmp/possibility-k1-live-model-2026-10-04T04-06-41-240Z.json`（权限 600）；没有读取或使用真实用户模型配置。此有限样本不代表对所有模型输出的保证。
