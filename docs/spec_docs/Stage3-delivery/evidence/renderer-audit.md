# Renderer 相机与生命周期审计（T03）

**基线：** `ab0911f`（`docs: approve phase three delivery plan`），分支 `p3-t03-renderer`；本次审计前工作区干净。本文仅盘点源码和现有测试入口，不代表测试结果。本次没有运行测试、浏览器、renderer、构建或运行时测量。

## 2D pan/zoom 与 viewport 生命周期

### 代码证据

- 相机状态为 `{ pan: {x, y}, zoom }`；屏幕坐标由投影坐标乘 `zoom` 再加像素 `pan`。模型和变换定义在 `web/src/native2d/projection.ts`。
- `web/src/native2d/input.ts` 将指针拖动转换为 pan 增量，将双指捏合转换为中心平移和 zoom 比例。`web/src/native2d/viewport.ts` 把增量应用到私有相机状态，按场景/viewport 边界限幅，更新 Pixi world 容器，并通过 `requestAnimationFrame` 排队绘制。
- 每次调用 `createNative2dViewport(host, scene, options)` 都创建并初始化自己的 Pixi `Application`、canvas、指针输入和 `ResizeObserver`，并拥有独立相机、绘制队列和场景状态。resize 时会重新计算全景构图。其 `dispose()` 会解绑输入、断开 observer、取消待执行帧、销毁场景子项及 Application/canvas。Pixi 初始化后发现 signal 已 abort 时也会销毁 Application 再抛错。
- `web/src/native2d/Native2dViewport.tsx` 管理异步初始化：effect cleanup 会标记失活、abort 初始化、销毁已安装的 viewport、清除 diagnostics 并通知 `onReady(null)`；若初始化在 cleanup 后才完成，也会立即销毁该 viewport。当前 viewport API 提供 `setPresentation`、选择/跟随/预览更新、`showOverview` 和 `dispose`，没有公开相机 get/set API。
- `web/src/native2d/controller.ts` 明确说明 controller 不拥有 viewport 生命周期；`controller.dispose()` 不会销毁 viewport。renderer teardown 由 React viewport wrapper/factory 持有。在 `web/src` 中，`Native2dViewport` 当前只由独立的 native2d sample page 使用；现有生产分屏仍走 3D 路径。

### 可复用测试入口（本次未运行）

- `web/src/native2d/__tests__/projection.test.ts`：pan/zoom 变换逆运算、格点往返、输入坐标投影。
- `web/src/native2d/__tests__/input.test.ts`：指针拖动 pan、双指捏合平移/缩放回调。
- `web/native2d-e2e/sample.spec.ts` 与 `sample.mobile.spec.ts`：浏览器 pan、pinch、resize 和触屏交互路径。
- `web/native2d-e2e/lifecycle.spec.ts`：Pixi 初始化延迟期间卸载、重复挂载/卸载、canvas/listener/observer 计数、销毁后停止重绘。该文件是浏览器测试，本次未运行。

## 3D OrbitPose 与 engine/renderer 生命周期

### 代码证据

- `web/src/voxel/engine/camera.ts` 将 `OrbitPose` 定义为 `theta`、`phi`、`distance` 和三维 `target`。`CameraRig.getOrbitPose()` 在 orbit 模式返回副本，在 walk 模式返回 `null`；`setOrbitPose()` 在非 orbit 模式忽略写入。
- 每个 `VoxelEngine` 实例各自拥有 `TextureAtlas`、`VoxelRenderer`、`CameraRig`、assets 管理器和帧/更新状态。`mount()` 挂接 renderer 及相机/缩放输入、创建 `ResizeObserver` 并同步尺寸和相机 aspect。`dispose()` 停止并取消动画帧、断开 observer、解绑缩放和相机输入，销毁 weather/animation/resident/feedback/motion/assets，并调用 `renderer.dispose()`。
- `VoxelRenderer.dispose()` 移除 section meshes 并销毁 sky、shadow map、post pipeline、materials 和 Three.js renderer。检查到的路径没有显式调用 `forceContextLoss()`；仅凭源码不能确认浏览器/GPU 在 `three.dispose()` 后何时回收上下文资源。
- `web/src/voxel/VoxelViewport.tsx` 每个 effect 实例创建一个 `VoxelEngine`，并以 `instanceId` 注册探针。cleanup 会标记异步 setup 取消、清理回调/ref、调用 `engine.dispose()` 并注销探针。相机通过可选 `cameraPose` / `onCameraChange` props 同步：仅当当前姿态不近似相等时写入；每帧 updatable 在 orbit 姿态变化时报告。

