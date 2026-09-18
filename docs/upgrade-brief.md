# Possibility 升级优化简报（2026-09-17）

> 本文是"升级优化"阶段的工作底稿。配置/环境问题已全部解决，不再赘述。
> 运行状态：DeepSeek（`api.deepseek.com/v1`，模型 `deepseek-flash`）已接入，引擎全链路运转正常（日程/节拍/邂逅/对话均产出）。
>
> **进度：四阶段已全部实施完毕并在 dev 环境逐项验证（2026-09-17）。** 下文"二、bug 清单"保留原始记录；"四、升级路线"标注各阶段完成状态与实际改动。部署到线上前必读「部署注意事项」。

---

## 一、项目现状速览

- **定位**：个人作品"平行世界平台"。多角色架空世界，LLM 扮演有分层人设卡的角色在世界中自主生活；用户可旁观、注入事件、与角色"打电话"；支持 what-if 时间线分叉。
- **栈**：web/ Vite+React19+TS+Tailwind；api/ Cloudflare Worker + Hono + Drizzle + D1（本地 SQLite）；OpenAI 兼容 LLM 协议。
- **引擎**：每 15s 一拍，时钟 6 倍速；机械日程零 LLM；决策点优先级 dialogue_turn > injection > beat > schedule > summary；每拍每世界上限 8 次、每日 400 次调用；统一记忆流 + 重要性评分 + 蒸馏。
- **关键源码地图**：`api/src/engine/tick.ts`（主循环）、`api/src/engine/steps/`（五类执行器）、`api/src/engine/budget.ts`（预算）、`api/src/agent/`（提示词/记忆/工具循环）、`api/src/worlds/routes.ts`、`api/src/timelines/routes.ts`、`api/src/chat/routes.ts`。

## 二、已确认 bug 清单（按修复优先级）

### 严重
1. **LLM 预算漏记账 + 聊天不设防** — fork 预览（2 次/次）、fork 推演（≤25 次迭代）、人设蒸馏均无 `recordCall`；chat 只记账不查 `dailyCapHit`、不查世界 status（paused/capped 照样烧调用）。修法：所有 LLM 出口统一走带 cap 校验的网关。
2. **person 级 fork 丢祖先链 → 分叉零记忆** — `api/src/timelines/routes.ts:121-141` 未写 `ancestorIdsJson`，记忆可见性（`agent/memory.ts:58-66`）依赖祖先链；与提示词承诺矛盾。还缺活跃时间线上限（3 条）校验。
3. **catchup 把世界时钟往回拨** — `api/src/agent/loop.ts:41` 用真实时间当追赶窗口右端，但 sim 时钟 6 倍速恒领先真实时间，追赶后写回 `simNow` 导致倒退数小时。修法：窗口右端基于 `timeline.simNow` 换算。

### 重要
4. **capped 世界永不自动恢复** — 换天清零只在 `budget.ts:50` recordCall 内，capped 世界被 tick 排除 → 死锁。修法：tick 前对 `capped && callsDay≠today` 自动清零恢复。（2026-09-17 已手动 resume 一次）
5. **resume 清零当日用量** — `worlds/routes.ts:198-208` pause→resume 即刷新日限额，与 4 合修：resume 只改状态，日计数按天自然滚动。
6. **act 信任模型的 simTime** — 聊天模式 `windowEnd=null`，模型可把时钟写到任意未来。修法：钳制在 `[clock, simNow+合理窗口]`。
7. **时钟推进 read-modify-write 竞态** — tick 与聊天并发写 `simNow`/`lastRealTickAt` 无 CAS。修法：条件更新或收敛到 tick 单点写时钟。
8. **streamChat 无超时** — `llm/client.ts:105` 无 AbortController（complete 有 180s）；流式异常时 llmCalls 漏上报。修法：加超时信号 + try/finally 上报。

