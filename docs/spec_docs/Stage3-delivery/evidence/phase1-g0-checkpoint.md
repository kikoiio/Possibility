# 阶段一 G0 真实旅程验收检查点

日期：2026-10-07（Asia/Shanghai）

验收分支：`phase3`

验收提交基线：`8bdc79fc11465a7e8837a89f717e03ab7c937c56`
应用源码基线：`07dcdb40e9cfec19524bded888faee6498f2cea1`（与验收 worktree 的 `api/`、`web/` 树逐文件一致）

## 逐项结果

| 门槛项 | 结果 | 实测与限制 |
|---|---|---|
| 真实多空间访客进入与交互 | **部分通过** | Playwright `guest-claim-journey.spec.ts` 使用隔离 Wrangler D1 和真实 API；访客进入 `/demo`、进入温室并移动到场、创建真实分支。没有交谈步骤。本机与 GitHub Actions 各 1/1 通过；云端 run `37561465283` 复验的是同一片段。详见 [`phase1-guest-claim.log`](phase1-guest-claim.log) 和 [`phase1-g0-cloud-guest-claim.md`](phase1-g0-cloud-guest-claim.md)。 |
| 访客认领与进度保留 | **部分通过** | 同一 E2E 注册账户并执行真实 claim；新账户落在非 demo 的已认领世界，世界有 2 条时间线、7 位居民和 1 个场景修订。页面确认时间线选择器有两条线，并确认访客仍在温室。本机和云端结果均未刷新页面；云端只复验访客交互/分叉/认领片段。 |
| 所有者管理 | **未核验** | 页面进入了已认领世界，但本次没有逐项操作/断言暂停、继续、历史或管理能力。数据库所有权与 `is_demo=0` 只能证明 claim 结果，不能替代管理 UI 验收。 |
| 编辑与持久化 | **未核验** | 本次没有在认领后的多空间世界提交编辑并刷新验证。独立旧场景兼容测试不属于这次同一旅程，也没有运行。 |
| 分屏比较与刷新继续 | **未核验** | 访客分叉后的“两种人生”比较是弹窗/面板，不是左右分屏。E2E 未执行 `page.reload()`。因此不满足“编辑 → 分屏 → 刷新继续”。现有 split E2E 使用 API stub，不作为本项真实 API 证据。 |
| 三个自写描述与官方示例的真实生成 | **未通过** | 四条真实 API 生成共计 17 次 provider 请求。custom-1 API 返回 200，但 8 个地点仅对应 3 个场景对象，不能判为成功；custom-2、custom-3、官方示例均返回 502 内容校验错误。完整输入、返回、问题码和调用数见 [`phase1-generation-results.json`](phase1-generation-results.json)。 |
| 自建单空间与原世界补建对照 | **未通过** | 再次用官方示例走自建生成，5 次 provider 请求后仍 502，未进入 `POST /api/worlds`，没有生成自建单空间。隔离 D1 中创建的无场景原世界保留 1 位居民、1 条时间线；`repair-context` 为 200，但真实 `repair-draft` 4 次 provider 请求后以 walk-connectivity / walk-gap 返回 502，场景修订仍为 0。原 worldId 未变化，但没有成功补建保存。 |

## 真实生成诊断

- 四条基线输入是第四轮记录的三条自写描述和原样官方示例；模型响应经本机隔离 API 发送到本机 `.dev.vars` 所配置的 provider。没有把密钥、token 或 `.dev.vars` 内容写入证据。
- 总计 **26 次 provider 调用**：四条输入 17 次；单空间创建复测 5 次；原世界补建 4 次。低于已批准的 200 次上限。本检查点之后没有继续调用 provider。
- 三条失败结果的 provider 调用均已完成，失败发生在体素场景通行校验：custom-2 重复返回 `walk-clearance`；custom-3 返回 `walk-clearance`；官方示例返回 `walk-connectivity`。原世界补建返回 `walk-connectivity` 与 `walk-gap`。
- custom-1 返回“成功”但 `document.locations` 有 8 项、`document.objects` 只有 3 项。当前 `api/src/scenes/voxel-draft.ts` 的最终地点核对比较地点名称集合，没有在此处确认每个地点的 `objectId` 都指向实际场景对象；这是与本次结果一致的校验缺口候选。未尝试保存这份草稿，不能断言创建路由会接收它。
- API `llm_call_log` 查询显示自建生成请求 5 行、补建请求 4 行；路由没有向补建响应返回 `callsUsed`，本报告以隔离 D1 调用日志计数。

## 验收环境和复查方式

- Playwright：`web/e2e/guest-claim-journey.spec.ts`，命令为 `PLAYWRIGHT_API_PORT=27887 PLAYWRIGHT_WEB_PORT=25173 npx playwright test --workers=1 --project=desktop-chromium --output=/tmp/p3-g0-evidence/guest-claim e2e/guest-claim-journey.spec.ts`。结果：1 passed；桌面 Chromium 视口配置 1280×720，WebGL 使用 SwiftShader。
- API 流程：本地 `dev:s02-e2e`，独立 D1 `/tmp/p3-g0-generation-db`，端口 27888；自建/补建流程各用隔离新账号。修复失败后只读查询确认原世界没有新增 scene revision，居民、地点、时间线保持原样。
- 验收结束后已停止本 session 启动的 Wrangler、Vite 和 Playwright 进程，并移除 phase3 worktree 临时依赖与 `.dev.vars` 符号链接；没有触碰 main worktree 的未提交更改。
- 资源协调者报告 MemAvailable 约 5.3 GiB、swap 使用上升、memory PSI avg10 约 0.33 后，本 session 未再启动浏览器、构建或测试；后续重型复验待错峰。

