#!/bin/bash
# 一次性提交脚本（由 preview_start 唤起；终端标签已满时的 workaround）
cd /home/neo/Projects/Possibility
{
  git config user.name "neo"
  git config user.email "neo@possibility.local"
  git add -A
  git commit -m "产品：你在世界里（到场交谈）+ LLM 导演仲裁 + 闲置自动归档

- 你在世界里（persona/ + scene/）：用户在世界中登记在场身份
  （isUser 人物，每人每世界一个），以该身份到场说话——同地点清醒且
  空闲的人物依次回应（1 人 1 次 LLM 调用，purpose 'scene'，走预算护栏）；
  对话写入事件流与记忆流（他们会记住这次相遇），章节回顾会把它织进小说。
  引擎不替用户身份行动（tick 全链路跳过 isUser）
- LLM 导演层 v2（engine/director-llm.ts）：注入事件反应者多于扇入上限时，
  问一次导演'谁最有戏'（每拍至多 1 次调用、计预算与日限额、失败回退 v1
  机械排序）；DIRECTOR_LLM=0 可关
- 闲置自动归档（AI Town archive 思路）：worlds.last_userActivityAt 记录
  聊天/注入/章节/创建/恢复等交互，tick 每拍扫描，超过 IDLE_ARCHIVE_DAYS
  （缺省 7）无交互的 running 世界自动 archived（pauseReason='idle'），
  resume 解冻；存量世界列值为 null 不归档
- 人物列表排除 isUser；迁移 0005（本地已应用）
- 新增 10 个单测，合计 42/42；两端 tsc 干净
- 实测：登记'阿透'→ 小夜当场回应并写入关系记忆；注入事件引擎照常反应"
  echo "EXIT=$?"
  git log --oneline -2
  git status --short | head -10
} > /tmp/commit-out.txt 2>&1
sleep 2
