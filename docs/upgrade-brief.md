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
6. **远期（未做，保持建议）**：按世界分片的调度；记忆可审计 UI（对标 Kindroid）；闲置自动归档（当前为手动）。

## 部署注意事项

- **必须**：`api/drizzle/0003_long_firebrand.sql` 需应用到线上 D1：`cd api && npx wrangler d1 migrations apply DB --remote`（本地已应用）。
- 新环境变量 `PREWORLD_DAILY_CAP`（预世界调用用户日限额，缺省 40，可不配）。
- `llm_call_log.purpose` 新增枚举值：`world_draft / fork_preview / fork_simulate`（旧行不受影响）。

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
