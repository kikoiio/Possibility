# 产品状态与模型输入纵向验证（2026-10-29）

对应提交：`cc403789605c060606511b6e5c3a3d0520d963dc`。

GitHub Actions：[40938747760](https://github.com/kikoiio/Wispiva/actions/runs/40938747760)，结果为 `success`。
运行在 Ubuntu 26.04 容器中，安装 Luanti 5.10.0、Lua 5.1，并执行了本分支的
Python、Lua、Luanti 产品世界回归。

本次验证覆盖：

1. `cognition/product_state.lua` 的 `READY`／`PREPARING`／`FROZEN` 状态、提交版本和中断恢复测试；
2. `cognition/model_envelope.lua` 的 `wispiva.model-input` v1 四类知识（事实、经历、传闻、未知）、来源和 audience 隔离测试；
3. `model/bridge.py` 在 provider 调用前拒绝越权或无 audience 的产品输入；
4. disposable Luanti preview 复制新增模型输入模块并成功运行；
5. 确认 Draft 到持久 Luanti 世界的投影、环境资源事件、fixture 模型 gather/build、正常停服 checkpoint 和 `--resume` 恢复；
6. 消息 inbox、上次动作反馈、库存、长期记忆和产品提交版本进入持久恢复路径。

关键运行证据包括 `origin projection verified`、`ev=model-request`、`ev=environment`、
`ev=resource ... ok=true`、`product-checkpoint commit`、`ev=restore ... reset=false`
和两次 `done result=ok`。Actions artifact 仍保存在 GitHub 运行记录中；本地下载在本次归档时因远端 blob 返回 EOF 未完成。

范围限制：模型使用 Actions fixture worker，不是供应商真实模型调用；没有真人 Luanti 客户端画面验收；容量阶梯和真实模型任务在产品分支运行中按 workflow 条件跳过；地图、事件、库存、环境和角色 checkpoint 仍不是断电级跨存储原子事务；产品角色仍使用受控空间投影和无碰撞 `set_pos` 移动。

前一提交 `247bef52a86a39b0105242f993c24c95fcaf7d53` 的 Actions 运行
[40938177065](https://github.com/kikoiio/Wispiva/actions/runs/40938177065) 曾因 disposable preview 未复制 `model_envelope.lua` 失败；该问题已在本次提交中修复并由本运行复验通过。