### 次要
- 零测试（引擎状态机最急需；fork 链路"测一次就能发现"的 bug 就是证据）。
- 世界创建/世界级 fork 多步写无事务（对比 persons 路由用了 `db.batch`）。
- 提示词注入无防护（注入事件/用户原文直进提示词）。
- SSE 每连接 2s 四轮查询、公开流免登录无连接上限。
- 单 Worker 串行 tick + 内存单飞锁：世界数增长必然拖垮节拍，上生产需按世界分片调度。

## 三、竞品调研结论（下一阶段的对标库）

**核心判断：「多人世界自主运转 + 时间线分叉」在竞品中属空白带。** 商业产品全部"对话驱动、用户在场才运转"；自治世界模拟只有学术界（AI Town/Smallville）且无产品化记忆与商业玩法。

| 产品 | 关键做法 | 对 Possibility 的意义 |
|---|---|---|
| Character.AI | Persona 显式建模"用户也是角色"；群聊互相 @ 轮流发言 | "打电话"= Persona 的实时化；群聊交互范式 |
| AI Town（a16z 开源） | 记忆流=重要性评分+相关性/新近度/重要性三因子检索+周期反思+递归规划；闲置即暂停、archive 冻结可读 | 记忆配方已验证可抄；**archive/冻结能力 = 具体下一步** |
| Inworld AI | 大小模型分层（成本 -80%）；群聊 **Director 层**（决定谁发言、何时升级大模型）；持久 brain 对象 | **Director 层 = 最值得抄的调度思路** |
| Replika/Kindroid/Nomi | Nomi：失效主因是**检索失败（信息过载）而非存储失败**，Identity Core 自主蒸馏不可直看；Kindroid：记忆用户可编辑是高黏性刚需 | 支持硬性节流设计；记忆可审计性可作特性 |
| 星野（MiniMax） | ⚠️ 公认痛点：私聊记忆不带入群聊、人设跳反 | **"统一记忆流+跨场景人设一致"是可主打的对标缺口** |
| 筑梦岛（阅文） | "梦境保存并被他人接续"= 分叉商业化雏形（手动单线）；互动资产化（星念抽卡）验证变现钩子 | 自动分叉是差异化；事件资产化可参考 |

**学术成本结论**：调度式比逐步调 LLM 便宜三个数量级（$0.48 vs $270/episode）。现有"日程零 LLM+决策点调用+硬上限"是文献支持的正确架构；建议引入 **Token Cost 指标**（每动作平均 token）作为拍级上限调参依据。

## 四、升级路线执行记录（全部完成 ✅，2026-09-17）

1. **护栏闭环 ✅**（bug 1/4/5/8）
   - 新增 `api/src/engine/guard.ts` 统一闸门：`gateWorld`（世界须 running 且未触顶，触顶当场封板）/ `gateUser`（预世界调用按用户日限额）/ `settleWorld`（记账+触顶）。
   - 全部 LLM 出口已接入：chat、fork 预览（含失败重试）、fork 推演、蒸馏、世界骨架草稿。`llm_call_log` 新增 `user_id` 列、`world_id` 可空（迁移 0003），预世界调用记用户桶；新用途 `world_draft/fork_preview/fork_simulate`。
   - `streamChat` 加 120s 超时（AbortController）；`runAgentTurn` 流中途失败也产出 `done`（带 `llmCalls` 与 `error`），调用方照常记账——预算无旁路。
   - tick 开头 `recoverCappedWorlds`：昨日 capped 世界自动复位；`resume` 不再清零当日用量。
   - **回归教训**：重构成 `rolloverCalls` 时漏加 `+n`，计数永远停 0（被运行时验证当场抓住）；已抽纯函数 `bumpCalls` 并加回归测试。
2. **时钟单点化 ✅**（bug 2/6/7）
   - `runAgentTurn` 时钟一律以 `timeline.simNow` 为锚：chat 锚定 simNow 且 `windowEnd=simNow`（模型给的 simTime 钳制在窗口内，不能写飞）；catchup 从 `state.simTime` 填到 simNow（间隔也按虚拟时间计，入口文案同步改）；simulate 保持跨天步进。
   - `timelines.simNow` 写回收敛：仅 simulate（分叉推演）写回，且条件更新 `WHERE simNow < next` 不许拨回；chat/catchup 不再碰世界时钟，tick 成为唯一推进者。
