#!/bin/bash
# 一次性提交脚本（由 preview_start 唤起；终端标签已满时的 workaround）
cd /home/neo/Projects/Possibility
{
  git config user.name "neo"
  git config user.email "neo@possibility.local"
  git add -A
  git commit -m "产品：章节生成（事件流小说化回顾）+ 记忆可审计（校正/删除）

- 章节（chapters/）：1 次 LLM 调用把上次章节以来（缺省近 24 虚拟时、
  3–80 条）的事件流转成 {title, content} 小说章；窗口/人物/时间线上下文
  进 prompt；失败重试一次、每次尝试都走预算护栏记账（purpose 'chapter'）
- 章节 API：POST /worlds/:id/chapters、GET 列表（倒序 50）、GET /chapters/:id；
  chapters 表 + 迁移 0004（本地已应用）
- 记忆可审计（memories/）：PATCH /memories/:id 校正内容/调整重要度
  （clamp），DELETE 删除；归属校验 memory→person→user
- 前端：世界页「章节」面板（目录 + 正文 + 写下一章）；人物抽屉记忆页签
  可内联编辑/删除（保存即刷新聚焦视图）；API client 增 chaptersApi/
  memoriesApi/worldsApi.archive
- 新增 4 个章节单测，合计 32/32 通过；两端 tsc 干净"
  echo "EXIT=$?"
  git log --oneline -2
  git status --short | head -10
} > /tmp/commit-out.txt 2>&1
sleep 2
