#!/bin/bash
# 一次性提交脚本（由 preview_start 唤起；终端标签已满时的 workaround）
cd /home/neo/Projects/Possibility
{
  git config user.name "neo"
  git config user.email "neo@possibility.local"
  git add -A
  git commit -m "产品：在场交谈并入对话模型——事件流可展开、章节可得对话全文"
  echo "EXIT=$?"
  git log --oneline -3
  git status --short | head -10
} > /tmp/commit-out.txt 2>&1
sleep 2
