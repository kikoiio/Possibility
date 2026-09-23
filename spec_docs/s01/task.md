# s01｜P3 Fork 与 Compare 验收闭环 Tasks

> 依据：[spec.md](./spec.md) 与 [plan.md](./plan.md)。四份规格文档全部获批前不得开始实现。先复核已有覆盖，只为实际暴露的缺陷做最小修复。所有自动验收使用一次性隔离本地 D1、固定模型替身和合成账号，不连接项目默认/远端数据库。

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 修改 | `docs/current-state-audit.md` | 记录 P3 起点、已有覆盖及本轮实际证据。 |
| 修改 | `scripts/verify-s01-workers.ts` | 扩展两个独立 Worker 共享临时 D1 的 Fork 并发验收。 |
| 修改 | `api/src/life/compare.test.ts` | 补多级记忆/承诺/知识隔离矩阵和拒绝无副作用断言。 |
| 修改 | `api/src/test/world-journey.test.ts` | 补消息进入接收者后续上下文的固定模型旅程。 |
| 条件修改 | `api/src/life/fork.ts`、`api/src/worlds/routes.ts`、数据库迁移 | 仅修复多 Worker 证据复现的快照/事务/约束缺陷。 |
| 条件修改 | `api/src/agent/visibility.ts`、`api/src/world-state/invariants.ts` | 仅修复隔离矩阵或审计证据复现的可见性/完整性缺陷。 |
| 条件修改 | `api/src/life/compare.ts`、`web/src/components/world/ComparePanel.tsx` | 仅修复登录态走查发现的对照证据/文案/返回选线缺陷。 |
| 修改 | `spec_docs/s01/checklist.md` | 记录 AC1–AC6 的逐项结果和证据。 |
| 修改 | `docs/world-quality-report.md` | 更新 P3 出口状态及遗留边界。 |

不预设新增业务表、依赖、迁移或浏览器自动化框架。条件修改只有在对应验收复现缺陷时执行。

## T01｜记录 P3 起点并核对现有覆盖

**文件：** `docs/current-state-audit.md`；只读核对 Fork、Compare、消息知识及 Worker 验收路径。
**依赖：** 无。

**步骤：**
1. 记录 P3 开始时的 HEAD、分支和工作区状态，并注明现有未提交文档/代码不属于 P3 新增实现成果。
2. 按 AC1–AC6 对照现有实现与证据，逐项标记已有覆盖和仍缺证据。
3. 记录 `scripts/verify-s01-workers.ts`、Fork/Compare 路由、checkpoint 可见性、消息上下文与登录态 UI 的复用位置。

**验证：** 起点可由 Git 状态命令复核；AC1–AC6 每项有对应既有证据或清楚记录的缺口。（AC6）

## T02｜准备 Fork 多 Worker 验收夹具

**文件：** `scripts/verify-s01-workers.ts`。
**依赖：** T01。

**步骤：**
1. 保留现有专用临时目录、metrics 关闭、两个 Worker 启动和清理逻辑。
2. 为合成账号创建仅供本地验收的 session，并准备可 Fork 的结构化世界、源 revision 和固定分叉条件。
3. 验证两个 Worker 都能通过健康检查并访问同一隔离 D1；输出确认只使用本地库的环境摘要。

**验证：** `npm run verify:s01:workers -- --readiness-only`；两个 Worker 就绪并共用打印出的唯一临时 D1 路径，完成后无遗留进程/数据。（N1、N3）

## T03｜覆盖并发 Fork 与请求幂等

**文件：** `scripts/verify-s01-workers.ts`。
**依赖：** T02。

**步骤：**
1. 使用屏障让两个 Worker 并发向同一源时间线提交不同 request ID 的 Fork。
2. 验证每个成功子线 checkpoint、revision 0、复制状态和源版本彼此一致；不得出现半成品时间线。
3. 让不同 Worker 使用同 ID/同内容重试，再以同 ID/不同内容重试；验证前者返回同一子线，后者冲突且不新增记录。

**验证：** `npm run verify:s01:workers`；输出每个请求的 HTTP 状态、最终时间线数及源/子线 revision；D1 查询确认没有重复子线或部分投影。（AC1）

## T04｜覆盖源版本竞争、容量冲突与事务失败

**文件：** `scripts/verify-s01-workers.ts`；若实际复现缺陷，再修改 `api/src/life/fork.ts`、`api/src/worlds/routes.ts` 或最小必要迁移。
**依赖：** T03。

**步骤：**
1. 让一个 Worker 的 Fork 与另一个 Worker 对源线的版本化写入竞争，验证子线要么对应写入前一致快照，要么明确冲突。
2. 达到 active timeline 上限后并发再发 Fork，核对容量拒绝不会多建时间线。
3. 在隔离库注入子线初始投影写入失败，比较事务前后时间线、revision、命令、事实和投影集合。
4. 如触发缺陷，先新增最小回归，再修复现有事务/约束边界并重跑对应场景。

**验证：** `npm run verify:s01:workers`；所有成功响应都指向有效源版本，冲突/故障没有半写入，最终 D1 不变量通过。（AC1、AC5）

## T05｜验证 Root→Child→Grandchild 的记忆与承诺边界

**文件：** `api/src/life/compare.test.ts`；仅在失败时条件修改可见性或审计模块。
**依赖：** T01。

