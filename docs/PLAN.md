# Wispiva 工作计划

更新日期：2026-10-28。

## 2026-10-28 原型与实验分支迁移

- 按用户新指示，将创建世界原型保存到 `proto/world-genesis`，将 Minecraft 社会实验保存到 `experiment/minecraft-societies`。两者分别保留代码、说明、检查和相应 CI 定义；仅有本地分支，没有推送或合并。
- 两个提交都基于同一原始 HEAD 创建，包含迁移时的共享项目工作区快照及各自目录，不会修改主工作区暂存区。逐一核对了原型 66 个文件及实验 30 个文件的 Git 对象与迁移前工作区内容一致。私有 `.env`、`.data/`、`node_modules/` 和实验 `.runtime/` 没有纳入提交。
- 原始目录及其未入库的依赖、运行时和工作流移至 `.tmp/branch-migration/working-copy/`，便于恢复；此位置是本机临时备份，并非永久归档。未触碰 `.data/` 和真实配置，未终止用户进程。
- 主线的运行说明、架构、导航已改为分支入口；下方历史记录描述当时的路径和验证，不代表主线仍有相应目录。
- 原有主工作区还有大量未提交的旧代码删除和新文档，迁移没有暂存或提交这些主线改动。两个本地分支在原始快照提交后增加了文档对齐提交；初始快照分别为 `40206a2414713b89bfd4e19a7b9347183dec0867` 和 `7e33189e144d76d5a18a13c462b26c502f74b797`。
- 导出两个分支到本地临时目录核对：原型分支 21 份 Markdown、实验分支 16 份 Markdown 的本地链接目标均存在；主线文档链接与标题锚点检查通过。复用本机已有依赖，在原型分支导出目录运行 `node prototypes/verify.mjs`，73/73 Node 测试与 282/282 环境检查通过，未读取真实配置或调用网络；日志为 `.tmp/branch-migration/prototype-branch-verify.log`。实验分支三个 shell 脚本通过语法检查，未运行 Luanti、浏览器或云端 CI。

## 2026-10-28 按 development-docs 整理文档与架构

- 当时补充了 `prototypes/`、`experiments/` 与根目录 `AGENTS.md` 的入口和边界；这条旧位置约定已由上方用户要求的分支迁移取代。
- 将原 `docs/PRD.md` 完整迁入[项目意图与产品需求](intent.md)，把当前实现地图迁入[标准架构入口](architecture.md)，原目标架构方案迁入[设计文档](design/2026-10-27-target-architecture.md)。分别说明目标、现状与方案，更新内部链接，并增加目标、源码、证据和缺口的对应表。
- 文档索引（`docs/README.md`）统一收录各文档；按受众拆分的独立入口目录后因文档类型表未定义而删除。根 README 增加最短启动方式；仓库要求的本文件及原型、实验的独立位置不变。
- `docs/research/` 中现有研究为跨多日期持续更新的综合材料，不足以无歧义地改成某一天冻结的研究记录；暂保留原路径和内容，在索引中明确其生命周期与日期边界。历史 `PLAN.md` 记录按项目规则保留，不改写成已完成的目标设计。
- 检查根 README、AGENTS 和项目文档共 23 份 Markdown 的本地链接与标题锚点，均可解析；`git diff --check` 通过。本机没有 Mermaid 解析器，图表语法和实际渲染尚未由工具验证。本轮未调用真实模型、浏览器或云端；此前的原型测试记录见下节。

## 2026-10-28 文档入口整理

- 早先增加了文档索引、简短项目意图和实现地图，但没有按技能采用规范文件名，也没有完整迁移需求；这次遗漏已按上节纠正。当时未迁移历史资料或修改代码。
- 本轮仅做文档与源码路径核对和本地链接检查，未运行应用、测试、浏览器或云端任务；此前记录的验证结果不代表本轮重新执行。

## 2026-10-28 全仓整理与核对

