# 阶段三基线与工作区隔离（T01）

核验日期：2026-10-07（Asia/Shanghai）

## phase3 基线与 Orca worktree

- `phase3` 管理 worktree：分支 `refs/heads/phase3`，HEAD `ab0911f63da075186479cb506797412a05a75fb9`，核验时工作区干净。
- 本任务子 worktree：分支 `p3-t01-baseline`，与 `phase3` 指向同一 HEAD；核验开始时工作区干净。Orca worktree ID：`eedae095-bad7-4090-8c0f-ce0eb11ac91c::/home/neo/orca/workspaces/Possibility/p3-t01-baseline`。
- `phase3` Orca worktree ID：`eedae095-bad7-4090-8c0f-ce0eb11ac91c::/home/neo/orca/workspaces/Possibility/phase3`。
- 本记录自身是本次唯一新增文件；它将作为独立提交留在 T01 子 worktree，待协调者检查后集成。

## main 隔离状态

- main worktree `/home/neo/Projects/Possibility` 当前分支为 `main`（`main...origin/main`）；核验时存在已修改文件及未跟踪文件。
- 按 T01 限制，只查询了 main 的分支与 Git 状态；没有读取、复制、比较或改写其未提交文件内容。本任务没有在 main worktree 写入内容。

## DEVELOPMENT_ARRANGEMENT.md 来源与阶段 gate

- 来源记录：已提交的 [`spec.md`](../spec.md) 说明规格编制参考了本机 main worktree 中 2026-10-05 版本的 `docs/DEVELOPMENT_ARRANGEMENT.md`，该版本声明代码基线为 `dbba8b6`。该 arrangement 文件在 main 路径存在，但不在本子 worktree 中；为遵守 main 未提交内容隔离，本次没有读取该文件，以上来源信息据已提交的 `spec.md` 记录，未独立核验 arrangement 内容或其声明基线。
- 本次使用 [`task.md`](../task.md) 的阶段 gate：按 arrangement 对照阶段一核心旅程，以及阶段二“事实/规则/画面/证据连续、离页后真实推进回访、2D 账户会话和声明的交互”；没有对应验收证据的条目标为未核验，不视为通过。T01 仅记录基线和可见证据路径，不执行 G0 判定。

## 当前可见的验收证据路径

- 阶段二原生 2D 样板证据索引：[`N2D1-interactive-sample/evidence/README.md`](../../N2D1-interactive-sample/evidence/README.md)，其中列出浏览器、构建、单测、真实公开只读 API、性能和视觉材料。
- 可见材料示例：`docs/spec_docs/N2D1-interactive-sample/evidence/native2d-browser.log`、`web-build.log`、`web-unit.log`、`real-public-identity.json`、`performance.json`、`production-entry.png`；具体完整列表见上述 README。该证据 README 将其采集归于集成 local main commit `2923d3d` 的验收分支，不能单独证明阶段二完整旅程已在当前 `phase3` 基线完成验收。
- 体验记录：[`EXPERIENCE_REPORT_2026-10-02.md`](../../../EXPERIENCE_REPORT_2026-10-02.md)；这是体验观察报告，不是阶段一/二完整旅程的验收结论。
- 在当前可见材料中，未找到覆盖阶段一、二全部出口的完整验收记录。尤其阶段二真实验收尚待完成（用户已明确指出）；不得把 N2D1 样板测试或体验报告推定为阶段二完整验收通过。整体前置 gate 在 G0 由协调者按批准任务核验。

## 未核验项

- 未读取 main 中的 `DEVELOPMENT_ARRANGEMENT.md`，因此未对其原文或 `dbba8b6` 声明作独立核验。
- 阶段一完整旅程及阶段二完整真实验收均未由本 T01 任务执行；阶段二真实验收仍待完成。相关 gate 当前不能据本记录标为通过。
- 未运行应用测试、浏览器验收或构建；本任务范围为只读基线盘点和新增本证据文件。

## G0：阶段一/二证据门槛结论（协调者）

核验日期：2026-10-07（Asia/Shanghai）

