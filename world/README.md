# 世界状态事务核心

独立 Python 3 标准库模块，尚未接入 Luanti 或现有 Lua 角色循环。单个 SQLite 文件表示一个世界；调用方拥有规则判定、角色快照构造与校验、外部投影同步及重试。只在同一个数据库中，事件与完整世界、角色和时间快照共同提交；SQLite `synchronous=FULL` 的持久性仍依赖文件系统和硬件兑现同步保证。**不提供与 Luanti 地图、对象或其他存储之间的原子性**，调用方不得以本库提交成功作为地图操作成功的证据。

## 精确契约

- JSON 值限 `null`、布尔、字符串、有限数、数组、字符串键对象；无 NaN、无限数或非字符串对象键。
- `world`：JSON 对象，键由调用方定义；例如 `{"resources": {"tree:1": 2}}`。全量替换，不是增量合并。该库不推断资源规则或检查具体业务键。
- `characters`：JSON 对象，**非空字符串角色稳定 ID → JSON 对象角色快照**，例如 `{"agent:1": {"pos": {"x": 1, "y": 2, "z": 3}, "memory": []}}`。全量替换，缺失的角色不再存在；角色快照内部字段由调用方定义与校验。角色 ID 的命名空间和持久映射由调用方负责，数字 ID 应先明确编码为字符串，避免碰撞。库不调用 `cognition/persistence.lua`，也不验证其业务 schema。
- `event`：恰好 `{"id": 非空字符串, "type": 非空字符串, "data": JSON对象}`。ID 在本世界永久唯一；事件 `type` 和 `data` 的语义由调用方定义。一个提交对应一个事件与一个完整快照，失败尝试是否记事件由调用方决定。
- `clock`：恰好 `{"time": 有限非负数, "paused": 布尔}`。初始时间为 0，初始暂停。时间单位由调用方统一指定；`elapsed` 是调用方确认的非负有限模拟时间，库不读取系统时钟、不计算倍率、不自动推进。暂停状态下 `elapsed` 必须为 0，即使同一提交要恢复运行；运行状态下可在一次提交中先推进 `elapsed` 再设 `paused=True`。等待、离线或暂停的时间应由调用方排除；进程重启本身不增加时间，恢复后 `paused` 保持上次值，调用方决定何时推进。
- `expected_version`：从 0 起的非负整数，必须匹配当前版本；每次成功提交加 1。上限为 SQLite 有符号 64 位整数范围。
- `recover()` 返回 `{"version": 整数, "world": 对象, "characters": 对象, "clock": 对象, "events": [{"version": 整数, "event": 事件对象}, ...]}`，事件按版本递增。数据库 schema 使用 `PRAGMA user_version=1`、单行 `checkpoint(singleton, version, snapshot)` 与 `events(version, event_id, request, result)`；事件保留完整请求，以验证快照与事件历史一致并支持精确重试。

## 用法

```python
from world.store import WorldStore, Conflict, CorruptStore

s = WorldStore("world.sqlite", create=True)  # 首次显式创建；已有库不会重置
try:
    state = s.recover()
    world = {"resources": {"tree:1": 2}}
    characters = {"agent:1": {"pos": {"x": 1, "y": 2, "z": 3}, "memory": []}}
    event = {"id": "command:42", "type": "world.started", "data": {}}
    result = s.commit(event, state["version"], world, characters, paused=False)
    # 原样重试，即使当前版本已变化，也返回同一个结果，不重复提交。
    assert s.commit(event, state["version"], world, characters, paused=False) == result
    state = s.recover()
    s.commit({"id": "command:43", "type": "world.paused", "data": {}},
             state["version"], state["world"], state["characters"], elapsed=3, paused=True)
finally:
    s.close()

s = WorldStore("world.sqlite")  # 只打开已有库
try:
    restored = s.recover()  # 恢复时间、全部角色和有序事件
finally:
    s.close()
```

重试必须保留相同 ID 和**整个请求**，包括原版本、快照、时间增量与暂停参数；同 ID 不同请求抛 `Conflict`，新的 ID 使用旧版本也抛 `Conflict`。客户端在提交结果不确定时可按原请求重试或读取恢复结果核对 ID；不能仅凭异常认定提交未发生。调用方应在提交前验证动作和所有输入依赖，冲突后重新判定，不能将旧推演直接套到新版本。事务通过 SQLite 写锁序列化，版本检查防止多个写入者覆盖；不要在多线程共用同一个连接。

恢复在一致的 SQLite 读事务中检查数据库、schema 版本、checkpoint、事件序列、事件请求、时间规则以及由全部事件重放出的完整快照。校验失败抛 `CorruptStore`，不会清空或自动修复已有数据库；缺失文件默认无法打开。底层无法打开数据库时 SQLite 异常会直接传递。该校验不是防篡改或备份方案，无法检测能够同步改写全部历史与快照的恶意修改；整库丢失、磁盘损坏和旧格式迁移仍需独立备份及运维策略。完整快照存于每条事件，恢复和存储成本随历史与状态大小增长，目前没有截断或压缩协议。