## G0 判定

**阶段一 G0 未通过，集成开发仍锁定。** 本检查点只证明访客交互/分叉/认领的一部分；完整交谈、认领后所有者管理、编辑保存、真实分屏和刷新回访尚无同一旅程证据。真实生成出现三条 502 及一条地点对象不完整的 200；自建单空间和原世界补建均未成功保存。阶段二真实验收仍由另一个 session 负责，亦未纳入本提交。

下一次完整验收需在资源允许时，用真实多空间会话完成同一账号旅程的剩余步骤；修正生成地点绑定/通行失败后，以同一四条输入复验，并完成自建世界保存和原世界原 ID 补建保存。阶段二 session 提供其通过证据后，协调者再更新 G0 判定。

## G0 补充复核：Actions guest-claim slice

- GitHub Actions run [37561465283](https://github.com/kikoiio/Possibility/actions/runs/37561465283) 在 `phase3` commit `12393a8127ad830b066d5d400473bd8068cf17c8` 上完成，工作流与逐项结果见 [`phase1-g0-cloud-guest-claim.md`](phase1-g0-cloud-guest-claim.md)。
- 结果：`guest-claim-journey.spec.ts` **1 passed**；总 Playwright 用时 52.8 秒，测试主体 35.5 秒。使用 GitHub 托管 Ubuntu、隔离 Wrangler/D1、单 worker Chromium；未调用 provider 或读取 secrets。
- 此 run 仅重验访客进入/移动、分叉、注册认领和认领后状态可见；不覆盖交谈、所有者管理、编辑保存、真实分屏、刷新继续、真实生成、自建单空间保存或原世界补建保存。因此它加强的是同一子路径的复查证据，**不改变阶段一 G0 未通过结论**。
- 临时 runner/job 已随 Actions 完成并释放；专用 workflow 保留在 `phase3` 供复跑，触发器限定为 `phase3` 上该 workflow 文件自身的变更，证据文档提交不会再次触发。

## G0 补充复核：Actions 扩展旅程诊断

- Actions run [37564443630](https://github.com/kikoiio/Possibility/actions/runs/37564443630)，测试/工作流提交 `71976b8429addcd27e6e6cf136062c6dfb5263be`，旅程修订 4。新增 `/demo` 加载时仅针对明确 404 错误重载一次；这次 run 越过了先前 demo world/timeline 404，继续到注册认领步骤。
- 逐项结果及限制见 [`phase1-g0-cloud-expanded-journey.md`](phase1-g0-cloud-expanded-journey.md)；Actions 原始日志、Playwright trace 和截图在 artifact `phase1-g0-guest-claim-37564443630`（ID `11458467505`，12,268,835 bytes，保留 14 天）。
- 同一隔离旅程已断言访客进入、温室移动、固定 fixture 交谈、创建真实分叉并打开来源/新分支比较面板；注册成功后真实 claim 在克隆保存时失败，服务端日志为 `world_state_version_conflict`，页面停留于 `login?claimDemo=1`。因未进入已认领世界，所有者管理、编辑保存、真实分屏、刷新继续均未执行。
- provider 调用数为 0；对话来自仅在 `s02-e2e` 隔离环境启用的确定性 fixture，不等于真实模型生成验收。run 失败，不能以此证明 claim 或 G0 通过。
- runner/job 已完成并释放；保留的专用 workflow 仍只响应 `phase3` 上 workflow 文件自身的变更。失败 trace/log artifact 可复查；当前工作流未配置自动上传应用源码或 secrets。

## G0 补充复核：历史事实克隆回归夹具修正

- Actions run [37567552608](https://github.com/kikoiio/Possibility/actions/runs/37567552608) 在 API 回归阶段失败，未启动浏览器旅程。失败发生在测试构造第二条居民移动时：同一模拟时刻不允许居民移动到另一地点（HTTP 409），所以本次没有触及克隆触发器，不能用于判断克隆修复。
- 已将回归夹具改为 `move -> clock_advance(+60s) -> move`，并强化 source->clone 的逐字段断言以及迁移触发器证明；修正版本为后续独立提交，待 Actions 复跑。
- 此次失败不改变 G0 未通过结论；完整旅程和真实生成、自建单空间/原世界补建仍待验收。
- 后续 run [37567910009](https://github.com/kikoiio/Possibility/actions/runs/37567910009) 中，合法 `move -> clock_advance(+60s) -> move` 已通过，访客 subject remap 前置断言也通过；测试因产品当前没有通过 command 生成 `supersedes_id` 的路径，在覆盖前置断言处失败，尚未进入 claim。检索确认 world facts 有不可变 UPDATE trigger；下个回归将在隔离测试库中创建代表历史更正的 source command+fact，通过现有普通 insert triggers 校验 command/timeline/version/time/value/subject/type/visibility/supersedes 后再执行真实 clone/claim。
- run [37568241090](https://github.com/kikoiio/Possibility/actions/runs/37568241090) 中，普通 insert triggers 接受了 source correction command/fact，claim 和 clone 也成功到达后续断言；失败是测试把 fork snapshot format `version`（实际为 1）误当 source state version（payload 中为 3）。clone 字段逐项断言尚未执行，browser slice 被前置 API failure 跳过。修正期望后重跑。
- run [37568362759](https://github.com/kikoiio/Possibility/actions/runs/37568362759) 已通过 claim、克隆行数/source fact marker 和逐条克隆字段断言，包括非空 supersedes 重映射、subject remap、version/time/type/value/visibility 与 clone source command 关联；失败仅是新 source history 将主线投影从大厅推进到温室后，尾部旧 location 期望未更新。browser slice 因 API suite failure 被跳过；修正主线期望后重跑。
