# F1：分叉条件执行 Tasks

> 状态：已实现；四份文档已获批，验收结果见 [checklist.md](checklist.md)。
> 输入：已批准的 [spec.md](spec.md) 与 [plan.md](plan.md)。
> 范围：登录用户世界 fork；消息和地点环境状态两种初始动作；demo fork 不接入。

## 实施约束

- 每个任务聚焦一个可审查的改动；如果实施中发现任务范围明显扩大，应先细分再继续。
- 一次分叉只含一项初始动作。动作由用户在确认界面审阅后提交；服务端不得信任模型生成的动作对象。
- fork 快照、子线、动作 command/fact/event 和证据修订必须处于同一原子写入中；禁止成功建线后补写动作。
- F1 的 paused 例外仅用于带有效初始动作的 fork；保留普通无动作 fork 与独立 `/actions` 原门禁。
- 不新增数据库表或迁移；消息正文不得写入公共事件。

## 文件清单

| 操作 | 文件 | 任务 |
|---|---|---|
| 新建 | `api/src/life/fork-action.ts` | F1 动作类型、校验和 `PreparedForkAction`（T1、T3） |
| 新建 | `api/src/life/fork-action.test.ts` | 动作参数、目标归属、证据继承规则（T13） |
| 修改 | `api/src/world-state/rules.ts` | 抽取可共享的纯动作事实/事件计划构造（T2） |
| 修改 | `api/src/world-state/commit.ts` | 普通动作提交复用抽出的逻辑，保持原门禁（T2） |
| 修改 | `api/src/life/fork-preview.ts` | 动作建议、预览版本和消息来源候选（T4、T5） |
| 修改 | `api/src/life/fork.ts` | 原子初始动作、版本保护、paused 路径、幂等回执（T6–T8） |
| 修改 | `api/src/worlds/routes.ts` | 登录 fork 预览/确认请求与响应（T9） |
| 修改 | `web/src/api/types.ts` | F1 请求、响应及动作联合类型（T10） |
| 修改 | `web/src/api/client.ts` | 预览与 fork 确认客户端接口（T10） |
| 修改 | `web/src/components/world/TimelineSwitcher.tsx` | 动作审阅编辑、来源选择及提交反馈（T11、T12） |
| 新建或修改 | 对应 API fork/world-state/journey 测试 | 校验、事务、重放和旧路径回归（T13、T14） |
| 新建或修改 | TimelineSwitcher 组件测试 | 确认前编辑与失败保留输入（T15） |

> 实施说明：`commitWorldCommand` 已通过 `validateWorldAction` 取得计划；本次在 `rules.ts` 抽出两个纯计划构造函数，并继续由原验证与提交路径调用，因此无需修改 `commit.ts`，普通 `/actions` 的运行和版本门禁保持原样。

## T1：定义 F1 动作合同

**文件：** `api/src/life/fork-action.ts`
**依赖：** 无。
**步骤：**
1. 定义 `ForkInitialAction` 的 `inform` 与 `environment` 联合类型。
2. 定义 `PreparedForkAction`，只含服务端派生的动作计划字段。
3. 明确类别白名单、topic/content/value 长度常量，避免前后端各自猜测约束。

**验证：** TypeScript 类型检查通过；请求类型不能携带可见性、事实值或事件正文等派生字段。

## T2：抽出世界动作纯校验与计划构造

**文件：** `api/src/world-state/rules.ts`、`api/src/world-state/commit.ts`
**依赖：** T1。
**步骤：**
1. 将无数据库写入的动作语义校验/计划构造整理为可复用函数。
2. 保持 `commitWorldCommand` 的权限、时间线存在、模拟运行及版本门禁和既有写入行为。
3. 给 fork 初始化提供构造事实、事件和载荷所需的共享语义，不在 fork 后调用 `/actions`。

**验证：** 现有 world-state 定向测试通过；既有动作提交仍遵守 running 和 expectedVersion 检查。

## T3：实现 F1 动作校验与计划构造

