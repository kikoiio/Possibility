# L2 长期记忆 API 设计审查

核对日期：2026-10-30。审查对象是 `cognition/long_term_memory.lua` 及其当前测试和 Luanti 调用点。本次只记录接口契约和验证矩阵，不修改实现文件。

## 结论

当前实现把 L2 定义为角色对一组本人 L1 经历的追加式解释：每个主题按角色独立递增版本，L2 记录保留它引用的 L1 ID。这个边界适合作为“可追溯的反思记录”底层存储，能够拒绝跨角色引用、跳号版本、重复 ID 和非法字段。

当前公开 API 已提供受约束的 `store:reflect(...)` 包装器，调用者不必手写 L2 记录字段；底层 `store:append(record)` 仍保留给恢复和特权导入。实现没有把某个版本标记为当前有效版本；检索会返回该所有者的 L1 与全部 L2 记录。因此上层必须明确选择“读取全部历史”还是“按主题取最新版本”，不能把 L2 自动当作事实或唯一答案。

## 当前接口签名

以下是 Lua 5.1 形式的当前签名。返回的记录和快照都是深拷贝，调用者修改返回值不会直接修改存储。

```lua
memory.new() -> store
memory.load(snapshot) -> store

store:append(record) -> copied_record
store:export() -> { version = 1, records = record[] }
store:count() -> integer

store:record_outcome(
  actor, kind, ok, reason, time,
  recipient?, message?, detail?, event_id?
) -> event_id

store:record_meeting(actor, other, time, event_id?) -> event_id

store:reflect(
  owner, topic, experience_ids, text, time, source_id?
) -> copied_L2_record

store:retrieve(owner, {
  cursor?, max_scan, max_entries, max_bytes, query
}) -> record[], metadata
```

`record_outcome` 和 `record_meeting` 是 L0/L1 事件桥接 API；它们不是 L2 API，但会产生 L2 的输入经历。`export()` 是特权快照接口，包含所有 owner 的记录，不能直接暴露给角色。

## L2 记录签名与不变量

L2 通过 `append` 写入，必需形状如下：

```lua
{
  layer = "L2",
  id = nonempty_string,                 -- 全局唯一
  owner = nonempty_string,              -- 解释的角色
  time = finite_number,
  text = string,
  source = {
    kind = nonempty_string,
    id = nonempty_string,
    revision = integer_0_to_2^53?,
  },
  audience = nonempty_unique_string_array?,
  topic = nonempty_string,
  version = positive_integer,
  experiences = nonempty_unique_string_array, -- L1 IDs
}
```

实现强制以下关系：

1. `id` 在整个 store 内唯一；记录采用追加式写入，不能覆盖已有记录。
2. `experiences` 中每个 ID 必须已经存在、层级为 L1、并且 `source.owner == L2.owner`。L2 不能直接引用 L0、别的角色的 L1 或另一条 L2。
3. `version` 按 `(owner, topic)` 单独计数，必须从 1 开始连续递增。版本号不能跳过，也不能重复。
4. L2 不允许 `classification`；它的认识状态由上层模型输入协议解释，存储层只记录主题、文本和来源。
5. `audience` 非空、无重复；L2 的 audience 必须包含 owner。省略时默认为 `[owner]`。
6. `source` 只接受 `kind`、`id`、可选 `revision`；未知字段拒绝。`time` 只要求有限数值，没有单调性或时钟来源约束。
7. `experiences` 只保存 ID，不复制 L1 文本。因此删除、重写或跨快照迁移 L1 会破坏可追溯性；当前 `load` 会在加载时拒绝缺失引用。

## 检索和边界条件

`retrieve(owner, options)` 只检索该 owner 的 L1/L2 索引，按追加顺序倒序扫描。L0 不会出现在角色检索结果中；L0 只能通过 L1 的 `source` 或上层授权视图提供。

| 条件 | 当前语义 | 上层必须处理的结果 |
| --- | --- | --- |
| `options` 缺失 | 立即拒绝；没有默认预算 | 调用方必须显式给出全部三个预算和 query |
| `max_scan` | 1 到 10000，限制扫描数量 | `scan_limited=true` 时用 `next_cursor` 继续 |
| `max_entries` | 0 到 10000，限制返回条数 | 可以扫描但返回空页；不能把空页当成没有匹配 |
| `max_bytes` | 2 到 10000000，按保守 JSON 字节估算 | `result_limited=true` 或 `omitted>0` 表示预算不足 |
| `query` | 必须是字符串；空串匹配全部；大小写不敏感的纯子串 | 没有分词、排序相关性或语义检索 |
| `cursor` | 当前 owner 索引的排他上界，范围为 `1..#owner+1` | 使用返回的 `next_cursor`；新记录追加不会改变已有游标边界 |
| 单条记录超过 `max_bytes` | 该记录被省略，继续扫描 | 增大预算或记录省略，不会截断文本 |
| 无匹配 / 扫描耗尽 | `remaining=nil`、`next_cursor=nil` | 与预算导致的空结果区分 `matched`、`omitted` |
| 同一主题多个 L2 版本 | 全部都能返回 | 上层必须显式选择最新版本或保留历史并标注版本 |
| `importance` | 只校验为有限数值，当前不参与排序/筛选 | 不能宣称当前检索已经使用重要度 |

## 持久化、隐私和失败边界

