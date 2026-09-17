#!/bin/bash
# 一次性提交脚本（由 preview_start 唤起；终端标签已满时的 workaround）
cd /home/neo/Projects/Possibility
{
  git config user.name "neo"
  git config user.email "neo@possibility.local"
  git add -A
  git commit -m "升级：护栏闭环 + 时钟单点化 + fork 修复 + Director 层 + 世界归档

- 统一 LLM 闸门（engine/guard.ts）：chat/fork 预览/fork 推演/蒸馏/骨架全部
  记账 + 查顶；llm_call_log 加 user_id、world_id 可空（迁移 0003），
  预世界调用记用户桶（PREWORLD_DAILY_CAP，缺省 40）
- capped 世界换天自动恢复；resume 不再清零当日用量（曾可无限刷日限额）
- streamChat 120s 超时；流中途失败也产出 done（llmCalls/error），记账无旁路
- 时钟单点化：自主体时钟以 timeline.simNow 为锚，chat/catchup 的 simTime
  钳制在窗口内；simNow 仅 simulate 写回且不许拨回；catchup 按虚拟时间计间隔
- person 级 fork 显式写祖先链（修复分叉零记忆）+ 活跃时间线上限校验
- Director 层 v1（engine/director.ts，纯函数零 LLM）：注入扇入每事件每拍
  最多 2 人 + 同优先级人物轮转公平
- 世界级 archive 冻结可读 + 前端状态标签/归档按钮
- 新增 vitest：28 个单测覆盖预算状态机/时钟钳制/导演层/祖先链
- 文档：docs/upgrade-brief.md 执行记录 + 部署注意事项（远端须应用迁移 0003）"
  echo "EXIT=$?"
  git log --oneline -2
  git status --short | head -10
} > /tmp/commit-out.txt 2>&1
sleep 2
