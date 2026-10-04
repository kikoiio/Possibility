# F1：分叉条件执行 Checklist

> 状态：已执行；验收记录包含实际命令、结果和证据文件。
> 输入：已批准的 [spec.md](spec.md)、[plan.md](plan.md)、[task.md](task.md)。四份规格全部批准后才开始实现。
> 范围：登录用户世界 fork 的一项消息或环境初始动作；暂停世界的动作初始化例外；无动作 fork 与 demo 兼容。

## 使用与证据规则

- 只在实际运行、观察请求前模型输入或检查持久化结果后勾选；代码存在不代表通过。
- 每条证据记录：检查 ID、状态（通过/未通过/未完成/不适用）、日期、提交、环境、命令或操作、实际结果和 trace/日志路径。
- API 验收使用隔离数据库、合成居民/世界/时间线与合成 canary；不得使用真实用户进度或私人消息。
- 单元及定向验证按 `task.md` 使用单 worker。构建或较大验证前按仓库 `AGENTS.md` 检查 `MemAvailable`、后续 `si/so`、memory PSI 和适用的 cgroup 限额；有持续内存压力时降低并行度、分批执行并记录未完成项。
- 预览 stub 可验证 schema 与确定性动作解析，但不能证明用户确认行为、数据库原子性或居民输入隐私；这些需分别检查真实 API/UI 流程和持久化记录。
- 失败注入只作用于隔离数据库。不得人为改变共享开发数据库中的生产或用户数据。
- 验收执行前所有项目初始未勾选。未执行或因环境限制无法执行的项目保持未勾选，并注明原因。

## 功能验收

- [x] **AC1 / F1 / N1 / N5：预览、动作建议和明确确认。**
  - 在登录世界 fork UI 输入 what-if，确认预览仍只有一次既有模型调用；预览不会创建时间线、命令、事实或事件。
  - 确认动作建议为至多一项结构化支持动作。测试不支持动作、错误结构、空必填字段时不能提交；对支持动作可编辑类型和参数，只有用户明确按确认后才发送创建请求。
  - 检查模型生成的提议对象不能绕过用户确认或服务器动作校验；确认应用动作时不额外调用模型。
  - **证据：** fork preview/API 调用记录、UI 交互测试、数据库调用前后计数。

- [x] **AC2 / F3 / N3：消息事实、私有正文与确定性继承。**
  - 确认无来源消息在子线起点写为接收者私有知识，certainty 为 rumor；公共事件只说明收到消息，不出现 topic 或正文 canary。
  - 选用合格来源时事实/传闻级别保持一致；选用不可继承、未来、兄弟线、跨世界或伪造来源 ID 时拒绝。
  - 分别构造接收者和其他居民实际模型输入/居民上下文：正文只出现在指定接收者输入中。
  - **证据：** `worldFacts`、`worldCommands`、`events` 持久化行；K1 居民证据/提示输入断言；无效来源请求响应。

- [x] **AC3 / F2 / F4：地点环境事实与证据可见性。**
  - 分别提交 weather、lighting、access 环境动作，确认子线起点的事实记录关联正确地点、类别和值，且世界可见事件与事实一致。
  - 确认相关居民只能按 K1 来源、时间线及版本规则获得环境证据；不要求图形、导航或物理变化。
  - 检查父线和兄弟线没有这项事实或事件。
  - **证据：** 隔离 DB 前后查询、居民输入证据、父/兄弟/子线对照。

- [x] **AC4 / F2 / F3 / F5 / N1：字段和权限失败关闭。**
  - 分别提交非本世界居民、非本世界地点、未知环境类别、空值、超长 value/topic/content、不合格来源、未登录/非所有者请求和归档源线。
  - 每个失败都返回明确客户端错误或冲突；没有子线、动作 command/fact/event 残留，源线数据不变。
  - 覆盖一次请求携带多项动作或结构不符合联合类型时拒绝，不静默执行部分动作。
  - **证据：** API 响应状态/错误码与每次请求前后的隔离 DB 行对照。

