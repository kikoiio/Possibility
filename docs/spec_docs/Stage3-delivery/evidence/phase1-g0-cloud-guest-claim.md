# 阶段一 G0：GitHub Actions 访客认领片段复核

日期：2026-10-07（Asia/Shanghai）

验收分支：`phase3`

受测应用/测试提交：`12393a8127ad830b066d5d400473bd8068cf17c8`

对应云端工作流提交：`12393a8127ad830b066d5d400473bd8068cf17c8`

Actions run：[37561465283](https://github.com/kikoiio/Possibility/actions/runs/37561465283)

Artifact：`phase1-g0-guest-claim-37561465283`（ID `11456638070`，保留 14 天，617 bytes）

## 结果

**访客分叉与认领片段通过，不能据此判定 G0 通过。** GitHub 托管 Ubuntu runner 上依次完成 `npm ci`、Chromium 安装、隔离 Wrangler/D1 API 服务和 Vite 页面；单 worker `desktop-chromium` 执行 `web/e2e/guest-claim-journey.spec.ts`，结果 **1 passed / 1 total**，Playwright 用时 52.8 秒。日志记录：访客进入演示世界、进入温室并移动、创建真实分叉、注册并 claim、进入已认领世界、确认两条时间线及访客仍在温室。

此次工作流没有读取 secrets 或 `.dev.vars`，没有访问外部模型服务，provider 调用数为 **0**。测试使用隔离的本机 Wrangler D1 数据库；工作流 artifact 包含本次日志。通过时没有生成失败 trace。

复查入口：工作流定义 [`.github/workflows/phase1-g0-guest-claim.yml`](../../../../.github/workflows/phase1-g0-guest-claim.yml)；原 Playwright 测试 [`web/e2e/guest-claim-journey.spec.ts`](../../../../../../web/e2e/guest-claim-journey.spec.ts)；云端完整日志及 artifact 可从上方 Actions run 页面下载。

## 尚未覆盖的阶段一旅程

以下均未由这次云跑执行或证明：

- 访客在同一真实会话中完成一次交谈；
- 认领后执行所有者管理操作（例如暂停/继续，并确认结果持久化）；
- 在认领后的多空间世界提交编辑，并经真实 API 保存及刷新验证；
- 真实 API/UI 分屏比较两条时间线；
- 页面刷新后恢复已保存世界、时间线、位置和编辑结果；
- 三条自写描述和官方示例的真实生成；
- 自建单空间保存成功与原世界同 ID 补建保存成功的对照。

上列生成失败与代码候选缺口见 [`phase1-g0-checkpoint.md`](phase1-g0-checkpoint.md) 和 [`phase1-generation-diagnosis.md`](phase1-generation-diagnosis.md)。当前 G0 仍未通过；阶段二验收由另一个 session 负责，本记录不作阶段二判断。

## 当前判定

本次云端结果加强了“访客移动 → 分叉 → 认领 → 认领后状态可见”这一子路径的可复查证据。交谈、管理、编辑保存、分屏、刷新、真实生成和自建/补建保存对照仍无通过证据；阶段一门槛未满足，不解锁 G0。
