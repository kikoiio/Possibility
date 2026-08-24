# 虚拟邻居（Virtual Neighbor）Tasks

> 依据已批准的 [spec.md](spec.md) 与 [plan.md](plan.md)。
> 共 24 个任务。每个任务自包含：文件、依赖、步骤、验证。
>
> **需要用户提前准备的事项（不阻塞编码，阻塞对应验证）：**
> - Cloudflare 账号（免费注册，T1/T21 需要 wrangler login）
> - 至少一个 LLM API key（OpenAI 兼容端点：DeepSeek/通义/智谱均可，T5 起需要）
> - 管理员工令牌（自定一串随机字符串，T16 需要）

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 删除 | 旧 Python 项目全部文件 | 退役（T0） |
| 新建 | `package.json` `tsconfig.json` `.gitignore` | 脚手架 |
| 新建 | `wrangler.jsonc` | Worker 配置：cron/D1/KV/env.demo |
| 新建 | `migrations/0001_init.sql` | D1 schema（5 表 + FTS5 + 触发器） |
| 新建 | `src/index.ts` | Workers 入口：fetch(router) + scheduled(tick) |
| 新建 | `src/config.ts` | KV 配置读取 + zod 默认值 |
| 新建 | `src/store/db.ts` | D1 访问层（唯一平台耦合模块） |
| 新建 | `src/llm/client.ts` `src/llm/usage.ts` | LLM 封装 + 用量统计 |
| 新建 | `src/feed/guard.ts` | 内容护栏（规则+词表） |
| 新建 | `src/persona/profile.ts` | 人格档案解析校验 |
| 新建 | `src/memory/store.ts` | 记忆写入/三元检索/反思阈值 |
| 新建 | `src/cognition/assemble.ts` | 分层注入组装器 |
| 新建 | `src/cognition/plan.ts` | planDay 每日计划 |
| 新建 | `src/cognition/decide.ts` | decide/converse/monologue |
| 新建 | `src/cognition/respond.ts` | 二期会话接口（壳） |
| 新建 | `src/world/events.ts` | 世界事件生成 |
| 新建 | `src/world/mystery.ts` | 谜团引擎 |
| 新建 | `src/feed/entries.ts` | 信息流条目生成 |
| 新建 | `src/world/engine.ts` | tick 主流程 |
| 新建 | `src/api/public.ts` `src/api/admin.ts` | Hono 路由 |
| 新建 | `personas/hoshino/profile.md` | 星野档案 |
| 新建 | `personas/nanase/profile.md` | 七濑档案 |
| 新建 | `web/`（index.html + src/*） | 信息流前端 |
| 新建 | `tests/*.test.ts` | vitest 测试 |
| 修改 | `README.md`（新建） | 项目说明与运维手册 |

---

## T0: 旧代码退役

**文件：** 仓库根目录全部旧 Python 文件
**依赖：** 无
**步骤：**
1. `git add -A` 暂存当前工作区已删除的旧文件
2. 删除剩余旧文件（`core/`、`backend/`、`edge/`、`eval/`、`scripts/`、`tools/`、旧 `personas/`、`main.py`、旧 requirements、旧 tests、`data/`）
3. 保留 `docs/spec_docs/`（spec 四文档）、`LICENSE`、`.gitignore`
4. 提交：`重构：旧 Python 语音项目退役，spec/plan/task 三文档奠基`

**验证：** `git status` 干净；仓库只剩三份文档与 LICENSE

## T1: 项目脚手架

**文件：** `package.json` `tsconfig.json` `wrangler.jsonc` `.gitignore`
**依赖：** T0
**步骤：**
1. `pnpm init`，安装依赖：hono、ai（Vercel AI SDK）、zod、gray-matter；devDependencies：typescript、tsx、vitest、wrangler、@cloudflare/vitest-pool-workers、@types/node
2. tsconfig：strict、module ESNext、target ES2022、moduleResolution bundler
3. wrangler.jsonc：name=`virtual-neighbor`、main=`src/index.ts`、compatibility_date、定义 cron `*/30 * * * *`；声明 D1 绑定 `DB`、KV 绑定 `CONFIG_KV`；`env.demo` 独立 D1 + cron `*/5 * * * *`
4. .gitignore：node_modules、dist、.wrangler、.dev.vars、web/dist
5. `pnpm exec tsc --noEmit` 通过

**验证：** `pnpm exec wrangler --version` 可用；`wrangler whoami` 登录成功（用户操作）

## T2: D1 schema 迁移

**文件：** `migrations/0001_init.sql`
**依赖：** T1
**步骤：**
1. 建表：`entries`(id TEXT PK, ts, type, resident_ids JSON, location, title, content, status)
2. 建表：`memories`(id INTEGER PK AUTOINCREMENT, resident_id, ts, kind, content, salience, tags, subject)
3. 建 FTS5 虚拟表（**小写 fts5**）：`memories_fts(content, tags, content='memories', content_rowid='id')`
4. 建同步触发器：memories 的 insert/delete 同步 memories_fts
5. 建表：`mysteries`(id TEXT PK, arc, title, premise, state, clues JSON, resolution, created_ts)
6. 建表：`usage_records`(id INTEGER PK AUTOINCREMENT, ts, purpose, tier, model, tokens_in, tokens_out, est_cost)
7. 建表：`moderation_log`(id INTEGER PK AUTOINCREMENT, ts, target_type, target_id, action, reason)
8. 建表：`world_snapshots`(id INTEGER PK CHECK(id=1), ts, state JSON)
9. `wrangler d1 migrations apply DB --local` 应用本地库

**验证：** `wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master"` 列出全部 8 个表/虚拟表/触发器

