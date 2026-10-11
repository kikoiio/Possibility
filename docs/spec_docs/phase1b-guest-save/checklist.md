# 阶段 1B：访客保存和恢复 Checklist

> 状态：Spec、Plan、Task、Checklist 已批准；实现已完成。定向 API/Web、迁移回归和证据工具已有实际通过记录；全量云端汇合与三视口旅程按 T39/T40 实际结果登记，未取得证据的条目保持未勾选。

## 验证与证据规则

- 每项以实际行为、响应、数据库读回或命令结果判定，记录通过、失败、未验证及原因；没有证据保持未勾选。静态检查、测试发现列表和旧版本截图不能替代实际执行。
- 定向单元测试按 Task 资源预算单 worker 执行；真实 SQLite/D1 证明数据库门禁和事务回滚，不能仅用返回预设结果的数据库替身证明。认证与认领页面旅程使用隔离真实 API/D1，模型使用确定性替身；网络、时钟与失败注入范围明确标注。
- 下列全量测试、构建、依赖安装和所有浏览器运行统一安排 T39，经明确告知并取得具体免费 GitHub Actions、代码上传、分支及权限许可后执行。未授权时只准备，不在本机以资源充足为由执行重型验证。
- 真实服务的结果写入须经只读查询核实；页面进入世界、认证返回成功或发起 workflow 均不单独证明保存成功。关键证据关联本次 SHA、原副本、目标账号、保存操作及结果，标识使用脱敏别名。
- 不上传密码、会话凭证、认证请求原文、headers、localStorage、原始 trace、视频或测试数据库。关闭自动失败截图，受控截图清空认证输入或只采集安全页面。

## 验证命令约定

在仓库根目录执行。`API(文件,用例)`、`WEB(文件,用例)` 表示将条目列出的相对路径和测试名称代入以下命令；零匹配、跳过或只发现测试均不算通过。

```sh
npm --workspace api test -- --maxWorkers=1 --no-file-parallelism <文件> -t '<用例>'
npm --workspace web test -- --maxWorkers=1 --no-file-parallelism <文件> -t '<用例>'
```

`E2E(AC标签)` 表示在获授权的云端执行以下命令并检查相应旅程的页面行为、真实响应和数据库读回。三个视口项目都须有执行结果。

```sh
npm --workspace web run test:e2e -- --config playwright.guest-claim.config.ts --workers=1 --grep '<AC标签>'
```

60 秒前端边界使用可控浏览器/单测时钟；120 秒服务端执行期限使用受控服务时间或隔离数据库期限设置。分别验证两种时间语义，不能以推进浏览器时钟假装服务端期限已过。

## 功能与恢复行为

