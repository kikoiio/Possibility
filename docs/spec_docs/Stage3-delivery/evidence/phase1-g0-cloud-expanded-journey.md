# 阶段一 G0：Actions 扩展访客旅程诊断

日期：2026-10-07（Asia/Shanghai）  
分支：`phase3`  
提交：`71976b8429addcd27e6e6cf136062c6dfb5263be`  
Actions run：[37564443630](https://github.com/kikoiio/Possibility/actions/runs/37564443630)  
Job：[Isolated real API + browser guest claim slice](https://github.com/kikoiio/Possibility/actions/runs/37564443630/job/112608852292)  
Artifact：`phase1-g0-guest-claim-37564443630`（ID `11458467505`，12,268,835 bytes，保留 14 天）

## 结果

**失败，G0 仍未通过。** 1 个 Chromium 用例在注册后的 claim 步骤失败。隔离 API 日志记录：

```text
[claim] 保存失败: D1_ERROR: world_state_version_conflict: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)
```

浏览器最终仍在 `/login?claimDemo=1`，未导航到 `/worlds/...`；Playwright 在测试第 91 行等待已认领世界时超时。此结果证明 claim 保存路径当前不能通过这条带有交谈/分叉历史的真实 API 旅程。它没有证明 claim 通过。

## 逐项结果

| 旅程步骤 | 结果 | 证据 / 限制 |
|---|---|---|
| 隔离基线 seed 与 `/demo` 加载 | 通过 | 测试完成 seed；对明确的“世界或时间线不存在”错误重载一次后，画布出现。本次没有复现此前 run `37563800568` 的画布前失败。 |
| 多空间访客进入温室并移动 | 通过 | 用例继续通过地点面板和“你在温室花房”断言。 |
| 交谈 | 通过（fixture） | 用例等待固定回复文本；API 使用 `standard-life-fixture` 确定性 provider，仅用于隔离 E2E，不是外部/真实模型生成证据。 |
| 创建分叉与来源/新分支比较 | 通过（比较面板） | 用例完成真实 API 分叉并打开“两种人生”面板。该面板不等同左右分屏。 |
| 注册新账户 | 通过 | 页面到达 claim API 调用阶段。 |
| claim 并进入所有者世界 | **失败** | D1 `world_state_version_conflict`；页面停留登录页。失败日志、截图和 trace 在上述 artifact。 |
| 所有者管理 | 未执行 | claim 失败，未进入 owner UI。 |
| 编辑并保存 | 未执行 | claim 失败，未提交场景 revision。 |
| 左右分屏 | 未执行 | claim 失败；此前访客比较面板不算分屏。 |
| 刷新继续 | 未执行 | claim 失败，未运行 reload 持久性断言。 |
| 真实生成、单空间自建/原世界补建对照 | 未执行 | 此工作流排除模型服务；provider 调用 0。既有真实生成失败仍见 `phase1-g0-checkpoint.md` 和 `phase1-generation-results.json`。 |

## 复查与资源

- 代码及测试：[`web/e2e/guest-claim-journey.spec.ts`](../../../../web/e2e/guest-claim-journey.spec.ts)。
- 工作流：[`phase1-g0-guest-claim.yml`](../../../../.github/workflows/phase1-g0-guest-claim.yml)，只触发 `phase3` 上该 workflow 文件自身的变更；提交本证据不会重跑。
- Actions run 已失败结束，临时 Ubuntu runner/job 已释放；artifact 保留 14 天。provider 调用数为 0，未读取 `.dev.vars` 或 secrets。
- 失败定位候选：clone 路径批量复制 `universe_revisions` 和 `world_facts`（`api/src/demo/world-graph-cloner.ts`）；迁移 `api/drizzle/0008_cool_spiral.sql` 中 `world_facts_revision_guard` 要求每条新事实版本等于目标时间线当前 revision。需要进一步用克隆逻辑/隔离数据确认违反触发器的具体事实行，当前证据不足以断言根因已定位。

G0 仍未通过。阶段二验收由另一个 session 负责，本记录不作阶段二判断。
