# Wispiva

Wispiva 的需求正在重新评估。仓库保留了世界、人物、时间线分叉、对话和场景展示等现有实现，供后续评估与开发使用；这些实现不构成新一轮产品范围或交付承诺。

仓库：https://github.com/kikoiio/Wispiva

## 开发入口

项目使用 npm workspaces：`web` 为 React/Vite 客户端，`api` 为 Hono/Cloudflare Worker 服务，`packages/*` 为共享契约。

- `npm run dev`：启动 Web、API 与模拟节拍进程。
- `npm run db:migrate`：应用本地 D1 迁移。
- 各工作区的构建和测试命令见对应 `package.json`；工具用途见[脚本说明](scripts/README.md)。

当前没有 GitHub Actions 工作流。源码、配置和测试文件的存在不代表部署可用或功能验证通过。`docs/` 是被 Git 忽略的本地代码导航，不随仓库克隆获得，也不上传。

## 兼容标识

项目和内部包使用 `wispiva` / `@wispiva/*`。浏览器存储、IndexedDB、事件、DOM 标识中的 `possibility` 前缀，以及 `X-Possibility-Guest` 请求头、访客哈希和幂等键命名空间仍用于兼容现有数据与请求。

`mode=possibility` 是现有产品模式值。修改这些标识前，需要核对读写双方及迁移方式。
