# Possibility 阶段三交付 Checklist

日期：2026-10-08。本表同步当前云端证据；早期独立模块调度与 G0 记录保留于 task、plan 和 baseline。用户明确要求需要真实账号、公开真实评估的项按通过处理，见 [用户验收决定](evidence/user-acceptance-2026-10-07.md)。隔离工程测试以实际结果为准。

## 执行状态汇总

| 任务 | 结果 | 证据 |
|---|---|---|
| G0 | 通过 | 历史真实生成/保存已有成功记录；阶段二 37640643443 通过；阶段一 guest/API/浏览器最终复验 37649736957 success，桌面 20/20。 |
| T17–T21 | 自动化通过 | [37639886928](https://github.com/kikoiio/Possibility/actions/runs/37639886928)：桌面 20/20、Pixel 7 仿真 1/1；表现/相机/存储恢复、同/跨世界、左右失败、adapter 重试、取消、宽窄屏和触控。 |
| T22 | 完整技术回归通过 | [37649736855](https://github.com/kikoiio/Possibility/actions/runs/37649736855)：API types、Web production build/types、完整 API（135 files/931 passed/1 skipped）、完整 Web（69 files）、voxel contract（17 files）均通过。 |
| T23 | 自动化工程覆盖通过 | 同 37639886928；实体硬件、真实网络、完整 pairwise 为覆盖限制，详见 qa-matrix。 |
| T24 | 实测完成，保留测量限制 | CDP JSHeapUsedSize readiness 快照、单/双/混合表现冷启动、热切换、关闭及离场 renderer 2→1→0；物理/GPU 峰值未测。 |
| T25 | 通过（用户确认） | 内部 QA 与真实账号/公开评估范围按用户验收决定通过，不宣称实际采集相关数据。 |
| T26 | 完成 | [证据索引](evidence/README.md) 记录 AC1–AC8 最终结果及限制。 |
| T27 | 清理及保留决定已记录 | 当前 run_b62869e0d391 的 14 Task completed；14 retained terminal user-owned/external 且 nextAction none。旧 run_a0e6 的 8 retained、1 released 保持原状态；用户 baseline 改动保留。 |

## 阶段门槛与工作区

- [x] 阶段一真实生成及保存已有可复查成功记录，旧失败不替代最新分批结果（baseline）。
- [x] 阶段二生产构建、环境共同投影、离页推进/暂停/恢复、触控有实际结果（37640643443）。
- [x] 阶段一 guest/几何完整旅程复验通过，G0 闭合（37649736957）。
- [x] 实现已集成到 main，干净子 worktree/分支已清理，用户修改的根 worktree 保留。

## 实现行为（37639886928；隔离 fixtures）

- [x] 单世界 2D/3D 往返保留 world/timeline、query、identity 和 simNow；完整上游旅程另见 G0。
- [x] 左右独立显示目标世界/时间线/表现及实际加载的时间、能力；四种同世界及跨世界表现组合通过。
- [x] 左右 503、403、超时、固定慢响应及断网恢复隔离；只重试失败侧，另一側保持可用。
- [x] 同世界同表现允许相机联动；跨世界/混合表现禁止联动；联动协调规则另有完整单测。
- [x] 2D/3D 相机刷新恢复，2D 相机按 timeline/表现隔离，浏览器偏好恢复且显式 URL 优先。
- [x] 存储损坏或不可用时保留世界上下文并降级到可用视口。
- [x] adapter 加载失败保留 pane world/timeline 上下文，展示原因并允许重试。
- [x] 快速替换目标取消迟到侧请求；关闭该侧保持兄弟 pane mounted。

## 集成与交付矩阵

- [x] guest 认领→所有者管理→编辑→比较→刷新最终旅程及 archive 几何回归通过（37649736957）。
- [x] 表现工作区读、取消、重试和 renderer 销毁隔离已有真实浏览器执行结果与单测。
- [x] 自动化矩阵及其覆盖限制已记录，不把实体硬件/真实网络/完整 pairwise 宣称为已执行。
- [x] 单/双 2D、单/双 3D、两个混合方向的冷启动、单 pane 热切换、关闭和离场有观测记录。
- [x] 权限来自实际会话契约；生产真实账号验证按用户决定通过，隔离授权测试保留实际断言。

## 内部 QA 与预算

- [x] T25 内部配对 QA 按用户验收确认通过，仓库未附参与者/成绩/回访明细。
- [x] 公开真实评估/投票按用户决定通过，不宣称开展过公开投票。
- [x] 真实 provider 调用预算和费用边界保留：追加 100 次已对账 75 次/$0.863707，余 25 次；本轮新增 0 次。

## 编译、测试与资源

- [x] API 类型、Web production build/types、完整 API、完整 Web 与 voxel contract 测试通过（37649736855）；实时 provider harness 排除。
- [x] 阶段三实际浏览器桌面 20/20、mobile 1/1（37639886928），证据为运行日志；该 run 未上传 trace artifact。
- [x] 重型验证在已授权 Actions 顺序分批执行、workers=1，保留 runner 内存/换页/PSI 快照；本轮未启动本机重型服务。
- [x] 临时云端 Worker/D1/preview 由 workflow 清理；用户与 external 终端按所有权保留。

## 最终报告

- [x] AC1–AC8 的最终结果、用户验收决定与测量边界同步记录。
- [x] 当前 Orca Task settled，终端释放/保留决定和用户 worktree 保留原因已记录；旧 provider session 未修改。
- [x] 最终 guest/G0 复验结果和交付结论已补（37649736957；真实账号、公开评估按用户验收决定通过）。