- 核验代码基线：`phase3` 应用代码仍基于 `ab0911f63da075186479cb506797412a05a75fb9`。本次汇入的四个 T01–T04 提交仅新增规格/证据文档，不包含阶段一/二应用代码或验收运行结果；当前 `phase3` HEAD 为 `3811cf6139950034a27db72829c7f33a645ace9e`。
- 阶段一完整旅程：**未核验**。当前 phase3 证据集中没有一份逐项证明“真实多空间访客 → 交谈/分叉 → 认领 → 所有者管理 → 编辑 → 分屏 → 刷新继续”的验收记录，也没有真实生成结果和自建单空间/原世界补建的完整对照。既有体验报告和 N2D1 样板证据可作为后续复查入口，不能代替该旅程的发布构建与真实 API 验收。
- 阶段二完整旅程：**未核验（阻塞）**。用户明确说明阶段二只剩真实验收；目前没有证据证明事实/规则/画面/证据连续、离页后真实推进并回访、2D 账户会话及声明交互已在真实 API 和发布构建中完成验收。T02 是源码路径审计，T03 是 renderer 静态审计，T04 矩阵中所有验收 case 均未执行；它们都不是阶段二通过证据。
- 主 worktree 状态：本次仅依照 T01 读取分支和 Git 状态元数据，未查看其未提交文件内容。主 worktree 上阶段二实现或测试相关的未提交状态不能作为 `phase3` 代码基线的已验收结果，也没有复制到 `phase3`。
- G0 判定：**未通过，集成派发阻塞**。当前没有阶段一完整旅程的正面证据，且阶段二真实验收尚待完成；缺证据按批准的 task.md 规则记未核验，不能推定通过。T05 及后续依赖集成任务保持未派发。
- 解锁条件：在 `phase3` 可复查的提交/证据中补齐阶段一完整旅程及阶段二完整真实验收（发布构建、真实 API、所声明交互和失败恢复），每项附版本、路径、实际结果及限制；协调者据证据重新执行 G0。届时只派发 G0 已证明通过的下游任务。

## G0 复核：阶段一检查点已提交，阶段二检查点待完成

复核日期：2026-10-07（Asia/Shanghai）

- 阶段一新证据：[`phase1-g0-checkpoint.md`](phase1-g0-checkpoint.md)，commit `1613b38906712dfa82331c826b105a9b9c832250`。该证据确认访客交互/分叉/认领仅部分通过；同一旅程缺少交谈、认领后管理、编辑持久化、真实分屏和刷新继续。
- 阶段一云端复核：新增 [`phase1-g0-cloud-guest-claim.md`](phase1-g0-cloud-guest-claim.md)，证据 commit `e1b22d874e20ed7ed6ca08b75556c0da13a8dca1`，workflow commit `12393a8127ad830b066d5d400473bd8068cf17c8`，GitHub Actions run `37561465283` 为 1/1 passed。它复验的是同一访客分叉/认领片段，不增加交谈、管理、编辑、分屏或刷新覆盖，不改变 G0 判定。
- 阶段一生成诊断：[`phase1-generation-diagnosis.md`](phase1-generation-diagnosis.md)，commit `bdbd5464d6d7fa9444511e45784c2dedcbf5925a`。它静态定位了通行性重试和地点承载物校验的候选缺口，没有新增实测，也没有确认单次失败根因或改变验收结果。
- 阶段一生成门槛：四条基线提示消耗 17 次 provider 调用，其中三条返回 502，另一条虽返回 200 但地点绑定 8 项、场景对象仅 3 个；单空间创建复测消耗 5 次后仍为 502，未保存世界。原世界补建消耗 4 次后返回 502，未保存场景。总计 26 次调用，低于既有 200 次授权上限；详细响应见 [`phase1-generation-results.json`](phase1-generation-results.json)。
- 阶段一判定：**未通过**。访客认领的单项 E2E 通过不满足完整阶段一出口，生成、自建与补建对照也未通过。
- 阶段二新证据：main commit `19089f6d75ad9b74262034b4eca5fc8ec32e8700` 更新了 [`phase2-acceptance-2026-10-07.md`](phase2-acceptance-2026-10-07.md) 和阶段二 checklist；该报告已作为独立证据文件加入 phase3，不包含阶段二应用代码。GitHub Actions run `37560275395` 在 production bundle + preview 下连接隔离 Cloudflare Worker/local D1，19 个真实 Worker 请求、HTTP 失败 0；owner 完成登录、读取、干预、分叉、比较、布局保存、整页 reload、重选和布局回读。聊天 SSE 是唯一 mock。API 全量 876 passed/1 skipped、Web 单测 536/536、开发服务器 native2d-desktop 35/35 也有记录。
- 阶段二判定：**未通过**。production preview 的布局保存与 reload/回读现已通过，但 T15 的部署世界离页推进、暂停、恢复没有运行；公开 demo live 检查、触屏、跨设备布局恢复和归档行为仍未验证。阶段二实现代码 commit `b68e79b9762a0e071515e5549305ee64480bcae9` 在 `main`，尚未并入本 `phase3` 分支。
- 最新 G0 判定：**未通过，T05 及后续集成开发保持锁定**。阶段一有明确失败和未覆盖项，阶段二也有正式的出口未验证项；两个阶段均未达到批准的通过门槛。不得以部分旅程或单项回归替代出口。