- [ ] **AC1.1 正确登录自动保存原副本。** 未登录访客选择“登录并保存”，正确登录后无需再点击保存即进入目标账号结果；读回来源与原副本一致。（验证：`WEB(src/guest/claim-flow.test.ts,authentication entry)`、`API(src/demo/session-service.test.ts,coordinated claim)`、`E2E(AC1)` 的独立 login 旅程。）
- [ ] **AC1.2 成功注册自动保存原副本。** 独立新账号旅程注册后自动保存，结果归属新账号，未新建访客副本。（验证：同上及 `E2E(AC1)` 的独立 register 旅程；不得复用正确登录的结果当注册证据。）
- [ ] **AC2.1 认证失败保持同一保存上下文。** 错误密码、非法注册、用户名冲突及认证网络失败期间均无认领写入；原副本凭证、意图和请求标识保持。（验证：`WEB(src/api/client.test.ts,explicit claim identity)`、`WEB(src/guest/claim-flow.test.ts,authentication entry)`、`E2E(AC2)`，核对请求次数与来源别名，不采集凭证原文。）
- [ ] **AC2.2 修正后仍保存原副本。** 上述失败修正后保存成功；错误密码后登录和注册认领分别提供独立真实页面证据。（验证：`E2E(AC2)`，读回来源、目标、唯一结果及原有进度。）
- [ ] **AC3.1 导航与刷新保留意图。** 切换登录/注册、刷新认证页、返回原副本再进入保存，来源与已有请求标识保持一致；恢复页刷新不保存、不创建替代副本。（验证：`WEB(src/guest/claim-store.test.ts,persistent intent)`、`WEB(src/guest/claim-flow.test.ts,authentication entry)`、`E2E(AC3)` 的请求计数和来源读回。）
- [ ] **AC3.2 普通登录不认领。** 用户未选择保存时，普通登录正常导航，认领调用及保存结果新增数量均为零。（验证：`WEB(src/guest/claim-flow.test.ts,authentication entry)`、`E2E(AC3)` 的 ordinary-login 旅程。）
- [ ] **AC4.1 失败可返回同一访客副本。** 临时保存失败后显示重试和返回入口；账号已登录时，返回及刷新仍以访客身份读取同一原副本。暂时读取故障只提示重试，不创建替代副本。（验证：`WEB(src/api/client.test.ts,explicit claim identity)`、`WEB(src/guest/claim-flow.test.ts,safe manual recovery)`、`E2E(AC4)`。）
- [ ] **AC4.2 新增进度进入重试结果。** 返回后完成有效地点进度、时间线分支与持久化交互，再由用户重试；目标世界同时读到新旧进度。（验证：`API(src/demo/clone-verification.test.ts,claim staging clone)`、`E2E(AC4)`，记录保存前后进度摘要及最终归属。）
- [ ] **AC5.1 已登录及切换账号均确认目标。** 已登录进入流程显示当前账号，点击“保存到此账号”前零认领；安全切换后显示新目标，确认前不向新账号保存。（验证：`WEB(src/guest/claim-flow.test.ts,authentication entry)`、`WEB(src/guest/claim-flow.test.ts,safe manual recovery)`、`E2E(AC5)`。）
- [ ] **AC5.2 未确认结果先核实原账号。** 旧结果成功则恢复原结果；仍执行或无法核实时保留原上下文和核实入口，不向新账号保存。只有旧执行权已持久封闭且仍可认领时才允许切换。（验证：`API(src/demo/claim-repository.test.ts,manual recovery)`、`WEB(src/guest/claim-flow.test.ts,safe manual recovery)`、`E2E(AC5)`，含 GET 无槽后仍需主动封闭的场景。）
- [ ] **AC6.1 重复与并发只形成一个结果。** 重复点击、并发请求、刷新后的用户重试及成功重放均只形成一份最终世界，返回同一结果；保存中按钮阻止重复点击。（验证：`API(src/demo/claim-repository.test.ts,acquisition)`、`API(src/demo/claim-publication.test.ts,atomic publication)`、`E2E(AC6)`，按同一原副本查询最终保存数量为 1。）
- [ ] **AC6.2 他账号冲突不泄露或暴露半成品。** 另一账号争抢或认领已保存副本时无第二结果，响应不含获胜账号结果/进度；候选阶段双方均不能通过世界、人物、会话和访问接口访问半成品。（验证：`API(src/demo/claim-status.test.ts,read-only claim status)`、`API(src/demo/session-service.test.ts,coordinated claim)`、`E2E(AC6)`，包含真实权限接口拒绝和结果数量读回。）
- [ ] **AC7.1 已成功但丢响应可恢复。** 真实服务提交成功后丢弃响应，界面先显示结果未确认；刷新只 GET，核实后进入同一保存结果，数量仍为 1。（验证：`WEB(src/guest/claim-flow.test.ts,save wait boundary)`、`E2E(AC7)`，以真实提交后网络注入及只读结果证明。）
- [ ] **AC7.2 60 秒结束前端等待。** 59 秒仍保存中，60 秒解除忙碌并显示“结果未确认”和恢复入口，不声称服务已取消；迟到响应不清理新上下文。（验证：`WEB(src/guest/claim-flow.test.ts,save wait boundary)`、`E2E(AC7)` 的可控时钟旅程。）
- [ ] **AC7.3 未完成操作仅手动恢复和重试。** 刷新只读、期限内不能撤销仍有效执行；用户主动恢复封闭过期执行后不自动保存，只有用户再点击才取得新执行权。（验证：`API(src/demo/claim-repository.test.ts,manual recovery)`、`WEB(src/guest/claim-flow.test.ts,safe manual recovery)`、`E2E(AC7)`，分别检查恢复和保存请求次数。）
- [ ] **AC8 不可恢复时主动新体验。** 缺凭证及确认过期不可恢复分别说明原进度无法恢复；点击前创建数量为零，点击后明确新体验。暂时读取失败不显示为原进度已失效。（验证：`E2E(AC8)`，检查可见文案、用户事件、创建次数及新旧来源区别。）
- [ ] **AC9.1 只清理匹配的确认成功上下文。** 认证成功、保存失败、未确认期间凭证和意图仍在；成功收据持久后才清理匹配上下文，中断可恢复，旧响应不能清除新副本/新操作。（验证：`WEB(src/guest/claim-store.test.ts,confirmed receipt cleanup)`、`WEB(src/guest/claim-flow.test.ts,save wait boundary)`、`E2E(AC9)`。）
- [ ] **AC9.2 保存后刷新读回完整进度。** 最终世界归属目标账号，重新进入和刷新后地点、分支、持久化交互均与认领时相符；界面区分认证成功和世界保存成功。（验证：`API(src/demo/clone-verification.test.ts,claim ownership verification)`、`E2E(AC9)`，核对目标归属及新旧进度摘要。）
- [ ] **AC10.1 账号失效不清除访客凭证。** 账号会话失效后显示重新认证入口，原副本与保存意图保持；认证、访客读取、认领分别使用规定身份。（验证：`WEB(src/api/client.test.ts,explicit claim identity)`、`API(src/demo/routes.test.ts,status and recover HTTP)`、`E2E(AC10)`。）
- [ ] **AC10.2 未授权请求拒绝且不写入。** 缺少或伪造账号/访客权限的查询、保存与主动恢复均被拒绝，不创建保存结果或阻断记录，不泄露其他账号结果。（验证：`API(src/demo/routes.test.ts,status and recover HTTP)`、`API(src/demo/routes.test.ts,claim HTTP compatibility)`、`E2E(AC10)`，对比前后隔离数据库数量。）
- [ ] **AC11 存储异常显示实际限制。** 持久化不可用、quota/security 异常及上下文损坏分别显示限制；保存前写上下文失败则不发送保存，不误报成功，不替换原副本。（验证：`WEB(src/guest/claim-store.test.ts,persistent intent)`、`WEB(src/guest/claim-store.test.ts,confirmed receipt cleanup)`、`E2E(AC11)`。）
- [ ] **AC12 三视口关键操作可达。** 桌面、485×724、390×844 完成登录/注册、目标确认、失败重试、返回原副本与不可恢复后的主动新体验；说明不裁切，可滚动到恢复入口，键盘焦点、鼠标和触摸均有效。（验证：`WEB(src/components/guest/GuestClaimStatusPanel.test.tsx,claim status actions)`、`E2E(AC12)`；每个视口记录实际操作，触摸使用真实触摸配置或明确标注触摸模拟。）
- [ ] **AC13.1 既有接口与生命周期保持。** 普通登录/注册、合法访客读取和既有认领旅程通过；旧首次 claim 请求兼容，旧请求不得绕过失败后的新版本门禁。（验证：`API(src/demo/routes.test.ts,claim HTTP compatibility)`、`API(src/test/s03-guest-participation.test.ts,phase1b lifecycle)`、`E2E(AC13)` 及调整后的旧旅程。）
- [ ] **AC13.2 有效期与只读语义保持。** 普通副本到期按原规则处理，进入待认领状态仍可按原规则重试；仅点击保存入口不延长期限。GET 不续期、不恢复/创建世界、不写事实，也不关闭执行权。（验证：`API(src/demo/claim-status.test.ts,read-only claim status)`、`API(src/test/s03-guest-participation.test.ts,phase1b lifecycle)`、`E2E(AC13)`，读取前后对比时间字段、事实和世界数量。）
- [ ] **AC14.1 当前版本证据完整。** 每条关键行为有当前版本定向验证及真实页面旅程证据；记录响应状态、写入是否确认、唯一结果数量、最终读回及替身/故障注入范围。（验证：下方 E1～E6 旅程、R1～R3 证据检查与 finalizer；上一阶段的页面可见性结果不得填入。）
- [ ] **AC14.2 实际验证与清理如实记录。** 全量回归、构建和浏览器分别有实际通过/失败/未验证记录；云端执行已获具体许可，结束确认本任务服务及子进程退出、临时资源清理，保留其他任务资源。（验证：B1～B5、R4～R5；未执行或清理不明保持未勾选。）

