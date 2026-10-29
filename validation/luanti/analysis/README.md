# 结果汇总

`summarize.py` 用标准库解析 SOCIETY 原始日志，保留每次运行的来源与行号，输出描述性 JSON。支持 `.log`、`.log.gz`、`.events`、`.events.gz`，相同运行优先完整日志，避免重复统计。重试 token 与延迟按 attempt 计数，不再重复加上最终 action；缺失测量保留 null。

```sh
python3 -B validation/luanti/analysis/summarize.py --compact --input <证据目录> --output <结果.json>
python3 -B -m unittest discover -s validation/luanti/analysis -v
```

模型动作与世界动作成功分开统计，`meet` 与消息投递分开统计，来源为 fixture 的动作不解释为真实模型。RSS 来自运行器逐秒采样，仅包含引擎；日志跨度吞吐包含启动及关闭时间，不是 provider 服务能力。配对实验要按运行和条件比较，不能用所有文件的总计推断记忆效果或统计显著性。

`--compact` 以 multiplicity 压缩不参与指标计算的重复事件，保持计数且不在内存与 JSON 中复制全部大日志。较大容量日志使用压缩原件保存，并在云端汇总。永久证据与 Actions 运行号、源提交相互对应，见 [执行计划](../PLAN.md)。