## T3: store 访问层

**文件：** `src/store/db.ts`
**依赖：** T2
**步骤：**
1. 定义各表 TS 类型（Entry/MemoryEntry/Mystery/UsageRecord/WorldSnapshot）
2. 实现 CRUD 函数：insertEntry、listEntries(分页/筛选/状态过滤)、getEntry、setEntryStatus
3. 实现：insertMemory、searchMemoriesFts(query, residentId, k)、recentMemories(residentId, k)
4. 实现：upsertMystery、getMystery、listMysteries(state)
5. 实现：insertUsage、usageByDay(day)
6. 实现：insertModerationLog
7. 实现：saveSnapshot、loadSnapshot
8. vitest 单测：用 workers 池对本地 D1 真跑各函数

**验证：** `pnpm test store` 全部通过（本地 miniflare D1）

## T4: config 模块

**文件：** `src/config.ts`
**依赖：** T1
**步骤：**
1. zod 定义 Config schema：heartbeatCron、sleepWindow(start/end)、timezone、modelTiers(cheap/prose 各含 provider/baseURL/model)、activationRate、demo 标记、guard 词表路径
2. 默认值内嵌；`get(env)`：读 KV `config` 键，zod 解析，失败回落默认值并记日志
3. 单测：KV 有值/无值/非法值三种情况

**验证：** `pnpm test config` 通过

## T5: LLM 客户端 + 用量

**文件：** `src/llm/client.ts` `src/llm/usage.ts`
**依赖：** T3、T4
**步骤：**
1. client.ts：`complete(purpose, tier, messages)`——按 tier 从 config 取 provider，Vercel AI SDK 调 OpenAI 兼容端点；key 从 env secret 读取
2. `structured(purpose, tier, schema, messages)`——generateObject + zod
3. 每次调用后 insertUsage（tokens 从 response.usage，estCost 按 config 单价表估算）
4. usage.ts：`dailyReport(env, day)` 聚合 usage_records 按天统计
5. 单测 mock fetch；联调验证用真实 key 跑一次 `complete`

**验证：** `pnpm test llm` 通过；真实调用后 `usage_records` 表新增一行且 tokens 非零

## T6: 内容护栏

**文件：** `src/feed/guard.ts` `src/feed/wordlist.ts`
**依赖：** T3
**步骤：**
1. wordlist.ts：敏感主题/不当内容词表（含犯罪细节类：杀、血案、尸体处理等；政治敏感；NSFW）
2. guard.ts：`check(text, context: 'entry'|'profile')`——词表命中/长度异常/格式异常（如泄露 prompt 痕迹"你是"开头）→ 返回 reason
3. 命中时 insertModerationLog
4. 单测：命中词表/正常文本/长文截断三组

