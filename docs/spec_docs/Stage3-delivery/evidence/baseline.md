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
- 阶段一生成门槛：四条基线提示消耗 17 次 provider 调用，其中三条返回 502，另一条虽返回 200 但地点绑定 8 项、场景对象仅 3 个；单空间创建复测消耗 5 次后仍为 502，未保存世界。原世界补建消耗 4 次后返回 502，未保存场景。总计 26 次调用，低于既有 200 次授权上限；详细响应见 [`phase1-generation-results.json`](phase1-generation-results.json)。
- 阶段一判定：**未通过**。访客认领的单项 E2E 通过不满足完整阶段一出口，生成、自建与补建对照也未通过。
- 阶段二：仍待另一 main session 提交可复查检查点；其正在检查 production preview 下的真实账户 API、布局保存/刷新恢复和离页后推进/回访。该 session 的临时进度不作为通过证据。
- 最新 G0 判定：**未通过，T05 及后续集成开发保持锁定**。阶段一已有明确失败/未覆盖项，阶段二的正式证据也尚未提交并复核。不得以部分旅程或单项回归替代出口。
