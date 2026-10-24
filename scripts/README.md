# 脚本入口与保留边界

本目录区分当前开发工具与历史验收辅助。没有 npm 入口不代表脚本无用；运行前先阅读输入、写入目标和资源需求。需求正在重新评估，旧阶段编号不构成当前执行计划。

## 当前开发入口

| 入口 | 用途 |
| --- | --- |
| `npm run dev:engine` | 本地引擎节拍；通常由根 `npm run dev` 启动，不重复启动 |
| `npm run seed`、`npm run seed:demo` | 写入开发数据；先确认目标环境 |
| `npm run asset:import` | 体素资产导入与品质检查 |
| `npm run asset:thumbnail` | 体素资产缩略图；会启动开发服务器和浏览器，按重型任务规则执行 |
| `npm run verify:deployment` | 对指定部署执行验收旅程；不是只读静态检查，运行前确认目标与权限 |
| `activate-scene-policy.ts` | 场景兼容策略激活；有数据库写入，且被迁移测试使用 |
| `validate-voxel-atlas.ts` | 检查当前体素图集与方块注册表的一致性 |

`generate-mist-manor-atlas.ts`、`generate-building-assets.ts`、`generate-vegetation-assets.ts`、`prepare-demo-scene.ts`、`rebuild-scenes-voxel.ts`、`import-voxel-scene.ts` 保留为手动资产/场景维护工具。部分依赖忽略的 `out/` 产物、数据库、模型服务或浏览器，不是默认构建步骤，也不能直接当成可无条件复现的纯源码流程。是否合并或退役，留待新的资产与场景需求确定后决定。

## 保留的历史验收辅助

- `phase1-core-loop-baseline.mjs` 与 `phase1-core-loop-correlation.mjs`：旧基线矩阵、证据关联与汇总。
- `finalize-phase1*.mjs`、`finalize-phase2b-time-status-acceptance.mjs` 及相邻测试：按旧阶段规则验证并汇总证据。
- `lib/acceptance-evidence.mjs`：以上汇总器共用的证据读取、脱敏检查和报告输出。

它们原先的 GitHub 工作流已删除，历史远端产物已清理。保留脚本不代表旧 CI 仍然可用，历史通过也不代表当前功能通过。新需求确定前，不默认恢复或执行整套旧验收；根 CLI 与 Web 验收 helper 中重复的基线定义也暂不扩展。

仍可单独运行的无第三方依赖回归：

```bash
node --test --test-concurrency=1 \
  scripts/finalize-phase1b-guest-save-acceptance.test.mjs \
  scripts/finalize-phase1c-world-projection-acceptance.test.mjs \
  scripts/finalize-phase2b-time-status-acceptance.test.mjs \
  scripts/phase1-core-loop-correlation.test.mjs
```

测试会创建临时证据文件；如需执行，先将 `TMPDIR` 指向根文件系统上的独立临时目录，结束后清理本次生成的文件。

## 已退役与暂缓清理

旧 Phase 2 临时 Cloudflare 环境的 bootstrap、readiness、marker、资源 guard、迁移包装、finalize 和定点 orphan 清理脚本，以及绑定已删除工作流的测试，已移除。数据库迁移本身及现用场景兼容机制没有删除。

旧 `scene-assets` 缩略图生成/校验工具与其 npm 入口已移除；当前体素缩略图入口是 `asset:thumbnail`，不是已移除的 Web `assets:thumbnails`。旧公开素材暂时保留，避免未经确认地破坏直接 URL。

本轮不改变双引擎、native2d 样板、两套比较界面、旧数据兼容桥或共享包公开别名。这些需要产品范围或兼容策略决定，不按名称和引用计数直接删除。
