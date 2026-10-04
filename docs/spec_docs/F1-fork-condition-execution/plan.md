# F1 技术设计 Plan：分叉条件执行

## 1. 架构概览

- **预览层**：现有登录世界 fork 预览在一次模型调用中生成场景文本和一项结构化动作建议，并返回该草稿对应的源状态版本与可选来源列表。模型只建议，不执行。
- **确认层**：`TimelineSwitcher` 展示并允许用户编辑动作字段；消息可选一条可继承来源。确认请求携带编辑后的动作和预览版本。
- **动作校验层**：新增 F1 专用的确定性校验，将受支持的消息/环境动作解析为可持久化动作计划；复用 K1 来源资格、现有地点/居民检查和世界动作事实语义。确认时发现源状态已变则拒绝。
- **分叉持久层**：扩展 `forkTimeline` 的可选初始动作路径，在同一 D1 原子批次中写入子线快照、动作命令、版本化事实、事件及修订状态。初始动作位于子线版本 1；不带动作的旧路径继续沿用原逻辑。
- **暂停门禁**：仅 F1 带初始动作路径可在模拟暂停时初始化子线；既有不带初始动作分叉仍保留原来的运行状态要求。现有 schema 已有命令、事实和事件表，当前设计不新增迁移。

## 2. 核心数据结构与接口

- `ForkInitialAction` 为受限联合类型：
  - `inform { recipientId, topic, content, sourceFactId? }`
  - `environment { location, condition: weather|lighting|access, value }`
  环境地点非空。模型只建议 `actionProposal`，用户确认请求发送独立的 `initialAction`。
- `ForkPreview` 在现有场景草稿外返回 `sourceVersion`（确认时作乐观并发条件）和动作建议。消息来源候选携带事实 ID、类型、时间、确定性与供用户识别的短标签；候选按所选起点过滤，并只允许提交候选中的 ID。若候选量较大，接口分页且页面绑定相同 `sourceVersion`。
- `ForkCreateRequest` 增加 `expectedSourceVersion` 与可选 `initialAction`。没有动作的老请求仍走原分叉路径；带动作请求必须经过 F1 校验。
- 内部 `PreparedForkAction` 是服务端校验后的动作计划，包含确定的 `worldFact` 载荷、可见性、事件文案、来源链和接收者/地点，不接受客户端自带这些派生字段。
- `ForkResult` 在原分支 ID 等字段外返回动作命令 ID、事实 ID、提交版本和可读执行摘要，便于成功反馈和幂等重放。现有 `worldCommands`、`worldFacts`、`events` 和 `universeRevisions` 足以保存结果，不新增持久化表。

## 3. 模块设计

- **`fork-preview`**：扩展登录用户预览响应，返回源状态版本、受约束动作建议及按分叉时刻筛选的消息来源候选；模型输出只做结构解析，不作为执行授权。
- **`fork-action`（新增纯业务模块）**：校验用户提交的动作联合类型、字段长度、居民/地点归属和来源资格，并产出 `PreparedForkAction`。它将动作转换为现有 `WorldAction` 语义和确定的事实、事件、私有知识载荷；地点类别采用 F1 固定白名单。
- **`forkTimeline`**：增加带预期源版本、可选初始动作的事务路径。先读取并构建分叉快照，再用带源版本条件的原子写入保护创建子线；在同一批次写入初始动作 command、fact、event、revision 和证据水位。动作子线版本为 1，fork snapshot 的源版本记录源线水位。源版本竞争或批次任一写入失败时整批回滚。
- **`world-state` 共享语义**：从现有 `validateWorldAction` / command materialization 抽出可在“子线尚不存在、世界暂停”的条件下运行的确定性校验与计划构造；原 `/actions` 提交仍保留其运行状态和版本门禁，F1 只复用纯校验/物化语义，不调用会再次提交的 endpoint。
- **`worlds/routes` 与预览路由**：解析登录态、校验请求结构并映射稳定错误码；创建接口把 idempotency request ID、`expectedSourceVersion`、编辑后动作交给 `forkTimeline`，成功响应返回分支和动作回执。
- **`TimelineSwitcher` 与 API 类型**：增加动作建议编辑、来源候选选择和版本随请求提交；等待确认后显示执行回执，错误时保留草稿。demo fork 不接入 F1。

当前 `commitWorldCommand` 会检查世界必须运行且目标时间线已存在，因此 F1 需复用/抽出其校验与事实事件构造逻辑，并在 fork 事务内落库，不能在 fork 完成后再单独调用它。