## G0 与提前独立开发复核（2026-10-07 14:41）

- 用户本轮授权：尽可能并行推进前两阶段门槛，同时可提前开发不依赖门槛的 phase3 部分。四份规格已记录调度更新；提前实现范围为 T05/T06/T07/T10 独立模块，不接入真实世界会话、renderer 或页面。G0 仍约束依赖集成。
- phase3 已从 `18dedf1` 快进到远端已提交 `e33809c`；随后新增公共契约与云端独立验证 `2ba51ee`、比较 fixture `17053cf`。没有从其他 worktree 复制未提交改动。
- 阶段一 UI/API 旅程：[Actions run 37581579770](https://github.com/kikoiio/Possibility/actions/runs/37581579770)，commit `8305393`，6 个 API 文件 33 tests passed、浏览器 10 tests passed。范围包含多空间访客交谈/分叉/认领、owner 暂停/恢复、编辑持久化、真实分屏、reload 继续及固定草稿的 create/repair UI。对话和生成草稿的确定性 fixture 不作为真实生成证据。
- 阶段一真实生成：[Actions run 37581260623](https://github.com/kikoiio/Possibility/actions/runs/37581260623)，commit `068e93d`。16 次 provider 请求，实际费用 `$0.040377`、账本对账通过、清理通过。custom-2 通过；custom-1 净空、custom-3 连通性、official-example 内容失败。原世界补建保存通过，官方示例单空间保存未完成。脱敏原始证据见 [phase1-provider-37581260623.json](phase1-provider-37581260623.json)。这批 25 次授权剩余最多 9 次，由协调者集中调度，不另启 25 次完整批次。
- 阶段二部署诊断：[run 37581995275](https://github.com/kikoiio/Possibility/actions/runs/37581995275)，commit `c520548`，tick summary 明确为缺失 LLM_BASE_URL 导致 `undefined.replace`，未进入时钟推进；归档和严格零残留清理通过。fixture 配置修复 `252f1a3` 正在 [run 37582832140](https://github.com/kikoiio/Possibility/actions/runs/37582832140) 复验。公共 demo live-read 仍需独立证据。
- 提前实现 P05：公共契约 commit `2ba51ee` 在 [run 37582294420](https://github.com/kikoiio/Possibility/actions/runs/37582294420) Web production build/类型检查通过。P06/P07 在 `p3-independent-state-route` 子 worktree 开发；P10 fixture 的发现/数据烟测由独立云端 CI 验证，尚不构成浏览器集成通过。
- 当前判定：**G0 未通过**。阶段一真实生成仍失败，阶段二部署旅程复验与公共 demo 验收待完成。提前独立模块已正式开始；renderer、会话与页面集成继续等待正面证据。
- worktree 所有权：`phase3` 为协调者集成分支；`phase1-claim-fix`/`phase1-g0-timeout-fix` 为阶段一生成修复；`phase2-clock-fix` 为阶段二临时验收修复；`p3-independent-state-route` 为纯存储/路由实现。主 worktree `/home/neo/Projects/Possibility` 已恢复 `main` 且干净。T01–T04 的旧审计 worktree 和 user-owned 终端保留为可复查记录，未擅自删除或终止。

## 集成基线与提前实现复核（2026-10-07 14:57）

- 四项独立模块已实现并汇入 `phase3`：公共契约 `2ba51ee`、隔离 fixture `17053cf`、存储及 URL `57e94c2`。最新集成基线 `51b8d75` 在 [run 37583769998](https://github.com/kikoiio/Possibility/actions/runs/37583769998) Web production build/类型检查通过，存储与 URL 共 **79 tests passed**，fixture 数据 **2 tests passed**。这不是 renderer 或页面集成验收。
- 阶段二已提交代码与验收工具从 `phase2-clock-fix` 合入 `phase3`（merge `efaf7b5`）。两阶段各自的历史 `0039` SQL 文件名均保留，避免改名导致既有按文件名记录的迁移被重新应用；`0039_snapshot` 保留认领来源列，合并后的 `0040_snapshot` 增加 native2d 两表，journal idx 39/40 各自保留对应历史 tag。API 类型检查及本轮 fresh D1 迁移、认领与布局定向测试已通过；已部署旧数据库升级不由本轮临时 fresh D1 证据代替。
- 阶段二真实部署： [run 37582832140](https://github.com/kikoiio/Possibility/actions/runs/37582832140)，tested commit `252f1a3`，临时远端 Cloudflare Worker/隔离 D1 的离页推进、暂停冻结、恢复推进 **9/9 断言通过**；归档、归档可读和写入拒绝 **3/3 通过**；Worker/D1 清理后精确名称匹配均为 0。原始摘要见 [deployed-37582832140.md](../../phase2-world-loop/evidence/deployed-37582832140.md) 和对应 JSON（evidence commit `9304b1b`，集成 `1c03c25`）。此 fixture 无居民、无 scene、零 provider，仅补齐部署时钟出口。
- 阶段二发布构建和 owner/mobile 布局回归在集成 SHA `51b8d75` 的 [run 37583839313](https://github.com/kikoiio/Possibility/actions/runs/37583839313) 为 success。公开 demo URL 尚未提供，但 arrangement 阶段二门槛没有把 demo live-read 单列为必需出口；按扩展 QA 留待补证，不单独阻塞 G0。居民/地点循环及改变的事实/规则/画面/证据连续性仍按已有与新增证据逐项核对。
- 阶段一修复已汇入：地点绑定检查进入生成重试、净空有限轮修复、不可达承载物反馈、安全 failureStage 和归一记录。云端回归发现等数量新净空仍被旧判断拦截，已在 `cc25984` 修正；越界反馈用例改为真实越界物体，未放宽 validator。[run 37584142096](https://github.com/kikoiio/Possibility/actions/runs/37584142096) 的 API build 与 10 文件/81 项定向回归已通过，随后执行仅 official-example/custom-1/custom-3 的真实生成复验，硬上限 **9 次**。先前 `37583830342` 因回归失败跳过 provider，调用数为 0。
- 阶段一完整确定性 UI/API 旅程在 [run 37583487064](https://github.com/kikoiio/Possibility/actions/runs/37583487064) 的 browser job 仍为 success；该 run 整体因 API typed fixture/harness 编译问题失败，已另行修复且在 `37584142096` API build 通过。不得把整个失败 run 标为成功。
- 当前 **G0 仍未通过**：等待真实生成复验结果，并继续核对两阶段完整出口的证据范围。原集成 DAG 未解锁；P05/P06/P07/P10 的成功只记录提前独立实施，不能冒充完整 phase3 交付。
- Orca 独立 worker 的完成消息已处理，release 返回 `retained/user_takeover`，未终止用户接管的终端；当前 Run 的 reclaimable worker 列表为空。所有新重型检查运行于已授权 GitHub Actions，未在本机启动新 build/browser/provider 服务。


## 2026-10-07 15:24 CST：追加授权与并行补验

- 用户明确回复“允许200次”，按累计 provider 调用 200 次、$10 上限执行，不再逐批请求授权。旧26次费用尚未完整对账；后续三批16/9/17次合计42次，已对账费用 $0.108998。当前累计68次，剩132次；成本未知部分保留，不将已知费用误称全量费用。
- run 37584984785 at 0fe8c7c：17次/$0.048484，日志17行对账一致；custom-1通过，官方示例结构及真实保存通过但coast文本判据失败（生成描述含“沿海小镇”，待核对误判），custom-3越界、custom-2独立carrier失败。原世界repair生成及保存通过。cleanup报告remainingTableRows=-1/d1Deleted=false，尚待定位，整体失败。完整脱敏报告保存为phase1-provider-37584984785.json。
- 阶段二实际2D环境渲染接线 b137d9d 与连续旅程脚本 1bb542d 已集成；生成文档独立生产预览脚本 d756a44/227b15b 支持失败artifact的合法草稿，每例独立BrowserContext，无provider调用。
- 已在 phase3 227b15b 云端并行启动阶段二 production验收 37585977801 与阶段一真实生成稿预览 37585985131。两项均待结果，不能视为通过。
- 两个已有子agent分别负责阶段一失败精准定位和阶段二连续性修复；根负责统一CI/预算/集成；未启动本机重型任务。G0仍blocked，独立T05/T06/T07/T10通过记录保持，集成DAG待正面证据解锁。


## 2026-10-07：阶段二门槛补验完成与阶段一画面失败

- [phase2 production run37586411002](https://github.com/kikoiio/Possibility/actions/runs/37586411002) at5e99f23整体success。新增连续旅程6居民7地点，10/10断言通过，32真实Worker请求、0意外失败、0provider：child雾效/关闭地点真实绘制，关闭进入409，重开进入200；命令/事实/事件/版本直接evidence关联通过，parent没有child条件污染。发布构建、定向投影/规则回归、原owner旅程、离页暂停恢复和mobile均在同run通过。截图已人工查看，封闭红色marker切换为开放绿色marker，雾效存在。报告及两张PNG见同目录phase2-37586411002-*。
- 该run在GitHub-hosted runner上的localWorker/D1，不是远端部署；报告api旧字符串temporaryWorker不精确，脚本已修正a5e027e但原证据不篡改。真实远端部署离页证据仍为37582832140。聊天SSE、public demo live-read范围限制保持：本次未验证真实模型聊天，公共demo URL未配置，后者不属于原文G0的独立门槛。
- [生成画面run37586257398](https://github.com/kikoiio/Possibility/actions/runs/37586257398) success，仅说明37584984785的三个真实生成document在production预览可渲染，0provider、API draft回放；不能当实际保存或语义通过。主协调者已查看三个overview：多余起伏地形掩埋部分建筑，道路不连贯，custom2载体复用。阶段一生成质量仍未通过，已转交精准修复。
- 访客/自建/repair确定性完整UI回归37585946929整体success at227b15b；真实生成语义单独补验，G0仍blocked。
- 根据用户允许提前无门槛依赖开发，P11纯相机联动逻辑已派发：task95279ad1366b/dispatchctx17704fff00c5，worktreep3-independent-camera-link，禁止页面/API/renderer接入；真实adapter联动边界仍在G0后验证。


## 2026-10-07：第二批追加预算结果与精准回放

- run37587238422 at705e5e6：20次provider/$0.060572；官方示例真实生成及保存通过；custom3返回200但重复carrier且出现禁止对象，custom1重复carrier，custom2组装失败，repair4次后walk-gap失败未保存；日志对账一致，清理所有表0行并删除D1文件通过。未用满25请求，不算通过。完整报告phase1-provider-37587238422.json。
- 累计 provider 88/200，剩112（未包括正在运行的零模型回放）；后续四批62次已对账费用$0.169570，旧26次费用未完整对账，仍保留总$10预算约束。
- 接管429退出agent已保存改动，提交02be2cd/d849496，集成81fa1f6/abee391：重复地点carrier进入有限重试、草地非随机起伏、5–8地点可为活动区且不增添未要求建筑、terrain边缘footprint回归；G0_PROVIDER_REPLAY_FILE按场景响应顺序仅回放已有模型内容，严格报告sourceRun/replayedRequests/actualProviderRequests=0，不冒充新provider验收。
- 已启动零模型回放37588240392：只选37584984785已有官方示例与成功repair，验证当前cleanup/生成链回归，不新增真实模型调用。新增真实生成画面37588154107已success，人工视觉复核待下载。
- P11纯协调器初提交f6eb290已集成04deafe；独立实现有界回声修复追加task2719c014be2e/dispatchctxc3ee3252726e，复用同终端。实际adapter与页面不接入，G0仍blocked。


## 2026-10-07：P11独立模块通过与零模型重放结果

- [P11独立验证37588754469](https://github.com/kikoiio/Possibility/actions/runs/37588754469) atf620085 success：productionWeb build/types、存储/URL/纯相机109tests、fixture2tests通过。有界回声记录64个不同姿态，关闭清空；真实adapter联动仍未挂载，本次不代表phase3页面完成。Orca两次P11Dispatch均settled，release返回retained/external_terminal，无进程操作；reclaimable列表为空。
- [零模型回放37588240392](https://github.com/kikoiio/Possibility/actions/runs/37588240392) at04deafe success：来源37584984785，只选official-example与original-world-repair，5个归档响应、0真实provider、$0新增费用，真实API创建/保存链及cleanup0行/D1deleted通过。fullSuite=false，原响应历史费用单列，不重复计预算。证据phase1-replay-37588240392.json。
- 实际生成20次的画面回放37588154107已查看：official平地消除前批掩埋，建筑轮廓和道路可见；仍存在额外商店被bench承载，custom1重复carrier且主路/两层形态质量不足，custom3新增多栋建筑违反只一栋。不能仅因official文本与保存通过解除整个G0。
- 阶段一gate子agent因429停止，root已接管其完整未提交改动并分提交；阶段二agent转为生成根因修复，只有自己隔离分支可编辑。新根因：assetPlacements默认范例缺placementId，locations引用不存在；正在补准确声明、解析及零调用逐响应诊断，不盲目消耗剩112次。


## 2026-10-07：诊断复核与新并行波次

- P14 独立控件 d80c8ac 在 [37590355872](https://github.com/kikoiio/Possibility/actions/runs/37590355872) production build/types 与独立模块验证通过；Orca task03496913824a已结算，真实切换旅程尚待G0后。
- 37590413308 零模型诊断已读取：custom2后续几轮缺稳定placementId，repair末两轮walk-gap坐标位于y5。报告不算新模型证据。旧真实调用保持88/200；回归失败的37589439714/37589737496/37590245031/37590243427/37590413382均跳过真实provider。
- 307c7fd修正咖啡館真实建筑fixture世界边界为32，保留missing-binding有限重试的原断言，不放宽validator。新真实复测[37591036270](https://github.com/kikoiio/Possibility/actions/runs/37591036270)至多25请求、全五场景、回归成功才调用provider；运行中尚不记实际调用。
- 两已有agent分别在phase1-claim-fix与phase2-clock-fix处理准确生成几何约束与repair通行根因；所有命令显式绝对workdir，禁止修改协调者分支。P13纯生命周期模块另开隔离worktree，重型验证继续使用已授权GitHubActions。

- 阶段一提示复核提交 `fa43f0f` / `83de0c6` 已精准移植：增加区域地点独立 carrier、道路连续路面和按用户数量建楼层约束；两层住宅改用专用 `manor-two-story-house` 体素模板。补建 walk-gap 提示提交 `629462c`，说明 `issue.at` 是严格可达的缺口前格，并检查同高度四邻、中间缺格及两格外落脚格；湖岸按实际高差接路，不盲目填当前位置。
- 新两层模板首次云端检查 [37592030411](https://github.com/kikoiio/Possibility/actions/runs/37592030411) 证明楼梯旁存在真实 walk-clearance 问题，0 provider 请求。补齐第二踏步下方支撑后，[37592376850](https://github.com/kikoiio/Possibility/actions/runs/37592376850) 的 API build、phase1 voxel 回归（含四种旋转的住宅净空/通行路径）通过；该 run 正在执行真实 provider 全套验收，调用及费用待归档报告确认。
- T13 纯生命周期模块已合入 `8a3d2fa`，用转换 generation 防止同步重入复写；延迟 mount、取消、相机恢复/保存、旧视口释放和幂等 destroy 均有测试。[Phase3 independent validation 37592945905](https://github.com/kikoiio/Possibility/actions/runs/37592945905) 成功：production Web build/types、独立模块 **118 tests**、fixture **2 tests**。应用页面及真实 renderer/双 pane 集成仍未验收，G0继续阻塞该集成波次。
- 零模型回放 [37593108274](https://github.com/kikoiio/Possibility/actions/runs/37593108274) 使用源 run37587238422的20个归档响应，新增 provider请求0、增量费用$0；未通过，原因包括官方/原有场景使用旧 carrier/操作格式，且原世界补建两轮末仍有walk-gap（共重放4次）。当前格式诊断显示源报告中的official地点复用dock-path、custom-1对象重叠/重复carrier、custom-2未稳定placementId、repair通路在湖岸交界；它只诊断历史响应，不计作本轮实现的真实provider验收。完整回放及诊断 JSON 保留于 `/tmp/phase1-replay-report-37593108274/` 与 `/tmp/phase1-diagnostics-37593108274/`。


## 2026-10-07：37592376850 真实生成与 37594525129 零模型回放

- [真实 provider run 37592376850](https://github.com/kikoiio/Possibility/actions/runs/37592376850)，代码提交 `21ddb040`，使用 DeepSeek V4 Pro。报告记录 **24 次实际 provider calls**、`reconciled=true`、费用 **$0.452166**。四条提示各尝试 5 次后均以 API 502 assembly failure 结束；官方示例单空间未保存。原世界 repair 额外调用 4 次后也返回 502，未保存。隔离数据清理精确核验为 **0 rows**，D1 文件已删除。
- [零模型回放 run 37594525129](https://github.com/kikoiio/Possibility/actions/runs/37594525129)，提交 `84ece66`，使用历史响应重放：实际 provider calls **0**、replayed calls **20**、新增费用 **$0**。旧四条提示各重放 5 次，仍因 assembly failure 返回 502；原世界 repair 重放返回 200 并成功保存。清理精确核验为 **0 rows**，D1 文件已删除。该 repair replay 只证明归档响应在回放链路中的结果，不构成新的真实 provider 成功证据。
- **G0 仍未通过**：四条提示的真实生成未成功，自建单空间没有保存，真实 repair 也没有保存；历史 repair 成功回放不能代替真实请求验收。
- 用户后来明确授权在零模型回放修复后最多追加 **100 次真实 provider 请求**，分批每次不超过 25 次。对该追加授权窗口中的 6 个已完成真实 provider runs 逐 artifact 对账：`37592376850` 24 次/$0.452166、`37597405183` 22 次/$0.251862、`37599954268` 21 次/$0.303015、`37601940670` 19 次/$0.225021、`37604189111` 8 次/$0.051348、`37604939224` 5 次/$0.032461；总计 **99 次**，费用 **$1.315873**，均报告 reconciled。该窗口尚余 1 次，本轮没有再调用。此前文档记录的 112/200 是追加授权前基线；更早历史运行的累计请求与费用仍未完全对账，不能据此声称所有历史费用已知。
- 综合历史与追加复验，G0 仍未通过：真实阶段一生成/自建保存和 repair 失败，旧格式零模型回放也失败；真实 provider 结果不能由 fixture 或历史响应回放替代。剩余 1 次预算不足以完成全场景验收，因此停止真实调用并保留失败状态。
