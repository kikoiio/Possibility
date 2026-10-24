# 开发与维护脚本

运行前阅读脚本的输入、写入目标和所需环境。没有 npm 入口的脚本也可能是手动维护工具。

| 入口 | 用途 |
| --- | --- |
| `npm run dev:engine` | 调用本地 API 推进模拟；根 `npm run dev` 已包含此进程。 |
| `npm run seed`、`npm run seed:demo` | 写入开发数据。 |
| `npm run asset:import` | 导入和检查体素资产。 |
| `npm run asset:thumbnail` | 生成体素资产缩略图，会启动开发服务器和浏览器。 |
| `npm run verify:deployment` | 对指定部署执行旅程检查；先确认目标、凭证和写入范围。 |
| `activate-scene-policy.ts` | 激活场景兼容策略，涉及数据库写入，迁移测试也使用它。 |
| `validate-voxel-atlas.ts` | 检查体素图集与方块注册表的一致性。 |

`generate-mist-manor-atlas.ts`、`generate-building-assets.ts`、`generate-vegetation-assets.ts`、`prepare-demo-scene.ts`、`rebuild-scenes-voxel.ts`、`import-voxel-scene.ts` 是手动资产和场景维护工具。部分依赖本地忽略的 `out/` 产物、数据库、模型服务或浏览器；运行条件以具体脚本为准。

浏览器自动化、重型构建等按全局资源规则优先使用经授权的云端资源。维护工具的存在不代表目标部署、外部服务或本地产物已准备好。

当前业务回归位于各模块测试和 `web/e2e/`；其中的阶段名称和编号仅用于定位既有用例，不定义新一轮需求、实施顺序或验收标准。
