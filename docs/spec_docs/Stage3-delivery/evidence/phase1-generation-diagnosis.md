# 阶段一生成失败：轻量代码诊断

日期：2026-10-07（Asia/Shanghai）

验收分支：`phase3`

应用源码基线：`07dcdb40e9cfec19524bded888faee6498f2cea1`

相关实测：[`phase1-g0-checkpoint.md`](phase1-g0-checkpoint.md)、[`phase1-generation-results.json`](phase1-generation-results.json)

## 本次范围

本检查点只做证据整理和源码静态追踪，没有运行浏览器、构建、测试或模型调用。代码结论均基于上述源码基线；没有把候选机制写成已证实的单次请求根因。

## 已复核的实现路径

1. `api/src/voxel/generate.ts:344-374` 每次生成会组装场景、执行 `validateDocument`，结构通过后运行 `validateWalkability`。出现问题时最多取前六条 issue，附对应提示后请求模型重出完整 JSON。`walk-connectivity` 和 `walk-gap` 分别提示提供可达站位/入口与填平缺口，但此处没有确定性改图步骤。
2. `api/src/voxel/normalize.ts:71-121` 的确定性归一会运行结构及通行性校验；仅当所有 issue 都是 `walk-clearance` 时尝试把问题格上方设为空气。出现 `walk-connectivity` 或 `walk-gap` 会直接标记不可修复，交给生成重试链。因此现有 502 与反复通行性问题相符，但仅凭保存的 issue code 无法判断具体布局触发点。
3. `api/src/scenes/voxel-draft.ts:152-154` 自建草稿的收尾校验只检查地点名是否缺失；它没有在此处要求名称集合精确相等/唯一，也没有确认地点 `objectId` 对应存在的对象或资产摆放。`api/src/voxel/generate.ts:294-309` 会过滤掉不存在 `objectId` 的地点绑定，但不会保证所有世界地点都有一个唯一且有效的承载物。
4. 同文件 `api/src/scenes/voxel-draft.ts:93-97` 的原世界补建会要求地点名数量相等、名称唯一且与原地点一致；它也没有在这个收尾检查处验证每个地点都有不同且仍然存在的承载对象。底层生成器只验证传入的绑定引用在组装时有效，并不等同于“每个地点均已绑定”。

## 对已保存实测的解释边界

- `custom-1` 的 200 与地点绑定 8 项、物体 3 项相符于“地点数量并未要求一地点一载体”的静态缺口。因已保存结果没有逐个 `locations[].objectId`、最终 `objects[].id` 和资产摆放 ID，当前不能证明这三个对象是否被重复绑定，也不能证明 API 的所有最终门槛都接受该文档。
- `custom-2`、`custom-3` 的 `walk-clearance`，官方示例及补建的 `walk-connectivity`/`walk-gap`，与生成器的通行性重试机制一致。现存 JSON 未保存各次 attempt 的原始输出、完整 issue message、坐标和提示文本，无法区分模型未按反馈修正、生成提示约束不足、校验与生成语义不匹配，或不同 provider 响应造成的情况。
- 上述缺口是同一源码基线上的静态观察，不代表阶段一生成验收通过；当前自建单空间与原世界补建仍均未保存成功。

## 下次复验应补齐的轻量记录

在获准的 provider 请求预算内复验同一组四条提示和两种保存对照时，每条请求应记录：请求 ID、attempt 序号、provider HTTP 状态、消耗次数、最终 issue 的 code/message/坐标、每轮修复提示、最终文档中的 `locations`、对象 ID、资产摆放 ID及其绑定映射。脱敏后保留结构摘要或哈希；不得记录密钥或 token。

通过判据仍以真实旅程证据为准：每个世界地点有唯一有效载体、完整通行性校验通过；自建单空间实际保存成功；补建写回同一原 world ID 且保留原居民/时间线；随后完成阶段一同账号旅程的交谈/分叉、认领、所有者管理、编辑、分屏和刷新继续。

## 当前判定

阶段一 G0 仍未通过。此记录缩小了需要追踪的实现范围，但没有替代真实生成复验、世界/场景保存对照或完整浏览器旅程。