## 4. 模块交互

1. 用户在登录世界的分叉弹窗填写 what-if；预览接口读取选定分叉时刻的源状态，调用一次场景预览模型，返回场景草稿、动作建议、`sourceVersion` 和合格消息来源候选。模型无法给出受支持动作时，仍可展示场景草稿，但确认界面不允许执行未映射动作。
2. 前端将模型建议转为可编辑表单。用户可改动作类型和参数；选择消息来源时只可选当前预览候选。前端随草稿保留预览版本，来源候选分页也必须使用该版本。
3. 用户确认时，前端生成/复用本次提交的 request ID，并发送分叉场景、`expectedSourceVersion`、结构化 `initialAction` 和所选 `sourceFactId`。服务器重新校验世界所有权、源线状态、版本、目标归属、字段约束及来源可继承性；模型建议本身不参与授权。
4. 校验通过后，fork 服务基于已读取的源状态构建子线快照与动作写入计划，通过单个 D1 batch 写入分支、快照、版本 1 的命令/事实/事件及证据修订。源版本条件不匹配或任一步失败，batch 整体回滚；世界暂停只在此带动作的初始化路径被允许。
5. 同 request ID 重放时，服务比较已有分支记录中的源线、场景和动作负载：一致则返回原分支及动作回执，不重复写入；不一致则返回冲突。成功 UI 展示子线和执行摘要；失败 UI 保留场景、动作编辑和来源选择，按稳定错误提示刷新预览或修正输入。

## 5. 文件组织与技术决策

### 预期文件

- `api/src/life/fork-preview.ts`：解析带约束的动作建议，并生成与 `sourceVersion` 绑定的消息来源候选。
- `api/src/life/fork-action.ts`（新增）：定义 F1 动作类型、字段/目标/来源确定性校验及 `PreparedForkAction` 构造。
- `api/src/world-state/rules.ts`：抽出纯事实/事件计划构造，继续经 `validateWorldAction` 供普通 `/actions` 提交路径共用；`commit.ts` 无需修改，普通运行状态和版本门禁保持不变。
- `api/src/life/fork.ts`：增加原子初始动作写入、预期源版本保护、paused 初始化例外与动作回执幂等重放。
- `api/src/worlds/routes.ts`：扩展预览/创建请求与响应验证和错误映射；不改 demo 路由。
- `web/src/api/types.ts`、`web/src/api/client.ts`、`web/src/components/world/TimelineSwitcher.tsx`：添加预览建议、可编辑确认表单、来源候选和成功/失败状态。
- 在现有 fork、world-state、journey、TimelineSwitcher 相关测试中补充动作、原子回滚、暂停分叉、来源边界、幂等和旧流程兼容覆盖。

### 技术决策

1. 不新增表或迁移。用 fork ID 对应的确定性命令 ID（例如 `fork:<id>:initial`）保存初始动作的规范化负载；幂等重放比较源线、场景和命令负载，以区分相同请求与同 ID 不同动作。
2. 将源版本校验放在 D1 原子批次的条件子线插入中，而不是只依赖批次前读取。动作写入依赖子线外键；源版本不匹配导致子线不插入、后续语句失败并使整批回滚。保留现有活跃时间线数、父线可写和归档门禁。
3. 子线 `universeRevisions` 从版本 0 初始化为版本 1，初始命令 `expectedVersion=0/resultVersion=1`；动作时间取快照分叉时刻。完整证据记录 `assessedVersion=1`，快照仍保留源线 `sourceStateVersion`，两者不混用。
4. 消息正文仅进入 `worldFacts` 私有知识载荷及命令负载；公共事件只表达收到消息。环境事实用固定类别、地点 subject 和可见性 `world`；既有读取层按事实证据版本处理居民认知。
5. 原子性以 D1 batch 的事务保证为基础；任何新增结果行均包含在同一批次，禁止 fork 成功后再补写动作。暂停世界的 SQLite 插入触发器要求 running，因此 F1 在同一 D1 batch 内暂时将世界状态改为 running，完成子线和动作写入后再恢复 paused；批次失败时两次状态更新与所有插入一起回滚。暂停例外只应用于带有效 F1 初始动作的创建请求。
6. 既有事件审计从事实字段重建事件投影；环境事件保留原有类别键（如 `weather`），居民知识投影与成功回执再显示为“天气、照明、通行状态”，避免改变历史事件投影语义。
