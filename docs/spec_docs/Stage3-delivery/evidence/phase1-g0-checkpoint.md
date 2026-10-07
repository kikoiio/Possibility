# 阶段一 G0 真实旅程验收检查点

日期：2026-10-07（Asia/Shanghai）

验收分支：`phase3`

验收提交基线：`8bdc79fc11465a7e8837a89f717e03ab7c937c56`
应用源码基线：`07dcdb40e9cfec19524bded888faee6498f2cea1`（与验收 worktree 的 `api/`、`web/` 树逐文件一致）

## 逐项结果

| 门槛项 | 结果 | 实测与限制 |
|---|---|---|
| 真实多空间访客进入与交互 | **部分通过** | run `37570453870` 的同一 Playwright 旅程通过访客 `/demo`、温室移动、确定性 fixture 交谈、创建真实分支、认领、管理、编辑、分屏刷新后继续对话。run `37571095445` 补上 Guest bootstrap/resume 路由边界、匿名 public read-only 和能力策略 API 检查；run `37571774129` 再通过 guest/public-read API slices 与浏览器旅程。对话不是外部模型生成。详见 [`phase1-guest-claim.log`](phase1-guest-claim.log)。 |
| 访客认领与进度保留 | **通过（本旅程）** | run `37570453870` 注册新账户并通过真实 claim；在所有者世界确认两条时间线、访客在场、对话记录和编辑修订跨刷新保留；API clone regression 同时通过完整 source→clone 字段映射。范围限该隔离多空间 world 与桌面 Chromium。 |
| 所有者管理 | **部分通过** | 本旅程经 UI 执行暂停与继续，并断言按钮状态返回。世界归档、时间线管理、管理设置和失败/权限边界未核验。 |
| 编辑与持久化 | **通过（本旅程）** | 所有者通过真实多空间场景编辑移除未绑定装饰资产，等待 `POST /scene/voxel-revision` 成功；刷新后同一 placement ID 仍不存在。其他编辑类型及冲突/失败恢复未核验。 |
| 分屏比较与刷新继续 | **通过（限 3D/3D smoke）** | 同一已认领 world 的两条时间线真实分屏分别挂载两个视口；刷新仍恢复左右标题与两个画布，切回“在场”后访客地点状态和对话仍在。未覆盖 2D/2D、混合表现、跨世界、相机/权限隔离、资源释放矩阵。 |
| 三个自写描述与官方示例的真实生成 | **未通过** | 四条真实 API 生成共计 17 次 provider 请求。custom-1 API 返回 200，但 8 个地点仅对应 3 个场景对象，不能判为成功；custom-2、custom-3、官方示例均返回 502 内容校验错误。完整输入、返回、问题码和调用数见 [`phase1-generation-results.json`](phase1-generation-results.json)。 |
| 自建单空间与原世界补建对照 | **未通过** | 再次用官方示例走自建生成，5 次 provider 请求后仍 502，未进入 `POST /api/worlds`，没有生成自建单空间。隔离 D1 中创建的无场景原世界保留 1 位居民、1 条时间线；`repair-context` 为 200，但真实 `repair-draft` 4 次 provider 请求后以 walk-connectivity / walk-gap 返回 502，场景修订仍为 0。原 worldId 未变化，但没有成功补建保存。run `37571774129` 的静态合法文档 API 持久化和 route-stub UI smoke 通过，但不替代真实生成后保存门槛。 |

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

**阶段一 G0 仍 blocked，集成开发仍锁定。** Actions 已通过 guest/public-read API、guest fork/claim browser 旅程、静态合法文档创建/补建 API 持久化契约，以及 route-stub 的创建/补建 UI 流程。阶段一仍欠真实 provider 对三条自写提示和官方示例的有效生成、生成后自建单空间保存、以及原 `worldId` 的真实 repair 生成后保存。已有真实调用是一条 200 但地点对象不完整、三条生成 502；自建保存和原世界补建保存均未成功。阶段二仍欠部署环境中的 progression / pause / resume 验收（Phase 2 checkpoint: [`phase2-acceptance-2026-10-07.md`](phase2-acceptance-2026-10-07.md)）；其他 session 负责，未纳入本提交。

