#!/usr/bin/env bash
# 实体规模阶梯测量（一次性核实脚本，非产品代码）。
# 顺序执行（同时只跑一个服务端），每个配置跑 RUN_SEC 秒，采样 RSS，抽取 BENCH 日志。
#
# 前置：先跑 runtime/bootstrap.sh 物化运行时。
# 用法：
#   bench/run.sh                    # 默认三档
#   bench/run.sh 1000 idle          # 只跑一档（位置参数按「实体数 模式」成对给）
#   RUN_SEC=40 bench/run.sh         # 改单档时长
#
# 产物写到 bench/run/（不入库）；committed 的原始证据是 bench/luanti-entity-scale-2026-10-27.txt。

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
EXP="$(dirname "$ROOT")"
RT="${LUANTI_RT:-$EXP/.runtime}"
BIN="$RT/root/usr/libexec/luanti/luantiserver"
LIB="$RT/root/usr/lib/x86_64-linux-gnu"
LUA_HOME="$RT/home"
OUT="$ROOT/run"
RUN_SEC="${RUN_SEC:-26}"

if [[ ! -x "$BIN" ]]; then
  echo "run.sh: 找不到引擎 $BIN —— 先跑 runtime/bootstrap.sh" >&2
  exit 2
fi
if pgrep -f 'luantiserver' >/dev/null 2>&1; then
  echo "run.sh: 已有 luantiserver 在跑；本脚本要求顺序执行，先停掉它" >&2
  exit 2
fi

mkdir -p "$OUT"
RESULTS="$OUT/results.txt"
: > "$RESULTS"

run_one() {
  local count="$1" mode="$2"
  local tag="${mode}_${count}"
  local wdir="$OUT/world/$tag"
  local conf="$OUT/conf_$tag.conf"
  local log="$OUT/$tag.log"

  rm -rf "$wdir"
  mkdir -p "$wdir/worldmods/societybench"
  cp "$ROOT/init.lua" "$wdir/worldmods/societybench/init.lua"

  cat > "$conf" <<EOF
bind_address = 127.0.0.1
port = 30099
mg_name = singlenode
max_users = 64
creative_mode = true
enable_damage = false
dedicated_server_step = 0.09
max_forceloaded_blocks = -1
societybench_count = $count
societybench_mode = $mode
EOF

  echo "=== $tag 开始 $(date +%H:%M:%S) ===" | tee -a "$RESULTS"
  HOME="$LUA_HOME" LD_LIBRARY_PATH="$LIB" "$BIN" \
    --config "$conf" --world "$wdir" --gameid minetest_game \
    --logfile "$log" > /dev/null 2>&1 &
  local pid=$!

  local peak_kb=0 t=0
  while kill -0 "$pid" 2>/dev/null && [ "$t" -lt "$RUN_SEC" ]; do
    sleep 1
    t=$((t + 1))
    if [ -r "/proc/$pid/status" ]; then
      local rss
      rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
      [ -n "${rss:-}" ] && [ "$rss" -gt "$peak_kb" ] && peak_kb="$rss"
    fi
  done
  kill -TERM "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null

  echo "峰值 RSS: $((peak_kb / 1024)) MiB（运行 ${t}s）" | tee -a "$RESULTS"
  command grep -h 'BENCH' "$log" 2>/dev/null | tail -4 | tee -a "$RESULTS"
  echo | tee -a "$RESULTS"
}

if [ "$#" -gt 0 ]; then
  while [ "$#" -ge 2 ]; do
    run_one "$1" "$2"
    shift 2
  done
else
  for cfg in "10000 idle" "10000 move" "20000 move"; do
    run_one $cfg
  done
fi

echo "=== 全部完成 $(date +%H:%M:%S) ===" | tee -a "$RESULTS"
echo "结果: $RESULTS"
