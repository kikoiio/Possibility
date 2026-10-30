# 从用户意图到通用世界起点

状态：审计与最小交付切片，2026-10-30。本文只记录当前产品创建链的事实、缺口和下一条可验收的纵向切片；不把目标设计写成已实现能力。

## 当前链路

当前代码可以走通下面这条原型路径：

```text
用户意图
  → genesis.DraftStore.create_from_intent()
  → 可编辑草稿 revision
  → DraftStore.confirm()
  → 起源 WorldStore checkpoint
  → genesis.world_create.create_world()
  → 私有 Luanti world directory
  → engine/luanti/run_product.sh
  → launch.py / WorldSession
  → Luanti mod 读取 wispiva-origin.json 并投影地图与角色起点
```

`DraftStore` 会保存原始 intent，确认前允许 `update()`，确认时绑定草稿 revision、目标起源库和 token。`world_create.create_world()` 会重新编译已确认草稿，检查起源库仍是只有首个 `genesis.created` 事件的创建态，然后在同一父目录下准备临时目录，写入世界身份、私有 manifest、起源副本、mod、`world.mt`、`server.conf` 和 `creation.json`，最后通过目录 rename 发布。

Luanti 运行时已经能从 manifest 读取公开地点、连接和角色起点，并把每个角色自己的 role、goal、memory seeds 放进该角色的模型输入。`launch.py` 在子进程全生命周期持有 `WorldSession`，负责协作锁、世界 UUID 和停止信号。

## 审计发现

### 1. 创建链存在两套起源形状，尚未统一

实际产品创建路径使用的是 `genesis/store.py` 的 `_projection()` 和 `genesis/world_create.py` 的 `build_manifest()`。它们把起源事件保存为草稿引用、revision 和 digest，角色与公开世界快照另存为独立形状。

`world/origin.py` 则定义了另一套 v1 契约：事件必须包含 `contract_version`、完整 `origin`、稳定 `runtime_ids` 和 `coordinate_system`，并可由 `origin_snapshot()` 派生角色私有种子。`world/origin_store.py` 只接这套契约和假引擎；`world_create.py` 没有调用它。两套实现都叫 origin，但不能直接互相重放。

因此当前“契约已存在”只在文档和假引擎范围内成立。完成通用创建需要选定一个实际权威形状，并让 DraftStore、world_create、Luanti manifest 和恢复校验使用同一个 `origin_event_id`、`draft_sha256`、角色映射和版本字段。

### 2. DraftStore 的确认对象与产品世界没有完成同一操作绑定

`DraftStore.confirm()` 确认的是一个起源 SQLite 目标；它把状态推进到 `confirmed`。随后 `create_world()` 读取该确认记录，另建一个 Luanti 世界目录。产品目录中的 `creation.json` 保留 world ID、draft ID、revision、origin event ID 和 intent 摘要，但这些信息不会回写 DraftStore，也没有独立的发布状态或 operation ID。

这带来两个边界：

- DraftStore 可以显示起源已 confirmed，但产品世界目录尚未发布或发布失败。
- `create_world()` 当前先拒绝任何已存在的目标目录；它的文档提到“同 manifest 重试”语义，代码却没有同 manifest 的恢复分支。目录发布后进程在返回前失败时，下一次不能仅凭 creation record 判断是安全重试、已完成还是未知状态。

这不是要把两个文件系统强行做成一个事务，而是需要一个明确的跨存储状态机：发布前、已发布、待核对和已就绪必须可区分；未知状态必须冻结并要求核对。

### 3. `preflight` 不是 Luanti 启动前的产品门禁

`genesis/preflight.py` 能检查确认 revision、草稿编译和部分当前不支持的规则／连接，但它明确不能授权启动，也只把目标目录可用性作为建议检查。它没有检查产品世界目录中的 manifest、`creation.json`、`origin.sqlite`、`wispiva-world-id` 是否互相绑定。

`launch.py` 只负责 `WorldSession`：取得锁、读取或创建 UUID、设置 `WISPIVA_WORLD_ID`、运行子进程并转发信号。`run_product.sh` 只检查世界目录、运行时、身份文件，然后生成临时配置并启动 Luanti。任何带有效身份文件的目录都有机会进入这条启动路径，启动器不会验证它是不是由当前创建链产生的世界，也不会在锁内核对 manifest 与起源副本。

### 4. Luanti 的投影已经有入口，但缺少创建态到运行态的对账门

`society/world_projection.lua` 会重新从 manifest 编译投影计划，并在产品启动时写入地点、连接和角色位置；这保护了“不要信任调用方预计算 plan”的边界。但当前启动前没有验证：

- manifest 的 `world_id` 是否等于目录身份；
- manifest 的 draft ID、revision、digest、origin event 是否等于 `creation.json` 和 `origin.sqlite`；
- origin 副本是否仍是同一创建起点，是否已经被推进或替换；
- 角色 runtime ID 与 manifest 顺序、稳定 actor ID 是否一致；
- 已投影世界是否属于该 origin，能否安全恢复而不是重新覆盖。

运行时已有产品状态账本和正常停服恢复，但那是创建完成之后的持续运行协议，不能替代首次启动的 origin admission check。

### 5. 私有边界已有实现意图，创建入口仍缺语义确认

`world_create` 把完整 manifest、原始 intent、起源副本和 `creation.json` 放在 `private/` 并设置受限权限；Lua 模型输入按角色注入自己的 profile 和 seeds。结构上已经能阻止把完整 manifest 当作公开空间投影。