## 集成与并发门禁

- [ ] **I1 原副本改变后迟到请求被拒绝。** 保存意图建立后重置副本或改变 generation，再放行旧 GET、POST、recover，只得到来源变更说明；新副本无保存结果、无阻断槽。取得执行权后来源改变也不能发布。（验证：`API(src/demo/claim-repository.test.ts,acquisition)`、`API(src/demo/claim-repository.test.ts,manual recovery)`、`API(src/db/guest-claim-migration.test.ts,publication fence)`、`E2E(AC3|AC7)` 的 delayed-source-change 旅程。）
- [ ] **I2 无槽不代表旧请求不会到达。** 将旧 POST 阻塞在数据库前，GET 返回未开始且不允许切换；用户主动恢复建立阻断版本后放行旧 POST，旧请求不能取得执行权。（验证：`API(src/demo/claim-repository.test.ts,manual recovery)`、`E2E(AC5|AC7)`，旧请求写入为零，后续用户新版本重试合法。）
- [ ] **I3 失权候选 INSERT 整批拒绝。** 过期、已封闭、错误归属/候选 ID、无操作槽或旧执行的克隆不能创建部分图；合法暂存可创建，普通克隆仍可用。（验证：`API(src/db/guest-claim-migration.test.ts,candidate insert fence)`，真实数据库回滚后候选及子表新增为零。）
- [ ] **I4 发布原子一致。** 合法发布同时转移世界、人物、会话、访问归属并确认 session/sandbox/操作结果；中途故障或旧执行发布使整个批次回滚，不留下局部转移。（验证：`API(src/db/guest-claim-migration.test.ts,publication fence)`、`API(src/demo/claim-publication.test.ts,atomic publication)`，实际读回四组 owner 与成功指针。）
- [ ] **I5 120 秒期限及旧版本封闭生效。** 前端 60 秒超时不直接释放服务端执行权；服务端期限内保持运行，期限后也须用户恢复。失败或恢复推进版本，旧 POST、close、publish 均不能影响新版或成功结果。（验证：`API(src/demo/claim-repository.test.ts,closure)`、`API(src/demo/claim-repository.test.ts,manual recovery)`、`API(src/db/guest-claim-migration.test.ts,publication fence)`。）
- [ ] **I6 候选不能被引擎推进。** 未核验候选固定暂停，若状态维护误改为 running 也不推进时间、不写事实、模型调用为零；正常世界与发布后世界按原规则运行。（验证：`API(src/engine/tick.test.ts,claim staging exclusion)`，对比事实、时间与模型调用计数。）
- [ ] **I7 迟到清理不破坏结果。** 旧执行清理不能删除新执行候选或原副本；已发布结果的世界及所有子表删除均为零，不因清理错误撤销成功。注入一次清理失败后，遗留候选仍不可访问、不可运行，用户主动恢复重试清理也不影响已保存结果。（验证：`API(src/demo/claim-publication.test.ts,candidate cleanup)`、`API(src/demo/claim-publication.test.ts,atomic publication)`、`API(src/demo/session-service.test.ts,recovery and failure classification)`，逐表数量和进度读回保持。）
- [ ] **I8 核验与历史证明保持。** 暂存核验检查完整图，发布后核对最终目标；不可变场景克隆证明不被转归属重写，地点/时间线/事件/指令/事实及现有场景内容保持。（验证：`API(src/demo/clone-verification.test.ts,claim ownership verification)`，比较克隆前后进度摘要与历史证明。）
- [ ] **I9 挂载、卸载及乱序响应安全。** 页面挂载/严格模式重挂只读不保存，卸载无遗留订阅/计时器；旧异步结果不覆盖当前来源、账号或操作，不误清理。（验证：`WEB(src/components/guest/GuestClaimStatusPanel.test.tsx,flow subscription)`、`WEB(src/guest/claim-flow.test.ts,save wait boundary)`，请求与订阅计数、上下文读回正确。）
- [ ] **I10 HTTP 状态与不确定错误一致。** 200 为确认成功/恢复结果，202 保持运行，版本冲突需重查；网络丢失、普通 500 或封闭失败均不能冒充已确定未保存。GET 禁止缓存，明确失败必须有持久封闭依据。（验证：`API(src/demo/routes.test.ts,status and recover HTTP)`、`API(src/demo/routes.test.ts,claim HTTP compatibility)`、`API(src/demo/session-service.test.ts,recovery and failure classification)`，核对响应语义及数据库状态。）

