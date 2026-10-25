# 世界模型调研：环境机制、验证与公开实现

核对日期：2026-10-25
状态：**讨论材料，不是选型或需求冻结**。承接 [DISCUSSION-world-model.md](DISCUSSION-world-model.md)。本轮阅读论文、作者资料、公开仓库与部分实现；没有安装项目、下载模型、调用付费模型或复现实验。对性能的描述均为作者报告，不是本项目测量。

记录范围：下面保存进入本次讨论的研究及其一手入口、借鉴点、限制和阅读深度；末尾另列检索发现但未深入核查的线索。讨论中的优先级调整、用户要求和未定项见[讨论记录 §9](DISCUSSION-world-model.md#9-后续讨论记录与状态)。代码架构判断以[世界表示设计草案](DESIGN-world-representation.md)为入口，后续执行顺序见[计划](../PLAN-world-representation.md)。

## 1. 调研后最需要澄清的区别

已有研究至少包含三种不同任务：

1. **预测一个已有环境**：环境可以执行并给出结果，模型学习它的状态转移。WorldCoder、Word2World、WorldLLM 等提供这类方法。
2. **构造一个可执行环境**：生成状态、接口或规律，再由程序执行。AWM，以及近期 Code World Model / PWM / CoDeR 的研究接近这类任务，但覆盖范围、验证方法与开放程度不同。
3. **评估世界是否维持正确**：给定参考结果、事件关系或环境规则，检查状态与演化。GlobeBench 与 WorldAgent-Benchmark 是测试材料，不是可以直接替换环境的 Simulator。

对 Wispiva 的推断：预测已有环境的方法值得借鉴，但它们的验证依据往往来自那个环境。若 Simulator、轨迹和裁判都由同一组模型自己生成，循环一致性不能独立证明现实准确性。

## 2. 分享中项目的核对结果

| 项目与一手入口 | 实际做什么 | 可借鉴部分与边界 |
| --- | --- | --- |
| [Concordia](https://github.com/google-deepmind/concordia) | Agent 提出行动，由 Game Master 产生观察、裁定结果，engine 组织执行；有组件与调度实现 | 适合参考意图/后果/观察的分工。已读的通用 `WorldState` 组件仍依赖模型更新字符串变量，不能当作数值环境的可靠性保证 |
| [WorldCoder](https://github.com/haotang1995/WorldCoder)、[论文](https://arxiv.org/abs/2402.12275) | 从与环境交互获得的经验合成、修订 Python 状态转移与奖励程序，再用于规划 | 借鉴机制成为程序、错误经验成为修订依据的循环。官方 README 明示旧 numpy/gymnasium/minigrid 兼容限制；属于研究实现 |
| [Text2World](https://github.com/Aaron617/text2world)、[作者项目](https://text-to-world.github.io/) | 文本生成 PDDL 世界模型，并评估谓词、动作参数、前置条件、效果和可执行性 | 借鉴变化的显式表示；不是持续开放世界内核，也不要求 Wispiva 采用 PDDL |
| [NeSyS](https://github.com/tianyi-lab/NeSyS)、[论文](https://arxiv.org/html/2602.10480v2) | 融合模型给候选转移的概率与可执行规则评分；交替改进神经模型和规则 | 可借鉴规则覆盖明确部分、模型处理剩余部分。公开主实验包含转移选择题与规则重排，也有 WebShop 开放式行动评测；不能说它已验证任意新环境效应 |
| [Word2World](https://github.com/X1AOX1A/Word2World) | 在 ALFWorld、ScienceWorld、TextWorld、WebShop、StableToolBench 等协议下训练、评估文本世界模型，发布模型与数据 | 借鉴单步预测、多步 rollout，以及把模拟中的行动映射回原环境检验的区分。现成权重不自带 Wispiva 的世界规律 |
| [GlobeBench](https://github.com/patronus-ai/globebench)、[论文](https://arxiv.org/abs/2610.22708) | 1,632 项文本环境模拟测试；公开题目、响应、评审记录、确定性 grader 与离线重评分工具 | 借鉴受影响对象、依赖对象、无关对象的检查，以及确定性检查无法判断时才用语义评审。其依赖传播平均 5.1% 是该基准特定设置的报告，不是所有环境的通用成功率 |
| [AgentSociety 2](https://github.com/tsinghua-fib-lab/AgentSociety)、[架构文档](https://agentsociety2.readthedocs.io/en/latest/architecture.html) | 社会模拟与实验平台，组织角色、环境模块、模型服务、追踪与回放；当前仓库同时保留 v1 | 参考模块化环境和批次调度。v1 大规模城市模拟结果不能直接作为 v2 复杂环境动力学能力的证明；Ray 等基础设施也不是 Wispiva 的默认依赖 |
| [ScienceWorld](https://github.com/allenai/ScienceWorld) | 代码实现的文本科学环境，含动作、物件、温度、电路、生物等过程 | 适合观察属性与过程如何组合出状态后果、生成测试。其过程是简化教学模拟，范围有限，不是开放式学习到的真实物理 |

NeSyS 的具体例子：公开 ScienceWorld 规则会检查“使用温度计”的候选是否含读数、是否不当地改变库存。这是有用的局部一致性信号，但不能据此证明读数或热力学过程正确。参见[公开规则文件](https://github.com/tianyi-lab/NeSyS/blob/main/nesys/final_rules/rules_scienceworld_qwen3-4b_final.py)。

## 3. 补搜中值得深入的工作

### LLM-Sim / ByteSized32：直接检验状态转移

[Can Language Models Serve as Text-Based World Simulators?（ACL 2024）](https://aclanthology.org/2024.acl-short.1/)。使用 ByteSized32-State-Prediction 文本游戏状态转移数据检验模型能否正确预测世界变化。本轮核对论文摘要与官方出版信息，没有复现实验。

它作为“需要测实际状态变化”的基础参考，已在最初讨论中引用。其特定模型与任务上的结果不能直接作为当前模型的能力上限，也不能据此认定某种 Wispiva 表示已经有效。

### WorldAgent-Benchmark：长期运行与事件关系

[论文](https://arxiv.org/abs/2609.32692)、[公开实现](https://github.com/HCPLab-SYSU/WorldAgent-Benchmark)。维护轨要求把持续叙事落实为结构化世界变化；推断轨在部分观察下推测世界。维护轨分别报告完成情况与事件关系分数，后者由程序判断。

实际已读的 engine 包含分阶段写入、引用与类型检查、同一步冲突写拒绝，以及用相同校验路径预演提交的 `simulate_commit_step`。其评审读取冻结快照与操作日志，并有案例真值作为依据。值得参考“可查询、可预演、可审计”的接口；不是通用物理因果裁判。回放、渲染和可玩演示仍列于发布路线。

### WorldLLM：假设需要主动找反例

[论文](https://arxiv.org/html/2506.06725v3)、[公开实现](https://github.com/flowersteam/WorldLLM)。用自然语言假设影响预测，通过 Bayesian 推断更新假设，并训练好奇心驱动的实验者，寻找当前假设解释不好的环境转移。

它说明规律不必一开始全变成代码，也可以先是有证据、可修订的文字假设。其测试来自已有环境，不能把 Wispiva 自己模拟出的后果当成同等独立证据。与既有角色记忆还须区分：角色的信念和环境采用的机制不是同一类知识。

### EMPIRIC：基础模拟器之外可以补机制

[作者项目](https://basisresearch.github.io/empiric/)、[论文](https://arxiv.org/abs/2609.35047)、[作者链接的代码仓库](https://github.com/BasisResearch/predicators)。2026-09 的工作从基础物理引擎出发，为胶水固化、水的加热、风等缺失机制补充程序，再通过实验推断参数和隐藏状态；预测与执行不符时修订模型。

对 Wispiva 的启发是让已有机制与新候选机制共存，避免每轮从头猜一切。其验证依靠模拟或机器人实验；目前覆盖有限物理任务，不是现成的社会、经济、生态通用模拟器。本轮核对了作者项目与链接仓库，未审计 EMPIRIC 的具体算法实现或复现实验。

### Agent World Model（AWM）：生成环境与验证任务完成

[论文](https://arxiv.org/html/2602.10090v1)、[公开实现](https://github.com/Snowflake-Labs/agent-world-model)。生成场景、数据库、工具和验证程序，构造可执行的工具使用环境；公开 1,000 个环境资源。

最相关的是数据库状态为验证提供依据，以及生成接口与状态共同演化的方法。但这里的 verifier 主要服务任务完成与奖励判断；不能直接挪作“暴雨是否造成某种减产”的动力学验证器。论文的 code-augmented judge 也不是硬约束被模型同意后即可跳过的依据。

### DiscoveryWorld：把假设变成可测实验

[作者项目](https://allenai.github.io/discoveryworld/)、[公开实现](https://github.com/allenai/discoveryworld)。提供需要提出假设、设计实验、执行与分析的科学发现任务，可参考如何构造“模型说得通，但实验可能反驳”的测试。

它与 ScienceWorld 都有可执行环境为结果提供锚点。值得借鉴测试设计，不意味着要把 Wispiva 变成科研任务游戏。

### Memento 3：围绕世界模型的自我改进

[Memento 3: Model-Based Recursive Self-Improvement through Reflective Rulebooks](https://arxiv.org/abs/2610.11794)，2026-10-08 提交。本项在用户询问“RSI?”后补查，本轮仅核对论文摘要，未核实完整实现或复现实验。

摘要描述：底层 LLM 保持固定，通过外部记忆维护可修订的自然语言规则书，编译为可执行世界模型，再根据观察、预测错误、规则修订和验证更新规则书与代码。更新接受条件包括模型对规则书忠实性的判断，以及精确重放已观察转移。作者将此作为基于世界模型的 RSI 路线。

对 Wispiva 的讨论价值：已学机制可能帮助选择更有效的探索和实验，再改善后续建模。仅增加规则并不自动证明系统的自我改进能力增强；重放既有转移也不等于未见情形已正确。当前用户要求先解决表示和计划，**没有决定将 RSI 纳入交付或自动采用机制学习方案**。

## 4. 最新的显式世界与生成画面路线

| 研究 | 方向 | 本轮核对到的开放状态与边界 |
| --- | --- | --- |
| [Code World Model: Coding Agent as World Brain（2026-08）](https://arxiv.org/html/2608.25927v1)、[仓库](https://github.com/buaacyw/code-world-model) | 编程 agent 维护世界，proxy 连接状态与视频生成 | 仓库公开 H3 推理、LoRA/示例资源入口。论文使用已有基础引擎与模板，明确未展示自主构造完整开放世界模拟器；不能把渲染实现等同于通用 world brain 已交付 |
| [Programmable World Model（2026-09）](https://arxiv.org/abs/2609.10540)、[仓库](https://github.com/AlayaLab/PWM) | 持久状态与程序化规则，经带状态的 3D OBB 编译后控制视频渲染 | 核对时仓库主要是 README 与 assets；推理代码、权重仍在发布路线。可参考架构，不能算已可接入的完整开源引擎 |
| [CoDeR: Code Plans, Diffusion Renders（2026-09）](https://arxiv.org/html/2609.26458v1) | 按输入、输出和共享约束把世界分成功能模块，由 coding agents 构造，再生成画面 | 论文称将公开代码与权重；本轮未核实完整发布，所列项目页未能访问。模块分解有参考价值，不作为可用实现推荐 |

对本项目的推断：这些工作使“可执行环境 + 独立视觉呈现”成为值得比较的路线；它们并没有提供 Wispiva 所需的通用真实性保证，也不构成现在改用视频渲染的理由。

## 5. 对 Wispiva 的讨论建议

### 分开验证三件事

- **状态是否合法**：引用、数量、单位、归属、时间、冲突写等，依据明确时用程序检查。
- **机制是否有依据**：适用前提、反例、领域数据与世界设定；LLM 审查可提供线索，但不能替代缺失的依据。
- **后果是否完整传播**：直接目标之外的依赖对象是否更新，无关对象是否被误改，延迟后果与多轮演化是否一致。

GlobeBench 与 WorldAgent 的价值尤其在第三项。即使一次变化看起来正确，跨对象、跨时间维持一致仍是独立问题。

### 比较三条路线，先不冻结

| 候选路线 | 潜在收益 | 需要验证的代价 |
| --- | --- | --- |
| LLM 每轮提出候选状态变化，分层检查后提交 | 开放、启动快，接近当前 beat | 长期规律漂移、数值不稳、未建模后果遗漏，审查成本 |
| LLM 构造机制，机制通过检查后重复执行 | 可重放、便宜地重复计算同类效应，规律可检查 | 生成的机制本身可能错误；需要表示、执行边界、独立测试及版本管理 |
| 已采用机制负责覆盖范围，LLM 提出未覆盖的效应或新机制 | 保留开放性，减少重复推导 | 如何判断覆盖、如何处理未知、如何升级和撤回机制，仍需实验 |

暂时更值得比较的是第一与第三条。机制可以先用声明式前提与效果表达，并不等于立刻让模型生成任意 Python，或训练专用世界模型。

例如，连续暴雨后的运输受阻，应能够查询道路状态与运力，记录对库存的延迟影响；排水改善后，后果应随前提改变。居民是否恐慌、囤货或互助仍由角色决定。无论选择哪条路线，都要能说明哪些值由既有机制计算、哪些是模型估计、哪些尚无足够依据。

最需要继续讨论的问题是：**世界的基础规律由谁确立，哪些结果必须符合现实依据，哪些可以作为幻想世界的设定？** 这决定 Verifier 能做什么，也决定“新机制通过测试”究竟表示内部自洽、符合特定环境，还是符合现实。

## 6. 关键源码阅读入口

以下文件均在本轮下载为文本并阅读了相关部分，没有执行其代码：

- Concordia：[world_state.py](https://github.com/google-deepmind/concordia/blob/main/concordia/components/game_master/world_state.py)、[event_resolution.py](https://github.com/google-deepmind/concordia/blob/main/concordia/components/game_master/event_resolution.py)。
- WorldCoder：[synthesizer/evaluator.py](https://github.com/haotang1995/WorldCoder/blob/main/worldcoder/agent/synthesizer/evaluator.py)、[refine_transit.py](https://github.com/haotang1995/WorldCoder/blob/main/worldcoder/agent/synthesizer/refine_transit.py)。
- Text2World：[evaluator.py](https://github.com/Aaron617/text2world/blob/main/text2world/utils/evaluator.py)。
- NeSyS：[create_transition_mcq_rules.py](https://github.com/tianyi-lab/NeSyS/blob/main/nesys/create_transition_mcq_rules.py)。
- GlobeBench：[deterministic_grader.py](https://github.com/patronus-ai/globebench/blob/main/deterministic_grader.py)、[harness.py](https://github.com/patronus-ai/globebench/blob/main/harness.py)。
- WorldAgent：[runtime/engine.py](https://github.com/HCPLab-SYSU/WorldAgent-Benchmark/blob/main/benchmark/maintenance_track/runtime/engine.py)。
- AWM：[verifier.py](https://github.com/Snowflake-Labs/agent-world-model/blob/main/awm/core/verifier.py)、[verify.py](https://github.com/Snowflake-Labs/agent-world-model/blob/main/awm/core/verify.py)。
- ScienceWorld：[HeatTransfer.scala](https://github.com/allenai/ScienceWorld/blob/main/simulator/src/main/scala/scienceworld/processes/HeatTransfer.scala)、[Plant.scala](https://github.com/allenai/ScienceWorld/blob/main/simulator/src/main/scala/scienceworld/objects/livingthing/plant/Plant.scala)。

这是定向调研，不是代码审计、性能排行或项目整体质量背书。公开仓库、论文方法和完整可运行产品分别判断；如后续引入代码或模型，还需按具体制品核对兼容性与许可。

## 7. 阅读深度与证据范围

以下为本次实际完成的资料阅读范围；“正文”指阅读了相关章节，不代表逐页精读。所有项目均未安装或运行，性能结论均未独立复现。

| 资料 | 已核对的内容 | 尚未验证 |
| --- | --- | --- |
| Concordia | 官方 README、相关调度文件、世界状态与事件裁定组件的部分源码 | 目标场景的运行行为、真实性与成本 |
| WorldCoder | 相关论文正文、README、转移评估和返修源码 | 依赖兼容、可运行性、迁移到开放世界的能力 |
| Text2World | 作者项目页、README、评估源码 | 完整论文复核、规划器执行与本项目适用性 |
| NeSyS | 方法正文、README、规则生成与部分最终规则源码 | 复现、开放式环境效应验证能力 |
| Word2World | 官方 README、模型/数据入口、评估协议说明 | 权重效果、模型文件及训练/评估运行 |
| GlobeBench | 论文摘要、README、确定性 grader 与 harness 的相关源码 | 数据与全部评审记录审计、重评分复现 |
| AgentSociety 2 | README、作者资料与架构文档、仓库结构 | 环境与调度算法审计、部署和成本 |
| ScienceWorld | README、传热与植物过程相关源码 | 数值正确性、过程覆盖和实际执行 |
| LLM-Sim / ByteSized32（ACL 2024） | 官方论文摘要与出版信息 | 实验复现、对当前模型与本项目的可迁移性 |
| WorldAgent-Benchmark | 论文摘要、README、维护轨 engine 相关源码 | 案例整体质量、评分复现、完整运行 |
| WorldLLM | 相关论文正文与 README | 假设推断和探索算法源码审计、效果复现 |
| EMPIRIC | 作者项目页、论文摘要、作者链接的仓库 | EMPIRIC 具体实现、实验轨迹与复现 |
| AWM | 相关论文正文、README、verifier / verify 相关源码 | 生成环境质量、验证器准确率和训练效果 |
| DiscoveryWorld | 论文摘要、作者项目与 README | 具体场景实现与 agent 实验 |
| Code World Model | 相关论文正文、局限章节、项目与官方仓库 README | 完整 world brain、推理运行与视觉效果 |
| PWM | 论文摘要与仓库 README / 发布路线 | 未核实到完整推理实现和权重运行 |
| CoDeR | 相关论文正文 | 所列项目页未能访问，完整代码/权重发布未核实 |
| Memento 3 | 论文摘要 | 具体算法实现、代码发布及 RSI 实验结论 |

开放状态是 2026-10-25 的核对记录，后续选型需复核。源码入口是阅读证据，不表示代码已经通过测试；研究价值、可读实现和可直接用于本项目的产品能力分别判断。

## 8. 检索发现但未深入核查的线索

以下保留检索范围，便于后续接续。它们未进入已核对项目的推荐结论；没有确认的能力、跑分和宣传语不据此写入需求。

| 线索与入口 | 当时关注的问题 | 本轮处理 |
| --- | --- | --- |
| [Code World Models for General Game Playing](https://arxiv.org/abs/2510.04542) | 根据规则与轨迹生成可执行游戏模型，再配合规划 | 阅读检索到的论文摘要与发布信息；未核实对应完整开源实现 |
| [OpenWorld](https://github.com/quome-cloud/openworld) | 世界 spec、代码动力学与候选程序验收 | 仅检索到项目说明，未审查源码或验证性能声明 |
| [Manyworld](https://github.com/alinojoumi8/manyworld) | 持久状态、社会模拟、实验与回放 | 仅检索线索，未深入评估 |
| [WMW](https://github.com/EmmanuelleB985/wmw) | 类型化转移记录与混合检查器 | 仅检索线索，未验证数据与检查效果 |
| [Agent World Model in the Wild](https://msr-orchard.github.io/WildAWM/) | 跨界面的合成环境与执行验收 | 仅阅读检索到的作者项目说明；属于软件环境方向，未深读实现 |
| [Trace2Env](https://github.com/ruyue0001/trace2env) | 根据行动—观察轨迹重建环境动力学 | 仅检索线索，未审查实现与评测 |
| [ExoPredicator（作者入口）](https://yichao-liang.github.io/) | 同时表示角色行动与自行发生的环境过程 | 作为 EMPIRIC 的相关工作发现，未单独深入核查 |

论文索引也分层保留：[Awesome Code World Models](https://github.com/yifliu3/awesome-code-world-models)用于补搜线索；分享中还提到 [Awesome Text World Models](https://github.com/sustech-nlp/awesome-text-world-models)，本轮未单独核对其内容。索引条目需要回到原始论文、作者项目与源码验证。

## 9. 当前研究判断与待回答问题

- **有证据支持继续研究**：角色意图与环境后果分工、显式状态、可执行机制、基于轨迹的反例修订，以及多步后果传播评测都有对应研究与实现入口。
- **本项目尚无验证结论**：A/B 哪种表示更合适、是否采用可执行机制、需要何种 Verifier、总成本与长期稳定性，均未实验。
- **当前优先级已由用户明确**：世界表示优先；先写好文档与计划，再决定后续实践方式。
- **仍开放**：基础规律如何确立、新机制第一次出现如何裁定、哪些现实依据必需、未知与估计如何记录，以及表示怎样扩展而不改写过去。

后续每次补充应记录日期、一手来源、阅读/运行深度和对原判断的影响。若新证据推翻旧判断，保留变化原因，并同步讨论与设计文档；不把候选资料自动升级为已选方案。
