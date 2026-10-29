# 起源与假引擎资源集成回归

- [GitHub Actions 40898042968](https://github.com/kikoiio/Wispiva/actions/runs/40898042968)：success，提交 `ba4770a439e4f97cae8d310c253852db87884694`。
- 后续 [GitHub Actions 40904034040](https://github.com/kikoiio/Wispiva/actions/runs/40904034040)：success，提交 `fd86b956141a94160f64ac96466486c68c6272e7`；加入身份文件、跨进程世界锁和起源到模型输入的隔离测试，并复跑 Luanti 认知、恢复、资源、长期记忆和起源预览。
- 后续本地切片补充 `WorldSession`：组合身份读取／创建、预期身份校验和锁释放；对应 34 项测试已在本地及 [GitHub Actions 40905440163](https://github.com/kikoiio/Wispiva/actions/runs/40905440163) 通过，提交 `db59d1078695218f29b653d25cfe502a2043e738`。
- 覆盖起源、确认绑定、假引擎资源与跨进程恢复的 Python 测试，以及现有 Lua、Luanti 认知、恢复、资源和合成预览回归。
- 本次新增的身份与锁测试证明协作访问者之间的文件级边界；它们不证明未使用协议的 Luanti 进程、玩家或 mod 会被阻止，也不证明地图断电持久性。
- 跳过真实模型与容量实验。假引擎使用独立 JSON 夹具；没有验证 Luanti 地图与新起源／资源事务的集成、真实用户认证或生产持久性。
- [原始 Actions 产物](actions-artifact.zip)：artifact ID `12907348224`，SHA-256 `b305114d71c4f4d0d2de60c19392125e84c9264117e49686ab5686482c86d82c`；已核对哈希和 ZIP 完整性。
