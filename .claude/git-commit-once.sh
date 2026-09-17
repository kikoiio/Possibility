#!/bin/bash
# 一次性提交脚本（由 preview_start 唤起；终端标签已满时的 workaround）
cd /home/neo/Projects/Possibility
{
  git config user.name "neo"
  git config user.email "neo@possibility.local"
  git add -A
  git commit -m "文档：简报补充打磨轮执行记录（scene 对话化 + 人物色修复）"
  echo "EXIT=$?"
  git log --oneline -3
  git status --short | head -10
} > /tmp/commit-out.txt 2>&1
sleep 2