- [x] **AC5 / F5 / N2 / N4：暂停初始化、版本和原子成功。**
  - 对可写活跃源线分别在运行与暂停状态创建带初始动作分叉；暂停只绕过 F1 初始动作路径门禁。不带动作的普通 fork 在暂停状态继续拒绝。
  - 成功后同时观察 fork 快照、子线、唯一命令、版本化事实、事件和证据修订；子线初始 revision 为 1，command `expectedVersion=0/resultVersion=1`，动作 simTime 对应分叉起点，快照记录源线 `sourceStateVersion`。
  - 确认成功响应中的子线和动作回执对应持久化记录；父线状态、版本和事实不变。
  - **证据：** 成功 API 响应、DB 行/版本对照、父线快照对照及普通动作门禁回归。

- [x] **AC6 / N2：原子失败和过期预览冲突。**
  - 在隔离 DB 的 fork batch 不同写入位置注入失败，确认子线、快照、command、fact、event 和 revision 均无部分残留，源线不变。
  - 预览后递增源线 revision 或改变受保护源状态，再提交旧 `expectedSourceVersion`；确认返回 409/等价稳定冲突，提示重新预览且不创建分支。
  - 并发源版本保护必须位于原子提交条件中；单纯在 batch 前读取版本不算通过。
  - **证据：** 故障注入配置、冲突请求响应和事务前后全表相关行对照。

- [x] **AC7 / F6：请求 ID 幂等与冲突。**
  - 同一 ID、同一场景、同一动作重放，响应标识与初次结果一致，command/fact/event/时间线计数不增加。
  - 同一 ID 改变场景、动作参数、来源或是否携带动作，返回冲突，不写入新记录。
  - **证据：** 两次/多次 API 响应及相应数据库主键、计数和 payload 对照。

- [x] **AC8 / N1 / N2：所有权、活跃源线和来源门禁。**
  - 验证所有者可对自身可写活跃源线完成请求；非所有者、其他世界目标、已归档源线及不可写源线失败关闭。
  - 验证合格消息来源属于提交的源时间线在所选分叉点的可继承范围；错误或缺失版本信息不回退到宽松读取。
  - **证据：** 鉴权/门禁 API 测试、源候选与服务端重验结果、无写入断言。

- [x] **AC9 / F1 / F6 / N6：端到端 UI 与旧入口兼容。**
  - 实际走完登录用户流程：what-if 输入、预览、检查/编辑动作、（消息时）来源选择、明确确认、成功子线/动作反馈。
  - 强制失败后确认 what-if、结构化动作、来源选择仍保留，用户可刷新预览或修正后再次提交；网络重试复用 request ID，修改负载后使用新 ID。
  - 回归普通无动作 fork、旧 `changedVariable` 展示、demo fork 和独立 `/actions`；旧描述不得呈现为已执行改变，旧功能仍可用。
  - **证据：** 组件/浏览器流程记录、失败状态截图或 DOM 断言、普通/demo fork 和 `/actions` 回归结果。

## 集成、构建与隐私回归

- [x] `ForkInitialAction` 在客户端与服务端只表达支持的两种动作；派生事实值、可见性、事件正文和证据链均由服务端决定。
- [x] 初始动作 command/fact/event 使用子线命名空间和同一提交版本；任何消息公共事件、普通列表或非接收者输入均不包含消息正文。
- [x] 所有新增结果行纳入 fork D1 batch；无 schema 表或 migration 变更；独立 `commitWorldCommand` 语义未放宽。
- [x] 前端 API 类型检查通过；API build 通过；Web production build 通过。
- [x] F1 定向 API、world-state、journey 和前端组件测试通过；失败注入确认没有意外副作用。
- [x] API 全量测试通过（1 项既有 skip）。

## 验收记录