3. **fork 链路修复 + 测试 ✅**（bug 3）
   - person 级 fork 显式写入 `ancestorIdsJson = 源的祖先链 + 源`（修复零记忆分叉），并补活跃时间线上限（3 条）校验，与世界级 fork 对齐。
   - 新增 vitest（`npm test`），28 个单测覆盖：预算滚动/触顶/记账核心、时钟钳制（7 种场景）、导演层仲裁、祖先链计算。
4. **Director 层 ✅**（新能力）
   - `api/src/engine/director.ts`（纯函数零 LLM，借鉴 Inworld 思路）：优先级排序 + 注入扇入（同一事件每拍最多 2 人反应，其余顺延不丢失）+ 同优先级人物轮转公平（防预算截断饿死排在后面的人物）。tick 主循环已接入。
5. **archive/冻结 ✅**
   - 世界级 `POST /worlds/:id/archive`：`archived` 状态冻结可读（tick 天然排除），`resume` 解冻；前端世界列表/世界视图补齐状态标签与「归档」按钮；capped 提示文案改为"次日自动恢复"。
6. **远期（未做，保持建议）**：按世界分片的调度；闲置自动归档（当前为手动）。

## 四之二、产品增量执行记录（2026-09-17，提交 57727dc）

1. **章节生成 ✅**（"世界自己出书"——对标筑梦岛"梦境保存"，但自动成文）
   - `api/src/chapters/`：1 次 LLM 调用（purpose `chapter`，走预算护栏）把上次章节以来（缺省近 24 虚拟时、3–80 条）的事件流转成小说章 `{title(≤14字), content(800–1400字)}`；世界/时间线/人物名单/全部事件行进 prompt；失败重试一次、每次尝试均记账。
   - API：`POST /worlds/:id/chapters`（生成）、`GET /worlds/:id/chapters`（倒序 50）、`GET /chapters/:id`；`chapters` 表 + 迁移 0004。
   - 前端：世界页「章节」面板（章节目录 + 正文渲染 + 「写下一章」）。
   - 实测：主线 53 事件 → 《纸背上半个雪字》1333 字，callsToday +1，章节列表/全文正常。
2. **记忆可审计 ✅**（对标 Kindroid"记忆用户可编辑是高黏性刚需"）
   - `api/src/memories/`：`PATCH /memories/:id`（校正内容 / 调整重要度，clamp 1–5）、`DELETE /memories/:id`；归属校验 memory→person→user。
   - 前端：人物抽屉记忆页签可内联编辑/删除（保存即刷新聚焦视图）。
   - 实测：改后立即可见、恢复成功、未授权 401、importance 越界被 clamp。
3. 测试：新增章节单测 4 个，合计 **32/32**；两端 tsc 干净。

## 四之三、产品增量第二波（2026-09-17/18，提交 35c7f5d）

1. **你在世界里 ✅**（Character.AI Persona 思路——从"观察世界"到"生活在世界里"）
   - 世界页「进入世界」：登记在场身份（`persons.isUser`，每人每世界一个：名字 + 身份自述），之后以该身份在场说话；同地点清醒且空闲的人物依次以本人身份回应（SSE 逐句，1 人 1 次 LLM 调用，purpose `scene`，走预算护栏与日限额）。
   - 相遇写进世界史（事件流，章节会把它织进小说）与每个人的记忆流（内心想法 + 关系记忆）——他们会记住你。
   - 提示词红线：人物不得点破第四面墙（不暗示访客是观察者/玩家/用户）。
   - 引擎全链路跳过 isUser 人物（不排日程/节拍/对话/蒸馏），人物列表/API 不展示。
   - 实测：登记「阿透」后深夜到温室花房，小夜当场回应并在记忆中记下"往后早起生火，留意院里的脚步声"；UI 端到端发送/回应正常。