若继续真实生成验收，应先由协调者审阅调用计划、provider/model 计价及失败重试上限，再复验三条自写提示与官方示例，并把至少一个有效生成结果用于单空间创建保存；随后对隔离的既有原 `worldId` 做真实 repair 生成和保存。阶段二 session 提供其通过证据后，协调者再综合更新 G0 判定。

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
- run [37568473326](https://github.com/kikoiio/Possibility/actions/runs/37568473326) 的 API regression 整体通过；browser 旅程通过 guest dialogue/fork/claim 与 owner pause/resume，进入编辑步骤时测试脚本 `page.evaluate` 回调引用了浏览器作用域不存在的 `candidate`（参数名为 `at`），报 ReferenceError。编辑保存、真实 split 和 reload 尚未执行。已修正为引用回调参数，待 Actions 复跑。
- run [37568706180](https://github.com/kikoiio/Possibility/actions/runs/37568706180) 的 API regression 再次通过；修正 `page.evaluate` 后 browser 继续到分屏入口，但连续点击 4 分钟因 GuestWorldMap 的体验位置 nav `sm:top-4` 覆盖顶栏“对照宇宙”而超时，trace/error context 与截图已复查。已把该 nav 下移到顶栏/时间线说明带下方，待云端重跑；尚未证明分屏或 reload。

## G0 补充复核：多空间分屏路由修复

- 最新 run [37569334903](https://github.com/kikoiio/Possibility/actions/runs/37569334903) 的 API regression 通过。浏览器通过认领、所有者暂停/继续及场景编辑保存；导航遮挡已消失，刷新后保存的移除编辑仍存在。随后重进地点时，可能性抽屉拦截“进入此地点”。轨迹显示分屏入口没有产生 `split-view`：多空间页面早退到 `GuestWorldMap`，未挂载既有双视口分屏组件。
- 已将既有 `SplitViewStage` 接入多空间页面，使用所选空间的场景文档、两条真实时间线快照、各自 overlay/事件及现有比较数据；比较面板分屏导航会关闭面板。分屏保留在 URL 状态；通过旅程在分屏打开时刷新并断言两个画布和左右标题均恢复。
- 刷新后测试通过“体验位置 → 在场”正常收起可能性抽屉，再验证地点居民和对话；没有 force-click。具体成功 run 见下方。API clone regression 代码和非空 supersedes/source-command 映射断言未改动；provider 调用为 0。此项仍不改变阶段一 G0 未通过判定。

## G0 补充复核：Actions 多空间完整访客旅程

- **通过证据**：GitHub Actions [run 37570453870](https://github.com/kikoiio/Possibility/actions/runs/37570453870)，验收分支 `phase3`，commit `1b96beca8cf2a62586f09884b356debffb62ddf1`，workflow `journey_revision=14`。结果：API `src/test/s03-guest-participation.test.ts` 为 **1 file / 4 tests passed**；Playwright `guest-claim-journey.spec.ts` 为 **1 passed**。云端 job 2m43s，外部 provider 调用 0。
- **逐步观察**：访客进入真实多空间 demo、温室移动、确定性交谈、创建分叉、注册/claim；认领后暂停/继续；编辑器经服务端 revision 保存装饰资产移除；打开来源/分支真实 3D/3D 分屏；刷新后仍有两个分屏画布和左右标题；退出分屏后温室居民/对话记录仍可见。没有 force-click。
- **artifact/日志**：Actions job `112627651680`；artifact `phase1-g0-guest-claim-37570453870`，ID `11459909535`，1,412 bytes，未过期；完整命令与 runner 输出可从 run 页面复查。成功 run 不生成失败 trace/screenshot。
- **限制**：此旅程中的对话使用隔离环境确定性 fixture；owner 管理只测暂停/继续；编辑只测一类删除；split 只测同 world 两 timeline、3D/3D、桌面 1280×720 和此旅程中的 refresh continuation。真实生成及自建/原 world 补建保存仍失败，故 G0 仍未通过。

## 非 provider 补充 API 验收

- Actions [run 37571095445](https://github.com/kikoiio/Possibility/actions/runs/37571095445)，commit `96e6e8d7a1f0e77f52dbc5f7537859204f1a44db`，workflow revision 15，job `112629670488`：4 个 API 测试文件共 **10/10 tests passed**；同一浏览器旅程 **1/1 passed**；总 job 3m37s。文件为 `s03-guest-participation.test.ts`、`map/bootstrap.test.ts`、`public/routes.test.ts`、`access/policy.test.ts`。
- Guest `/map/bootstrap` 和 `/map/resume` route test 验证当前 sandbox 可读、有效 timeline/space/mode 可保存并恢复、跨 world bootstrap/resume 被拒；匿名 demo snapshot/scene 只读、public 写入被拒；owner/guest capabilities 测试通过。provider calls 0。
- Artifact `phase1-g0-guest-claim-37571095445`（ID `11460489345`，1,519 bytes，未过期）；完整逐步日志可从 run 页面复查。此 run 重跑了 guest fork/claim/owner/edit/split/reload 浏览器旅程，结果维持通过。
- `access-audit.md` 中 Guest bootstrap route 专项状态更新为已核验。账户型 readonly 未发现独立产品身份/授权契约，不虚构接口或功能，继续标未核验。

## 独立非 provider 创建/补建契约 smoke（已通过，范围有限）

GitHub Actions run [37571774129](https://github.com/kikoiio/Possibility/actions/runs/37571774129)，`phase3` commit `548de701fdfbb0f53ab0bbbd809647e2983ad090`，job `112631785249`，workflow revision 16，2026-10-07 04:30:23–04:34:41 UTC，结论 **success**。

- API：6 files / **33 tests passed**，包括 `s03-guest-participation.test.ts`、`map/bootstrap.test.ts`、`public/routes.test.ts`、`access/policy.test.ts`、`worlds/create-voxel.test.ts`、`scenes/routes.test.ts`。其中 create/repair API 使用固定合法 voxel 文档验证保存契约。
- Browser：**10/10 passed**（3 E2E files，1 worker）：`guest-claim-journey.spec.ts`（guest fork/claim journey 通过）、`scene-create.spec.ts`、`scene-repair.spec.ts`。后两者使用 route fixtures 提供 draft API 响应。
- Artifact `phase1-g0-guest-claim-37571774129`（ID `11460956808`，2,887 bytes，未过期）；provider calls **0**。测试结果与日志可从 Actions run 和 artifact 复查。
- 此 run 的 UI/API 子契约通过不证明真实模型生成或生成后保存成功，不改变 G0 blocked 判定。

## 下一阶段解锁缺口

- **阶段一未通过**：真实 provider 下的 3 条自写 prompt + 官方示例有效生成；将有效生成结果保存为自建单空间；对既有原 `worldId` 完成真实 repair 生成与保存。
- **阶段二未通过/待另一 session**：部署环境 progression、pause、resume 验收；现有证据只覆盖 Actions 上 local Worker/D1 production preview，未触达已部署 world。详见 Phase 2 checkpoint。
- **本轮没有发起 provider 请求，也没有启动新 Actions run。**
