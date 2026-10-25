# Wispiva v1 开发计划

日期:2026-10-25
状态:**草案,待用户确认后执行**。本文把 [ARCHITECTURE.md](architecture/ARCHITECTURE.md) §9 的里程碑展开为可并行执行的轨道计划;契约依据 [CONTRACT-DRAFT.md](architecture/CONTRACT-DRAFT.md)(11 项已裁决),记忆依据 [DESIGN-memory.md](architecture/DESIGN-memory.md)(已批准)。

## 0. 基线:已定与未定

**已定**:契约形状全部(Q1–Q11);记忆系统(owner 分行/透镜/三层/情境触发 reflection);渲染路线(solid 主/voxel 副);在场三态(可对话、附身=B 含 A、交互降速+提醒);创世=用户与 AI 对话式;追更=新闻播报;驱动力=架构解耦不预付方案。

**未定(归属后置阶段,不阻塞开工)**:在场细节(降速窗口内到期 beat 的抢占/交错,P2-E 实现);新闻播报的分级阈值(P3-J);创世对话流程细节(P3-I);story driver 策略(P3+);两段式叙述(P3-H 实验带)。

## 1. 并行执行策略

- **执行者**:主 agent + 子 agent。实测子 agent 并发上限约 1–2,因此并行性首先体现在**轨道解耦**(互不依赖、各有独立 DoD 与测试),其次才是同时开工——轨道一旦解耦,串行调度也能无缝流水,并发恢复时立即加速。
- **关键技巧:轨道间接口先行**。凡有依赖的轨道,先在共享文档冻结接口签名(不是实现),各轨对接口编程,消除等待。
- **重型验证走云端 CI**(E2E、真实 LLM 调用、大规模回归),本机只跑定向单测;规则遵守用户 AGENTS.md(内存判断、复用服务、错峰)。
- **决策门推进,不做日历估计**:每阶段以"门"收口,过门才进下一阶段。

## 2. 依赖图

```
P0 contract(串行,关键路径)
    │ 类型+Schema+fixtures+轨道间接口约定
    ├─────────────┬─────────────┬─────────────┐
P1-A domain   P1-B store    P1-C clock    P1-D llmclient
(纯函数)      (SQLite+FTS5) (倍速积分)    (预算/审计/记忆组装)
    │             │              │             │
    └──────┬──────┴──────┬───────┘             │
P2-E runtime+http ←──────┘(编排 T1–T4)   P2-F web/shell(可与 P1 并行起)
           │                                 │
P2-G renderer 3d(projection=engine 侧 + three.js 侧,依赖 A/F)
           │
    ┌──────┴────────┬──────────────┐
P3-H live LLM    P3-I 编辑器+      P3-J 在场:对话/附身/
+灵魂A/B实验     创世+三栏视图      新闻播报/追更
    └──────┬────────┴──────────────┘
P4 收口:单命令打包/云部署文档/E2E 全量/性能测量
```

## 3. 阶段与轨道

### P0 契约与脚手架(串行,主 agent)

| 项 | 内容 | 验收 |
| --- | --- | --- |
| P0.1 | 根 workspaces(`packages/contract engine web`)+ tsconfig 基座 + vitest | `npm test` 空转通过 |
| P0.2 | `packages/contract`:全部 TS 类型(按 CONTRACT-DRAFT 定稿) | tsc 零错误 |
| P0.3 | JSON Schema(Op/Plan/Memory/EditProposal 优先)+ 校验工具函数 | schema 自校验 fixtures |
| P0.4 | 9 个 fixtures(按 CONTRACT-DRAFT §5 清单) | 全部通过 schema |
| P0.5 | **轨道间接口约定文档**(store 查询 API 签名、domain 导出清单、llm 组装输入) | 四轨负责人(即各 agent 任务书)可据此开工 |

**门 G0(M0 冻结)**:上表全绿 → 宣布契约冻结,此后 contract 改动走 §9 变更协议。

### P1 引擎四轨(并行,子 agent 或主 agent 分轨)