### 可复用测试入口（本次未运行）

- `web/src/voxel/__tests__/orbit-pose.test.ts`：OrbitPose 往返、边界、相机坐标映射和 walk 模式行为。
- `web/e2e/split-view.spec.ts`：`dispose:关闭分屏后引擎注册表回落,重新进入不泄漏` 检查关闭/重进前后的探针注册表；相机联动用例检查姿态传播和取消联动后的独立性。文件明确为双 SwiftShader WebGL context 配置串行执行；这些断言不测 GPU 内存或 context 实际回收。本次未运行该 e2e。

## 现有 split 挂载与清理路径

- `WorldCanvasPage.tsx` 在 `mode === 'possibility'` 时渲染 `SplitViewStage`。`closeSplit()` 删除 URL 中 `mode` 与 `right` 参数并将 mode 切回 `life`，替换分屏子树；React effect cleanup 随后进入各 `VoxelViewport` 的 `engine.dispose()` 路径。
- 宽屏下 `SplitViewStage.tsx` 分别挂载 `instanceId` 为 `left` 和 `right` 的 `VoxelViewport`，各自接收对应时间线的 overlay/events，engine 实例彼此独立。当前 split 是 3D/3D；联动时可向两侧传同一个共享 `OrbitPose`，任一侧处于 walk 模式时会关闭联动。
- 窄屏下仅挂载当前选中侧的一个 `VoxelViewport`；切换当前侧会换掉挂载的实例。现有 split e2e 也覆盖右侧快照仍在加载时关闭 split，但断言停留在组件/画面层面。

## 双实例与混合实例风险

| 项目 | 代码支持的观察 | 待验证的风险/假设 |
|---|---|---|
| 双 3D pane | split 挂载两个独立 `VoxelEngine` / `VoxelRenderer`，各自有 Three renderer、相机、assets 和帧循环。 | 两个 WebGL context 和重复场景/GPU 资源可能触及设备 context、显存、内存或帧预算。现有测试注释表明双 context 的软件渲染负载较重，需串行执行；真实设备余量和 dispose 后资源回收尚未测量。 |
| 双 2D pane | 每次 native 2D viewport factory 调用都会创建独立 Pixi `Application`、canvas、相机闭包、observer 和绘制队列。 | 并行 Pixi 后端/context 数、纹理重复、内存开销、反复同时挂载两个 pane 后的释放情况均未测量。 |
| 2D + 3D | 2D viewport 公共 API 没有相机读写契约；3D 暴露的是坐标语义与控制方式不同的 `OrbitPose`。现有 split adapter 没有混合挂载。 | 现有 API 无法支撑或证明共用相机联动/恢复行为。混合挂载、resize、关闭与重挂载的所有权需另行定义和测量；不能把 2D pan/zoom 直接当成 3D OrbitPose。 |
| 状态持久化 | 2D 相机封装在 viewport 内，presentation 更新和 resize 会重新套用全景构图；3D split 可在页面级共享 OrbitPose。 | 当前 split 行为没有证明 pane 替换、renderer 切换、timeline 变化或刷新时是否保留相机状态。 |
| teardown 边缘情况 | 源码显式清理 listener、observer、动画帧及 renderer 资源；现有 2D 生命周期 e2e 观测若干 2D 资源，split e2e 检查 3D 探针注册表。 | 浏览器/WebGL context 数、GPU 分配、部分初始化失败、快速关闭/重开、并发异步初始化及混合 renderer 清理均未在本审计中观察。源码清理路径本身不能证明这些运行时结果。 |

## T03 未实测项

本次没有运行测试、浏览器会话、构建、WebGL/Pixi 初始化、性能采样或资源计数。特别是双 Pixi 与 Pixi/Three 混合挂载、同时 context 限制、实际 GPU/CPU 内存和帧耗时、dispose 后浏览器资源回收、快速关闭重开及异步失败竞态，仍未验证。上面列出的单测和 e2e 文件是候选复用入口，不是本任务的通过结果。
