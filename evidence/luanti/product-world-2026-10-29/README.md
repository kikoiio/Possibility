# 持久产品世界纵向验证（2026-10-29）

对应提交：`3e198154956d7fc1e3cfe2dbcc7bbacc5765b3aa`。

GitHub Actions：[40928557051](https://github.com/kikoiio/Wispiva/actions/runs/40928557051)。
该运行在 Ubuntu 26.04 容器中使用 Luanti 5.10.0、Lua 5.1 完成全部常规单测和
产品场景，结论为 `success`。

验证链路：

1. 从 `genesis/example.json` 创建并确认 Draft；
2. `genesis.world_create.create_world` 发布新的 Luanti 世界目录，生成稳定世界 UUID、私有起源 manifest、起源副本和 mod；
3. `run_product.sh` 启动同一世界，读取 manifest，投影 101 个空间操作，生成角色并写入角色私有起源记忆；
4. 环境过程再生 `society:resource`，每次变化写入 `world-event:N`，角色通过 fixture 模型实际 gather/build；
5. 正常停服保存角色、事件、长期记忆和环境快照；
6. 同一世界用 `--resume` 重启，恢复角色和长期记忆，环境从保存时间继续推进，未重复写入起源记忆。

关键日志证据包括：`origin projection`、`ev=genesis-memory`、`ev=environment`、
`ev=resource ... ok=true`、`long-term-checkpoint`、`ev=restore ... reset=false`
和两次 `done result=ok`。

范围限制：本次使用 fixture 模型验证运行时闭环，不是配置供应商的真实模型体验；
没有进行真人 Luanti 客户端画面评价；地图、事件、库存、环境和角色 checkpoint
目前仍通过正常停服与 mod storage 分别保存，尚未形成断电级跨存储原子事务；
产品空间仍是受控的 Luanti 投影和无碰撞 `set_pos` 移动。