但生成器和结构校验不能发现“秘密被重复写进 title、place description、role 或 public rule”。现有产品案例证明了字段级隔离和回归边界，不能证明任意用户意图下的语义隐私。最小交付应把“用户查看公开／私有预览并确认”作为创建门的一部分，并把语义审查结果与确认 revision 绑定；不能只把模型输出的结构有效当作用户确认。

## 最小可交付切片

完成“用户意图到通用世界起点”不需要先实现完整规则系统、复杂地形或长期社会模拟。下一条切片应只覆盖一条可恢复、可审计的产品纵向路径：

### A. 选定并落地一个 canonical origin contract

以 `world/origin.py` 的 v1 形状为候选基准，或明确把 `world_create.py` 的 manifest 形状升级为同一契约。必须只有一套字段定义，至少固定：

- `world_id`、`origin_event_id`、`draft_id`、确认 `revision`、`draft_sha256`；
- `actor_id → runtime_id` 的持久双射；
- 公开世界计划与每角色私有 `role`、`goal`、`memory_seeds`；
- 坐标系、manifest/contract version 和创建 operation ID；
- 起源仍处于可发布的首事件状态，还是已经进入运行态。

交付物是一个可从确认记录重新验证的 canonical manifest／origin event，以及针对两种现有形状的明确拒绝或迁移策略。不能继续让 `world/origin.py` 只是“纯函数原型”而让产品创建链另有一套事实来源。

### B. 增加产品发布记录和安全重试边界

在 DraftStore 或同一私有创建记录中增加产品发布状态，最小状态为：

```text
CONFIRMED → PUBLISHING → PUBLISHED → READY
                     ↘ UNKNOWN / FROZEN
```

记录必须绑定完整请求：world path、world ID、draft ID、revision、digest、origin event ID 和 operation ID。`create_world()` 在目标不存在时原子发布；目标已存在时只允许读取并验证完全相同的 creation record、identity、manifest 和 origin copy，匹配则返回已发布结果，不匹配则拒绝且不修改目录。异常发生在无法判断发布是否完成的窗口时进入 `UNKNOWN/FROZEN`，由核对命令决定恢复或人工处理。

这一步只要求跨存储状态可解释，不要求 DraftStore、Luanti map 和 SQLite 在同一个操作系统事务中提交。

### C. 将启动器变成产品世界 admission gate

在 `run_product.sh` 调用 Luanti 前，通过 `launch.py` 或独立的只读 preflight 完成以下核对，并在持有 `WorldSession` 锁后执行：

1. 读取 `wispiva-world-id`、`private/creation.json`、`private/wispiva-origin.json` 和 `private/origin.sqlite`。
2. 验证 contract version、world ID、draft revision、digest、origin event ID 和 operation ID 全部相等。
3. 验证 origin SQLite 仍对应 manifest 的创建起点；未知、损坏、缺失或已推进状态均停止。
4. 验证 manifest 的角色映射和公开投影可由 canonical contract 重编译；失败时不启动 Luanti。
5. 将已核对的 world ID 作为 expected identity 传入运行会话，并把 admission 结果写入受限日志。

这样 `launch.py` 才真正保护“这个进程正在打开由这条创建链生成的这个世界”，而不只是保护一个 UUID 和协作锁。

### D. 做一次非固定题材的端到端创建验收

使用现有两个非 `example.json` 产品意图案例中的一个，最小验收必须覆盖：

```text
intent
→ editable draft v1
→ user-visible public/private preview
→ edit to v2
→ explicit confirmation of v2
→ canonical origin + product world publication
→ admission check
→ Luanti product start
→ actor-specific seed visible to its actor only
```

必须保留 `draft_id`、revision、intent digest、origin event、world ID、角色映射和发布结果。至少验证一次：修改确认前草稿不会改变旧世界；确认后重试不会重建或覆盖同一世界；另一个角色和公开投影拿不到私有 seed；任何绑定不一致都会在 Luanti 启动前失败。

这条验收可以先使用假模型响应、headless Luanti 和轻量启动器测试；它不需要 GUI，也不应把固定 `genesis/example.json` 当产品验收。

## 暂不纳入这条切片

以下能力仍是后续切片：完整自然语言创建 UI、任意素材到三维资产、可执行规则编译、真实用户语义隐私评分、地图／角色／事件／库存／记忆跨存储原子提交、断电恢复、复杂寻路、长期社会行为和大规模真实模型并发。它们不能成为本切片“起点已创建”的隐含前提。

## 建议涉及文件

实现下一条切片时，变更边界应集中在这些位置：

- `world/origin.py`：canonical origin contract、重放和完整绑定校验；
- `genesis/store.py`：发布状态、operation 绑定和安全重试记录；
- `genesis/world_create.py`：只消费 canonical contract，补齐 published／unknown 核对；
- `genesis/preflight.py`：把产品 world admission 检查与草稿语义 preflight 分开；
- `engine/luanti/launch.py` 或新增产品 admission 模块：锁内读取并核对创建产物；
- `engine/luanti/run_product.sh`：只通过 admission gate 启动产品世界；
- `engine/luanti/mod/society/world_projection.lua`：继续从已核对 manifest 重编译投影，不接受外部 plan；
- `genesis/test_world_create.py`、`world/test_origin_end_to_end.py`、`engine/luanti/test_launch.py`：覆盖同 manifest 重试、绑定冲突、未知状态和角色私有边界。

本次审计只修改了本文档；没有启动构建、完整测试或 GUI。
