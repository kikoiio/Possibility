# K2：交谈渠道与空间事实一致 Checklist

> 状态：已获用户批准；实现及计划验收已完成，证据与未覆盖限制记录如下。
> 输入：[spec.md](./spec.md)、[plan.md](./plan.md)、[task.md](./task.md)。
> 工作区：/home/neo/.codex/worktrees/b-trust-branching-6638/Possibility，分支 codex/b-trust-branching。

## 交付门槛

- [x] Spec、Plan、Task、Checklist 均已获用户批准。
- [x] 实现基于恢复后的 B 分支；K1 知识隔离回归通过。
- [x] 验证命令、通过数量与限制已记入本清单；未执行项未标通过。
- [x] 迁移只新增默认 `unknown` 的请求渠道列；迁移与 legacy 回归确认旧消息、记忆和事件正文不回填或改写。
- [x] 定向验证、完整 API 套件及 E2E 均使用单 worker 串行执行；启动重型浏览器测试前检查了 MemAvailable、换页和 PSI。
- [x] 临时 API 测试世界、浏览器响应均为合成数据，未调用模型提供方。

## 功能验收

### AC1：电话渠道和居民地点

- [x] 人物页普通聊天请求由服务端绑定 channel=phone；忽略客户端伪造的 channel/location/participants 字段。
- [x] 提示上下文表明用户远程电话联系，不在居民现场参与者集合中。
- [x] 合成位置纠正与恶意位置更新旅程通过；居民 location 保持 `车站街/Cafe`，没有创建用户在场身份。
- [x] 请求数据库行、status/recovery 回执及 pending 列表包含 phone/unknown 渠道。

**证据：** api/src/chat/routes.test.ts、agent prompt/context 定向测试；合成世界请求前后 personStates 对比。
**结果/命令：** `api/src/chat/routes.test.ts`（含伪造客户端空间字段和合成位置纠正）；`api/src/agent/prompt.time-zone.test.ts`；`api/src/chat/recovery.test.ts`；`web/e2e/k2-phone-chat.spec.ts`。API route 与浏览器旅程通过。

### AC2：电话邀请不是到场

- [x] 电话提示明确来访邀请不代表到达；普通电话 API 不创建 visitor、共同地点或 scene 记录。
- [x] 完成的电话回合活动由服务端标记为电话交谈；工具拒绝改地点、忽略模型活动字段。
- [x] 聚合命令 ID 由 requestId 确定，命令、事实、事件与记忆都写入请求的时间线。
- [x] 合成私密 canary 不进入共享事件文案；详细记忆留在居民专属 memory，聊天正文只出现在该会话。

**证据：** prompt/tool 输出注入测试、命令与事实投影断言、K1 知识可见性回归。
**结果/命令：** `api/src/chat/routes.test.ts`（原子电话旅程与事件 canary）；`api/src/agent/prompt.time-zone.test.ts`。共 6 个 K2 定向文件中的 27 项 API 测试通过；之后加入的 provider 中断与取消用例也通过。

### AC3：电话中明确纠正位置

- [x] 纠正文本和同请求的下一次模型提示均保留 phone 语义；普通入口每次请求都由服务端固定 phone。
- [x] 服务端状态继续使用实际居民地点，活动规范为“通过电话与用户交谈”。
- [x] 合成记忆以“通过电话澄清”描述更正，没有把用户写成同地拜访。
- [x] 本旅程无旧派生错误需要修复；系统只追加带 phone 来源的当前命令/记忆，不批量覆写历史。

**证据：** 含合成纠正文本的 agent route journey；检查提示、当前 state、memory、world command。
**结果/命令：** `api/src/chat/routes.test.ts` 电话纠正旅程、电话地点约束；`api/src/agent/prompt.time-zone.test.ts` 电话/unknown 提示测试通过。

### AC4：当面交谈位置证据

- [x] 有效现场交谈仍使用服务端 persona 状态、时间线和地点作为依据。
- [x] scene route 回归覆盖缺少/无效在场信息拒绝路径。
- [x] scene recovery 与 world commit 回归确认失败事务不会留下部分交谈投影。
- [x] 合法现场交谈路径继续使用既有 `scene_open` / `conversation` 和私人 thought 存储。