## 编译、回归与工具检查

- [ ] **B1 API 完整回归通过。**（验证：获授权云端执行 `npm --workspace api test -- --maxWorkers=1 --no-file-parallelism`，检查真实退出码和用例数量；非本轮问题单独记录，不将失败标为通过。）
- [ ] **B2 Web 完整单元回归通过。**（验证：获授权云端执行 `npm --workspace web test -- --maxWorkers=1 --no-file-parallelism`，全部实际通过，不能以定向测试替代完整回归。）
- [ ] **B3 API 与 Web 构建通过。**（验证：获授权云端顺序执行 `npm --workspace api run build`、`npm --workspace web run build`，分别记录退出码；相关 contract 如受影响，追加对应 workspace 测试/构建并记录实际结果。）
- [ ] **B4 浏览器矩阵及旧旅程通过。**（验证：获授权云端执行 `npm --workspace web run test:e2e -- --config playwright.guest-claim.config.ts --workers=1`，三个视口、本轮与调整后的两组旧认领旅程均实际执行；跳过和零匹配为未验证。）
- [ ] **B5 格式、工作流与证据工具检查通过。**（验证：`git diff --check`，以及 `npm exec -- tsx web/scripts/phase1b-guest-save.acceptance.ts --validate-manifest`、`node --test scripts/finalize-phase1b-guest-save-acceptance.test.mjs`；工作流有可用 actionlint 则定向执行，没有则在获授权云端验证。仓库没有 lint 脚本，不声称 lint 已通过；检查本轮新增未跟踪文件的格式，不把无 diff 误当新增文件已检查。）