**验证：** `pnpm test guard` 通过；构造违规文本返回 reason 且 moderation_log 有记录

## T7: 人格档案解析

**文件：** `src/persona/profile.ts`
**依赖：** T6
**步骤：**
1. zod 定义 ResidentProfile schema（按 plan 字段，schedule 为 TimeBlock[]）
2. gray-matter 解析 profile.md：frontmatter 放结构化字段（id/name/age/role/schedule/home/haunts/relations），正文小节放 description/personality/speechStyle/scenario/dialogueExamples/secrets
3. 校验：home/haunts 必须在地点清单内（地点清单常量 `src/world/locations.ts`：满月喫茶/拾光旧书店/海边堤坝/神社台阶/街心公园/住家A/住家B）
4. 载入文本过 guard.check('profile')，违规抛 ProfileError(field)
5. 单测：合法档案/缺字段档案/非法地点/含违规词四个用例

**验证：** `pnpm test persona` 通过；错误信息指名问题字段

## T8: 记忆模块

**文件：** `src/memory/store.ts`
**依赖：** T3、T5
**步骤：**
1. `write(residentId, kind, content, salience, subject?)`：调 cheap 模型给 salience 打分（1-5）+ 抽 tags，insertMemory
2. `recall(residentId, hints, k)`：FTS5 匹配度 + 近因衰减 + salience 三元加权排序，返回 top-k（α/β/γ 常量可调）
3. `maybeReflect(residentId)`：未反思 salience 累计超阈值（默认 15）→ prose 模型生成 1-3 条抽象认识，kind=reflection 写入，重置计数
4. 单测：写入后可检索；阈值触发反思（mock LLM）

**验证：** `pnpm test memory` 通过；FTS 中文检索命中正确

## T9: 分层注入组装器

**文件：** `src/cognition/assemble.ts`
**依赖：** T7、T8
**步骤：**
1. `assemble({profile, world, memories, situation, instruction})`：按层组装 messages——system(人格锚：name/role/personality/speechStyle/dialogueExamples 摘要) → user(世界状态块：时间/天气/地点/在场者) → user(预算化记忆块：recall top-k，token 预算截断 ~800) → user(当前情境) → user(depth-0 指令：任务 + "你是{name}，说话方式：{speechStyle 摘要}")
2. 输出为 Vercel AI SDK messages 数组
3. 单测：层序正确；超预算记忆被截断；depth-0 指令含风格锚

**验证：** `pnpm test assemble` 通过

## T10: 每日计划 planDay

**文件：** `src/cognition/plan.ts`
**依赖：** T5、T8、T9
**步骤：**
1. `planDay(resident, world)`：assemble（人格锚+作息表+昨日记忆摘要+世界事件）→ cheap 模型出当日计划（3-6 个时间块的 JSON）
2. structured 输出 zod 校验（时间块含 时段/地点/活动）
3. 写入 kind=plan、salience=4 的记忆
4. 单测 mock LLM：计划写入且结构合法

**验证：** `pnpm test plan` 通过

## T11: decide/converse/monologue

**文件：** `src/cognition/decide.ts`
**依赖：** T5、T8、T9、T10
**步骤：**
1. `decide(resident, world)`：assemble（人格+世界+recall(当日 plan+近期)+情境）→ structured Action：zod 枚举 `stay|move|speak|investigate` + 目标地点 + 活动描述 + 话题线索
2. `converse(residents, world)`：prose 模型生成 4-8 轮短对话（双方人格锚分别注入，输出 JSON 数组[{speaker, line}]）
3. `monologue(resident, world)`：prose 模型，depth-0 风格锚，150-300 字第一人称独白；星野时指令要求"推理笔记"口吻
4. 单测 mock：三种输出结构合法、人格锚在场

**验证：** `pnpm test decide` 通过

## T12: respond 壳（二期预留）

**文件：** `src/cognition/respond.ts`
**依赖：** T11
**步骤：**
1. 定义 `respond(resident, session): Promise<string>` 签名，内部调用 decide 的 assemble 复用逻辑，本期抛 `NotImplementedError('二期')`
2. 类型导出 Session（visitorId/messages）

