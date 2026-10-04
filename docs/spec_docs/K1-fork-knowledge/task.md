# K1：分叉设定与居民知识、时间线隔离 Tasks

> 状态：T1–T27 实现与验证已完成；AC1–AC10 验收完成。AC10 覆盖两位居民各一轮的有限真实模型样本，结果与限制记录在 checklist.md。
> 输入：已批准的 [spec.md](spec.md)、[plan.md](plan.md)。四份规格全部批准前不写实现代码。
> 工作区：`/home/neo/.codex/worktrees/b-trust-branching/Possibility`，分支 `codex/b-trust-branching`。

## 开发门槛与资源约束

- 下列任务仅在 spec、plan、task、checklist 四份文档全部获批后执行。
- 每项任务目标为 2–5 分钟的主动编辑；若实际任务更大，执行前按文件职责拆小，不跳过验证。
- 单元验证使用一个 worker。记忆修复、管理员路由集成、API 完整构建和真实模型对话按批次串行安排；启动重型操作前按 AGENTS.md 观察 MemAvailable、换页和 memory PSI。
- 不启动额外模拟节拍器、不重用真实用户数据作为可变夹具、不绕过现有模型预算。真实对话仅用隔离测试世界与受控模型配置。
- 各任务验证命令是执行阶段要求，本文件生成时没有运行任何实现验证。

## 文件清单

| 操作 | 文件 | 职责/任务 |
|---|---|---|
| 新建 | `api/src/agent/resident-evidence.ts` | 居民证据类型、时间线可见性与来源链装配（T1–T5） |
| 新建 | `api/src/agent/resident-evidence.test.ts` | 私人事实、环境事实、传闻和对话来源验证（T6） |
| 修改 | `api/src/world-state/query.ts` | 指定时间线事实读取与来源元数据（T4） |
| 修改 | `api/src/agent/visibility-buckets.test.ts` | 祖先时间线截止回归（T6） |
| 新建 | `api/src/agent/resident-context.ts` | 将证据、状态和合格记忆投影为唯一居民提示上下文（T11） |
| 新建 | `api/src/agent/resident-context.test.ts` | 上下文不包含完整分叉设定和他人私密记忆（T12） |
| 修改 | `api/src/agent/knowledge.ts` | 收紧居民知识读取及确定性校验（T2–T3） |
| 修改 | `api/src/agent/knowledge.test.ts` | 固定私人知识与传闻约束（T3） |
| 修改 | `api/src/agent/memory.ts` | 读取、检索及压缩候选的修复资格过滤（T8–T10） |
| 修改 | `api/src/agent/memory.test.ts`、`api/src/agent/memory-retrieval.test.ts` | 记忆隔离、待审排除及压缩资格（T8–T10、T19） |
| 新建 | `api/src/agent/memory-repair.ts` | 分叉后历史记忆/摘要的批次重建（T17–T19） |
| 新建 | `api/src/agent/memory-repair.test.ts` | 游标、恢复、幂等和不可重建状态（T17–T19、T23–T24） |
| 修改 | `api/src/agent/context.ts` | 普通聊天使用安全居民上下文（T13） |
| 修改 | `api/src/agent/loop.ts` | 普通聊天只使用投影上下文（T13） |
| 修改 | `api/src/agent/engine-context.ts` | 自主生活和摘要使用安全居民上下文（T14） |
| 修改 | `api/src/agent/prompt.ts` | 普通聊天提示词移除完整分叉设定输入（T15） |
| 修改 | `api/src/agent/engine-prompt.ts` | 所有自主提示词及摘要提示词移除完整分叉设定输入（T16） |
| 修改 | `api/src/engine/steps/summary.ts` | 摘要源资格与居民上下文的一致性（T10、T16） |
| 修改 | `api/src/agent/prompt.time-zone.test.ts`、`api/src/agent/scene-prompt.test.ts` | 普通提示词输入边界回归（T15–T16） |
| 新建 | `api/src/agent/prompt.security.test.ts` | 所有居民提示词入口的 canary 检查（T21） |
| 修改 | `api/src/engine/steps/schedule.test.ts`、`api/src/engine/steps/beat.test.ts`、`api/src/engine/steps/dialogue.test.ts`、`api/src/engine/steps/summary.test.ts` | 模拟和摘要输入隔离（T10、T14、T16） |
| 修改 | `api/src/test/s4-migration.test.ts` | 旧分叉记忆资格水位验证（T7、T23） |
| 修改 | `api/src/db/schema.ts` | 重建批次、逐条状态和来源元数据表（T7） |
| 新建 | `api/drizzle/0034_resident_memory_provenance.sql` | 创建状态表并为旧分叉线建立安全版本水位（T7） |
| 修改 | `api/drizzle/meta/_journal.json` | 登记 0034 迁移（T7） |
| 新建 | `api/src/admin/memory-repair-routes.ts` | 管理员启动、续跑与读取重建状态（T20） |
| 新建 | `api/src/admin/memory-repair-routes.test.ts` | 管理员鉴权、参数校验和批次路由行为（T20、T24） |
| 新建 | `api/src/test/k1-knowledge-fork-journey.test.ts` | 居民传闻对话、分叉隔离、后代继承及管理员修复完整旅程（AC3–AC5、AC9） |
| 新建 | `api/src/test/k1-live-model.test.ts` | 显式启用的双居民真实模型请求与结果复核（AC10） |
| 修改 | `.gitignore` | 忽略 `api/.dev.vars.k1-test` 专用本地模型凭据文件 |
| 修改 | `api/src/index.ts` | 在认证中间件配置正确位置注册维护路由（T20） |
| 修改 | `api/src/test/knowledge-journey.test.ts` | 多提示入口、对话传播和分叉知识边界集成场景（T22–T23） |
| 修改 | `api/src/life/compare.test.ts` | 父线、子线、兄弟线和后代隔离回归（T22、T25） |

