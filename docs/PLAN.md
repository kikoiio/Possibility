# Wispiva 工作计划

更新日期：2026-10-28。

## 当前状态

- GitHub `main` 已启用规则集，要求 PR 和 GitHub Actions `branch-origin-guard` 检查，拦截 `proto/*`、`experiment/*` 直接合入；规则与检查文件已通过 API 读取核对，并已用实际 PR 运行验证（PR #3 通过检查后合并）。
- 主线基线已提交（`b801bf1`，经 PR #3 合并为 `ceb952d`）：移除被替代的 v1 实现，加入 `AGENTS.md` 与重组后的 `docs/`。删除的代码仍保存在 `proto/world-genesis` 与 `experiment/minecraft-societies`。
- 产品文案使用“创建世界”描述从文本建立世界的过程。
- 产品目标见[项目意图](intent.md)；[当前架构](architecture.md)描述现有证据和分支边界，[目标架构](design/2026-10-27-target-architecture.md)仍是方案。
- 创建世界和模拟原型位于 `proto/world-genesis`，工作区为 `/home/neo/Projects/Wispiva-prototype`；主线不直接运行该原型，也不整体合并一次性原型分支。入口支持可选文本素材、讨论摘要和起点确认，素材作为参考资料而非指令；真实模型体验尚未验收。[合成数据浏览器验收](https://github.com/kikoiio/Wispiva/actions/runs/40664414490)通过，截图位于原型工作区 `.tmp/entry-flow/screenshots-final/`。
- Minecraft 社会实验位于 `experiment/minecraft-societies`，工作区为 `/home/neo/Projects/Wispiva-experiment`；它有独立代码、依赖、检查与证据，不接入主项目运行时。
- 《红发会》英文[原文](source-texts/sherlock-holmes/the-red-headed-league.txt)已保存；故事导入和完整小说模拟尚未实现。文本摘自 [Project Gutenberg](https://www.gutenberg.org/cache/epub/1661/pg1661.txt)，其标注该英文版本在美国属于公有领域；其他地区及中文译本的权利需另行核实。

## 已验证的范围

- 创建世界原型的入口改动通过离线回归：75 个 Node 测试、282 项环境检查及 27 项内存 UI 检查；素材保存、刷新恢复、传入模型请求和变更后草稿失效均有定向检查。它支持有限资源、条件过程、离散行动和角色级信息边界；隐私审计不能证明同义改写、暗示或后续模型推理安全。
- Luanti 实验的 M0 已证明小规模服务端实体可以重复启停、被推进、改变世界，并检出指定失败；决策是确定性规则，没有接入 LLM。证据位于实验分支 `experiments/minecraft-societies/agent/evidence/m0-2026-10-27.md`。
- 长期相关性记忆、反思、平行世界、完整小说因果、任意物理和复杂 3D 尚未实现或验证。分支迁移后的浏览器验收和实验独立 CI 尚未执行。

## 下一步

1. 审阅主线基线中的删除范围和文档准确性，特别是本地配置路径（`.gitignore` 忽略根 `config.json`，本文旧记录写 `.data/wispiva/config.json`）。
2. 验证真实模型对长故事素材、起点与信息边界的处理，评估隐私审计的漏报、误报和返修成本。创建世界失败时不得用固定样例冒充模型结果。
3. 明确空间方案的最小验证：先检查地点坐标、连接、方位与角色空间认知，再决定房间、道路、门洞和建造操作的扩展；通用主题内容包依赖空间基底，不把现有红发会专用造型视为通用能力。
4. 验证角色经历与长期检索、反思、计划失效及分岔继承；已有有限经历和保存恢复不能代表这些目标已完成。
5. 决定 Minecraft 实验是否继续 Luanti 路线或比较其他环境；在接入真实 LLM 前确定研究问题、指标、对照组和免费模型端点。

## 约束与待确认

- 项目与实验的重型验证优先使用云端免费资源；使用具体云服务前告知用途、权限并取得许可。真实模型密钥不进入 CI。
- Luanti 路线使用服务端实体而非玩家客户端，是否接受这一形态仍待决定；环境选型和 LLM 社会行为尚无结论。
- 原型与实验分支已推送远端并设置了上游追踪（`proto/world-genesis`、`experiment/minecraft-societies`）。早先的远端 `prototype/review-*` 审查分支已删除，其改动均已在 `proto/world-genesis` 中。真实配置、存档、依赖目录和实验运行时不在分支提交中。`.tmp/branch-migration/working-copy/` 是可恢复的本地临时备份，不是永久归档。
- 原型依赖 `three` 未入库；在新工作区运行 `node prototypes/verify.mjs` 前，需在 `prototypes/` 下 `npm install`（可从本地 npm 缓存离线完成）。