| 轨 | 内容 | 独立验收 | 依赖 |
| --- | --- | --- | --- |
| A domain | applyOps(JSON Pointer 子集、value 直接值、remove 禁值)、changedPaths、记忆行校验(owner/about 引用、valence/importance 范围)、fork/plan 纯函数 | fixtures+`ops-invalid` 全过;纯函数零 I/O | P0 |
| B store | SQLite schema(lines/revisions/drafts/llm_calls/**memories+FTS5 trigram**/**memory_reflections**)、T1–T4、崩溃恢复、log 分页、按 owner/可见集检索查询 | 临时目录测试:T1–T4、重启、FTS5 命中 | P0.5 接口 |
| C clock | 单调钟采样+倍速积分、**整数分钟提交**、暂停/恢复、到期事件计算、**在场降速/恢复挂钩** | fake timers:24×、暂停、降速、到期顺序 | P0 |
| D llm | OpenAI 兼容 client(候选回退/预算/审计/等待与超时分离)+ **分层记忆组装**(世界全量+近窗+owner 可见集检索+R/I/Rel×C 公式+超预算裁剪次序)+ prompt 模板 | mock fetch:回退/预算/审计/公式确定性(同输入同 prompt) | P0.5 接口 |

### P2 三轨(并行)

| 轨 | 内容 | 独立验收 |
| --- | --- | --- |
| E runtime+http | beat 调度、T1–T4 编排、SSE、重启恢复、错误重试、**chat 事件提交路径**(对话入史+降速窗口到期 beat 的抢占策略在此实现) | mock llm 集成测试:8 个原型观察场景移植 |
| F web/shell | React 壳、API client、多元宇宙总览、线控制、log 分页、**三栏对照视图** | fixtures 驱动组件测试;可与 P1 并行启动(仅依赖 contract fixtures) |
| G renderer | engine/projection(WorldState→SceneDocument 投影,含位置=op 可改)+ web/renderers/3d(从 geometry-lab solid 后端提纯,recipeHash 增量) | golden view 测试:fixtures 世界→稳定截图/统计;增量只重建脏部件 |

**门 G2(集成冒烟)**:E+F+G 联通——mock beat 驱动 3D 画面实时推进、倍速/暂停可见。这是**首个可看竖切**。

### P3 三轨(并行)

| 轨 | 内容 | 备注 |
| --- | --- | --- |
| H live 接线+灵魂 A/B | 真实模型接入、预算全开、云端 CI workflow_dispatch 验证;**灵魂 A/B**(偏见记忆 vs 中性记忆同局面对照) | 需用户授权 GROQ secret 用于 CI |
| I 编辑器+创世 | 草稿/提议/diff/确认分岔 UI、**对话式创世**(产出 WorldState+前史记忆种子)、记忆视图 | 依赖 F |
| J 在场 | 入世对话(chat call kind 全链)、附身切换、**新闻播报追更**(重要度分级)、记忆问询面板 | 依赖 E+H |

**门 G3(可玩)**:真实 LLM 驱动、可 fork、可对话、可追更——用户开始长期把玩,"好不好玩"进入实测。

### P4 收口(并行度低)

单命令打包(engine serve web/dist)、云自托管文档与卷挂载说明、E2E 全量(云端:桌面/手机/2D3D 并排/编辑器/多元宇宙/暂停)、性能测量(revision 大小与频率→是否改增量存储;fork 深链深度→是否物化前缀)。

## 4. 验证与资源规则

- 每轨自带定向测试,合并点跑交集;全量回归只在门与 CI。
- 本机内存规则照 AGENTS.md:并行前 `free -h`+PSI;浏览器/构建类重型操作云端优先,本机兜底条件 MemAvailable≥4G 且 PSI 低;服务实例复用。
- 证据纪律沿用:观察结论进 docs,一次性代码不进 main。

## 5. 变更

计划本身按需修订;轨道间接口变更视同 contract 变更(影响多轨,须同步所有任务书)。
