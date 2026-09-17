#!/bin/bash
# 一次性提交脚本（由 preview_start 唤起；终端标签已满时的 workaround）
cd /home/neo/Projects/Possibility
{
  git config user.name "neo"
  git config user.email "neo@possibility.local"
  git add -A
  git commit -m "产品：世界记得你——留言托付 + 与你有关的动静

- scene 回应新增可选 word 字段（想托付给来访者的事：邀约/提醒/口信，
  同一次 LLM 调用产出，零额外消耗；提示词要求非真心不留）
- persona_messages 表（迁移 0006，本地已应用）：留言按收件人（在场身份）
  存未读，GET /worlds/:id/persona/messages 送达并标记已读，
  同时返回事件流里最近提及你名字的事（留言+动静=进入世界时的
  「自你上次离开后，世界没有忘记你」）
- GET /worlds/:id/persona 增加未读数；「进入世界」按钮未读角标
- 新增 parseSceneOutput 纯函数 + 5 个单测（word 截断/类型校验），
  合计 47/47；两端 tsc 干净
- 实测：告别场景小夜与柊一成各留一句话（灶上留饭/代收安神茶），
  未读=2 → 送达 → 已读清零；提及列表含人物节拍里提到访客的事"
  echo "EXIT=$?"
  git log --oneline -3
  git status --short | head -10
} > /tmp/commit-out.txt 2>&1
sleep 2