- 基线为大量未提交的迁移：180 个跟踪文件删除，原型、实验和多份文档尚未跟踪。保留现有工作，不暂存、不恢复或删除旧代码，也未读取真实配置和存档。
- 根目录的 `ddg.html` 是 DuckDuckGo 页面，`index.js` 是引用不存在的外部分包的打包文件，未发现项目引用；两份文件移至 `.tmp/project-organization-2026-10-28/` 暂存，未删除。该目录被 Git 忽略，不是永久归档；如需恢复，可将文件移回根目录。
- 修正实验说明：Luanti 实验没有依赖锁文件，运行时哈希清单不能固定后续软件下载版本。新增独立 CI 定义（`experiment/minecraft-societies` 分支：`.github/workflows/minecraft-societies.yml`），仅手动触发 shell 和 Lua 语法检查；尚未运行，使用前仍需依当前规则告知并取得许可。原型依赖与锁文件一致，`.env`、`.data/`、实验运行时及生成世界被忽略。
- 本轮运行 `node prototypes/verify.mjs`，退出码 0；包括 73/73 Node 测试、282/282 环境检查、17/17 配置检查、39/39 模型客户端检查，未调用真实模型或浏览器。日志为 `.tmp/project-organization-2026-10-28/prototype-verify.log`。三份实验 shell 脚本通过 `bash -n`，三份 Lua 源文件通过本机 LuaJIT 语法解析，CI YAML 可解析，文档本地链接目标存在；这不代表 CI、实验运行时或浏览器已重新验收。
- 待处理：独立 CI 尚未运行，不能视为实验闭环验收；尚未全面逐项确认所有旧代码、历史证据和新文件是否应纳入最终提交，也尚未完成迁移的浏览器验收。相关盘点和决定记录在 `.audit/project-organization.todo.md` 与 `.audit/project-organization.tsv`。

## 当前状态

- 创建世界与模拟原型保存在 `proto/world-genesis` 分支（`prototypes/README.md`）；Minecraft 社会实验保存在 `experiment/minecraft-societies` 分支。主工作区不再提供这两个目录或原型启动入口。
- 原型使用 Node.js、ES modules、Three.js 和 JSON 存档；[目标架构](design/2026-10-27-target-architecture.md)不代表 React、Hono、SQLite 等均已实现。[产品需求](intent.md)描述目标，[当前架构](architecture.md)描述实现。
- 现有证据支持有限资源、阈值过程、离散行动和小规模角色调用；完整小说因果、长期相关性记忆、反思、分岔、任意物理与复杂 3D 未实现或未验证。创建世界失败不得以固定故事冒充成功。

## 故事原文