## T1：定义居民证据与安全上下文类型

**文件：** `api/src/agent/resident-evidence.ts`
**依赖：** 无。
**步骤：**
1. 定义 `ResidentEvidence`、确定性枚举和居民/时间线定位输入。
2. 定义证据来源、来源链和截止版本字段；不在类型中提供 `forkScenarioJson`。
3. 导出最小类型接口，不接数据库或模型。

**验证：** `npm --prefix api run build` 类型检查通过，导出类型不包含完整时间线记录。

## T2：实现单条居民知识可见性判断

**文件：** `api/src/agent/knowledge.ts`、`api/src/agent/knowledge.test.ts`
**依赖：** T1。
**步骤：**
1. 将既有事实过滤抽成可复用的居民可见性判断。
2. 保留私人事实接收者、世界可见环境事实和事实/传闻标记。
3. 增加未知可见范围、错误载荷和接收者不匹配的拒绝用例。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/knowledge.test.ts`，期望全部通过且 canary 私人内容只出现在接收者结果中。

## T3：验证传闻来源链不升级

**文件：** `api/src/agent/knowledge.ts`、`api/src/agent/knowledge.test.ts`
**依赖：** T2。
**步骤：**
1. 为居民证据链验证补齐来源接收者、时间线和版本约束。
2. 拒绝来源不可见、循环、未来、跨线或载荷不合法的链。
3. 保持任何传闻来源的后续断言为传闻。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/knowledge.test.ts`，期望 rumor 链通过且不能升级为 fact。

## T4：装配世界事实证据

**文件：** `api/src/agent/resident-evidence.ts`、`api/src/world-state/query.ts`
**依赖：** T1、T2。
**步骤：**
1. 读取指定世界、时间线与版本的结构化事实。
2. 用居民知识规则筛选私人和世界可见事实，并复制来源 ID、版本、时间及确定性。
3. 缺失来源或版本边界时返回不可用于居民输入的结果，不读取完整分叉设定补足。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/resident-evidence.test.ts`，期望只返回获准事实和对应来源元数据。

## T5：装配居民实际听到的对话证据

**文件：** `api/src/agent/resident-evidence.ts`
**依赖：** T1、T3、T4（与 T4 修改同一证据装配文件，串行交接）。
**步骤：**
1. 仅按对话参与者及逐轮记录读取对话。
2. 将 `utterance` 作为可被该轮其他参与者听到的来源，不把 `thought` 字段加入共享证据。
3. 为传播内容记录说话者、听者、对话、时间线及时间；上游是 rumor 时继承 rumor。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/resident-evidence.test.ts`，期望其他居民的 thought 不可见、实际 utterance 可见并保留确定性。

## T6：覆盖居民证据来源与时间线截止

