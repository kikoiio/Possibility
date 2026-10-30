#!/usr/bin/env bash
# M0 启停夹具：可重复地起停一个装载 society mod 的 Luanti 世界，采集日志与内存，
# 并对「agent 是否真的被每步推进」「是否全部存活」做硬校验。
#
# 判定是硬失败，不是打印一行看看：
#   - 进程必须真的退出（SIGTERM/SIGKILL 之后用 kill -0 复核）
#   - 必须出现 SOCIETY done，且不得出现任何 SOCIETY fail=
#   - 每个 agent 的步数在每个统计区间都必须增长（stepped_delta == agents）
#   - steps_per_sec 不得跌破实时基准 11.1 太多
# 任一不满足即以非零退出，并在报告里写明是哪一条不满足。
#
# 用法：
#   engine/luanti/run.sh --label m0-run              # 默认 5 agent，每个 8 次决策后自行关服
#   engine/luanti/run.sh --label m0-n12 --agents 12 --decisions 6
#   engine/luanti/run.sh --label m0-stop --decisions 0 --seconds 20   # 不自动关服，测 SIGTERM 停止路径
#   engine/luanti/run.sh --label m0-run --repeat 2   # 跑两次并比对事件序列
#   engine/luanti/run.sh --label saved --resume-preserve # 从已有世界恢复角色记忆
#   engine/luanti/run.sh --label saved --long-term-memory # 启用长期记忆及正常停服快照
#   engine/luanti/run.sh --label m0-negative --set society_spacing=64 \
#     --expect-fail agents-lost-after-spawn          # 反向用例：失败必须被自己发现
#   agent/run.sh --set society_step=4                # 追加任意 Luanti setting
#
# 一次只跑一个服务端：本机内存预算与「顺序执行」的测量口径都要求这样。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXP="$(cd "$HERE/../.." && pwd)"
RT="${LUANTI_RT:-$HERE/.runtime}"
ENGINE="$RT/root/usr/libexec/luanti/luantiserver"
LIBDIR="$RT/root/usr/lib/x86_64-linux-gnu"
LUA_HOME="$RT/home"
MOD_SRC="$HERE/mod/society"
EVIDENCE="$EXP/evidence/luanti/agent"
WORLDS="$HERE/worlds"

LABEL="m0-run"
AGENTS=5
DECISIONS=10
INTERVAL=2.0
SECONDS_MAX=180
REPEAT=1
PORT=30077
EXPECT_FAIL=""
MODEL=0
FIXTURE=0
RESUME=0
RESET_MINDS=1
OVERWRITE=0
LONG_TERM_MEMORY=0
EXTRA_SETTINGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --agents) AGENTS="$2"; shift 2 ;;
    --decisions) DECISIONS="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --seconds) SECONDS_MAX="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --expect-fail) EXPECT_FAIL="$2"; shift 2 ;;
    --model) MODEL=1; shift ;;
    --fake-model) MODEL=1; FIXTURE=1; shift ;;
    --resume) RESUME=1; shift ;;
    --resume-preserve) RESUME=1; RESET_MINDS=0; shift ;;
    --long-term-memory) LONG_TERM_MEMORY=1; shift ;;
    --overwrite) OVERWRITE=1; shift ;;
    --set) EXTRA_SETTINGS+=("$2"); shift 2 ;;
    -h|--help) command sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "run.sh: 未知参数 $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$LABEL" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "run.sh: label 只能包含字母、数字、下划线和连字符" >&2
  exit 2
fi

if [[ ! -x "$ENGINE" ]]; then
  echo "run.sh: 找不到引擎 $ENGINE —— 先跑 runtime/bootstrap.sh" >&2
  exit 2
fi

if pgrep -f 'luantiserver' >/dev/null 2>&1; then
  echo "run.sh: 已有 luantiserver 在跑，本夹具要求一次只跑一个，先停掉它" >&2
  exit 2
fi

mkdir -p "$EVIDENCE" "$WORLDS"

# 抽出可比较的事件行：去掉日志前缀与时间，只留 mod 自己写的内容。
normalize() {
  command grep -h 'SOCIETY' "$1" | command sed 's/^.*SOCIETY /SOCIETY /'
}

# 只保留不依赖墙钟的行做重复性比对：统计行里的 step/s 与 t 本来就不可复现。
normalize_deterministic() {
  normalize "$1" | command grep -E 'SOCIETY (banner|artifact|forceload|spawn|check|ev=|verify|summary|done|fail=)'
}