2. **LLM 导演层 v2 ✅**（Inworld 思路的 LLM 版）
   - `engine/director-llm.ts`：注入事件的有效反应者多于扇入上限（2）时，问一次导演"此刻谁最有戏"（事件 + 候选人物状态/身份进 prompt，输出有序反应者名单），选中者本拍优先反应；每拍至多 1 次调用、计入拍预算与日限额（purpose `director`）、失败自动回退 v1 机械排序。`DIRECTOR_LLM=0` 关闭。
3. **闲置自动归档 ✅**（AI Town archive 思路的自动版）
   - `worlds.lastUserActivityAt` 在聊天/注入/章节/创建/恢复时刷新；tick 每拍扫描，无交互超过 `IDLE_ARCHIVE_DAYS`（缺省 7）的 running 世界自动 `archived`（pauseReason='idle'），零 LLM 费用、数据完整保留、resume 解冻；存量世界该列为 null 不归档（行为不变）。世界列表对 idle 归档单独标注「闲置归档」。
4. 测试：新增 10 个（闲置判定/导演提示与解析/scene prompt/在场身份模型），合计 **42/42**；两端 tsc 干净；迁移 0005（本地已应用）。

## 四之四、产品增量第三波（2026-09-18，提交 29d2cda）

1. **世界记得你 ✅**（「你在世界里」的闭环：离开之后，世界继续记挂你）
   - scene 回应新增可选 `word` 字段：人物有邀约/提醒/口信时托付给来访者——**同一次 LLM 调用产出，零额外消耗**；提示词要求非真心不留，避免灌水。
   - `persona_messages` 表（迁移 0006）：留言按收件人存未读；`GET /worlds/:id/persona/messages` 送达并标记已读，同时返回事件流里**最近提及你名字的事**（含人物节拍里主动提到访客的事件）。
   - 「进入世界」面板顶部展示「自你上次离开后，世界没有忘记你」；「进入世界」按钮带未读角标。
   - 实测：告别场景小夜（"晚膳六时半……灶上我留着"）与柊一成（代收安神茶的托付）各留一句 → 未读 2 → 送达 → 已读清零；提及列表正确聚合两条时间线里的事件。
2. 测试：新增 `parseSceneOutput` 纯函数 + 5 个单测（word 截断/非字符串拒绝），合计 **47/47**。

## 四之五、打磨轮（2026-09-18，提交 3d0593a）

1. **在场交谈并入对话模型 ✅**（scene 从"散装事件"升级为完整对话）
   - 一场 scene 现在就是一段 `dialogues` + `dialogueTurns`：参与者 = 用户在场身份 + 在场回应者，一次说完即 `ended`（引擎只为 ongoing 对话排步，天然不会拾起它轮转；实测 tick 健康不受影响）。
   - 事件流复用对话卡片：可逐句展开、按人着色、查看每句内心想法；`description` 存完整对话摘录（上限 800 字截断），章节生成走 `fmtEventLine` 时自动拿到对话全文——访客戏份直接织入小说。无回应者时不落事件（`turns.length > 1` 才写）。
   - 纯函数 `scene/plan.ts`（`sceneDialogueTitle` / `sceneTranscript`）+ 7 个单测；合计 **54/54**。
   - 实测：餐厅发问 → 卡片「阿透 与 小夜、雾野 透 在餐厅交谈」→ 展开逐句 + 想法正常；`persona/messages` 提及板块自动捕获该事件。
2. **ScenePanel 小打磨 ✅**：对话开头显示「在{地点}——{在场者} 在场」系统行；地点下拉显示各地点在场人数（世界快照 locationBoard）。
3. **人物标识色修复 ✅**：旧 charCode 线性哈希对 UUID 分布极差（8 色盘 6 人撞 3 对）。改 FNV-1a + 末尾混合（分布均匀，6000 随机 UUID 实测各桶 ~500±40），色盘扩至 12 色。按 ID 稳定、不随人物增删漂移。

## 四之六、章节质量走查与修复（2026-09-18，提交 a47225c）