**验证：** `pnpm exec tsc --noEmit` 通过（签名存在即可）

## T13: 世界事件生成

**文件：** `src/world/events.ts`
**依赖：** T5
**步骤：**
1. `rollEvents(world, rng)`：按概率产出 0-2 个世界事件：天气变化（状态机：晴/阴/雨/雪按季节转移）、背景人物花絮（从模板池抽：駄菓子屋奶奶/邮局大叔/流浪猫，cheap 模型润色一句话）、季节/节日标记
2. 事件写入 WorldState.pendingEvents，供居民 perceive
3. 单测：概率分布合理；事件结构合法

**验证：** `pnpm test events` 通过

## T14: 谜团引擎

**文件：** `src/world/mystery.ts`
**依赖：** T5、T3
**步骤：**
1. `maybeSpawn(world)`：日常之谜按周节奏（配置：每周 1-2 个）由 prose 模型生成（谜面+预定谜底+3-5 条线索大纲），约束：谜底必须温暖向；生成后过 guard
2. `advance(world)`：investigating 中的谜团按居民 investigate 行动释放下一条线索；线索耗尽→生成揭晓（EntryCandidate，type=mystery，title 必填）
3. 季度谜团（星野旧案）：不从 LLM 生成谜面，从 hoshino 档案 secrets + 配置里的阶段大纲读取，按周推进一阶段
4. 单测 mock：完整走完 出现→调查→揭晓 生命周期

**验证：** `pnpm test mystery` 通过；揭晓文本无 guard 违规

## T15: 信息流条目生成

**文件：** `src/feed/entries.ts`
**依赖：** T3、T6
**步骤：**
1. `draft(type, residentIds, location, content, title?)`：组装 EntryCandidate
2. 发布管线：`publishAll(candidates)`——逐个过 guard.check，过则 insertEntry(status=published)，拦截则记 moderation_log
3. 激活率：按 config.activationRate 对 activity 类候选做随机丢弃（dialogue/monologue/mystery 不受影响）
4. 单测：发布/拦截/丢弃三路

**验证：** `pnpm test entries` 通过

## T16: engine tick 主流程

**文件：** `src/world/engine.ts`
**依赖：** T4、T8、T10、T11、T13、T14、T15
**步骤：**
1. `tick(env)`：loadSnapshot + config.get → 休眠窗口内 no-op（仍更新 lastTickTs）
2. 时钟推进：period 计算（按 timezone 的本地时间）
3. 每日首个 tick：为每位居民 planDay
4. events.rollEvents → mystery.maybeSpawn
5. 居民循环：decide → 规则裁决（move 校验地点合法、相遇检测）→ 更新 WorldState → draft 动态候选 + memory.write(observation)
6. 同地 ≥2 人：converse → draft 对话候选
7. mystery.advance；到点的 monologue（每日傍晚各 1 篇）；maybeReflect
8. publishAll → saveSnapshot
9. 单测（mock LLM）：连续 3 个 tick 后 WorldState 有位置/活动，entries 表有新增，快照可恢复

**验证：** `pnpm test engine` 通过

## T17: API 路由

**文件：** `src/api/public.ts` `src/api/admin.ts`
**依赖：** T3、T16
**步骤：**
1. public：`GET /api/timeline?cursor&limit&resident`（倒序分页，仅 published）；`GET /api/residents`（公开人格：name/role/description 摘要，**不含 secrets**）；`GET /api/residents/:id/entries`
2. admin（Bearer token，env secret `ADMIN_TOKEN`）：`POST /api/admin/entries/:id/takedown`；`GET /api/admin/usage/daily?day=`；`POST /api/admin/tick`
3. 无 token/错 token → 401；public 路由无任何写方法
4. 单测：各路由状态码与分页行为

**验证：** `pnpm test api` 通过；无 token 调 admin 返回 401

## T18: Workers 入口装配