- 探索方向为《福尔摩斯探案集》的世界，先用《红发会》研究资料导入、时间和人物知情边界、角色塑造及改变条件后的演化。当前仅选择了素材，小说导入和模拟尚未实现。
- [《红发会》英文原文](source-texts/sherlock-holmes/the-red-headed-league.txt)从 [Project Gutenberg 第 1661 号文本](https://www.gutenberg.org/cache/epub/1661/pg1661.txt)按第二、第三篇标题截取，UTF-8，50,288 字符，SHA-256 `8eaa2a64865f9c78e793b82e80940515d3b4c46149a747fe13f7d05905f26ebe`。已检查边界、长度和迁移前后哈希，尚未逐段校对。Gutenberg 标注此英文版本在美国属于公有领域，其他地区和中文译本需另行核实。

## 2026-10-27 仓库整理

- `docs/PRD.md` 保存需求，`docs/ARCHITECTURE.md` 保存目标架构，`docs/research/` 保存项目级研究，`docs/source-texts/` 只放原始文本；根 README 仅作简短介绍。
- 将原型统一整理在 `prototypes/`，把原型说明、专属实验报告与历史记录移入原型目录，并将测试、山庄夹具及辅助脚本分到 `tests/`、`fixtures/`、`scripts/`。旧营地、voxel、山庄样例仍被代码或回归检查引用，本轮未因名称或年代删除。原型可能存在的其他冗余仍需逐项判断。
- 更新代码引用、验证入口、CI 工作流和项目文档链接。`.data/prototype/` 存档位置保持不变，原先的主世界未被读取或改写。以前的详细记录和结果保留在 历史进度（`proto/world-genesis` 分支：`prototypes/notes/2026-10-26-progress.md`），不作为本次验证的替代。
- 在 `.tmp/reorganization-verification/` 的隔离代码副本上运行 `node .../prototypes/verify.mjs`，退出码 0：62 个 Node 测试、282 个环境检查及既有角色、UI、创建、信息隔离、配置和模型客户端检查通过；使用合成数据，不调用真实模型或浏览器。日志为 `.tmp/reorganization-verification/checks.log`。
- 使用新路径的实际源码、临时独立存档和临时端口检查 `/`、`/api/state`、`/app.js`、Three.js 静态资源及场景模块，均返回 HTTP 200；服务已关闭。故事文件哈希保持一致，文档本地链接已检查。
- 进一步移除迁移后遗留的空 `scratch/` 目录；根 README 改为简短英文介绍。
- 移除唯一原型目录下多余的 `main` 层级，所有入口、CI、文档和仓库根目录定位统一改为 `prototypes/`；修正因目录深度变化而受影响的配置、存档和观察脚本路径。
- 在当前工作树运行 `node prototypes/verify.mjs`，退出码 0：62 个 Node 测试、282 个行为检查、配置 17/17、模型客户端 39/39 全部通过，未调用真实模型或浏览器；使用隔离存档做 HTTP 冒烟，`/`、`/api/state`、`/app.js`、Three.js 静态资源和场景模块均返回 200。
- 本轮新增角色级秘密行动验证：资源和行动支持 `visibility: { actors, clues }`，行动支持 `performers`；地点、知情、当前观察、可执行权限和主观记忆保持分离。新增《红发会》小起点夹具（`proto/world-genesis` 分支：`prototypes/fixtures/red-headed-league.mjs`）及 8 个定向测试，覆盖 Wilson、Spaulding、Holmes、地下挖掘、线索揭示、跨地点银行警戒、通用失败、严格引用和复制后观察一致性。
- 本轮 `node prototypes/verify.mjs` 退出码 0：70 个 Node 测试全部通过。此前一次全量运行在观察投影向后兼容测试上发现 3 个失败，已修正为仅对带 story 的角色观察隐藏 author-facing 地点描述，并保留无 story 旧观察的完整序列化形状。
- 使用真实 `.env` 配置在全新隔离目录 `.tmp/prototype/red-headed-live-vpQN87/` 完成一次三阶段创建世界，3 次真实模型调用通过完整世界、引用、规则、几何和运行检查，输出 4 个地点、3 个角色、4 个资源、2 个过程、5 个行动，并产生角色级 `visibility`/`performers`。没有确认进入作者当前世界，也没有启动浏览器。
- 真实模型输出暴露一个新的研究问题：模型把地下计划写进公开 `world.story.premise` 和地点 `description`，结构校验无法发现自然语言泄漏。角色观察现已不再携带 author-facing premise；含 story 的角色观察也不传地点描述。该失败和后续约束已写入[世界模型研究](research/2026-10-28-world-models.md)、[记忆研究](research/2026-10-28-memory.md)与[架构](design/2026-10-27-target-architecture.md)，不能把这次创建世界记为语义完全正确。
- 已把创建世界接受前的 `auditCandidatePrivacy()` 接入 `checkWorldCandidate()`：确定性检查覆盖作者级 premise/地点叙述、隐藏实体标识、他人目标与前史是否进入角色观察；有限片段重合检查覆盖公开文本中的私有目标和隐藏机制。通过的草稿保存审计限制，命中的候选以 `privacy-audit-failed` 拒绝。审计明确标注不能证明同义改写、暗示、推理或后续对白安全。
- 《红发会》夹具新增 Wilson 出勤计数与反事实分支测试：Wilson 继续赴红发会、Holmes 检查地下室获得进度信息但仍无 Spaulding 执行权、Spaulding 挖掘到阈值后银行警戒变化；原点副本彼此独立，不写死银行抢劫结局。
- 当前工作树验证已扩展为 72 个 Node 测试及既有环境检查，全部通过；本次仍未启动真实模型或浏览器验收。
- 已启动本地体验服务 `node prototypes/server.mjs`，地址 `http://127.0.0.1:5175/`；只读冒烟确认 `/`、`/api/state`、`/api/events`、`/app.js` 和 `/world-scene.js` 可访问。服务复用现有存档“山雨未停”（世界第 30 分钟、revision 39），没有重置或覆盖当前世界；当时存档处于 `actor:invalid-decision` 等待状态。
- CI 路径已更新，但此次未运行 GitHub Actions 或浏览器验收，不能据历史截图推断迁移后的真实浏览器体验。历史截图、真实模型轨迹和有限场景实验见原型说明和历史进度；`.tmp/` 内证据不是永久存储。
- 整理前工作区已包含大量跟踪文件删除与未跟踪原型；未暂存、提交、恢复旧代码或改变既有迁移决定。

## 下一步

1. 用更多真实生成草稿和同义改写样例评估接受前隐私审计的误报、漏报与返修成本；不能把片段检查升级成语义安全证明。
2. 继续验证短期经历账本与长期检索、reflection、Plan 失效和 revision fork；当前只证明了有来源的有限经历和保存恢复，不应把目标架构当作已实现。
3. 如需确认本次目录调整后的浏览器交互，按项目云端优先与权限规则安排 CI 验收；必要时再根据实际使用情况清理确认无用的原型代码和历史产物。

4. 主题场景已有《红发会》专用程序化配方与有限视觉证据，见下方第二轮记录；通用主题内容包仍待实验。拟让 LLM 生成 `styleBrief`、街区拓扑和稳定场景锚点，由程序化配方负责建筑、道路与陈设等，并继续验证多视角构图、通行、局部编辑和浏览器资源。

5. 在主题内容包之前补一个空间基底实验：增加语义地点图、房间／道路／门洞关系和小型区块建造网格；让角色观察从同一空间基底派生 `placeId`、`roomId`、当前位置、出口、可见对象和已知地图。LLM 只提交受限蓝图或建造操作，程序执行占用、碰撞、通行和稳定对象绑定。暂不引入 Minecraft 服务器或运行时。

6. 先实现独立的空间关系层：固定世界坐标约定，按地点／建筑锚点计算方位、邻接、距离区间和路径关系；为角色增加带 `source`、`revision`、`certainty` 的 `spatial-belief` 记忆。先用现有 `places[].position` 与连接图验证“家东边有商店”，再把查询扩展到房间和区块网格。

7. 将建造入口定为工具驱动循环：模型通过事务性 `createRoom`、`connectPortal`、`buildStructure`、`placeObject`、`inspectSpace`、`renderPreview` 和局部 `repair` 修改 `SpatialWorld`；工具返回诊断、变更 ID、revision 和预览，渲染器从空间状态派生。优先提供宏建造操作，逐 voxel 操作只用于局部修补，不允许模型直接写 Three.js 运行时代码。

8. Minecraft 实验按文末[立项](#2026-10-27-minecraft-agent-社会实验立项)推进：C 路线（Luanti）的 M0 已跑通（服务端启停、agent 每步被推进、世界差异、失败可检出），下一步按用户“先 C 小规模跑通再定”之后的判断走——要么在 C 上继续 M1 容量阶梯／M2 实验编排，要么回到 A 路线做对比。它与上面 4、5、6 项分属两条线：主原型继续不引入 Minecraft 运行时。
## 2026-10-27 红发会重做与验收

- 用户指出旧的“山雨未停”体验不应继续使用。本轮删除 `.data/prototype/state.json`、`creation.json` 和旧 `model-calls.jsonl`，重新建立唯一运行入口的《红发会》起点：第 0 分钟、revision 0、暂停；3 个地点、3 位人物、5 个资源，场景标题为“萨克斯·科堡广场 · 案件现场”。没有恢复或启动旧存档。
- `prototypes/fixtures/red-headed-league.mjs` 现在同时提供红发会专属的紧凑场景布局：当铺、地下室、银行拥有不同房间尺寸和程序化陈设，地点位置与房间绑定保持一致。`prototypes/geometry/solid.js` 为当铺柜台、地下室工作台／隧道入口和银行柜台／立柱增加区分度；完整世界、空间、绑定和 solid 编译检查通过。
- `prototypes/ui/index.html`、`style.css` 重做为维多利亚伦敦调查档案视觉：暗煤黑、雾蓝灰、旧纸金和暗红；首屏直接显示红发会冲突，运行页以现场总览、案件时间线、暂停／播放／下一人行动组成同一体验。保留既有状态、SSE、键盘焦点、移动布局和 reduced-motion 行为。
- 浏览器检查先发现动态模块请求 `/prototypes/geometry/*` 导致三维区域空白，已修复为服务实际暴露的 `/geometry/*`。随后用本机独立、禁用 GPU 的 headless Chrome 延迟截图检查桌面和移动尺寸：画布存在、无 `data-scene-error`，三处现场可见；移动截图无横向溢出。截图证据在 `.tmp/browser/rhl-final-visual.png`、`.tmp/browser/rhl-mobile.png`，仅作本轮临时证据。
- CUA 浏览器入口当时不可用（`Browser is not available: iab`），所以本轮使用 AGENTS 允许的本机兜底：启动前确认 `MemAvailable` 约 4.8–5.4 GiB、内存 PSI 低、`/tmp` 使用率约 2%，headless Chrome 禁用 GPU 且一次只运行一个实例；截图后关闭了临时浏览器进程。软件 WebGL 仅用于视觉回归，不代表目标设备性能验收。
- 本轮新增架构经验已写入[架构](design/2026-10-27-target-architecture.md)和[3D 生成研究](research/2026-10-28-3d-generation.md)，红发会起点与主题化壳层经验写入[世界模型研究](research/2026-10-28-world-models.md)。

### 本轮待收尾验证

1. 运行 `node prototypes/verify.mjs`，确认完整 Node 测试、环境检查、模型客户端检查仍通过。
2. 对 `/`、`/api/state`、`/api/events`、静态模块做 HTTP 冒烟，并用 `git diff --check` 检查文本变更。
3. 保留新《红发会》服务运行给用户体验；如果后续继续改 UI，先停止服务或使用新状态文件，避免后台写回覆盖验证结果。

### 收尾结果

- `node prototypes/verify.mjs`：72/72 Node 测试、282/282 行为检查、26/26 UI 检查、17/17 配置检查、39/39 模型客户端检查全部通过；无真实模型调用、无私有配置读取、无云端任务。
- `git diff --check` 通过。最终存档只读确认：`generated-world-v1`、标题“红发会：庞大的阴影”、第 0 分钟、revision 0、暂停、无等待；HTTP `/`、`/api/state`、`/api/events` 及 `/geometry/*` 静态资源返回 200。
- 桌面与移动 headless 截图检查完成，画布存在且无场景错误；CUA 的 `iab` 浏览器入口不可用，因此截图使用 AGENTS 允许的本机兜底，不能把它记为云端浏览器验收。
- 新服务已重新启动并保持运行，供用户体验；当前不会自动推进，因为存档处于暂停状态。

## 2026-10-27 红发会第二轮场景美术原型

- 针对“房间剖面图过丑”的反馈，保留同一 `SceneDocument`、world binding 和角色级权限，给 `victorian-archive` palette 增加主题化 solid 配方：湿石广场、正面街道、砖墙、石材、橱窗、门框、当铺招牌、银行柱廊、地下拱口、台阶和少量路灯。通用世界继续使用原有 room recipe。
- 浏览器端由 `createPlainMaterials()` 切换为已有 `createMaterials()` 程序纹理；Node/CPU 路径仍使用 plain 材质。这样浏览器截图能看到砖、木、石材粗糙度，同时不增加模型下载和服务端 GPU 依赖。
- 根据截图连续返修：删除遮挡主体的完整屋顶板，保留檐口与开敞剖面；主题场景按内容包围盒收紧取景；把球形路灯改成细杆和矩形灯箱，并把街道连接与灯位移到建筑正面。最终截图为 `.tmp/browser/rhl-street-v5.png`，真实 canvas 存在且 `data-scene-error` 为空。
- 新增红发会场景词汇的编译回归测试，确认共享场景文档能产出铺石地面、当铺招牌、地下拱口、银行柱子、正面街道和路灯；本轮没有改变 world 事实、角色观察、行动权限或模拟规则。
- 视觉证据仍是本机禁用 GPU 的软件 WebGL 截图，证明页面加载、材质、构图和场景初始化；尚未证明目标设备帧率、显存或生产级美术质量。截图表明场景已从调试房间推进为可辨识的案件街区，但仍是程序化原型。

### 本轮待收尾验证

1. 运行完整 `node prototypes/verify.mjs`，确认新增测试、环境检查、UI 和模型客户端检查全部通过。
2. 停止本轮启动的 headless Chrome 进程，重新读取 API 状态和静态资源；按需要把体验存档恢复到红发会第 0 分钟暂停起点。
3. 只保留用户需要的 `5175` 服务运行，并向用户报告真实截图证据与仍未验证的设备性能边界。

### 本轮收尾结果

- 修复视觉回归测试对静态合批后节点名的错误假设：测试现在检查合批前的主题部件词汇，以及合批后稳定的 `userData.parts`；不改变渲染实现。
- 修复房间和角色 Canvas 标签在精简 Canvas 替身中缺少 `stroke()` 时的兼容性，真实浏览器仍保留描边效果。
- `node prototypes/verify.mjs` 退出码 0：73/73 Node 测试、282/282 行为检查、26/26 UI 检查、17/17 配置检查、39/39 模型客户端检查全部通过；本轮验证没有真实模型调用或云端任务。
- HTTP 冒烟通过：`/`、`/api/state`、`/api/events`、`/app.js`、`/style.css`、`/world-scene.js`、`/geometry/scene-compiler.js`、`/geometry/materials.js` 和 Three.js 静态资源均返回 200。
- 当前体验存档已重新建立为红发会第 0 分钟、revision 0、暂停、无等待；三位人物回到当铺、地下室和银行，行动账本为空，资源回到起点数量。没有使用普通 `reset`，也没有恢复旧“山雨未停”世界。
- 使用本机单实例、禁用 GPU、`--ozone-platform=x11` 的 headless Chrome 验收真实页面：Three.js canvas 存在、`data-scene-error` 为空、没有 page error、桌面页面无横向溢出。截图证据为 `.tmp/browser-final/rhl-final-start.png`；这仍是软件 WebGL 的页面与构图验收，不代表目标设备帧率或生产级美术质量。
- 服务已在 `http://127.0.0.1:5175/` 的持久终端会话中重新启动并保持运行，当前存档暂停，不会自行推进。

## 2026-10-27 Minecraft agent 社会实验立项

- 用户决定把[研究文档](research/2026-10-28-minecraft-agent-societies.md)中的方向作为**延伸研究**启动，硬约束是**只能用免费资源**（免费模型端点、仅本机使用；容量测量也全部本机跑，不启用云端任务），并要求环境**优先开源、不为 Minecraft 付费**。位置定为仓库顶层 `experiments/minecraft-societies/`，计划与边界见实验说明（`experiment/minecraft-societies` 分支：`experiments/minecraft-societies/README.md`）。
- 用户最初答复为“一定要用真 MC”，随后澄清其本意是“找类似 MC 的开源项目，不打算为 MC 付费”。本轮据此纠正了一条事实：**Minecraft Java 版服务端免费、离线模式不需要账号、不需要买游戏**，需要付费的只是“正版客户端登录在线模式服务器”，与本研究无关；MC 本体确实**不开源**（Paper 是它的补丁分支）。因此环境改为 A（Paper）／B（flying-squid）／C（Luanti）三选一，**尚未决定**。
- 位置决策经过比较：不建 `scratch/`，也不把 `prototypes/` 搬进去。`scratch/` 是本轮整理刚作为迁移残留移除的目录；`prototypes/` 是 分支约定中唯一的原型入口。实验需要的是独立运行时（自己的依赖、CI、Java 与 MC 服务端），不是多一层目录。另有约定“独立实验放 `experiments/<方向>/`”。
- 本轮只做立项与核实，**没有实现、没有下载 MC 服务端、没有安装 Java、没有启动服务器或 bot、没有调用真实模型、没有发起云端任务**，也没有改动 `prototypes/` 的任何文件。
- 实际核实的事实（HTTP 查询与本机检查）：本机未安装 Java（`mise` 可用户级装 21/25，`apt` 有 openjdk-21 候选但需 sudo）；Paper 旧 API `api.papermc.io/v2` 已 sunset，现用 `fill.papermc.io/v3` 可访问；可用版本含 `1.21.11`、`26.1`、`26.3`（`26.3` 要求 Java ≥ 25）；`mineflayer@4.39.0` 依赖的 `minecraft-data` 实测支持到 `1.21.11` 与 `26.1`，因此固定 Paper `1.21.11` + Java 21，最终以 bot 实际连上为准；仓库为 public，Actions 标准 runner 免费；Mineflayer 与服务端均无头，不需 GPU/Xvfb。
- 路线：技能循环自己写最小实现（不引入 Mindcraft 作运行时）。原计划把 M1–M3 放云端免费 runner，**已按用户指示改为全部本机执行**；M4 真实 LLM 只在本机小规模（3–5 agent）接免费端点，密钥不进 CI、不读 `.env`。
- **C 路线（Luanti）已实测通过**：本机未安装任何系统包、未使用 sudo、未安装 Java，用 `apt-get download` + `dpkg-deb -x` 把 `luanti`/`luanti-server`/`luanti-data`/`luanti-game-minetest` 四个 deb（10.2 MB）与 6 个缺失 `.so` 解包到 `.tmp/luanti-probe/`，`luantiserver` 直接启动（`Luanti 5.10.0`，LuaJIT 2.1）。许可证读自包内 `copyright`：引擎 LGPL-2.1+，Minetest Game 代码 LGPL-2.1-only、素材 CC-BY-SA-3.0。
- **C 路线的服务端实体容量已实测**：每步 O(1) 工作时 2 万实体保持实时（11.02–11.04 step/s，峰值 RSS 167 MiB），崩塌点来自每实体计算量而非实体数——朴素 O(N²) 邻域感知在 1000→5000 之间跌破实时（4.4 step/s），10000 时 0.92 step/s。原始日志与基准代码见 `experiments/minecraft-societies/bench/`。这组数字为研究文档“距离 LOD 是千级以上关键设计”补上了本项目自己的证据，但也**只覆盖 tick 与内存，不覆盖 LLM 成本与 agent 行为**。
- **C 路线暴露的硬性工程前提**（实测，研究文档原先未记录）：无玩家时实体不会被 step，必须 `forceload`；且只有在区块 emerge 完成后才能生成实体，否则实体会在活跃区块管理周期（2.0 s）中被**静默删除**，而 `add_entity` 全程返回有效对象、不报错。另记录默认限制：`max_objects_per_block = 256`、`max_forceloaded_blocks = 16`（可 -1 解除）、`active_block_range = 4`、`dedicated_server_step = 0.09`。
- **C 路线的外部生态核查**（只读检索，未克隆未运行）：VoxeLibre（原 MineClone2，权威仓库在 Mesehub，GitHub 仅镜像）仍在维护（0.92.4，2026-10-18），代码 GPL-3.0-or-later、媒体 CC BY-SA 4.0，要求 Luanti ≥ 5.10，自述 beta、未 feature-complete；Luanti 引擎**不自带任何可玩游戏**（只有 devtest），Minetest Game 处于仅维护状态；**LLM agent／多智能体社会模拟方向在 Luanti 生态基本空白**（无规模化先例，arXiv 标题摘要零命中，客户端协议库孱弱且多已停更，官方 `doc/protocol.txt` 仍是 2011 年的未完成草案）；官方客户端 mod API（CSM）**无法操纵玩家**（`LocalPlayer` 只有 getter），因此“以玩家身份接入”的外部客户端必须自研协议实现，C 路线现实形态是**全程服务端 Lua mod 实体**。
- 未决（阻塞下一步）：① 环境 A／B／C 三选一未定（C 已按用户要求先做小规模验证，见下节）；② 研究问题、指标与对照组尚未确定，M4 之前必须定，否则只是“能动的世界”；③ 免费模型端点具体是哪一个待用户确认（不读 `.env`）；④ ContentDB 于 2026-10-26 因安全事件下线维护，Luanti 内容包的包搜索核实与 VoxeLibre 的实际安装验证需等其恢复；⑤ 是否接受 C 路线“agent 不是玩家、没有玩家视角”这一形态差异。
- 证据边界：本节为立项与核实记录；**A 路线（Paper/Minecraft）没有任何本项目的实测数据**。C 路线已有服务端实体 tick/内存实测与 M0 闭环实测，见下节。

## 2026-10-27 Minecraft 实验 M0（C 路线）跑通

按用户指示“先 C 小规模跑通再定”，本轮把 C 路线从“能启动服务端”推进到“有一份可运行的 agent 闭环”，代码与原始证据在 experiments/minecraft-societies（`experiment/minecraft-societies` 分支：`experiments/minecraft-societies/README.md`）。

- **零 sudo、零 Java、零系统包**：新增 `runtime/bootstrap.sh`，把 11 个 deb 下载后 `dpkg-deb -x` 解包成项目内运行时（`.runtime/`，约 60 MB，脚本幂等，已下好的包不重下）。实测镜像会间歇性连不上（`cn.archive.ubuntu.com` 超时、`security.ubuntu.com` 正常），脚本按“还缺哪些”重试三次。解包后 `luantiserver --version` 自检通过，产物哈希写入 `.runtime/manifest.sha256`。
- **新增 M0 agent 运行时**：`agent/mod/society/init.lua`（引擎胶水：forceload／emerge、生成、推进、执行、记账、事件格式）与 `agent/mod/society/policy.lua`（决策层，确定性桩，6 条规则）。分工是刻意的：M4 接 LLM 只替换 `policy.lua`，不动引擎胶水。`agent/run.sh` 是启停夹具，带硬校验，一次只允许一个服务端在跑。
- **四条退出条件的实测结果**（实时基准 11.1 step/s，详见证据（`experiment/minecraft-societies` 分支：`experiments/minecraft-societies/agent/evidence/m0-2026-10-27.md`））：5 agent×10 决策 23 s／45 MiB／step 率 11.08；20 agent×8 决策 19 s／46 MiB／step 率 11.08；SIGTERM 停止路径 15 s 并留下完整账；反向用例 5 s 内被检出。
  - **可重复启停**：同配置连跑两次，确定性事件序列逐行一致（73 行）。比对不含墙钟与 step/s 统计行——真实时间本来就不可复现。可重复靠两条设计：决策由一个 `globalstep` **按 agent id 排序**驱动（写在实体 `on_step` 里会因引擎遍历区块顺序不稳定而随机化交错），随机性用固定种子 LCG 而非 `math.random`。
  - **每步被推进**：每个统计区间 `stepped_delta` 等于 agent 数（5/5、20/20），`on_step` 只用于记这个证据。
  - **世界真的变了**：关服时用 `find_nodes_in_area` 回读地图，标记方块数与 mod 自记计数一致（`marks_counter=6 marks_in_world=6 ok=true`）——“世界变了”由世界本身证明，不由程序变量证明。
  - **失败说得清**：反向用例把 `society_spacing` 设成 64，生成点落到 forceload 范围外，`add_entity` 五个全部返回有效对象、一个错都不报，1 秒后只剩 1 个（活下来的那个生成点在范围内）；程序自己检出并报出 `fail=agents-lost-after-spawn alive=1 expected=5 hint=emerge-race-or-active-block-purge`。夹具用 `--expect-fail` 要求“检测到失败才算通过”，静默通过反而判 FAIL。
- **本轮仍未做**：没有接 LLM（决策是 6 条规则的桩）、没有持久化（`static_save=false`，每次从空世界重新生成）、没有客户端连接、规模只到 20、未做长时间稳定性测试；引擎仍是 5.10.0（不含上游 2025-04-08 的 k-d 树空间索引）。容量阶梯是 M1，快照与重置是 M3，真实 LLM 是 M4。
- **未决不变**：环境 A／B／C 仍未最终选定（C 现在是唯一有本项目闭环证据的路线，但“agent 不是玩家、没有玩家视角”这一形态差异仍需用户确认）；研究问题、指标与对照组仍未定；免费模型端点仍未确认。


## 2026-10-28 Luanti 社会实验继续执行

本节取代上面立项记录中的“环境未定、端点未定、仅本机运行”等当前决策；旧段落保留为历史。用户已接受 Luanti 服务端实体，并明确授权 GitHub 配置模型与 Actions 免费资源。主原型不变，实验不合并主线。

本轮实施范围与验收见 [独立执行计划](../experiments/minecraft-societies/PLAN.md)：分层容量至 10,000、角色局部观察和有来源的私有 FIFO 记忆、异步 Responses 模型桥接、资源采集／放置、停服快照与清空心智、配对记忆实验。重型操作全部在云端顺序执行；没有启动本机引擎、容器或 GUI。

当前证据已说明万级规则 agent 的旧版感知／接触／日志负载无法保持设定的实时步频，真实模型只完成小规模闭环。初次记忆对照每组 18 动作、各 2 次成功采集，无对话与建造，不能证明记忆改善行为。后续重复测量、改进动作反馈后的配对结果、独立审查和最终提交均由独立执行计划记录。


本轮收尾：已完成 5,000 与 10,000 人各条件三次重复，全部存活但实时阈值均未通过；[万级证据](../experiments/minecraft-societies/scale/evidence/2026-10-28-large-repeated/summary.md)。真实模型配对每组 72 有效动作，两组放置次数均为 5，开启记忆组 token 多约 33%（含重试），未证明记忆收益；[模型证据](../experiments/minecraft-societies/model/evidence/2026-10-28-memory-paired/summary.md)。实现、失败修复、定向测试与独立审查记录见独立执行计划和审计 trail。


## 2026-10-28 第二轮：感知调度优化与检索记忆

用户要求先更新 plan 再继续完成。新阶段已写入[实验计划](../experiments/minecraft-societies/PLAN.md)：同源新旧感知／调度对照，1000／5000／10000 每配置五次交替；检索记忆与 FIFO 共用存储和输出预算，在延迟回忆、消息来源、过期事实、已知失败四类任务上调用真实模型，再做 1／2／4 的有界并发探针。

当前已实现角色空间索引、写入失效的节点缓存、软时间预算的分帧调度与来源保留的词项检索。1000/5000/10000 容量五次交替对照、10000 的 60 轮长跑、真实模型记忆 24 次调用、1/2/4 并发小批探针和 25/50/65 ms 预算调优均已完成。真实记忆任务中 retrieval 12/12、FIFO 0/12，实际 token 13,480；并发探针全部成功但设计上只能判 inconclusive。65 ms 已据 5/5 预算通过和最低完整耗时改为默认；10000＋cognition 的实际决策间隔中位 14.32 秒，未证明 2 秒实时或大规模 LLM 负载。最终验证工作流 40753203801 成功。