1. **章节优先织入访客戏份 ✅**（走查实证：80 事件压一章时，用户的早餐 scene 被 LLM 略过）
   - 章节事件上限 80 → **48**（14 虚拟时 80 事件压缩过度；48 约半日，叙事密度合适）。
   - 人物名单中在场身份标注「（在场身份）」，系统提示要求其参与的事件必须写入正文。纯函数 `rosterLine` + 测试。
   - 实证：重生成《空着的四行》（07:46→次日 00:41，48 事件）——阿透以小说人物身份入章，早餐对话自然织入（"「早。昨夜后山的钟声，你们也听见了吗？」小夜答得利落……"）。
2. **修复 beat/injection 把事件写到未来 ✅**（升级简报 bug#6 的姊妹遗漏：chat 钳制了，beat 没有）
   - `normalizeBeatJson` 新增 `windowMinutes` 参数，`offsetMin` 钳制在 `[0, windowMinutes]`；injection 反应窗口 = 事件时刻→simNow。走查线索：章节 toSim（13:22）越过生成时刻 simNow（09:42）。
   - 存量"未来事件"自然消亡（时间线推进后即落在过去），无需数据修复。新增 `beat.test.ts` 5 个单测（含钳制回归）。
3. **可交谈地点看板 ✅**（走查中三连扑空：地点面板人数含睡眠/对话中者）
   - `GET /worlds/:id/scene/board`：各地点「清醒且空闲」的回应者人数（`scene/eligible.ts`，POST scene 与看板共用同一资格逻辑）；ScenePanel 选项标注「N 人可交谈 / 都在忙或睡着」，零人选项禁用，交谈后自动刷新。
4. **测试时间炸弹拆除 ✅**：budget.test 写死 `2026-09-17` 当"今天"，跨天后自爆——改为以真实当天为锚（TODAY/YESTERDAY 常量）。
5. 合计 **65/65** 单测，两端 tsc 干净。

## 部署注意事项

- **必须**：以下迁移需应用到线上 D1：`cd api && npx wrangler d1 migrations apply DB --remote`（本地均已应用）：
  - `api/drizzle/0003_long_firebrand.sql`（llm_call_log 加 user_id、world_id 可空）
  - `api/drizzle/0004_living_scalphunter.sql`（chapters 表）
  - `api/drizzle/0005_grey_tag.sql`（worlds.last_user_activity_at、persons.is_user）
  - `api/drizzle/0006_awesome_colonel_america.sql`（persona_messages 留言表）
- 新环境变量（均可不配）：`PREWORLD_DAILY_CAP`（预世界调用用户日限额，缺省 40）、`IDLE_ARCHIVE_DAYS`（闲置归档天数，缺省 7）、`DIRECTOR_LLM`（缺省 on，`0` 关闭 LLM 导演仲裁）。
- `llm_call_log.purpose` 新增枚举值：`world_draft / fork_preview / fork_simulate / chapter / director / scene`（旧行不受影响）。
- 无新增迁移。scene 复用既有 `dialogues` / `dialogue_turns` 表（在场身份也是 persons 行），存量数据兼容。

## 原四、升级方向建议（执行前的规划存档）

1. ~~护栏闭环~~（已完成，见上方执行记录）
2. ~~时钟单点化~~（已完成）
3. ~~fork 修复+补测试~~（已完成）
4. ~~Director 层~~（已完成 v1：机械仲裁；LLM 版仲裁留作后续）
5. ~~archive/冻结~~（已完成；闲置自动冻结留作后续）
6. 远期：分片调度；记忆审计 UI。

## 五、工作环境备忘（本会话约定）

- Bash 工具完全不可用（apply-seccomp 失败）：命令走 terminal 面板（最多 6 个标签）或 preview_eval 里 fetch localhost；文件操作用 Read/Write/Edit。
- 开发栈启动：preview_start（`possibility-dev`），日志在 /tmp/possibility-dev.log（用 Read 读）；引擎 tick 日志关键字 `[tick]`。
- dev 管理 API 走 HTTP 即可（如 resume：先 POST /api/auth/login 拿 token，再 POST /api/worlds/:id/resume）。
