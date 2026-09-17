#!/bin/bash
# 本地启动引导：数据库迁移 -> 后台启动 web+api+engine -> 等待 api 就绪 -> 种子账号与演示世界
set -u
cd /home/neo/Projects/Possibility
export PATH="/home/neo/.local/bin:/home/neo/.local/share/mise/shims:$PATH"

npm run db:migrate || { echo "BOOT_FAIL: db:migrate"; exit 1; }

npm run dev > /tmp/possibility-dev.log 2>&1 &
DEV_PID=$!

for i in $(seq 1 90); do
  curl -s -o /dev/null --max-time 2 localhost:8787 && break
  sleep 1
done

npm run seed && npm run seed:demo
echo "BOOT_OK（dev 进程仍在后台运行，日志：/tmp/possibility-dev.log）"
wait $DEV_PID