**文件：** `api/src/agent/resident-evidence.test.ts`、`api/src/agent/visibility-buckets.test.ts`
**依赖：** T4、T5。
**步骤：**
1. 固定主线事实、合法分叉前祖先事实、分叉后私人事实和兄弟线事实四类夹具。
2. 验证祖先截止版本与时间线归属均生效。
3. 验证来源不完整时按拒绝可见处理。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/resident-evidence.test.ts src/agent/visibility-buckets.test.ts`，期望合法共同过去可继承，后续兄弟线信息不可见。

## T7：添加历史重建与资格状态表

**文件：** `api/src/db/schema.ts`、`api/drizzle/0034_resident_memory_provenance.sql`、`api/drizzle/meta/_journal.json`
**依赖：** 无；可与 T1–T6 并行，负责此三文件的唯一编辑权。
**步骤：**
1. 定义按时间线和居民记录的重建批次、水位、游标、计数和状态表。
2. 定义逐原记忆的待审、已重建、不可重建状态，以及来源 ID、替代记忆 ID 和原因字段。
3. 在迁移中为现存分叉线建立安全版本水位；水位前且分叉点后的未登记记忆默认待审，水位后由安全提示路径新建的记忆可使用。
4. 更新 Drizzle journal，迁移不得覆盖或删除原对话、事实、事件或记忆。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/test/s4-migration.test.ts`，期望新表建立、原始历史行保持不变、旧分叉记忆落在待审范围。

## T8：实现记忆重建资格查询

**文件：** `api/src/agent/memory.ts`
**依赖：** T7。
**步骤：**
1. 增加统一资格查询，识别时间线/居民重建水位以及逐条排除状态。
2. 让来源不明的旧分叉记忆默认不合格。
3. 让水位后的安全新记录及已重建替代记录可以使用。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/memory.test.ts`，期望三类状态结果分别符合资格规则。

## T9：过滤可见和检索记忆

**文件：** `api/src/agent/memory.ts`、`api/src/agent/memory.test.ts`、`api/src/agent/memory-retrieval.test.ts`
**依赖：** T8。
**步骤：**
1. 将资格查询接入 `visibleMemories` 和 `retrieveForPrompt`。
2. 对含分叉快照的冻结记忆应用居民、祖先和截止检查。
3. 保留主线及分叉前合法共同记忆读取。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/memory.test.ts src/agent/memory-retrieval.test.ts`，期望待审和不可重建记忆均不进入输出。

## T10：过滤记忆压缩源

**文件：** `api/src/agent/memory.ts`、`api/src/engine/steps/summary.ts`、`api/src/engine/steps/summary.test.ts`
**依赖：** T9。
**步骤：**
1. 将资格规则接入 `oldestCompressible` 和压缩前候选读取。
2. 确保被隔离的原记忆不会通过 L1 或 L2 摘要绕回上下文。
3. 只在本居民安全上下文已建立时构造摘要输入。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/engine/steps/summary.test.ts src/agent/memory-hierarchy.golden.test.ts`，期望待审来源不被选中或压缩。

## T11：实现居民上下文投影器

**文件：** `api/src/agent/resident-context.ts`
**依赖：** T6、T9。
**步骤：**
1. 定义不携带完整 `Timeline` 的 `ResidentPromptContext`。
2. 组合证据、合格记忆、居民资料、状态、时间和允许的对话参与者。
3. 仅输出安全的分叉状态标签，不输出完整 scenario 或其他居民记忆正文。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/resident-context.test.ts`，期望结构化上下文不含完整分叉设定和未授权 canary。

## T12：测试居民上下文拒绝边界

**文件：** `api/src/agent/resident-context.test.ts`
**依赖：** T11。
**步骤：**
1. 构造有秘密、祖先知识、传闻及兄弟线未来的最小世界。
2. 分别装配秘密接收者和非接收者上下文。
3. 覆盖版本缺失、来源冲突和快照不完整时的失败关闭结果。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/resident-context.test.ts`，期望每个居民只收到允许内容。

## T13：普通聊天上下文接入投影器

**文件：** `api/src/agent/context.ts`、`api/src/agent/loop.ts`
**依赖：** T11、T12。
**步骤：**
1. 让普通聊天上下文由居民投影器构造。
2. 将记忆、私人知识、状态和身份传递给安全上下文。
3. 保证上下文建立失败时聊天请求不调用旧的原始时间线提示路径。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/scene-prompt.test.ts src/test/knowledge-journey.test.ts`，期望普通聊天和在场路径获得居民限定上下文。

## T14：自主模拟上下文接入投影器

**文件：** `api/src/agent/engine-context.ts`
**依赖：** T11、T12。各 step 已按单一 `personId` 调用 `buildEngineContext`，不另改 step 调度文件。
**步骤：**
1. 每次模拟决策按具体 `personId` 构建居民上下文。
2. 只为该居民装配可见事实、记忆和实际听到的对话。
3. 不把其他居民的私密个人上下文加入批量调度数据。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/engine/steps/schedule.test.ts src/engine/steps/beat.test.ts src/engine/steps/dialogue.test.ts`，期望各 step 对应输入保持逐居民隔离。

## T15：更新普通聊天提示词契约

**文件：** `api/src/agent/prompt.ts`、`api/src/agent/prompt.time-zone.test.ts`
**依赖：** T13。
**步骤：**
1. 将 `buildSystemPrompt` 输入改为 `ResidentPromptContext`。
2. 删除完整分叉设定序列化，只留下非秘密分叉状态说明。
3. 保留普通聊天角色、状态、时间和表达规则。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/prompt.time-zone.test.ts`，期望时区文案保留且 scenario canary 不出现在提示词。