**步骤：**
1. 在 Root 写入分叉前记忆和开放承诺，创建 Child；验证两项在 Child 的 checkpoint/投影中可见。
2. Child 创建后向 Root 追加记忆/承诺，再由 Child 创建 Grandchild；验证已存在的 Child/其 checkpoint 不吸收后加内容，Grandchild 只继承其 Fork 时符合 cutoff 的内容。
3. 在 Child 与 Grandchild 分别追加记录，验证变更不反向污染 Root 或旁支；对三条线运行只读审计。

**验证：** `npm --workspace api run test -- src/life/compare.test.ts`；断言逐条覆盖可见/不可见记录和 checkpoint 来源，三线审计没有未解释差异。（AC2）

## T06｜补齐多级 Fork 知识可见性矩阵

**文件：** `api/src/life/compare.test.ts`。
**依赖：** T05。

**步骤：**
1. 在 Root、Child、Grandchild 设置不同接收者、来源和 certainty 的结构化知识。
2. 分别检查分叉前知识继承、Fork 后祖先新增知识不下渗、当前父线内容在下一次 Fork 时按检查点继承。
3. 检查同一世界的无关居民、Root、Child、Grandchild 和旁支之间没有越界知识；对 legacy checkpoint 保留不完整/未知语义。

**验证：** `npm --workspace api run test -- src/life/compare.test.ts`；每条知识按 timeline、recipient、source fact 和 certainty 断言；未知历史未被补造。（AC2、AC5）

## T07｜完成消息提交到接收者上下文的旅程

**文件：** `api/src/test/world-journey.test.ts`；仅在失败时条件修改场景提交或上下文装配路径。
**依赖：** T05、T06。

**步骤：**
1. 在固定小世界中创建子线，并由在场身份向合格居民提交一条固定消息。
2. 从提交结果记录 timeline、command/fact ID、版本和 certainty。
3. 构造接收者后续决策上下文，确认它包含对应来源证据；为其他居民、Root 及旁支构造上下文并确认不可见。
4. 运行只读审计；不要求固定模型产生特定回复或行动。

**验证：** `npm --workspace api run test -- src/test/world-journey.test.ts`；接收者上下文含正确来源，隔离上下文不含消息，审计无差异。（AC3）

## T08｜复核 Fork/Compare 权限与失败无副作用

**文件：** `api/src/life/compare.test.ts`；必要时扩展 Fork Worker 夹具或相关现有路由测试。
**依赖：** T03–T07。

**步骤：**
1. 覆盖跨用户、错配世界/时间线、归档源线和失效源版本的 Fork/Compare 请求。
2. 覆盖并发冲突和注入事务故障后，对比源/目标 revision、命令、事实、投影及 active timeline 集合。
3. 确认 Compare 仅返回已授权世界的两条时间线证据，所有拒绝没有部分副作用。

**验证：** `npm --workspace api run test -- src/life/compare.test.ts`；每种拒绝状态明确，关键数据库集合前后相同。（AC5）

## T09｜完成本地登录态 Compare UI 人工走查

**文件：** `docs/current-state-audit.md`；若有缺陷则条件修改 `api/src/life/compare.ts` 或 `web/src/components/world/ComparePanel.tsx`。
**依赖：** T05–T08。

**步骤：**
1. 使用本地合成账号和隔离数据提交一条在场消息，检查用户可见结果区分“提交/进入接收者知识”和“居民已阅读或采取行动”。
2. 打开 Compare，检查结构化 Fork 的分叉条件、共同历史、状态/事实/事件差异及证据来源/版本/时间。
3. 加载无完整 checkpoint 的 legacy Fork，确认界面明确提示历史不完整，不推断共同过去。
4. 检查不同模拟时刻和因果限制文案；退出对照返回所选线，确认页面状态没有沿用另一条线的内容。
5. 记录具体页面观察；只有发现缺陷时才做最小修复并复走该场景。

**验证：** 登录态本地浏览器走查记录包含所用时间线、观察结果和任何修复后的复测；API/Web 构建通过。（AC4）

## T10｜运行 P3 自动化回归与构建

**文件：** 无新增产品文件；汇总实际命令与结果。
**依赖：** T03–T09。

**步骤：**
1. 运行 `npm run verify:s01:workers`。
2. 运行 `npm --workspace api run test -- src/life/compare.test.ts src/test/world-journey.test.ts`。
3. 运行 `npm --workspace api run build` 和 `npm --workspace web run build`。
4. 任一失败时回到对应任务修复并重跑受影响验证；记录实际命令、退出码和隔离环境。

**验证：** 所列多 Worker 场景、API 定向测试和两个 workspace 构建均成功；未证明项保留未通过/未知。（AC1–AC3、AC5–AC6）

## T11｜更新 checklist 与 P3 阶段报告

**文件：** `spec_docs/s01/checklist.md`、`docs/current-state-audit.md`、`docs/world-quality-report.md`。
**依赖：** T01–T10。

**步骤：**
1. 为 AC1–AC6 填写实际结论和可复核证据；区分自动测试、隔离 Worker 结果与人工浏览器观察。
2. 记录临时 D1 路径策略、Worker 数量、固定模型替身、命令结果及清理情况；不得记录凭据。
3. 对无法证明的行为和 legacy/unknown 范围明确保留，不以推测关闭验收。
4. 只有 AC1–AC5 全部通过且 AC6 报告完整时，才在报告中标记 P3 出口通过。

**验证：** 每项通过结论均指向实际证据；任何未通过或未知项都阻止 P3 出口通过。（AC6）

## 执行顺序

```text
T01 → T02 → T03 → T04 ─┐
              T05 → T06 → T07 ─┼→ T08 → T09 → T10 → T11
                               ┘
```