**文件：** `src/index.ts`
**依赖：** T17
**步骤：**
1. Hono app 挂载 public/admin 路由；静态资源（web/dist）由 assets 绑定托管
2. `scheduled` 处理器：`ctx.waitUntil(engine.tick(env))`
3. 全局错误处理：异常记日志不泄露内部信息
4. `wrangler dev` 启动，curl `/api/timeline` 返回空数组 200

**验证：** `wrangler dev` 下 curl public 路由 200；`wrangler dev --test-scheduled` 手动触发 cron 无报错

## T19: 星野人格档案

**文件：** `personas/hoshino/profile.md`
**依赖：** T7
**步骤：**
1. 按 spec 首发阵容写档案：42 岁前刑警、满月喫茶老板、辞职与旧案伏笔（secrets 写明旧案来龙去脉，供谜团引擎分阶段使用）
2. 字段完整：性格写行为不写形容词；speechStyle 给 3-5 条口癖/句式；dialogueExamples 5 条；schedule 覆盖 06:00-23:00（含清晨烘豆、傍晚堤坝散步）
3. relations：对七濑（看穿的无奈与照拂）、对背景人物（駄菓子屋奶奶等）
4. 跑 T7 校验通过

**验证：** `pnpm test persona` 通过；`loadAll()` 成功返回星野对象

## T20: 七濑人格档案

**文件：** `personas/nanase/profile.md`
**依赖：** T7
**步骤：**
1. 24 岁打工店员：直觉跳脱、结论比证据快十倍、蒙对时得意
2. 字段完整度同 T19；speechStyle 与星野形成可盲测区分的反差（语速快、感叹多、推理跳跃）
3. schedule 与星野错开（午后看店、打烊后江边）
4. 跑 T7 校验通过

**验证：** 同 T19；盲测：两人 dialogueExamples 隐名可区分

## T21: 信息流前端

**文件：** `web/index.html` `web/src/main.ts` `web/src/api.ts` `web/src/ui.ts` `web/src/style.css` `web/vite.config.ts`
**依赖：** T18
**步骤：**
1. api.ts：fetch 时间线/居民（轮询 30s，cursor 分页加载更多）
2. ui.ts：条目卡片（角色名/时间/地点/类型标签/内容；类型配色：动态灰、对话蓝、独白紫、谜团金）；居民筛选 chips；居民主页（hash 路由，人格介绍+其条目）
3. 移动适配：单列卡片、字号/触控目标达标
4. 页面无任何 input/button 提交控件（仅筛选 chips 与链接）
5. vite 构建到 `web/dist`；wrangler assets 指向它

**验证：** `wrangler dev` 打开页面：条目渲染、筛选可用、居民主页可达；移动端宽度（375px）排版正常；页面源无输入控件

## T22: secrets 与部署环境

**文件：** `.dev.vars`（本地，gitignore）、wrangler 环境配置
**依赖：** T18
**步骤：**
1. `wrangler secret put LLM_API_KEY` 与 `ADMIN_TOKEN`（用户提供）
2. .dev.vars 本地同名变量
3. 创建 D1：`wrangler d1 create virtual-neighbor`，更新 wrangler.jsonc 的 database_id；`migrations apply`（远端）
4. 创建 KV：`wrangler kv namespace create CONFIG_KV`；写入初始 config JSON
5. `wrangler deploy` 部署正式环境；`wrangler deploy --env demo` 部署演示环境

**验证：** 线上 `GET /api/timeline` 200；`POST /api/admin/tick`（带 token）后时间线出现真实条目；usage 日报有数据

## T23: 端到端联调与文档

**文件：** `README.md`
**依赖：** T22
**步骤：**
1. 演示环境加速跑 2 小时：观察条目质量（人格区分度/记忆引用/谜团推进），调 prompt 与激活率
2. 博客仓库 iframe 嵌入验证（桌面+手机）
3. README：架构图、本地开发命令、部署命令、配置说明、管理端点用法、成本观测方法
4. 最终提交

**验证：** 按 checklist.md 执行验收（下一阶段产物）

---

## 执行顺序

```
T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12
                                          ↓
                    T13 → T14 → T15 → T16 → T17 → T18 → T22 → T23
                                          ↑
                              T19 → T20（T7 后任意时间可并行）
                              T21（T18 后可并行）
```