run_once() {
  local tag="$1"
  local world="$WORLDS/$LABEL.$tag"
  local conf="$world/server.conf"
  local log="$EVIDENCE/$LABEL.$tag.log"
  local rssfile="$EVIDENCE/$LABEL.$tag.rss"
  local report="$EVIDENCE/$LABEL.$tag.report.txt"
  local failed=()

  if [[ "$RESUME" -eq 1 ]]; then
    [[ -d "$world" ]] || { echo "找不到要恢复的世界: $world" >&2; return 1; }
  else
    if [[ -e "$world" ]]; then
      if [[ "$OVERWRITE" -ne 1 ]]; then
        echo "世界已存在: $world；使用 --resume-preserve 恢复，或显式使用 --overwrite 替换" >&2
        return 1
      fi
      rm -rf "$world"
    fi
  fi
  # Establish the identity before adding Luanti files. Existing worlds must
  # already carry an identity; automatic replacement of a legacy/non-empty
  # world is deliberately rejected by WorldSession.
  mkdir -p "$world"
  python3 -B - "$world" <<'PY'
import sys
from engine.luanti.world_session import WorldSession
with WorldSession(sys.argv[1], create=True):
    pass
PY
  if [[ "$?" -ne 0 ]]; then
    echo "[$LABEL.$tag] FAIL: 无法取得 Wispiva 世界会话" >&2
    return 1
  fi
  mkdir -p "$world/worldmods/society"
  local spool=""
  if [[ "$MODEL" -eq 1 ]]; then
    spool=$(mktemp -d "$world/model-spool.XXXXXXXX") || return 1
  fi
  cp "$MOD_SRC"/*.lua "$world/worldmods/society/"
  cp "$EXP/cognition"/*.lua "$world/worldmods/society/"

  {
    echo "bind_address = 127.0.0.1"
    echo "port = $PORT"
    echo "mg_name = singlenode"
    echo "max_users = 8"
    echo "creative_mode = true"
    echo "enable_damage = false"
    echo "server_announce = false"
    echo "dedicated_server_step = 0.09"
    echo "max_forceloaded_blocks = -1"
    echo "society_count = $AGENTS"
    echo "society_decide_interval = $INTERVAL"
    echo "society_max_decisions = $DECISIONS"
    echo "society_event_namespace = $LABEL.$tag"
    echo "society_persist = true"
    if [[ "$LONG_TERM_MEMORY" -eq 1 ]]; then
      echo "society_long_term_memory = true"
    fi
    if [[ "$RESUME" -eq 1 ]]; then
      echo "society_restore = true"
      echo "society_reset_minds = $([[ "$RESET_MINDS" -eq 1 ]] && echo true || echo false)"
    fi
    if [[ "$MODEL" -eq 1 ]]; then
      echo "society_model = true"
      echo "society_cognition = true"
      echo "society_spool = $spool"
    fi
    if [[ ${#EXTRA_SETTINGS[@]} -gt 0 ]]; then
      for kv in "${EXTRA_SETTINGS[@]}"; do echo "$kv"; done
    fi
  } > "$conf"

  : > "$log"
  : > "$rssfile"

  local worker_pid=""
  if [[ "$MODEL" -eq 1 ]]; then
    local worker_flags=()
    if [[ "$FIXTURE" -eq 1 ]]; then worker_flags+=(--fixture); fi
    python3 -B "$EXP/model/spool_worker.py" "$spool" --timeout 45 "${worker_flags[@]}" > "$world/worker.log" 2>&1 &
    worker_pid=$!
  fi
  # Keep the Wispiva world identity and cooperative lock for the full engine
  # lifetime.  The launcher forwards stop signals and releases the lock only
  # after Luanti has exited.
  HOME="$LUA_HOME" LD_LIBRARY_PATH="$LIBDIR" python3 -B "$HERE/launch.py" \
    --world "$world" -- \
    "$ENGINE" --config "$conf" --world "$world" --gameid minetest_game \
    --logfile "$log" > /dev/null 2>&1 &
  local pid=$!
  trap 'kill -TERM "$pid" ${worker_pid:+"$worker_pid"} 2>/dev/null || true; wait "$pid" 2>/dev/null || true; [[ -z "$worker_pid" ]] || wait "$worker_pid" 2>/dev/null || true' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local peak_kb=0 t=0 cpu_ticks=0 engine_pid=""
  local ticks_per_second
  ticks_per_second=$(getconf CLK_TCK)
  while kill -0 "$pid" 2>/dev/null && [[ "$t" -lt "$SECONDS_MAX" ]]; do
    sleep 1
    t=$((t + 1))
    if [[ -z "$engine_pid" ]] || ! kill -0 "$engine_pid" 2>/dev/null; then
      engine_pid=$(pgrep -P "$pid" -x luantiserver 2>/dev/null | head -n 1 || true)
    fi
    if [[ -n "$engine_pid" && -r "/proc/$engine_pid/status" ]]; then
      local rss
      rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$engine_pid/status" 2>/dev/null)
      local sampled_ticks
      sampled_ticks=$(awk '{print $14 + $15}' "/proc/$engine_pid/stat" 2>/dev/null)
      [[ -z "${sampled_ticks:-}" ]] || cpu_ticks="$sampled_ticks"
      [[ -n "${rss:-}" ]] && echo "$t $rss $cpu_ticks $engine_pid" >> "$rssfile"
      [[ -n "${rss:-}" ]] && [[ "$rss" -gt "$peak_kb" ]] && peak_kb="$rss"
    fi
  done

  local stopped_by="self-shutdown"
  if kill -0 "$pid" 2>/dev/null; then
    stopped_by="timeout-${SECONDS_MAX}s"
    kill -TERM "$pid" 2>/dev/null
    local grace=0
    while kill -0 "$pid" 2>/dev/null && [[ "$grace" -lt 10 ]]; do
      sleep 1
      grace=$((grace + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      stopped_by="sigkill-after-term-${grace}s"
      kill -KILL "$pid" 2>/dev/null
      sleep 1
    fi
  fi
  wait "$pid" 2>/dev/null
  local exit_code=$?
  if [[ -n "$worker_pid" ]]; then
    kill -TERM "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  trap - EXIT INT TERM

  if kill -0 "$pid" 2>/dev/null; then
    failed+=("进程未退出（pid $pid）")
  fi
  [[ -n "$engine_pid" ]] || failed+=("没有捕获到 Luanti 引擎 PID，资源指标无效")

  [[ "$exit_code" -eq 0 ]] || failed+=("引擎退出码 $exit_code")

  # ---- 校验 ----
  local stats_total stats_stepped_min
  stats_total=$(command grep -c 'SOCIETY stats' "$log" 2>/dev/null || true)
  stats_stepped_min=$(command grep -o 'stepped_delta=[0-9]*' "$log" 2>/dev/null \
    | command sed 's/stepped_delta=//' | sort -n | head -1)
  local min_step_rate
  min_step_rate=$(command grep -o 'steps_per_sec=[0-9.]*' "$log" 2>/dev/null \
    | command sed 's/steps_per_sec=//' | sort -n | head -1)

  # 停止路径的期望：默认自行关服；--decisions 0 时由本脚本发 SIGTERM。
  if [[ "$DECISIONS" -eq 0 ]]; then
    command grep -q 'SOCIETY shutdown ' "$log" || failed+=("SIGTERM 之后没有留下 shutdown 账")
    [[ "$stopped_by" == timeout-* ]] || failed+=("预期由超时停止，实际是 $stopped_by")
  else
    [[ "$stopped_by" == "self-shutdown" ]] || failed+=("预期自行关服，实际是 $stopped_by")
    # 自动关服才有 done；--decisions 0 的停止路径只要求留下 shutdown 账。
    if [[ -z "$EXPECT_FAIL" ]]; then
      command grep -q 'SOCIETY done result=ok' "$log" || failed+=("缺少 SOCIETY done result=ok")
    fi
  fi

  if [[ -n "$EXPECT_FAIL" ]]; then
    # 反向用例：失败必须被程序自己发现，并且说得出是哪一种失败。
    # 这里要求「检测到失败」才算通过——静默通过反而是失败。
    command grep -q "SOCIETY fail=$EXPECT_FAIL" "$log" \
      || failed+=("预期的失败 $EXPECT_FAIL 没有出现（检测失效）")
    command grep -q 'SOCIETY done result=fail' "$log" \
      || failed+=("失败没有以 done result=fail 收尾")
    if [[ "$EXPECT_FAIL" == agents-lost* ]]; then
      command grep -q 'SOCIETY check stage=spawn .* ok=false' "$log" \
        || failed+=("预期角色丢失，但没有失败的存活校验")
    fi
  else
    if command grep -q 'SOCIETY fail=' "$log"; then
      failed+=("出现失败行：$(command grep -o 'SOCIETY fail=[^ ]*' "$log" | sort -u | tr '\n' ' ')")
    fi
    command grep -q 'SOCIETY check stage=spawn .* ok=true' "$log" || failed+=("生成后存活校验未通过")
    command grep -q 'SOCIETY verify .* ok=true' "$log" || failed+=("缺少世界回读核对（verify ok=true）")
    if [[ "$MODEL" -eq 1 ]]; then
      command grep -q 'SOCIETY resource-verify .* ok=true' "$log" || failed+=("资源总量回读核对未通过")
    fi
    if [[ "$MODEL" -eq 1 ]]; then
      local model_actions
      model_actions=$(command grep -c 'SOCIETY ev=model-action ' "$log" || true)
      if [[ "$DECISIONS" -gt 0 && "$model_actions" -ne $((AGENTS * DECISIONS)) ]]; then
        failed+=("模型动作数 $model_actions，不等于预期 $((AGENTS * DECISIONS))")
      fi
    fi
    if [[ -z "$stats_total" || "$stats_total" -eq 0 ]]; then
      failed+=("没有任何 SOCIETY stats（服务端可能一个统计周期都没跑到）")
    fi
    if [[ -n "$stats_stepped_min" && "$stats_stepped_min" -ne "$AGENTS" ]]; then
      failed+=("最少一个统计区间只推进了 $stats_stepped_min/$AGENTS 个 agent")
    fi
    if [[ -n "$min_step_rate" ]] && awk "BEGIN{exit !($min_step_rate < 10.0)}"; then
      failed+=("steps_per_sec 最低 $min_step_rate，低于实时基准 11.1 太多")
    fi
  fi

  {
    echo "=== M0 运行报告 $LABEL.$tag ==="
    echo "时间: $(date -Is)"
    echo "停止方式: $stopped_by（退出码 $exit_code，运行 ${t}s）"
    if [[ -n "$EXPECT_FAIL" ]]; then
      echo "预期结果: 失败（$EXPECT_FAIL）—— 反向用例，检测到该失败才算通过"
    else
      echo "预期结果: 成功"
    fi
    if [[ "$FIXTURE" -eq 1 ]]; then
      echo "执行模式: deterministic-fixture (not a model)"
    elif [[ "$MODEL" -eq 1 ]]; then
      echo "执行模式: real-model"
      echo "模型: ${XUNFEI_MODEL:-${WISPIVA_LLM_MODEL:-not-configured}}"
    else
      echo "执行模式: rule-policy"
    fi
    echo "Luanti 引擎 PID: ${engine_pid:-not-captured}"
    echo "Luanti 引擎峰值 RSS: $((peak_kb / 1024)) MiB"
    echo "Luanti 引擎累计 CPU 秒 (最后采样): $(awk -v ticks="$cpu_ticks" -v hz="$ticks_per_second" 'BEGIN{printf "%.3f", ticks/hz}')"
    echo
    echo "--- 配置 ---"
    command sed 's/^/  /' "$conf"
    echo
    echo "--- 产物哈希（行为数字必须能对应到这个二进制与这份源码）---"
    sha256sum "$ENGINE" "$MOD_SRC/init.lua" "$MOD_SRC/policy.lua" "$EXP/cognition/"*.lua "$EXP/model/"*.py | command sed 's/^/  /'
    echo
    echo "--- 校验 ---"
    echo "  stats 行数: ${stats_total:-0}"
    echo "  每区间最少被推进的 agent: ${stats_stepped_min:-n/a} / $AGENTS"
    echo "  最低 steps_per_sec: ${min_step_rate:-n/a}（实时基准 11.1）"
    if [[ ${#failed[@]} -eq 0 ]]; then
      echo "  结果: PASS"
    else
      echo "  结果: FAIL"
      for f in "${failed[@]}"; do echo "    - $f"; done
    fi
    echo
    echo "--- SOCIETY 事件（原文）---"
    normalize "$log"
  } > "$report" 2>&1

  normalize_deterministic "$log" > "$EVIDENCE/$LABEL.$tag.events"

  echo "[$LABEL.$tag] $stopped_by, ${t}s, Luanti 引擎峰值 RSS $((peak_kb / 1024)) MiB, 事件 $(wc -l < "$EVIDENCE/$LABEL.$tag.events") 行"
  if [[ ${#failed[@]} -eq 0 ]]; then
    echo "[$LABEL.$tag] PASS"
    return 0
  fi
  echo "[$LABEL.$tag] FAIL"
  for f in "${failed[@]}"; do echo "    - $f"; done
  return 1
}

rc=0
for i in $(seq 1 "$REPEAT"); do
  run_once "run$i" || rc=1
done

if [[ "$REPEAT" -ge 2 && "$MODEL" -eq 0 ]]; then
  for i in $(seq 2 "$REPEAT"); do
    if diff -q "$EVIDENCE/$LABEL.run1.events" "$EVIDENCE/$LABEL.run$i.events" > /dev/null; then
      echo "[$LABEL] 可重复性: run1 与 run$i 的确定性事件序列完全一致（$(wc -l < "$EVIDENCE/$LABEL.run1.events") 行）"
    else
      echo "[$LABEL] 可重复性: FAIL —— run1 与 run$i 事件序列不同："
      diff "$EVIDENCE/$LABEL.run1.events" "$EVIDENCE/$LABEL.run$i.events" | head -20
      rc=1
    fi
  done
fi

exit $rc
