# Wispiva

一个给第一用户（作者本人）的平行世界模拟器：世界线持续运转，随时问一个"如果…"、修改任意设定，在多元宇宙里观察命运分岔。

## 核心需求

- 持续运转的世界，时间与真实时钟耦合（默认 24 倍速起，可加速、可暂停）。
- 任意时刻可 fork；可自由批量修改角色、事件、世界设定，确认后生成新分支继续运行。
- 纯 LLM 驱动的事件引擎，不预设固定行为规则；prompt 携带角色现状。
- 实时观看使用 3D 画面，视觉必须有吸引力；用户可通过文本创建和修改世界。
- 完整历史 log，可回查任何分支（包括离开观看的分支）。
- 带 LLM 的世界/角色编辑器。
- 默认本机运行（进程不在则世界冻结）；支持自托管云服务器实现 7×24 常驻。
- LLM 调用节拍与成本上限由用户配置。

完整需求见 [docs/requirements.md](docs/requirements.md)。

## 状态

从零重建中。旧实现（世界/人物/时间线分叉/场景展示）已删除，可从 git 历史 `f0c207e` 查看。第二轮可玩原型于 2026-10-24 完成机制验证后删除，参考实现保留在 git 历史 `dea81b8`。

v1 架构正在根据创世与视觉需求修订：[docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)。文本生成 3D 的候选路线与来源见 [调研文档](docs/architecture/TEXT-TO-3D-RESEARCH.md)；视觉契约尚未冻结。[docs/architecture/SYNTHESIS.md](docs/architecture/SYNTHESIS.md) 及 candidates 仅作历史裁决记录。

## 开发

规划中的 monorepo 结构为 `packages/contract`、`engine`、`web`，见架构文档。代码骨架尚未落地；落地前根目录没有可运行脚本。
