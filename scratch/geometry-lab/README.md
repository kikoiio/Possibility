# Geometry Lab

一次性、可删除的 3D 构造对照实验，不是正式 Wispiva 架构。两条确定性后端共享 `SceneDocument`；保留可选的本地模型接口，本轮未配置或调用模型。

## 运行与验证

先检查 5173 / 5174，已有服务则直接复用，不重复启动。依赖已安装时无需再次安装。

```sh
npm run lab                 # 在本目录运行；同时提供 Vite 与本机模型接口
node observe.mjs            # 单个无头 Chrome，禁用 GPU，截图与结果写入 ../../.tmp/geometry-lab
node --test --test-concurrency=1 scene.test.mjs
node generate-experiment.mjs --mock               # 生成对照实验；--max-calls=12 走真实模型
node generate-experiment.mjs --generated=generated/glm-session              # 会话模型离线输出（藏书屋组）
node generate-experiment.mjs --generated=generated/glm-session --set=village # 村庄组（模糊 prompt）
node village-shot.mjs                                   # 生成村庄双后端并排截图（需 npm run dev 在 5173）
```

`generate-experiment.mjs` 是"模型生成成功率"对照实验：6 个陌生场景意图（`experiment-intents.mjs`，每个附手工参考解证明在子集内可行），同一模型逐个生成语义 SceneDocument → 结构 + 空间校验 → **失败时带诊断返修一次** → solid/voxel 双后端编译与探针 → 每意图一次"把门廊加宽"局部修订，检查增量重建是否恰好落在语义变化的部件上。另有 `--set=village` 村庄组（4 个模糊 prompt,含 house/path）。mock 模式用参考解验证管道，不调用模型；真实模式需要 `.data/geometry-lab/settings.json`（`{baseUrl, model, apiKey}`）或 `GROQ_API_KEY` + `--model=`。报告与完整文档写入 `../../.tmp/geometry-lab/generate-experiment/`（每次运行覆盖），调用审计在 `.data/geometry-lab/experiment-audit.jsonl`。

纯展示也可用 `npm run dev`，但模型设置接口需要 `npm run lab`。`observe.mjs` 不提交模型表单、不修改模型配置、不发送模型请求；需要本机 `/usr/bin/google-chrome`。

## 已实现

- 通用几何：参数化部件、曲面、斜面、圆柱与静态材质合批。
- 体素：可配置单位（0.2–1 米），隐藏面剔除，按材质生成表面网格；屋顶用斜面单元（ramp cell）生成连续坡面,消除阶梯轮廓。
- 村庄语义子集：除 library/porch/bridge/tree 外支持多栋 `house` 与 `path` 石板路；每栋房、每条路是独立 part，可单独增量重建与移除；校验含建筑 SAT 间距、路径同岛/不穿建筑、桥走廊与树冠避让。`villageScene` 为完整示例。
- 两后端读取建筑 XYZ / yaw、宽深墙高、入口、屋顶、门廊、桥端点 / 宽度 / 拱高、树 XYZ / 整体缩放，以及各岛屿与水域参数；按 kind 查找，不依赖示例节点名称。
- `compileSceneParts(document, backend, { materials, world, ...options })` 根据规范化 recipe 内容判断脏部件，只构造脏部件。`world.userData.rebuiltParts` 记录实际重建的 part IDs；每个 part 保留 `recipeHash`（规范化配方内容键，不是密码学摘要）。
- 修改门廊尺寸只重建 `porch`；演示“换成观景台”同时修改桥面材质，所以重建 `porch` / `bridge`。稳定部件的对象、geometry、material 与 recipe 引用/内容保持不变。替换部件释放 geometry、实例资源和部件私有体素材质，不释放共享材质。
- 文档提案通过相同增量路径应用；先准备两个后端，再提交。失败保留当前文档与画面。
- 结构与轻量空间验收：类型和尺寸、入口净空、室内活动空间预算、入口与门廊接合、岛屿边界、桥端点落区 / 高差 / 路径坡度、树冠与建筑/桥净空。入口与桥中心路径额外用实际编译网格射线采样验收。
- 错误有 `nodeId` / `operationId` / `requirementId` / `message`；`SceneCompileError.diagnostics` 保留结构化诊断。
- `scene-fixtures.js` 提供改 ID、平移、旋转并改变尺寸的陌生场景；`scene.test.mjs` 验证两后端、真实资源保留、旧几何释放、非法提案拒绝与编译表面检查。

## 边界

当前语义子集要求一个水域、一个 library / porch / bridge，支持多个岛与树；建筑只支持正面入口与 gable 屋顶。没有通用建模 DSL，也没有证明文本生成成功率。室内采用确定性家具布局，活动空间检查是保守预算，不是完整碰撞/角色导航；桥面检查是有限采样，不是拓扑证明。体素高程与外轮廓有栅格误差。软件 WebGL 的截图帧时间不是目标 GPU 性能基准。