## 完整页面旅程

每组均从真实 UI 入口走到真实 API、隔离数据库及最终页面/数据读回，只有网络与模型等已声明环节使用替身或注入。E1、E2、E3 为独立账号和原副本，分别采集证据。

- [ ] **E1 访客正确登录保存。** 建立地点/分支/交互进度 → 登录并保存 → 正确登录 → 自动保存 → 目标世界 → 刷新读回相同进度、唯一结果。（验证：`E2E(AC1|AC9)` 的 independent-login 旅程，保存来源、目标和读回关联完整。）
- [ ] **E2 错误密码后继续保存。** 原副本 → 登录并保存 → 错误密码 → 保留意图、零认领 → 修正密码 → 自动保存同一副本 → 刷新读回。（验证：`E2E(AC2|AC9)` 的 wrong-password 旅程，失败与成功阶段分别有计数证据。）
- [ ] **E3 注册认领。** 原副本 → 登录并保存 → 注册 → 用户名冲突/非法输入后修正 → 新账号成功注册 → 自动保存原副本 → 刷新读回。（验证：`E2E(AC1|AC2|AC9)` 的 independent-register 旅程，与登录证据分开。）
- [ ] **E4 保存失败返回再保存。** 正确认证 → 注入临时保存失败 → 返回并刷新原副本 → 新增有效进度 → 用户重试 → 保存结果含新旧进度。（验证：`E2E(AC4|AC9)`，真实原副本恢复及第二次克隆/最终读回证据。）
- [ ] **E5 丢响应核实与安全切换。** 分别覆盖真实提交成功丢响应，以及旧请求未到数据库/未完成 → 刷新只读 → 用户核实/恢复 → 成功恢复原结果或封闭后切换目标并确认 → 唯一最终结果。（验证：`E2E(AC5|AC6|AC7)`，不把裸 500 当确定未保存，含迟到请求放行和结果数量。）
- [ ] **E6 不可恢复与存储限制。** 分别模拟凭证缺失、确认过期、临时读取故障、存储不可用/损坏 → 显示对应原因 → 暂时故障保留恢复，确实不可用时用户主动新体验；三视口检查入口。（验证：`E2E(AC8|AC11|AC12|AC13)`，主动点击前无新副本，限制状态无误保存。）

## 证据、授权与资源清理