## T16：更新模拟提示词与记忆摘要提示词

**文件：** `api/src/agent/engine-prompt.ts`、`api/src/agent/scene-prompt.test.ts`、`api/src/engine/steps/summary.test.ts`
**依赖：** T14。
**步骤：**
1. 让日程、节拍、对话、在场、突发事件和摘要提示词只接受 `ResidentPromptContext`。
2. 从公共引擎上下文移除完整分叉设定。
3. 检查摘要输入源和提示上下文都通过资格筛选。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/scene-prompt.test.ts src/engine/steps/summary.test.ts`，期望所有居民提示词均不含 scenario canary。

## T17：实现历史重建批次状态机

**文件：** `api/src/agent/memory-repair.ts`
**依赖：** T7、T11。
**步骤：**
1. 定义创建或续跑 `MemoryRepairRun` 的纯状态转换。
2. 每批限制处理数量并持久化游标和成功/待审/失败计数。
3. 对相同批次游标的重试保持幂等。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/memory-repair.test.ts`，期望状态推进、续跑和重复请求稳定。

## T18：按居民来源重建记忆与摘要

**文件：** `api/src/agent/memory-repair.ts`、`api/src/agent/resident-evidence.ts`
**依赖：** T6、T10、T17。
**步骤：**
1. 只读取该居民在目标分叉点后可见的原始事实、有效发言和带来源行动证据。
2. 使用安全居民上下文及既有模型预算生成替代记忆/摘要，不把待审派生记忆当作证据。
3. 记录替代项和来源链；来源不充分时记录 `unreconstructable`，不调用模型编造缺失历史。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/memory-repair.test.ts`，期望输入只含有效证据，证据不足时没有新摘要。

## T19：原子登记重建结果和安全水位

**文件：** `api/src/agent/memory-repair.ts`、`api/src/agent/memory.ts`
**依赖：** T8、T17、T18。
**步骤：**
1. 将替代记忆、逐条状态和批次游标提交为一个可重试单元。
2. 标记被替代的原记录退出读取和压缩，不删除原始内容。
3. 让失败的批次保留游标与明确错误状态，后续重试不重复插入。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/memory-repair.test.ts src/agent/memory.test.ts`，期望重试后仅有一份可用替代记录。

## T20：新增管理员维护路由

**文件：** `api/src/admin/memory-repair-routes.ts`、`api/src/index.ts`
**依赖：** T17–T19。
**步骤：**
1. 暴露管理员鉴权的批次创建/续跑和进度查询端点。
2. 限制世界、时间线、居民和批次大小参数；普通用户不能启动或读取别人的修复任务。
3. 在认证和全局路由顺序正确的位置注册维护路由。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/admin/memory-repair-routes.test.ts`，期望管理员能续跑有界批次，普通用户被拒绝。

## T21：覆盖居民提示词入口清单

**文件：** `api/src/test/knowledge-journey.test.ts`、`api/src/agent/prompt.security.test.ts`（新建）
**依赖：** T15、T16。
**步骤：**
1. 对普通聊天、在场交谈、居民间对话、日程、节拍、突发事件和摘要提示词分别加入 scenario/private canary。
2. 检查每份实际模型输入；合法对话传播只进入听者对应回合。
3. 检查多居民共用上下文输入时拆分或确保逐人边界。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/prompt.security.test.ts src/test/knowledge-journey.test.ts`，期望所有非授权 canary 均缺席。

## T22：覆盖父线、子线和兄弟线隔离

**文件：** `api/src/life/compare.test.ts`、`api/src/test/knowledge-journey.test.ts`
**依赖：** T6、T14、T21。
**步骤：**
1. 建立主线、子线、同级兄弟线和孙线的私密证据夹具。
2. 验证分叉前合法知识按截止继承。
3. 验证任一后续线的记忆和事实不会反向或横向进入无关居民上下文。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/life/compare.test.ts src/test/knowledge-journey.test.ts`，期望 AC4 的各向访问结果一致。

## T23：验证旧数据、迁移水位和失败关闭

**文件：** `api/src/test/s4-migration.test.ts`、`api/src/agent/memory-repair.test.ts`
**依赖：** T7–T10、T17–T19。
**步骤：**
1. 构造无 `startTime`、旧快照、缺失来源与 null 版本的历史分支。
2. 验证旧记录在修复前不进入提示词或压缩，完整共同历史仍可继承。
3. 验证完成、证据不足和失败状态可区分且不会改写原始证据。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/test/s4-migration.test.ts src/agent/memory-repair.test.ts`，期望风险记录均失败关闭并留下状态。