| 检查项 | 状态 | 日期/提交 | 环境与命令/操作 | 实际结果 | 证据路径 |
|---|---|---|---|---|---|
| AC1 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/worlds/fork-condition.test.ts`；`npm run test:e2e -- e2e/f1-fork-condition.spec.ts e2e/fork-whatif-entry.spec.ts --workers=1` | 一次模型预览、无动作时确认禁用、编辑动作后明确确认；确认重试不再次预览 | `api/src/worlds/fork-condition.test.ts`；`web/e2e/f1-fork-condition.spec.ts` |
| AC2 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/life/fork-action.test.ts src/worlds/fork-condition.test.ts`；F1 Playwright E2E 单 worker | 无来源 rumor、来源 certainty 继承、接收者私有输入、其他居民无正文、公共事件不含正文；E2E 验证来源编辑保留和重试 | `api/src/life/fork-action.test.ts`；`api/src/worlds/fork-condition.test.ts`；`web/e2e/f1-fork-condition.spec.ts` |
| AC3 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/life/fork-action.test.ts src/life/fork.test.ts` | weather、lighting、access 均生成地点级 world 事实；居民投影类别可读；子线版本 1，父线版本不变 | `api/src/life/fork-action.test.ts`；`api/src/life/fork.test.ts` |
| AC4 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/life/fork-action.test.ts src/worlds/fork-condition.test.ts` | 无效目标、类别、长度、来源、未登录、非所有者、归档源线均拒绝；路由失败用例检查无部分写入 | `api/src/life/fork-action.test.ts`；`api/src/worlds/fork-condition.test.ts` |
| AC5 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/life/fork.test.ts src/worlds/fork-condition.test.ts` | running 与 paused 动作初始化成功；普通 paused fork 拒绝；command/fact/event、version 1、快照及 paused 恢复一致 | `api/src/life/fork.test.ts`；`api/src/worlds/fork-condition.test.ts` |
| AC6 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/life/fork.test.ts src/worlds/fork-condition.test.ts` | event 插入故障回滚子线和全部动作行、世界恢复 paused；过期预览返回冲突且不创建子线；写入条件包含源版本 | `api/src/life/fork.test.ts`；`api/src/worlds/fork-condition.test.ts` |
| AC7 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/life/fork.test.ts src/worlds/fork-condition.test.ts` | 相同请求重放返回原回执且不重复写入；不同动作冲突；环境动作首次响应与重放摘要一致 | `api/src/life/fork.test.ts`；`api/src/worlds/fork-condition.test.ts` |
| AC8 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api test -- --maxWorkers=1 src/life/fork-action.test.ts src/worlds/fork-condition.test.ts` | 所有权、归档、来源时间线/版本及完整证据链经路由和 K1 校验失败关闭 | `api/src/life/fork-action.test.ts`；`api/src/worlds/fork-condition.test.ts` |
| AC9 | 通过 | 2026-10-04 / 未提交工作树 | Playwright 单 worker：`f1-fork-condition.spec.ts`、`fork-whatif-entry.spec.ts`、`s4c-fork-feedback.spec.ts` | 消息动作成功/失败交互、环境动作登录流程、无动作高级 fork、demo fork 可用；源条件字段编辑失败保留 | `web/e2e/f1-fork-condition.spec.ts`；`web/e2e/fork-whatif-entry.spec.ts`；`web/e2e/s4c-fork-feedback.spec.ts` |
| 集成、构建与隐私回归 | 通过 | 2026-10-04 / 未提交工作树 | `npm --prefix api run build`；`npm --prefix api test -- --maxWorkers=1`；`npm --prefix web run build`；`npm --prefix web test -- --maxWorkers=1` | API 101 文件通过、1 跳过；673 通过、1 跳过；Web 构建通过；47 文件、272 测试通过。Vite 报告 1.26 MB JS chunk 警告 | `api/src/life/fork-action.test.ts`；`api/src/life/fork.test.ts`；`api/src/worlds/fork-condition.test.ts`；`web/src/components/world/TimelineSwitcher.test.tsx`；`web/e2e/f1-fork-condition.spec.ts` |

## 验收汇总

- 通过：10 项（AC1–AC9 与集成项）；未通过：0 项；未完成：0 项。
- 记录对应未提交的 B worktree 工作树；全量 Web 测试为组件测试，不代替 E2E。登录 fork 与 demo fork 的相关 Playwright E2E 已单独运行。
