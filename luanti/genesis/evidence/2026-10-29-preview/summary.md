# 一次性 Luanti 预览闭环

2026-10-29，GitHub Actions [40825261813](https://github.com/kikoiio/Wispiva/actions/runs/40825261813) 首次在源码快照 `6131f27bb1c2932ce8409b299a41e2b9110acde3` 上成功运行了已确认草稿的 Luanti 预览；目录和工作流迁移后的最终验证 [40827303033](https://github.com/kikoiio/Wispiva/actions/runs/40827303033) 又在快照 `5f6641191d65588b231cb5261a8649e76a8684ae` 上成功复跑。工作流完成 Python/Lua 测试、草稿预检、私有 manifest 读取、三角色生成和引擎存活检查，并记录了 fixture 的发言与移动事件。

这次运行验证了“已确认草稿 → 私有预览目录 → Luanti 服务端 → 角色事件”这条技术链路，也验证了 manifest 放在 `world/private/` 时 Luanti 的 mod security 不需要额外的 trusted-mod 配置。它使用平坦草地、确定性 fixture、一次性目录和非持久设置；没有验证真实模型行为、用户客户端画面、建筑生成、规则执行、世界保存恢复或跨 SQLite 与地图的原子提交。

原始 Actions 产物保留 14 天，仓库只保存可复核的运行元数据。fixture 事件不能计入真实模型证据，也不能把一次性预览称为持久世界。
