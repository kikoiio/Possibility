# 世界模拟与验证研究

环境模拟研究关注状态怎样变化、变化依据什么，以及局部后果怎样传到其他对象与时间步。此处区分三类任务：预测一个可执行的既有环境、构造一个新环境及其动力学、检查轨迹是否遵守给定条件。三类任务可互相借鉴，但实验结果不能互换。

Wispiva 的产品目标是由角色自主提出意图，由环境推演实际后果，并对模型提出的候选变化进行检查。研究资料用于比较方法与检查证据，不替代产品规则或架构说明。外部论文的成绩均为作者报告；本文没有复现实验，也没有运行所列项目。

## 任务与证据边界

| 任务 | 典型问题 | 可能的验证依据 | 不能据此推出 |
| --- | --- | --- | --- |
| 预测既有环境 | 给定状态与行动，预测下一状态或后续轨迹 | 可执行环境、数据集中的参考状态、真实交互 | 能为任意新想法构造可信规律 |
| 构造环境 | 从说明生成状态、动作接口、规律或程序 | 环境自身的结构检查、任务 verifier、外部环境执行 | 生成的环境物理或社会规律符合现实 |
| 评估模拟结果 | 检查状态合法、依赖传播、事件关系或任务完成 | 代码约束、案例真值、领域数据、已声明世界规则 | 单一 grader 能成为通用因果裁判 |

即使模拟器、轨迹与评审器彼此一致，也不能仅凭内部一致性证明现实准确。判断研究时还须区分状态合法性、机制是否有依据、影响是否完整传播，以及评测依据是否独立于生成模型。

## 世界模型、环境模拟与评测研究