**证据：** scene routes 和 world-state commit 定向测试；最小 API journey。
**结果/命令：** `api/src/scenes/routes.test.ts`、`api/src/scene/recovery.test.ts`、`api/src/world-state/commit.test.ts`：现场路由/恢复/事务 49 项通过；`api/src/test/knowledge-journey.test.ts` 和 `api/src/test/legacy-compat.test.ts` 纳入另一次回归，共同 57 项通过。`api/src/scene/routes.ts` 未修改。

### AC5：其他入口与旧记录

- [x] 新普通聊天请求由服务端入口固定 phone。
- [x] `/scene` 现场交谈语义仍由服务端场景/在场事实定义，且路由不读取客户端渠道字段。
- [x] catchup、自主模拟未注入 phone；没有来源的 chat context 按 unknown，并提示不得推断当面在场。
- [x] 迁移测试验证旧 request 默认为 unknown；旧消息历史兼容回归通过。

**证据：** request lifecycle / legacy compatibility tests、SQLite migration test。
**结果/命令：** `api/src/db/k2-migration.test.ts`、`api/src/chat/recovery.test.ts`、`api/src/scene/routes.test.ts`、`api/src/agent/prompt.time-zone.test.ts`；迁移和兼容验证通过。

### AC6：模型不能改写可信空间上下文

- [x] 注入模型 tool call 要求居民搬到图书馆时，phone 模式返回拒绝，不写地点或现场参与记录。
- [x] phone 模式 `update_state.location` 被确定性拒绝；活动由服务端规范化。
- [x] world command 的持久化 action 含 phone 渠道元数据，作为审计来源。
- [x] prompt 仅作引导；位置拒绝由工具运行态执行，并有 API 持久化断言。

**证据：** malicious tool-call fixture、validator/command 测试、数据库状态检查。
**结果/命令：** `api/src/chat/routes.test.ts` 的合成 act/update_state/remember 多工具调用；API 后端 build 通过。

### AC7：失败、原子性与 requestId

- [x] provider 中断、取消、位置越权和强制数据库命令插入失败均不会完成请求。
- [x] 失败回合仅保留用户原始消息和 failed/cancelled request，没有居民命令、事实、事件、记忆或回复。
- [x] 数据库提交错误对客户端显示通用重试提示，不透出数据库错误正文。
- [x] 成功回合以一次 `commitWorldCommand` D1 batch 写入居民状态/事件/记忆、回复和 completed 状态。
- [x] 同 requestId 重放不增加请求消息、模型调用或命令；不同正文/渠道冲突。
- [x] 取消已获胜时 completion 写入触发事务约束失败，附带世界命令也回滚。

**证据：** commitWorldCommand atomic write failure tests、chat request replay/race tests、DB projection assertions。
**结果/命令：** `api/src/chat/routes.test.ts`、`api/src/chat/recovery.test.ts`；成功、provider 中断、插入失败、完成/取消竞态及重放均通过。

### AC8：K1 知识隔离回归

- [x] phone 记忆写入对应居民的私有 memory 行；其他居民知识上下文由既有 K1 规则隔离。
- [x] 共享事件对 phone 详细经历使用通用描述，不包含合成私聊 canary；没有写公共 system note。
- [x] K1 knowledge journey 回归通过；phone channel 本身不改变 knowledge certainty。

**证据：** api/src/test/knowledge-journey.test.ts、K1 分叉旅程相关回归。
**结果/命令：** `api/src/test/knowledge-journey.test.ts`、`api/src/agent/knowledge.test.ts`、`api/src/chat/routes.test.ts`；K1 旅程回归和事件 canary 断言通过。

### AC9：旧数据与当前纠正范围

- [x] 迁移只增加渠道字段；不批量改写历史消息、事件、居民状态或压缩记忆。
- [x] 当前电话更新通过带渠道的版本化命令与居民专属记忆追溯。
- [x] 旧数据仍可能包含过往空间语义错误，本实现不声称自动修复历史。
- [x] 旧聊天正文保持可读；更正通过追加新记录表达，不删除历史依据。