**文件：** `api/src/life/fork-action.ts`
**依赖：** T1、T2。
**步骤：**
1. 校验动作类型、必填字段、长度、环境类别和非空目标值。
2. 校验接收居民/地点属于目标世界，并根据分叉点状态确认目标有效。
3. 对消息来源只接受候选集合内且分叉时刻可继承的事实；无来源生成 rumor 语义，有效来源继承 certainty。
4. 构造私有消息知识事实或地点世界可见环境事实及不泄漏正文的事件计划。

**验证：** 新增单元用例覆盖两类动作、边界长度、越权/未知目标和来源无效情况。

## T4：扩展分叉预览动作建议

**文件：** `api/src/life/fork-preview.ts`
**依赖：** T1。
**步骤：**
1. 扩展结构化输出 schema，使一次现有预览模型调用最多建议一项受支持动作。
2. 将模型输出作为草稿解析；非法或不支持的动作不得被当作可执行动作。
3. 返回当前预览对应的 `sourceVersion`，并继续返回既有场景预览字段。

**验证：** 预览定向用例覆盖有效建议、缺失/错误字段与不支持类型；预览本身不写分支或动作记录。

## T5：提供按分叉点筛选的消息来源候选

**文件：** `api/src/life/fork-preview.ts`
**依赖：** T3、T4。
**步骤：**
1. 使用 K1 的来源可见性与时间线截止规则筛选合格来源。
2. 返回事实 ID、类型、时间、certainty 和不泄漏正文的短标签。
3. 如实现分页，令游标绑定 `sourceVersion`；不得用过期预览版本续页。

**验证：** 定向用例确认未来事实、兄弟线事实和不可见私人事实不会出现在候选中，合法可继承来源保持原 certainty。

## T6：为 fork 构造动作写入计划

**文件：** `api/src/life/fork.ts`
**依赖：** T3。
**步骤：**
1. 为 `forkTimeline` 增加可选预期源版本和已校验动作计划参数。
2. 在快照建成后确定子线动作时间、command ID、fact ID、事件 ID 和版本字段。
3. 让子线初始动作写入共享现有 command/fact/event/revision/evidence 语义，并保持 source state version 存入快照。

**验证：** 定向用例检查子线版本 1、源状态水位和命令/事实/事件字段相互一致。

## T7：原子保护源版本并允许暂停初始化

**文件：** `api/src/life/fork.ts`
**依赖：** T6。
**步骤：**
1. 在 D1 batch 中以源时间线及预期 `universeRevisions.version` 条件保护子线创建，避免仅依赖批次前读取。
2. 将子线、快照、version 1 动作行和证据水位放入同一 batch；任一冲突/写入失败整体回滚。
3. 只在带有效 F1 动作时跳过世界必须 running 的 fork 门禁；普通无动作 fork 保持原限制。
4. 保留父线可写、源线 active、活跃子线数量限制等现有检查。

**验证：** 定向用例覆盖源版本竞争、写入失败无残留、暂停世界 F1 初始化成功、暂停世界普通 fork 仍拒绝。

## T8：实现动作幂等重放与冲突识别

**文件：** `api/src/life/fork.ts`
**依赖：** T6、T7。
**步骤：**
1. 使用 fork ID 生成确定性初始命令 ID，并存储规范化动作负载。
2. 同 ID 重放时比较世界、源线、场景和动作负载；一致返回原分支与原动作回执。
3. 同 ID 用于不同动作或动作缺失/多出时返回冲突，不追加写入。

**验证：** 定向用例证明相同请求无重复 command/fact/event；同 ID 不同负载稳定返回冲突。

## T9：连接登录 fork API 路由

**文件：** `api/src/worlds/routes.ts`、必要时 `api/src/life/fork-preview.ts`
**依赖：** T4、T5、T7、T8。
**步骤：**
1. 验证确认请求的场景、动作、request ID 与 `expectedSourceVersion` 结构。
2. 将用户编辑后的动作交由 F1 校验器处理，不采信模型原建议中的派生字段。
3. 映射稳定的 4xx/409 错误并返回可定位的动作回执；确认失败不吞掉前端草稿。
4. 不扩展 demo fork 路由。

