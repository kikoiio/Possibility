# 版本化产品创建契约

本契约把一次已确认创建绑定到一个持久产品世界。它解决启动时的身份和版本对账，暂不宣称地图数据库、角色、库存、事件、记忆和环境能够断电级共同提交。

`private/wispiva-contract.json` 使用 `wispiva-product-contract` v1，包含：

- `world_id`：世界身份文件中的 canonical UUID。
- `origin_event_id`：起源 `genesis.created` 事件身份。
- `draft_id`、`revision`、`draft_sha256`：创建输入的可追踪版本。
- `phase`、`commit_version`：产品提交边界的初始状态。
- `components`：map、actors、inventory、events、memory、environment 六类投影版本。

创建器把契约写入私有世界目录，同时把它嵌入 `wispiva-origin.json`，并在 `creation.json` 中记录引用。Luanti 产品启动器在获得 `WorldSession` 锁之后校验世界身份、契约、manifest 和 creation record；校验失败时不启动服务器。契约文件和 manifest 使用私有权限，不能作为公开空间投影。

当前提交只证明身份和启动对账。后续提交必须在同一契约上推进组件版本，并在未知或不一致时冻结世界；跨 SQLite、Luanti map database、mod storage 和文件的共同事务仍需单独设计和验证。