**证据：** migration 数据保留测试、状态命令来源检查、旧历史 journey。
**结果/命令：** `api/src/db/k2-migration.test.ts`、`api/src/test/legacy-compat.test.ts` 与 API 全量回归通过。

## 非功能与兼容检查

- [x] 服务端从所属会话解析世界/时间线/居民；渠道由路由固定，电话位置更新被拒绝，模型与客户端不能提供现场成员。
- [x] 不增加用于推断用户位置的模型调用。
- [x] 私人聊天正文留在 owner-authenticated 会话；共享事件不包含电话正文。
- [x] 旧 conversation/messages 保持兼容；request 查询、pending、取消、恢复保留渠道。
- [x] 状态类 SSE 和成功回执只在事务提交后发送；失败保留用户输入并标记请求失败。
- [x] phone 命令、居民状态、事实与事件使用请求对应的时间线。
- [x] API 构建、API 全量回归、Web 构建、Web recovery 测试与人物页电话 E2E 通过。
- [x] 验证环境、命令、通过/跳过数量及 chunk warning 记入下表。

## 实施后验收记录

| 日期 | 检查 | 结果 | 证据/命令 | 限制 |
|---|---|---|---|---|
| 2026-10-04 | API 全量 | 通过 | `cd api && npm run build && npm test -- --pool=threads --maxWorkers=1 --no-file-parallelism`；104 文件通过、1 文件跳过；682 项通过、1 项跳过 | 包含后续 E1 精确时点/证据边界回归；全部合成数据 |
| 2026-10-04 | K2 API 定向 | 通过 | `cd api && npm test -- --maxWorkers=1 --no-file-parallelism src/chat/routes.test.ts src/chat/recovery.test.ts src/db/k2-migration.test.ts`；3 文件、15 项通过 | 全部合成数据 |
| 2026-10-04 | 最终原子性与现场回归 | 通过 | `cd api && npm run build && npm test -- --maxWorkers=1 --no-file-parallelism src/chat/routes.test.ts src/chat/recovery.test.ts src/db/k2-migration.test.ts src/scenes/routes.test.ts src/scene/recovery.test.ts src/world-state/commit.test.ts`；6 文件、64 项通过；之后电话状态 SSE 断言单测通过 | 提交错误返回通用重试提示 |
| 2026-10-04 | K1 与 scene 回归 | 通过 | `cd api && npm test -- --maxWorkers=1 --no-file-parallelism src/scenes/routes.test.ts src/scene/recovery.test.ts src/world-state/commit.test.ts`；49 项通过；另运行 `src/test/knowledge-journey.test.ts` 与 `src/test/legacy-compat.test.ts`，四文件合计 57 项通过 | `/scene` 未修改 |
| 2026-10-04 | Agent/prompt/migration 定向 | 通过 | `cd api && npm test -- --maxWorkers=1 --no-file-parallelism src/chat/routes.test.ts src/chat/recovery.test.ts src/agent/tools.test.ts src/agent/tools.integration.test.ts src/agent/prompt.time-zone.test.ts src/db/k2-migration.test.ts`；6 文件、27 项通过 | 包含 phone/unknown 提示与隐私 canary |
| 2026-10-04 | Web API 类型与生产构建 | 通过 | `cd web && npm run build` | Vite 输出既有约 1.26 MB 主 chunk 警告；构建成功 |
| 2026-10-04 | Web chat recovery | 通过 | `cd web && npm test -- --maxWorkers=1 --no-file-parallelism src/lib/chatRecovery.test.ts`；1 文件、5 项通过 | — |
| 2026-10-04 | 人物页电话入口 E2E | 通过 | `cd web && npm run test:e2e -- --workers=1 k2-phone-chat.spec.ts`；Chromium 1 项通过 | 浏览器 API 为 stub；服务端绑定与数据库事务由 API 集成测试覆盖 |