- [ ] **R1 证据关联当前运行。** SHA、run、AC 标签、原副本/目标/操作脱敏别名、结果数量及最终读回能相互关联；缺失、历史版本、重复结果或只有页面截图时拒绝通过。（验证：`node --test scripts/finalize-phase1b-guest-save-acceptance.test.mjs`；在批准产物目录下执行 `PHASE1B_EVIDENCE_DIR=<本次脱敏产物目录> node scripts/finalize-phase1b-guest-save-acceptance.mjs`。）
- [ ] **R2 产物脱敏与截图受控。** 记录器只输出白名单，无密码/token/headers/原始请求/trace/视频/数据库；截图不包含认证输入和凭证。注入含凭证 fixture 时拒绝发布证据。（验证：finalizer 安全用例、实际产物扫描和截图观察，失败产物也检查；只上传批准白名单。）
- [ ] **R3 替身与缺失如实说明。** 明确列出确定性模型、网络和时钟注入；认证/认领真实服务证据齐全，未完成/失败检查有原因，不使用上一阶段结果或测试列表填充通过。（验证：核对 E1～E6、单测输出、AC 矩阵与最终报告，缺证据时 finalizer 非零退出。）
- [ ] **R4 具体云端执行已获授权并核实。** 先呈现具体 workflow、代码上传范围、分支/SHA、免费额度前提和 Actions 权限，获明确许可后才上传与 dispatch；不部署、不操作真实用户数据或真实模型。（验证：会话许可记录、`git ls-remote origin <授权分支>`、`gh run view <本次run-id> --json headSha,status,conclusion,jobs` 的只读二次确认；文档批准不能替代此许可。）
- [ ] **R5 临时资源清理确认。** 仅本任务的服务/子进程和临时数据库/目录按记录退出或清理，无生产资源、无他任务资源改动；缓存与大文件绕开本机 /tmp 配额。清理失败或未知不得通过。（验证：workflow always/trap 清理回执、本任务 PID/进程组与目录的只读核查、finalizer 清理校验；本机兜底若确有必要，附云端无法覆盖原因及内存/PSI、/tmp 与 GUI 前置证据。）

## 覆盖与记录方式

| Spec 验收标准 | 行为条目 | 补充集成／旅程／证据 |
| --- | --- | --- |
| AC1 | AC1.1、AC1.2 | E1、E3 |
| AC2 | AC2.1、AC2.2 | E2、E3 |
| AC3 | AC3.1、AC3.2 | I1、I9 |
| AC4 | AC4.1、AC4.2 | I8、E4 |
| AC5 | AC5.1、AC5.2 | I2、I5、E5 |
| AC6 | AC6.1、AC6.2 | I3～I7、E5 |
| AC7 | AC7.1～AC7.3 | I1、I2、I5、I9、I10、E5 |
| AC8 | AC8 | E6 |
| AC9 | AC9.1、AC9.2 | I4、I7～I9、E1～E4 |
| AC10 | AC10.1、AC10.2 | I10 |
| AC11 | AC11 | E6 |
| AC12 | AC12 | B4、E6 |
| AC13 | AC13.1、AC13.2 | I1、I8、I10、B4 |
| AC14 | AC14.1、AC14.2 | B1～B5、E1～E6、R1～R5 |

实施后每条记录实际命令/场景、版本及 run、实际结果、脱敏证据位置和原因；通过才勾选。失败保持未勾选，修复后只针对新改动或尚未解决的问题重验，并重新完成受影响的汇合检查。未获云端许可或未运行的条目明确记为未验证，不以文档静态自检替代验收。

## 当前验收记录

- 定向 API/Web contracts、migration/s03 回归、证据 tooling：本机已通过；对应命令均使用单 worker。`git diff --check` 已通过。
- 云端 run `38126276143`：focused 与 API/Web regression 通过，build/finalizer 失败；原因见 task T39/T40 记录。
- 云端 run `38126869047`：focused 与 API/Web regression 通过，build/finalizer 失败；修复点已提交到 `235b0c1`。
- 云端 run `38127264634`：以 `235b0c1b7a1b4b3d9dc9f1bb3dfab4a2ab3a16a9` 执行，结果待完成。browser evidence manifest 已接入 workflow；所有未完成旅程必须保持 `unverified`，finalizer 输出 `partial`。
- 云端 run `38130964273`（`da4c78f`）：focused、回归、build 通过；browser 21/24，AC1 三视口失败，finalizer `partial`。
- 云端 run `38132958216`（`a926876`）：focused、回归、build 通过；browser 仍 21/24，AC1 三视口失败，finalizer `partial`，清理通过。失败页面未产生可关联的保存状态证据。
- AC1～AC14 不因静态代码、页面可见性或 workflow dispatch 自动勾选；需等待本轮脱敏 evidence manifest 与 finalizer 报告后逐项登记。