## T24：验证批次中断、恢复和预算护栏

**文件：** `api/src/agent/memory-repair.test.ts`、`api/src/admin/memory-repair-routes.test.ts`
**依赖：** T20、T23。
**步骤：**
1. 中断一个有多个批次的修复 run，再从返回游标续跑。
2. 重复提交已完成游标，确认无重复 replacement。
3. 模拟来源冲突和模型预算拒绝，确认状态可诊断、原记录不变。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/agent/memory-repair.test.ts src/admin/memory-repair-routes.test.ts`，期望续跑幂等且所有模型请求经既有预算护栏。

## T25：执行 K1 定向集成验证

**文件：** `api/src/test/knowledge-journey.test.ts`、`api/src/life/compare.test.ts`、`api/src/test/s4-migration.test.ts`
**依赖：** T21–T24。
**步骤：**
1. 按用户旅程创建含私人分叉设定的主线和两个子线。
2. 运行聊天、居民间对话、模拟上下文和摘要路径，检查实际输入及记忆状态。
3. 续跑历史重建并核对共同历史、传闻级别和兄弟线隔离。

**验证：** `npm --prefix api test -- --maxWorkers=1 src/test/knowledge-journey.test.ts src/life/compare.test.ts src/test/s4-migration.test.ts`，期望 AC1–AC9 对应检查全部通过。

## T26：执行 API 类型与构建检查

**文件：** 所有 K1 实现文件。
**依赖：** T25。
**步骤：**
1. 按资源调度规则检查 MemAvailable、vmstat 后续采样、memory PSI 和可能的 cgroup 上限。
2. 以单并行度运行 API 类型检查/构建。
3. 修复 K1 引入的编译问题并复验，不改动 A/C 文件责任范围。

**验证：** `npm --prefix api run build`，期望 TypeScript 检查通过。

## T27：受控真实居民对话复核

**文件：** 验证记录（实现后在 `docs/spec_docs/K1-fork-knowledge/checklist.md` 留证据）
**依赖：** T25、T26；只在隔离测试世界和已配置预算的模型环境中执行。
**步骤：**
1. 使用测试居民甲的私人事实和居民乙的独立上下文构造真实居民对话。
2. 记录模型请求前的实际输入及实际调用路径，再复核少量输出是否保持信息边界和传闻级别。
3. 记录样本限制、请求预算和结果；出现异常时先保留 trace 并修复，不用单次未泄漏宣称普遍安全。

**验证：** 按 checklist AC10 保存输入摘要、居民/时间线范围、请求状态及实际观察；证据不足时标为未完成，不算通过。

## 执行顺序与并行边界

```text
批次 1（最多并行 2 个轻任务，互不改同一文件）：
  T1（类型契约）  ||  T7（数据库状态与迁移）

批次 2（完成先决契约后，最多并行 2 个轻任务）：
  T2 → T3 → T4 → T5 → T6（证据读取与测试；T4/T5 共享文件，串行）
  T7 → T8 → T9 → T10（记忆资格与压缩）

批次 3：
  T6 + T10 → T11 → T12
  T11/T12 → T13（聊天上下文） || T14（模拟上下文）
  T13 → T15（普通提示词）
  T14 → T16（模拟提示词）

批次 4：
  T11 + T10 → T17 → T18 → T19 → T20
  T15 + T16 → T21

批次 5（集成汇合；测试串行，maxWorkers=1）：
  T21 + T20 → T22 → T23 → T24 → T25 → T26 → T27
```

- 文件所有权：同一轮中不得并行编辑 `knowledge.ts`、`resident-evidence.ts`、`memory.ts`、`resident-context.ts`、`context.ts`、`engine-context.ts`、两个 prompt 文件或同一迁移文件；依任务顺序串行交接。
- 可并行任务以表中无共同文件者为限。T13 与 T14、T15 与 T16 可并行；数据库迁移 T7 可与纯类型/证据工作并行，但构建或测试由主 agent 错峰调度。
- 所有局部验证完成后，必须依序完成 T25 集成验证、T26 构建和 T27 受控真实对话。stub 验证不替代真实居民输入与对话证据。
- checklist 覆盖全量验收；task 验证仅为实现交付证据，不代替 checklist 审批和最终验收。
