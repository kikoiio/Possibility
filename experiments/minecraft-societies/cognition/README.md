# 角色观察与记忆

两个无全局状态的 Lua 5.1 模块，可在普通 Lua 测试，也可由 Luanti mod 用 `dofile` 加载。当前是可集成组件，**尚未接入 M0 驱动**；M0 原有 `policy.lua` 的 observation 和 `memory.met` 格式不同，需要调用方显式适配。

## 局部观察

```lua
local observe = dofile(path .. "/observation.lua")
local obs, err = observe.observe(minetest, self.object, {
  radius = 8,
  agent_name = "society:agent", -- 可省略，默认此名称
  node_names = {"society:mark"}, -- 必填；空数组不查询节点
})
```

返回 `{pos, radius, agents, nodes}`，位置均为 `{x, y, z}`。`agents` 元素为 `{id, pos, distance}`，从 Luanti 对象的 Lua 实体读取 `name` 与 `_id`（字符串或数字），排除自身，只保留三维欧氏距离不超过半径的对象，按 ID 类型及值排序。`nodes` 元素为 `{name, pos}`，只包含明确列出的节点名，先查询包围盒再过滤球体，按坐标排序；未加载节点被跳过。结果是新建的表，不包含其他角色的 persona、记忆或 Lua 实体。自身位置不可用时返回 `nil, "observer has no position"`；无效参数报错。

此接口是局部范围感知，不进行视线遮挡、视野方向或权限判断；不应声称结果是视觉上可见的。半径和节点列表由调用方限制；引擎的范围查询可能昂贵，尤其是旧版 Luanti，调用频率和规模需要单独测量。返回的距离为采样时距离，对象可能随后移动。

## 记忆

```lua
local memory = dofile(path .. "/memory.lua")
local mine = memory.new(128)  -- 每个角色创建独立实例
mine:add({time = 12, text = "附近有标记", source = {kind = "observation", id = "agent-1"}})
mine:add({time = 13, text = "agent-2 说这里安全", source = {kind = "agent", id = "agent-2"}})
local records = mine:list()  -- 从最早插入到最新；返回副本
mine:size()
mine:clear()
```

`new(capacity)` 接受非负整数，超出容量时按**插入顺序**淘汰最早记录；容量为零时 `add` 校验后返回 `false`，否则返回 `true`。每条记录必须有有限数字 `time`、字符串 `text`、非空字符串 `source.kind` 及非空字符串或有限数字 `source.id`。来源和时间由调用方提供，模块不验证真实性、不自动转存观察、不把其他角色的私有记忆变成公共信息。输入及输出被复制，实例不共享状态。容量限制的是**记录数**，不是文本字节数；调用方负责限制文本大小。内存只在进程中存在，无持久化和快照。

## 测试

从本目录运行 `lua5.1 test.lua`（也可用 LuaJIT）。测试使用模拟 Luanti API，覆盖范围过滤、隐私字段、缺失位置、来源、FIFO 淘汰、实例隔离与输入输出副本；它不代替真实 Luanti 集成或性能测试。
