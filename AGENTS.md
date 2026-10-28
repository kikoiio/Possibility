# Agent 入口

- 接手仓库任务时，先阅读 [docs/PLAN.md](docs/PLAN.md)，再按需阅读 [Agent 导航](docs/for_agent/README.md)、需求、架构和研究。先核对工作区差异与实际文件，不把设计、计划或历史结果当作当前验证。
- 任务取得进展或中断时，更新 `docs/PLAN.md` 的进度、产物、验证结果、未完成项和下一步。
- 项目级需求、架构、计划与研究放在 `docs/`；`docs/source-texts/` 只放原始故事文本。
- 一次性原型放在 `proto/<方向>` 分支，不合并到主线；在相关计划或设计记录目的、结论、分支、提交及证据。现有创建世界原型保存在 `proto/world-genesis`，不可把固定样例冒充模型创建世界结果。
- 独立研究实验按方向使用 `experiment/<方向>` 分支，与原型隔离，维护独立依赖、验证、说明和证据；Minecraft 社会实验位于 `experiment/minecraft-societies`。项目级研究结论和进度记录仍留在 `docs/` 与 `docs/PLAN.md`。
- 新功能应在适当的功能分支开发，基于需求重新实现与验证；不得把一次性原型分支整体合并进主线。