| 研究 | 方法与可借鉴内容 | 阅读与证据边界 |
| --- | --- | --- |
| [Concordia](https://github.com/google-deepmind/concordia) | Agent 提出行动，Game Master 生成观察并裁定后果，engine 组织组件和调度；可参考意图、结果、观察的职责分工。 | 阅读官方 README、调度文件及世界状态和事件裁定组件的部分源码。通用 `WorldState` 组件仍依赖模型更新字符串变量，不构成数值环境可靠性的保证；未运行。 |
| [WorldCoder](https://arxiv.org/abs/2402.12275) 与[公开实现](https://github.com/haotang1995/WorldCoder) | 根据环境交互经验合成和修订 Python 状态转移与奖励程序，再用于规划；错误经验可成为程序修订依据。 | 阅读论文相关正文、README、转移评估与修订源码。README 提到 numpy、gymnasium、minigrid 兼容限制；属于研究实现，未验证其开放世界适用性和本项目可运行性。 |
| [Text2World](https://text-to-world.github.io/) 与[公开实现](https://github.com/Aaron617/text2world) | 从文本生成 PDDL 世界模型，评估谓词、动作参数、前置条件、效果及可执行性；适合研究显式变化表达。 | 阅读作者项目、README、`evaluator.py`；未执行规划器。它不是持续开放世界内核，也不意味着 Wispiva 应采用 PDDL。 |
| [NeSyS](https://arxiv.org/html/2602.10480v2) 与[公开实现](https://github.com/tianyi-lab/NeSyS) | 融合模型为候选转移提供概率、由可执行规则评分，并交替改进模型和规则。公开实验包含转移选择题、规则重排及 WebShop 开放式行动评测。 | 阅读方法正文、README、规则生成和部分最终规则源码；未复现。它没有证明任意新环境效应已可验证。公开 ScienceWorld 规则会检查温度计行动是否包含读数、是否错误改变库存，这只能支持局部一致性检查，不能证明读数或热力学过程正确。 |
| [Word2World](https://github.com/X1AOX1A/Word2World) | 在 ALFWorld、ScienceWorld、TextWorld、WebShop、StableToolBench 等协议下训练和评估文本世界模型，并发布模型与数据。单步预测、多步 rollout、以及把模拟行动映射回原环境检验是可借鉴的区分。 | 阅读官方 README、模型／数据入口和评估协议；未运行权重或训练。现成权重不携带 Wispiva 的世界规律。 |
| [GlobeBench](https://arxiv.org/abs/2610.22708) 与[公开实现](https://github.com/patronus-ai/globebench) | 以 **1,632** 项文本环境测试评估模拟结果；公开题目、响应、评审记录、确定性 grader 与离线重评分工具。可检查直接受影响对象、依赖对象和无关状态。 | 阅读论文摘要、README、`deterministic_grader.py`、`harness.py` 相关源码；未审计全量数据和评审记录，也未重评分。论文报告的依赖传播平均 **5.1%** 属于该基准的特定设置，不是通用成功率。 |
| [AgentSociety 2](https://github.com/tsinghua-fib-lab/AgentSociety) 与[架构文档](https://agentsociety2.readthedocs.io/en/latest/architecture.html) | 社会模拟和实验平台，组织角色、环境模块、模型服务、追踪、回放与批次调度。 | 阅读 README、作者资料、架构文档和仓库结构；未审计环境与调度算法。仓库同时保留 v1；v1 大规模城市模拟结果不能证明 v2 具有同等复杂环境动力学。Ray 等基础设施只是参考，不是本项目默认依赖。 |
| [ScienceWorld](https://github.com/allenai/ScienceWorld) | 可执行的文本科学环境，涵盖行动、物件、温度、电路、生物等过程；适合观察对象属性和持续过程怎样共同产生可测后果。 | 阅读 README、传热与植物过程部分源码；未核对数值正确性和完整过程覆盖。它是范围有限的教学模拟，不是开放式真实物理。 |
| [LLM-Sim / ByteSized32-State-Prediction](https://aclanthology.org/2024.acl-short.1/) | ACL 2024 论文直接检验语言模型预测文本游戏中的状态转移，可作为“测实际状态变化”而非只评文字流畅度的基础参考。 | 核对论文摘要和官方出版信息；未复现。特定模型和任务结果不是当前模型能力上限，也不证明某种 Wispiva 表示有效。 |
| [WorldAgent-Benchmark](https://arxiv.org/abs/2609.32692) 与[公开实现](https://github.com/HCPLab-SYSU/WorldAgent-Benchmark) | 维护轨把持续叙事转成结构化变化，推断轨在局部观察下推测世界。维护轨分别报告完成情况和由程序判断的事件关系。engine 展示分阶段写入、引用／类型检查、同一步冲突写拒绝，以及 `simulate_commit_step` 预演提交。 | 阅读论文摘要、README 和维护轨 engine 的相关源码；评审读取冻结快照、操作日志和案例真值。它适合参考可查询、可预演、可审计的接口，不是通用物理因果裁判；完整运行、案例质量和评分未复现。 |
| [WorldLLM](https://arxiv.org/html/2506.06725v3) 与[公开实现](https://github.com/flowersteam/WorldLLM) | 用自然语言假设影响预测，以 Bayesian 推断更新假设，并训练好奇心驱动的实验者寻找当前假设解释不好的转移。可研究文字机制假设与主动反例搜索。 | 阅读论文相关正文和 README；测试依据来自既有环境，探索算法源码和效果未审计／复现。角色信念与环境采用的机制是不同知识。 |
| [EMPIRIC](https://arxiv.org/abs/2609.35047)、[作者项目](https://basisresearch.github.io/empiric/)与[链接仓库](https://github.com/BasisResearch/predicators) | 从基础物理引擎出发，为胶水固化、水加热、风等缺失机制补充程序，并通过实验推断参数和隐藏状态；预测与执行不符时修订模型。 | 核对作者项目、论文摘要和作者链接仓库；没有审计 EMPIRIC 的具体算法、实验轨迹或复现。依赖模拟或机器人实验，覆盖有限物理任务，不是社会、经济或生态通用模拟器。 |
| [Agent World Model（AWM）](https://arxiv.org/html/2602.10090v1) 与[公开实现](https://github.com/Snowflake-Labs/agent-world-model) | 生成场景、数据库、工具和 verifier，构造可执行工具使用环境；公开 **1,000** 个环境资源。数据库状态可为任务验收提供依据。 | 阅读论文相关正文、README、verifier 相关源码。verifier 主要服务任务完成和奖励判断，不能直接判断“暴雨是否造成减产”的动力学正确性；code-augmented judge 也不能豁免硬约束。 |
| [DiscoveryWorld](https://allenai.github.io/discoveryworld/) 与[公开实现](https://github.com/allenai/discoveryworld) | 科学发现任务要求提出假设、设计实验、执行并分析；可借鉴构造能反驳合理说法的测试。 | 阅读论文摘要、作者项目和 README；未审计具体场景实现或 agent 实验。可执行环境提供结果锚点，不意味着 Wispiva 要成为科研任务游戏。 |
| [Memento 3](https://arxiv.org/abs/2610.11794) | 论文提出固定底层 LLM、由外部记忆维护可修订自然语言规则书、编译为可执行世界模型，并根据观察和预测错误修订规则与代码的 RSI 路线。接受条件包括模型评判规则书忠实度及精确重放既有转移。 | 只核对摘要；未核实完整实现、代码发布或实验结论。精确重放已见轨迹不能证明未见情形正确；加入规则本身也不能证明自我改进能力提升。 |
| [Code World Model: Coding Agent as World Brain](https://arxiv.org/html/2608.25927v1) 与[仓库](https://github.com/buaacyw/code-world-model) | 编程 agent 维护世界，proxy 连接状态和视频生成；仓库提供 H3 推理及 LoRA／示例资源入口。 | 阅读论文正文、局限章节、项目与仓库 README。论文使用已有基础引擎和模板，未展示自主构造完整开放世界模拟器；渲染实现不等于通用 world brain。 |
| [Programmable World Model（PWM）](https://arxiv.org/abs/2609.10540) 与[仓库](https://github.com/AlayaLab/PWM) | 持久状态和程序化规则经带状态的 3D OBB 编译后控制视频渲染，可供研究可执行状态与画面生成的连接方式。 | 阅读论文摘要与仓库 README／发布路线；核对时仓库主要含 README 和 assets，推理代码与权重仍在发布路线，不能作为可直接接入的完整开源引擎。 |
| [CoDeR: Code Plans, Diffusion Renders](https://arxiv.org/html/2609.26458v1) | 将世界按输入、输出和共享约束分为功能模块，由 coding agents 构造，再生成画面；模块化可作为架构研究方向。 | 阅读论文正文；所列项目页未能访问，完整代码和权重发布未核实，不作为可用实现推荐。 |
| [Belief-State Engine](https://arxiv.org/abs/2609.10036) 与 [Belief-Based World Models](https://arxiv.org/abs/2609.00455) | 近期工作把部分可观测环境中的“已知、未知与信念”作为可查询的外部状态，强调 LLM 的历史条件策略本身不等于显式 belief state。可作为 Wispiva 区分客观世界、角色观察和角色信念的研究依据。 | 只核对摘要，未复现实验或审计代码；这些工作不能直接证明本项目的 `visibility` 结构或长期知识账本足够，也不替代领域规律验证。 |

## 实现阅读入口

以下源码是方法阅读入口，不是通过测试的实现背书：

- Concordia：[`world_state.py`](https://github.com/google-deepmind/concordia/blob/main/concordia/components/game_master/world_state.py)、[`event_resolution.py`](https://github.com/google-deepmind/concordia/blob/main/concordia/components/game_master/event_resolution.py)。
- WorldCoder：[`synthesizer/evaluator.py`](https://github.com/haotang1995/WorldCoder/blob/main/worldcoder/agent/synthesizer/evaluator.py)、[`refine_transit.py`](https://github.com/haotang1995/WorldCoder/blob/main/worldcoder/agent/synthesizer/refine_transit.py)。
- Text2World：[`evaluator.py`](https://github.com/Aaron617/text2world/blob/main/text2world/utils/evaluator.py)。
- NeSyS：[`create_transition_mcq_rules.py`](https://github.com/tianyi-lab/NeSyS/blob/main/nesys/create_transition_mcq_rules.py)、[ScienceWorld 最终规则示例](https://github.com/tianyi-lab/NeSyS/blob/main/nesys/final_rules/rules_scienceworld_qwen3-4b_final.py)。
- GlobeBench：[`deterministic_grader.py`](https://github.com/patronus-ai/globebench/blob/main/deterministic_grader.py)、[`harness.py`](https://github.com/patronus-ai/globebench/blob/main/harness.py)。
- WorldAgent：[`benchmark/maintenance_track/runtime/engine.py`](https://github.com/HCPLab-SYSU/WorldAgent-Benchmark/blob/main/benchmark/maintenance_track/runtime/engine.py)。
- AWM：[`verifier.py`](https://github.com/Snowflake-Labs/agent-world-model/blob/main/awm/core/verifier.py)、[`verify.py`](https://github.com/Snowflake-Labs/agent-world-model/blob/main/awm/core/verify.py)。
- ScienceWorld：[`HeatTransfer.scala`](https://github.com/allenai/ScienceWorld/blob/main/simulator/src/main/scala/scienceworld/processes/HeatTransfer.scala)、[`Plant.scala`](https://github.com/allenai/ScienceWorld/blob/main/simulator/src/main/scala/scienceworld/objects/livingthing/plant/Plant.scala)。

## 可继续检索的线索

以下条目仅有检索线索或项目说明，未进入方法结论：

- [Code World Models for General Game Playing](https://arxiv.org/abs/2510.04542)：根据规则和轨迹生成可执行游戏模型，再配合规划；核对论文摘要与发布信息，未找到经核实的完整开源实现。
- [OpenWorld](https://github.com/quome-cloud/openworld)：世界 spec、代码动力学与候选程序验收；仅检索项目说明，未审查源码或性能声明。
- [Manyworld](https://github.com/alinojoumi8/manyworld)：持久状态、社会模拟、实验和回放；未深入评估。
- [WMW](https://github.com/EmmanuelleB985/wmw)：类型化转移记录与混合检查器；未验证数据和检查效果。
- [Agent World Model in the Wild](https://msr-orchard.github.io/WildAWM/)：跨界面合成环境与执行验收；仅读作者项目说明，未深读实现。
- [Trace2Env](https://github.com/ruyue0001/trace2env)：由行动—观察轨迹重建环境动力学；未审查实现或评测。
- [ExoPredicator](https://yichao-liang.github.io/)：同时表示角色行动与自行发生的环境过程；作为 EMPIRIC 相关线索发现，未单独深入核查。
- [Awesome Code World Models](https://github.com/yifliu3/awesome-code-world-models) 与 [Awesome Text World Models](https://github.com/sustech-nlp/awesome-text-world-models)：索引只用于发现资料，条目须回到论文、作者项目和源码核对。

## 研究问题与检查维度

世界表示至少要能讨论四类信息：状态中有哪些实体、属性、关系、空间与资源；变化由什么行动或环境过程引起；世界规律和例外是什么；哪些已提交事实、历史事件或已采用机制为结果提供依据。数量需要单位、观测时间和未知表达；过程需要前提、作用范围、延迟和依赖；依据应能区分事实、假设与估计。

验证可拆成三层：

1. **状态是否合法**：检查引用、字段、单位、归属、数值范围、时间和同一步冲突写。
2. **机制是否有依据**：检查适用前提、已声明规律、反例、领域数据或用户设定。另一个 LLM 的同意只能作为语义审查信号。
3. **后果是否完整传播**：检查直接目标、依赖对象、无关对象、延迟影响和多步过程。一次局部结果正确不代表跨对象与跨时间一致。

代表性检验可用持续降雨影响道路、两处运输和库存：同一雨量在排水设施不同的情况下应能表达不同后果；角色是否绕行、修路、囤货或互助由其自身处境和所知决定。也可用干／湿木桌遇火检查属性区别是否影响跨领域后果。示例场景提供测试结构，不构成现实数值预测。

本文引用的公开项目、论文方法、可读代码、完整可运行产品和 Wispiva 适用性是不同层次。运行能力、许可、成本和项目发布状态在采用前需要针对具体制品核实。研究本身没有证明任意想法都能被可靠模拟。

## 世界表示的候选组织

表示不仅是 JSON、图、自然语言或程序等容器格式。它还决定哪些对象、状态、关系、过程、条件与未知信息能够被明确表达、持续引用和验证。一个实用的充分性检查是：若两个在表示中完全相同的局面按目标规律本应产生不同后果，表示就漏掉了必要区别；评估范围也须有限定，避免无目的地增加属性。

三种组织路线可在同一任务上比较，不预设任一表示胜出：

| 候选 | 组织方式 | 可能收益 | 需检查的代价 |
| --- | --- | --- | --- |
| A：属性快照与文字过程 | 实体保存开放属性，单位、条件与过程用文字说明 | 表达直接、创作自由、输入形状简单 | 跨步引用、未知值、依赖关系、重复执行和程序检查容易含混 |
| B：可扩展语义组件与显式过程 | 属性带定义、单位和信息状态；过程有身份、进度、对象与依赖；机制单独声明 | 可检查、可继承、便于扩展与对照 | 概念定义、机制版本、过程生命周期和模型表达成本增加 |
| C：可执行机制优先 | 用程序或规划语言描述转移，由模型构造、测试或修订机制 | 同一机制可重用、重放，部分约束可直接执行 | 机制程序本身可能错误；执行边界、开放性、测试和维护成本更高 |

A/B 对照回答的是信息组织方式对表达、检查与生成的影响。C 可作为单独比较项或消融，不应把“多给了可执行规律”带来的收益全部归因于表示方式。

## 事实、未知、机制、过程与预测

概念字段名不是核心；语义要能区分下列内容：

| 概念 | 需要表达的内容 | 关键限制 |
| --- | --- | --- |
| 实体与关系 | 身份、类别、位置、组成、连接、归属 | 同一事实有单一权威来源；派生索引和几何引用该来源 |
| 属性定义与量值 | 含义、数据类型、单位、适用对象、值域、来源 | 可扩展属性仍要有含义；单位不匹配不可静默兼容 |
| 信息状态 | 已知值、已观测值、估计、未知、不适用 | 未知不能默认为 0、false 或不存在；未知与已知为零是两种状态 |
| 持续过程 | 身份、对象、启停状态、开始时间、已推进时间、内部状态 | 已推进的过程进度是事实；未来预测不是已经发生的结果 |
| 机制与规律 | 前提、输入与输出、作用范围、参数、例外、版本及依据 | 文字声明、测试证据和可执行实现分开判断；模型同意不等于规律已验证 |
| 候选变化 | 基准 revision、时间窗、规律版本、读取依赖、直接／延迟效果、依据与未知 | 验证和原子提交之前不成为事实 |
| 角色观察与信念 | 谁在何时观察到什么、信息来源和所属主体 | 角色只获得其可见观察与自身记忆；误解可以存在，但不能覆盖环境事实 |

“系统尚未定义或观测某个量”与“角色不知道某个客观事实”不能混为一种 null。估计须保留产生估计的依据；模型自报 confidence 不是校准概率。后来建立腐蚀机制需要材料或涂层资料时，旧实体的该属性应可保持未知，不能把后来的推测倒填成先前世界历史。

## 多步、干预、失效与重启

单步回答无法覆盖连续模拟。表示和执行过程至少要能说明从上次推进时间到当前时间发生什么、哪些依赖仍有效，以及恢复时如何避免重复结算。

- **重复推进**：同一时间区间或同一事件重复送达时，不能重复扣资源或重复应用过程效果。
- **多步传播**：运输、库存、消耗和延迟效应应能跨实体与跨时间追踪；无关实体不应被顺手改变。
- **条件干预**：停雨、修好排水、关闭道路或改变世界设定后，读取这些条件的旧预测应失效、重新验证或重算。
- **错误和验证失败**：未能形成可用结果、共享预算不足或候选验证失败时，世界停在可确定的时刻，并明确显示等待；具备继续条件后从该点续跑，不编造结果、不跨过未知区间。
- **进程恢复**：从保存的世界时间、状态与过程进度继续，不补算进程退出期间的离线时间、不重复执行已结算区间。
- **历史节点**：每个历史节点保存完整 world 快照，包括只新增纯对白的节点；对白本身不需要伪造环境变化才能留下可回查状态。
- **分岔**：子线继承分岔时已发生的状态和过程进度；尚未发生的预测在新条件下重新评估。父子线状态、机制版本和之后的角色经验不串线。
- **预算与审计**：角色、环境推演、验证和返修共享配置的总预算；记录输入、输出、每次尝试、用量、延迟及失败／丢弃理由。不能因返修、跨线或拆分角色调用绕过上限。

固定步长或事件驱动并非概念表示本身即可决定。用分钟尺度的玩具场景可先测试过程累计、延迟、同一时刻事件排序及拆分时间步的差异；选择哪种调度应看行为要求、误差和运行成本。

## 对照方法与评估

一个可复核的 A/B 对照可采用六个小场景，每个场景各用 A、B 表示，并在固定条件下重复两次，最多 **24 次初始模型调用**。返修是否允许、返修次数、模型版本、上下文和 token 上限都在实验开始前固定；失败也计入结果，不反复重跑后只保留最好一次。该数量是有界实验设计，不足以支持统计显著性或普遍能力主张。

### 对照纪律

1. 两种表示使用相同初始状态、历史、规律说明、未知项、任务、模型、输出要求和预算；唯一计划改变的因素是组织方式。
2. B 不可额外得到更多已知事实、领域知识、参考答案或模型 token；若增加可执行机制，另作机制消融以区分表示收益和机制收益。
3. 参考轨迹与可判定条件独立保存，不放入模型 prompt；由确定性检查、外部案例依据或盲评判断，不能仅用生成模型自评。
4. 单步、持续多步、干预后失效、分岔和进程重启分别报告；不能用单步结构合法率代替多步正确性。
5. 同一玩具规律先用于检查解析、表示与确定性执行，再单独检验语言模型结果。玩具引擎通过只能证明该接口在所测条件下可执行，不能证明真实世界准确。
6. 提示、结果、失败、拒绝、返修次数、成本与验证依据一并保存，避免只保留成功案例。

### 指标与场景

| 指标 | 检查问题 |
| --- | --- |
| 关键事实表达率、必须字段遗漏 | 表示能否容纳目标效应所需的区别 |
| 单位、引用、资源账目、时间与冲突写违规数 | 可判定约束是否得到执行 |
| 依赖对象遗漏、无关对象误改、延迟与跨步漂移 | 后果是否完整并保持连续 |
| 未知被编造、预测被当事实、失效预测仍提交 | 不确定性与条件变化是否得到处理 |
| 误拒绝和误放行、诊断定位质量 | 检查器是否既能拦截违规又能指出缺少的条件 |
| 请求数、token、延迟、人工修改量、输入体积 | 收益是否值得额外成本 |

核心样例可以是一条道路、两个地点、降雨、排水、运输和库存：改变排水能力应改变道路积水和运输条件；中途改善排水后旧的库存预测要重新计算；角色随后决定绕行、修路或囤货，但这些行动由角色根据自身目标和所知提出。跨领域样例可用干／湿木桌遇火，检查表示是否捕捉影响结果的材料状态，而不是只适用于降雨。

每个案例应逐步列出事实、机制、过程进度、候选后果、提交结果、依据和未知项。量化玩具参数是用来检验流程的明示设定，不是现实科学预测。

## 原型验证与集成边界

原型分别检查以下边界，以轨迹、检查结果与失败案例决定数据组织和集成方式：

- 表示是否保留关键事实、持续过程、机制、未知项和依赖，扩展概念是否需要改写整个结构。
- 世界写入是否经过验证并与过程进度、历史和记忆一致提交，失败是否留下部分结果。
- 世界时间是否受可推进范围约束，条件变化后预测是否失效，暂停和重启是否重复结算。
- 角色可见域是否覆盖整个输入路径；仅按 owner 查询记忆并不能阻止完整世界输入泄漏隐藏事实。
- 候选结构是否表达因果与验证依赖；实验可使用独立数据结构，不应受预设产品 DTO 限制。

### 2026-10 原型实测：角色级秘密行动

#### 可见性方案选择

本轮比较了两种形状。方案 A 在资源和行动上保存静态 `visibility: { actors, clues }`，用 `clue.discoveredBy` 表达已经获得的揭示，再用行动的 `performers` 单独表达执行权限；方案 B 使用受限的 `anyOf` 条件树，把 actor、同地、已知事实和已知线索组合成策略。两者都必须经过程序解释，不能执行模型生成的脚本。

原型选择方案 A，因为它能直接复用现有的 `knownBy`、`discoveredBy`、完整 world 快照和严格引用检查，足以验证 Spaulding 的秘密行动；方案 B 需要策略版本、深度和循环限制，并且还要保存动态知识，当前实验没有足够证据承担这层复杂度。方案 A 的边界也明确：它暂时不能表达任意“进入后永久知道”“知道某事实才可见”或多条件信念推理。若后续反事实实验需要这些能力，再把 `itemVisibility` 解析器升级为受限策略，而不是直接允许自然语言或 JavaScript 条件。

本轮在 `prototypes/fixtures/red-headed-league.mjs` 建立了一个取自《红发会》开头事实的小起点：当铺、地下室、银行，Wilson、Spaulding 和 Holmes，以及挖掘进度、体力、开关和银行警戒。它不写入银行抢劫，也不要求角色复现原著结局。

新增的最小表示是：资源和行动可带 `visibility: { actors, clues }`，行动可带 `performers`。地点仍决定物理在场；`actors` 表达起点知情，`clues` 表达检查线索后的可见性，`performers` 表达执行权限。资源隐藏时仍参加完整环境过程；角色投影只接收当前可见资源，已知行动若依赖不可见资源则保留行动身份但只给出 `executable: null` 和通用未知条件。直接猜测隐藏行动 ID 返回通用 `action-unavailable`，不会返回隐藏行动或资源的名称、数量和阈值。

定向测试覆盖：同一地点可见但秘密资源和行动不进入 Wilson 观察；Spaulding 能看到并执行；Wilson 进入地下室仍看不到秘密实体，检查泥痕后看到进度但仍不能执行 Spaulding 专属行动；隐藏进度达到阈值后跨地点增加银行警戒；失败行动不改变完整快照；保存可复制的观察结果保持一致。该证据支持有限离散规则下的角色信息边界，不支持一般视线、推理、长期信念或任意秘密传播。

真实模型创建世界使用一次隔离存档完成了 3 个阶段调用，输出 4 个地点、3 个角色、4 个资源、2 个过程和 5 个行动，并生成了 `visibility`/`performers` 字段。模型输出同时暴露出一个重要失败模式：它把地下计划写入了公开的世界 premise 和地点 description。因而角色观察已停止传入 author-facing premise 与地点 description；后续创建世界提示和语义检查仍需继续收紧。证据目录为 `.tmp/prototype/red-headed-live-vpQN87/`，其中 `proof.json` 记录完整候选与验证结果，`model-calls.jsonl` 保存脱敏审计。

这次结果把“结构验证通过”与“信息语义正确”明确分开：程序能确认引用、权限数组、资源条件和场景可编译，不能仅凭 JSON 形状确认自然语言没有泄露秘密。下一步需要加入公开文本与私有机制的语义检查，并把作者级 API 与角色级观察接口分开验证。

#### 2026-10 原型实测：接受前隐私审计与反事实分支

针对真实创建世界中“秘密计划进入公开 premise／地点说明”的失败，原型在 `checkWorldCandidate()` 中加入了可复用的 `auditCandidatePrivacy()`。它先用同一角色观察投影建立每位角色的输入，再检查作者级 premise 和地点叙述、隐藏资源／行动标识、他人目标与前史是否进入角色观察；同时对作者级公开文字与角色私有目标、隐藏机制名称／描述做有限的四字符片段重合检查。高置信命中会以 `privacy-audit-failed` 拒绝草稿，草稿若通过则保存审计限制和结果。

这不是自然语言安全证明。角色目标和隐藏机制可能用同义词、暗示、跨语言或更长上下文推理泄漏；公共地点名称也可能合法地包含资源名称的一部分，所以实现避免把所有名称字符串重合都当作错误。当前限制被直接写入审计结果：通过只说明当前投影和词片段边界满足，不能说明后续对白、行动结果、模型上下文或角色信念没有越权。

《红发会》反事实实验把同一原点复制成独立分支：Wilson 增加一次出勤记录，Holmes 先移动并检查地下室后看到地下进度但仍不能执行 Spaulding 专属行动，Spaulding 连续挖掘四次再推进一分钟使银行警戒增加。三个分支的 revision、资源和观察不同，原点仍保持 revision 0；这证明当前离散规则可以表达“知情变化”和“客观后果变化”分离，但不证明完整小说因果、角色推理或原著结局复现。

持续过程、行动后果、多主体知情隔离与新规律扩展可先分别验证，再组合。时间、对话干预、迟到推演、空计划、fork 记忆继承、祖先日志分页和过程事务需要可复核的行为证据；静态接口存在不等于行为经过端到端验证。目标职责与提交边界见[架构方案](../design/2026-10-27-target-architecture.md)。

#### 2026-10-27 原型重做：红发会作为唯一体验入口

旧的“山雨未停”运行存档已删除并用新的《红发会》起点替换：第 0 分钟、revision 0、暂停，包含当铺、地下室、银行、Wilson、Spaulding 与 Holmes。固定夹具仍只用于这个可复核起点和回归测试；它没有把银行抢劫写成必然结局。服务启动时从这份新存档读取，避免旧世界继续自主推进而污染视觉或行为观察。

原型页面改成案件档案式壳层：首屏突出红发会的调查方向，运行页把三维现场和事实时间线并置，操作按钮仍调用原来的 control/actor 接口。这个改动支持了一个产品判断：主题化 UI 能帮助用户理解“观察现场 → 选择人物 → 改变状态”的路径，但主题文案不能替代 `world`、`activity`、角色观察和运行规则。