- `export`/`load` 按记录顺序重建索引；快照记录顺序是协议的一部分，因为 L1 必须先于引用它的 L2 出现，主题版本也必须按顺序出现。
- `load` 在遇到坏记录、缺失 L0、缺失 L1、跨 owner 引用、版本跳号或稀疏数组时拒绝整个快照；文档化的恢复策略应是冻结或人工修复，而不是忽略坏记录继续运行。
- `append` 返回深拷贝并拒绝未知字段，但没有独立的批量事务或回滚 API。`record_outcome`/`record_meeting` 先验证批次再逐条追加；若未来出现存储写入异常，当前接口没有向调用方承诺跨记录原子性。
- audience 是记录级授权提示，不是独立的安全隔离。文件级 `export` 仍包含所有 owner；宿主必须在调用 `retrieve`、组装模型输入和导出快照前认证 owner 与权限。
- 当前没有 L2 专用幂等 operation key。使用相同 `id` 重试会被拒绝；使用新 `id` 重试会产生新版本或重复解释。需要重试语义的上层应在写入前持久化 operation identity。

## 测试矩阵

状态按当前 `cognition/test_long_term_memory.lua` 判断：`现有` 表示已有直接覆盖，`缺口` 表示应补充的验证项；本次审查不修改测试文件。

| 类别 | 场景 | 期望 | 状态 |
| --- | --- | --- | --- |
| 构造 | 最小合法 L2，引用同 owner 的已存在 L1 | append 成功，版本 1 可检索 | 现有 |
| 构造 | L2 缺 topic/version/experiences | 拒绝 | 缺口 |
| 构造 | experiences 为空、重复 ID、包含 L0 | 拒绝 | 缺口 |
| 引用 | 引用另一 owner 的 L1 | 拒绝 | 现有 |
| 引用 | 引用 L2 或不存在的 ID | 拒绝 | 现有 |
| 版本 | 同 owner/topic 版本 1、2 连续追加 | 成功，两个版本均保留 | 现有 |
| 版本 | 首次版本不是 1、跳号、重复版本 | 拒绝 | 现有 / 缺重复重试说明 |
| 版本 | 不同 owner 或不同 topic 各自从 1 开始 | 成功，互不冲突 | 缺口 |
| 身份 | L2 ID 与任意已有 L0/L1/L2 重复 | 拒绝且存储不变 | 现有基础覆盖 |
| 来源 | source 未知字段、空 kind/id、非法 revision | 拒绝 | 缺口 |
| 时间 | NaN、正负无穷、普通负数、非单调时间 | 非有限值拒绝；有限值可存储 | 缺口 |
| audience | 缺 owner、重复成员、空数组、L2 不含 owner | 拒绝 | 缺口 |
| 隐私 | owner A 检索不能看到 owner B 或 L0 | 只返回 A 的 L1/L2 | 现有基础覆盖 |
| 查询 | query 空串、大小写差异、纯子串 | 匹配计数和结果正确 | 现有 |
| 预算 | max_scan、max_entries、max_bytes 分别触顶 | metadata 明确扫描/结果省略原因 | 现有 |
| 游标 | 取页后追加新记录，再用旧 next_cursor | 不重复已消费记录，不把新记录插入旧页 | 现有 |
| 游标 | 非法 cursor、边界 cursor、owner 无记录 | 拒绝或返回空页，语义稳定 | 部分现有 |
| 版本读取 | 同主题有多版 L2 | 返回全部，调用方能按 version 选择 | 缺口 |
| 复制 | 修改 append/export/retrieve 返回值 | 内部存储不变 | 现有 |
| 恢复 | export→load 后 L2 引用和版本索引保持 | 成功 | 现有 |
| 恢复失败 | 快照中 L2 排在其 L1 前、缺引用、版本跳号 | 整个 load 拒绝 | 现有部分 |
| 批次 | outcome/meeting 的任一关联记录非法或重复 | 不产生部分可见批次 | 缺口：需明确原子性承诺 |
| 重试 | 相同 operation 重试、相同 event/id 重试、新 id 重试 | 明确区分幂等成功、冲突拒绝和重复写入 | 缺口 |
| 容量 | 超长 text、极大 experiences、接近 JSON 上限 | 按预算拒绝或可预测地省略，不造成无限扫描 | 缺口 |

## 后续接口决策

在需要把 L2 接入真实 reflection worker 前，应先确定四个上层契约：

1. 是否增加按主题取最新版本的明确查询，或继续由模型输入组装器过滤全部历史。当前 `retrieve` 不表达“当前解释”。
2. 是否为反思任务引入持久 operation ID，使重试可以返回已有记录而不是依赖自动生成的 `(owner, topic, version)` ID 冲突。
3. 是否需要批量提交/回滚协议。若 L2 与角色快照、事件账本一起保存，必须继续沿用产品状态的协调提交边界，并把未知状态冻结，不能把部分写入当成成功。

`store:reflect` 已解决构造字段和来源归属的重复校验，但它仍是单 store 的追加操作：相同反思请求重试会生成下一版本，不能单独承诺跨事件、角色快照和世界状态的幂等提交。模型驱动触发、质量评估和按情境组装仍属于上层产品工作。

这些决策属于上层产品协议；当前 L2 存储层已经可以作为 append-only、可追溯的底座，但不能单独证明语义记忆质量、跨存储原子提交或角色权限安全。
