# 文档索引

| 类型 | 状态 | 更新 / 核对 | 文档 |
| --- | --- | --- | --- |
| 项目意图与需求 | Wispiva 共同产品目标；本分支采用 Luanti | 2026-10-29 | [项目意图](intent.md) |
| 当前架构 | 本 worktree 的现有组件和缺口；L2 写回、belief 输入、BFS 导航、可控逻辑时钟及共享公开世界 fact 已接入，公开 fact Actions 验收待完成 | 2026-10-30 | [当前架构](architecture.md) |
| 仓库布局 | 产品实现、验证工具和历史证据的边界 | 2026-10-29 | [仓库布局](repository-layout.md) |
| 世界草稿创建与确认 CLI | 真实模型生成、草稿 JSON 导出／编辑、revision 确认、Luanti 持久发布与安全重试用法 | 2026-10-30 | [Genesis 操作说明](../genesis/README.md) |
| 目标架构 | Wispiva 产品在 Minecraft-like 基底上的目标实现；草案，不等同于现状 | 2026-10-29 | [目标设计](design/2026-10-27-target-architecture.md) |
| 集成审查 | 创建、世界身份、资源投影与记忆之间尚未解决的契约 | 2026-10-29 | [创建与持久世界集成审查](design/2026-10-29-origin-integration-audit.md) |
| 集成契约 | 面向假引擎的版本化起源、身份及资源对账设计提案 | 2026-10-29 | [世界起源契约](design/2026-10-29-world-origin-contract.md) |
| 产品提交与模型输入 | 产品状态账本、冻结恢复边界与 `wispiva.model-input` v1 | 2026-10-29 | [产品状态与模型输入边界](design/2026-10-29-product-state-and-model-input.md) |
| 真实模型角色与环境闭环验收 | 当前真实模型、fixture 产品闭环证据的边界，以及角色输入／输出、失败、记忆来源、有限导航和世界后果的验收设计 | 2026-10-30 | [真实模型角色与环境闭环验收设计](design/2026-10-30-real-model-world-loop-acceptance.md) |
| L2 长期记忆 API 审查 | L2 记录签名、不变量、检索边界与测试矩阵 | 2026-10-30 | [L2 长期记忆 API 设计审查](design/2026-10-30-l2-memory-api-review.md) |
| 意图到世界起点审查 | 当前用户意图到产品世界链路、同确认请求安全重试，以及跨存储发布状态和用户确认缺口 | 2026-10-30 | [意图到世界起点](design/2026-10-30-intent-to-world.md) |
| 计划审计 | 未完成项的证据、状态与下一步；已记录有限 BFS 导航接入及真实通行待验 | 2026-10-30 | [计划审计](design/2026-10-30-plan-audit.md) |
| 产品运行与三维观察 | 持续服务、观察者出生点及 Luanti 客户端进入路径 | 2026-10-29 | [当前架构](architecture.md) |
| 受控世界接入边界 | `launch.py` 在 Luanti 进程生命周期内持有 `WorldSession`；地图、事件、库存和记忆共同提交尚未完成 | 2026-10-29 | [启动器](../engine/luanti/launch.py)、[世界会话](../engine/luanti/world_session.py)、[世界身份](../engine/luanti/world_identity.py)、[世界锁](../engine/luanti/world_lock.py) |
| 版本化产品创建契约 | 世界身份、起源事件、草稿 revision、组件版本和 Luanti 启动前对账 | 2026-10-30 | [产品创建契约](design/2026-10-30-product-contract.md) |
| 工作计划 | 产品与真实模型 Actions 通过；真实 provider 并发测至 16，真人体验、真实意图确认和千级 LLM 服务能力仍待验 | 2026-10-30 | [工作计划](PLAN.md) |
| 规则／认知实体容量证据 | 20–10k 阶梯全员存活；10k 引擎 RSS 1.22–1.49 GiB；LLM 队列只做模拟，不代表真实模型容量 | 2026-10-30 | [容量阶梯证据](../evidence/luanti/agent/capacity-2026-10-30.md) |
| 研究 | 方法、容量与记忆研究；自由社会出现交流与物品转移但仍不稳定；提示改进后 36 次记忆对照中短线索 1/3、明确提取 3/3，需更多 seeds 和长期质量评估 | 2026-10-30 | [世界模型](research/2026-10-28-world-models.md)、[记忆](research/2026-10-28-memory.md)、[3D 生成](research/2026-10-28-3d-generation.md)、[Minecraft 社会](research/2026-10-28-minecraft-agent-societies.md)、[Mineflayer / Voyager](research/2026-10-28-mineflayer-voyager.md)、[记忆证据](../evidence/luanti/genesis/2026-10-30-cjk-free-society/README.md)、[自由社会证据](../evidence/luanti/product-model-2026-10-30/README.md) |
| 公开 CI 数据边界 | 原始私有记忆 artifact 已清理；后续上传按汇总文件 allowlist | 2026-10-30 | [产品模型和隐私复核](../evidence/luanti/product-model-2026-10-30/README.md)、[Actions 上传 allowlist](../.github/workflows/wispiva-validation.yml) |
| 原始素材 | 故事原文，导入模拟尚未实现 | 2026-10-28 | [《红发会》](source-texts/sherlock-holmes/the-red-headed-league.txt) |
| 创建世界原型 | 另一分支快照；可供参考，本 worktree 尚未接入 | 2026-10-28 | `proto/world-genesis`，`prototypes/README.md` |
| 运行时验证与历史证据 | Luanti 适配层的验证工具、历史计划和量测 | 2026-10-29 | [运行时说明](../validation/luanti/README.md)、[验证记录](../validation/luanti/PLAN.md) |
| 产品目录迁移验证 | 根目录迁移后的引擎、恢复及预览检查 | 2026-10-29 | [Actions 原始证据](../evidence/luanti/product-root-2026-10-29/README.md) |
| 起源原型验证 | 起源数据原型与既有运行时回归，未验证集成 | 2026-10-29 | [Actions 原始证据](../evidence/luanti/origin-2026-10-29/README.md) |
| 起源与资源集成验证 | 确认绑定、假引擎对账及既有 Luanti 回归 | 2026-10-29 | [Actions 原始证据](../evidence/luanti/origin-integration-2026-10-29/README.md) |
| 用户意图创建案例 | 两个非固定题材草稿与确认边界；中文自由聚落两轮真实模型持久世界和记忆隔离验收通过，usage artifact 与记忆评测汇总由 Actions 验证 | 2026-10-30 | [创建案例](../evidence/luanti/genesis/2026-10-29-product-intents/summary.md)、[中文运行记录](../evidence/luanti/genesis/2026-10-30-cjk-free-society/README.md) |
| 持久产品世界验证 | 已确认 Draft 到 Luanti 世界目录、空间投影、角色私有起点、环境过程、重启恢复和自动客户端验收 | 2026-10-29 | [原始证据](../evidence/luanti/product-world-2026-10-29/README.md) |
| 四角色长自由社会失败与恢复证据 | 91/96 决策、交互已出现；未 checkpoint，marker 保留，恢复协议待设计 | 2026-10-30 | [Actions 聚合证据](../evidence/luanti/product-model-2026-10-30/README.md#四角色长自由社会与恢复边界-actions-41113101332) |
| 真实模型产品世界验证 | 三角色对话／资源行动与反思恢复、四角色自由社会、provider 并发 1–16 回放；明确不代表千级 LLM 容量 | 2026-10-30 UTC | [原始证据](../evidence/luanti/product-model-2026-10-30/README.md) |
| 产品长期记忆主循环证据 | 主循环 L2 写回、belief 检索、正常重启后的版本和动作反馈保留 | 2026-10-30 UTC | [原始证据](../evidence/luanti/product-memory-runtime-2026-10-30/README.md) |
| 产品状态与模型输入验证 | `wispiva-product-state`、`wispiva.model-input` v1、preview 复制及持久产品世界恢复 | 2026-10-29 | [原始证据](../evidence/luanti/product-state-model-input-2026-10-29/README.md) |
| 世界会话边界验证 | Luanti 启动器持锁、身份建立、信号转发及跨进程生命周期 | 2026-10-29 | [原始证据](../evidence/luanti/world-session-2026-10-29/README.md) |
| 世界事件账本验证 | 行动结果、接触、幂等事件身份与 checkpoint 接入 | 2026-10-29 | [原始证据](../evidence/luanti/world-events-2026-10-29/README.md) |
| 启动器断电恢复标记 | marker 发布与已提交 checkpoint 窄恢复已通过；真实恢复又暴露草地自然演化误报，兼容性修复待 Actions | 2026-10-30 | [恢复入口](../engine/luanti/launch.py)、[地图投影](../engine/luanti/mod/society/world_projection.lua)、[恢复 journal](../engine/luanti/recovery_journal.py) |
| Actions 工作流审查 | 真模型、Luanti、GUI、容量验证的资源和失败诊断边界 | 2026-10-30 | [工作流审查](../.github/workflows/WORKFLOW-AUDIT.md) |