仅验证本库，不涵盖 Luanti 地图、角色重建、引擎进程崩溃窗口或断电。集成方必须验证并协调这些外部操作；本模块不能替代跨存储恢复协议。

运行轻量单测：`python3 -m unittest discover -s world -p 'test_*.py' -v`。

## 受控资源投影协调器原型

`reconcile.py` 只供假引擎原型使用，**尚未接入 Luanti**。必须由外部保证：一个协调器独占事务库和注册项的所有写入；初始化、提交和恢复期间阻止其他写入与读取／对外展示；引擎适配器可靠提供稳定的世界 ID，且该 ID 不被其他世界复用。模块不生成或认证世界 ID，也没有跨进程锁、访问控制或地图持久化证明，不能检测第三方写入恰好等于历史值的情况。违反排他前提时不可安全运行。

注册 `nodes` 是 `{非空节点键: 非空资源名}`，每个节点只允许 `air` 或其对应资源名；`characters` 是互不重复的非空角色 ID 列表。角色库存是 `{已注册资源名: 正整数}`，零数量通过省略键表示，单项最多 2147483647。节点键是调用方标识，模块不解析坐标，不检查距离、权限、节点 metadata、回调或库存之外的角色状态。不要用它声称任意 Luanti 节点和完整角色已可恢复。

适配器提供 `get_world_id() -> 非空字符串`、`get_node(key) -> str`、`set_node(key, name)`、`get_inventory(id) -> dict`、`set_inventory(id, dict)`；写入返回 `False` 或抛异常表示失败，返回其他值后仍需回读。读取不可用时必须抛异常或返回无效值，不能伪装成 `air` 或空库存。协调器不负责加载区块或使 Luanti 节点缓存失效，真实适配器必须处理这些问题，且不能在其他写入者仍运行时使用。

```python
from world.store import WorldStore
from world.reconcile import Coordinator

store = WorldStore('resource.sqlite', create=True)
co = Coordinator(store, engine, {'1,0,0': 'ore'}, ['agent:1'], world_id='world-unique-id')
# 仅第一次使用空库；初值必须与适配器逐项读取一致。
co.initialize('world-init-unique-id', {'1,0,0': 'ore'}, {'agent:1': {}})
co.apply('command-unique-id', 'gather', '1,0,0', 'agent:1')
store.close()

store = WorldStore('resource.sqlite')
co = Coordinator(store, engine, {'1,0,0': 'ore'}, ['agent:1'], world_id='world-unique-id')
co.reconcile()  # 启动时必须先对账，再开放调用
# 相同 ID 与相同 kind/node/character 重试，返回原版本，不重复结算。
co.apply('command-unique-id', 'gather', '1,0,0', 'agent:1')
store.close()
```

协调器要求非空 `world_id`；初始化先核对适配器 ID，再将其写入初始化事件和事务快照。恢复及后续提交前核对请求、数据库和适配器的 ID，不匹配则在投影或事务写入前拒绝。适配器必须独立、可靠地读取实际世界的持久身份；假引擎仅模拟这一契约，不能证明真实 Luanti 世界绑定。旧版无身份的协调器数据不自动迁移，必须拒绝恢复并另行设计迁移。初始化事件固定 registration 与初始节点、库存。后续每个 `resource.change` 事件保存 `kind`、`node`、`character`；事务快照以 `world = {schema: 2, world_id: 世界ID, registration: nodes, nodes: 当前节点}` 和 `characters = {角色ID: {inventory: 库存}}` 表达。恢复对事件业务规则逐项重放，并与事务快照比较，再一次性预检所有注册项：投影值必须出现在该项的已提交历史中；未知值停止且不开始修复。预检通过后，逐项写成最新目标并回读，最后再次读取所有项，才将协调器置为 ready。历史旧值的可接受性完全依赖排他前提，不能证明这些值一定是本协调器写出的。

提交前先校验投影与当前快照及 gather/build 条件；提交后对账投影，只有全部回读一致才返回。任何错误将本实例置为非 ready；调用者须解决问题并调用 `reconcile()`，再使用**原操作 ID 和参数**重试。提交异常可能是结果未知，不能改用新 ID。初始化响应丢失时重新打开库并尝试 `reconcile()`，不能重复初始化或删除数据库。相同操作 ID 配不同参数会拒绝。库内事务提交与投影写入不是跨存储原子操作，读取一致也不等于地图已落盘；启动时始终重新对账。

当前实现保留全历史并线性扫描，且允许逐项重放历史旧值；它不支持并发操作、部分注册、自动注册或外部节点更新。验证只覆盖假引擎与临时 SQLite；尚无进程杀死、断电、Luanti 地图或角色实体集成证据。