**验证：** 路由定向用例覆盖未登录/越权、无效动作、陈旧版本、成功回执和 demo 旧行为。

## T10：更新前端 API 类型与客户端

**文件：** `web/src/api/types.ts`、`web/src/api/client.ts`
**依赖：** T4、T5、T9。
**步骤：**
1. 添加 F1 动作、预览候选、版本字段及动作回执类型。
2. 更新 fork preview 和 create 客户端方法以传递来源选择与 expected source version。
3. 保持无动作和 demo 方法的既有调用签名/行为。

**验证：** 前端 TypeScript 检查通过，旧 fork 调用仍能构造原有请求。

## T11：实现动作审阅与来源选择界面

**文件：** `web/src/components/TimelineSwitcher.tsx`
**依赖：** T10。
**步骤：**
1. 在预览结果中展示动作类型与字段，并允许编辑支持的类型和参数。
2. 对消息动作展示合格来源候选，未选择来源时明确使用 rumor 语义。
3. 阻止缺字段或不支持动作进入确认提交；请求携带预览版本和用户编辑后的动作。

**验证：** 组件用例覆盖两类动作切换、编辑、来源选择和不合法状态禁用确认。

## T12：显示提交成功与保留失败草稿

**文件：** `web/src/components/TimelineSwitcher.tsx`
**依赖：** T11。
**步骤：**
1. 成功后展示新子线与动作执行摘要。
2. 失败时保留 what-if、动作字段及来源选择，并显示可理解的冲突/校验提示。
3. 对网络重试复用本次 request ID，用户修改负载后生成新请求 ID。

**验证：** 组件用例覆盖成功反馈、网络重放、409/校验失败和输入保留。

## T13：覆盖动作语义、来源与隐私规则

**文件：** `api/src/life/fork-action.test.ts`、相关 `api/src/world-state` 测试
**依赖：** T2、T3、T5。
**步骤：**
1. 覆盖天气/照明/通行白名单、长度界限和世界内目标检查。
2. 覆盖无来源 rumor、有来源 certainty 继承以及无效/不可继承来源拒绝。
3. 断言消息正文不会进入公共事件，环境事实使用地点和 world visibility。

**验证：** 执行对应 API 定向测试，所有规则用例通过。

## T14：覆盖原子创建、并发和兼容行为

**文件：** 现有 fork、world-state、journey API 测试
**依赖：** T7、T8、T9。
**步骤：**
1. 覆盖快照、动作 command/fact/event/revision 同批次成功创建及子线版本 1。
2. 注入写入失败并检查不留子线、动作或源线修改。
3. 覆盖 paused 初始化、源版本过期、重复 request ID 和同 ID 不同负载。
4. 回归普通无动作 fork、demo fork 及独立 `/actions` 既有门禁。

**验证：** 执行选定的 fork/world-state/journey 定向测试，父线与兄弟线数据保持不变。

## T15：覆盖前端确认交互

**文件：** `TimelineSwitcher` 对应组件测试
**依赖：** T11、T12。
**步骤：**
1. 覆盖自然语言预览后用户检查和修改结构化动作。
2. 覆盖确认请求中的预览版本、动作参数和可选来源 ID。
3. 覆盖失败保留输入、成功执行摘要及普通 fork/demo 路径兼容。

**验证：** 执行对应前端组件定向测试。

## T16：完成 F1 定向验收与兼容检查

**文件：** 代码与测试，不新增规格文档内容。
**依赖：** T13、T14、T15。
**步骤：**
1. 按 `checklist.md` 顺序核对每条验收标准与实现证据。
2. 先执行低成本定向验证；涉及 build 或更大测试集合时按仓库 `AGENTS.md` 检查内存压力并限制 worker。
3. 记录未通过项、环境限制和确切结果，不把未执行项目标记为通过。

**验证：** checklist 全部验收项均有通过证据或明确未完成说明；没有用户私人数据进入合成验证输入。
