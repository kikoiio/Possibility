#!/usr/bin/env bash
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RT="${LUANTI_RT:-$HERE/.runtime}"
ENGINE="$RT/root/usr/libexec/luanti/luantiserver"
LIBDIR="$RT/root/usr/lib/x86_64-linux-gnu"
LUA_HOME="$RT/home"

WORLD=""
SECONDS_MAX=180
DECISIONS=10
INTERVAL=2
PORT=30078
FIXTURE=0
RESUME=0
SERVE=0
VISUAL_FIXTURE=0
AUDIT_MODEL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --world) WORLD="$2"; shift 2 ;;
    --seconds) SECONDS_MAX="$2"; shift 2 ;;
    --decisions) DECISIONS="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --fake-model) FIXTURE=1; shift ;;
    --resume) RESUME=1; shift ;;
    --serve) SERVE=1; shift ;;
    --visual-fixture) VISUAL_FIXTURE=1; shift ;;
    --audit-model) AUDIT_MODEL=1; shift ;;
    -h|--help) sed -n '1,26p' "$0"; exit 0 ;;
    *) echo "run_product.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [[ "$SERVE" -eq 1 ]]; then
  SECONDS_MAX=0
  DECISIONS=0
fi

[[ -n "$WORLD" && -d "$WORLD" ]] || { echo "run_product.sh: --world must name an existing product world" >&2; exit 2; }
[[ -x "$ENGINE" ]] || { echo "run_product.sh: engine unavailable: $ENGINE" >&2; exit 2; }
[[ -f "$WORLD/wispiva-world-id" ]] || { echo "run_product.sh: missing world identity" >&2; exit 2; }
mkdir -p "$WORLD/private/model-spool"
if [[ "$AUDIT_MODEL" -eq 1 ]]; then
  mkdir -p "$WORLD/private/model-audit"
  chmod 700 "$WORLD/private/model-audit"
fi
chmod 700 "$WORLD/private" "$WORLD/private/model-spool"

if pgrep -f 'luantiserver' >/dev/null 2>&1; then
  echo "run_product.sh: another luantiserver is running" >&2
  exit 2
fi

namespace="product.$(date +%s).$$"
conf="$WORLD/private/.runtime.conf"
log="$WORLD/private/product.log"
worker_pid=""
cat > "$conf" <<EOF
bind_address = 127.0.0.1
port = $PORT
mg_name = singlenode
server_announce = false
enable_damage = false
creative_mode = true
max_forceloaded_blocks = -1
dedicated_server_step = 0.09
server_map_save_interval = 1
static_spawnpoint = (0,2,-20)
society_world_product = true
society_genesis_manifest = $WORLD/private/wispiva-origin.json
society_spool = $WORLD/private/model-spool
society_model = $([[ "$VISUAL_FIXTURE" -eq 1 ]] && echo false || echo true)
society_cognition = $([[ "$VISUAL_FIXTURE" -eq 1 ]] && echo false || echo true)
society_visual = true
society_view_guide = true
society_view_spawn = true
society_view_acceptance = $([[ "$VISUAL_FIXTURE" -eq 1 ]] && echo true || echo false)
society_persist = true
society_long_term_memory = true
society_restore = $([[ "$RESUME" -eq 1 ]] && echo true || echo false)
society_reset_minds = false
society_max_decisions = $DECISIONS
society_decide_interval = $INTERVAL
society_event_namespace = $namespace
society_model_audit = $([[ "$AUDIT_MODEL" -eq 1 ]] && echo true || echo false)
society_model_audit_dir = $WORLD/private/model-audit
EOF
chmod 600 "$conf"

if [[ "$VISUAL_FIXTURE" -eq 1 ]]; then
  :
elif [[ "$FIXTURE" -eq 1 ]]; then
  python3 -B "$ROOT/model/spool_worker.py" "$WORLD/private/model-spool" --timeout 45 --fixture > "$WORLD/private/worker.log" 2>&1 &
  worker_pid=$!
else
  python3 -B "$ROOT/model/spool_worker.py" "$WORLD/private/model-spool" --timeout 45 > "$WORLD/private/worker.log" 2>&1 &
  worker_pid=$!
fi

cleanup() {
  if [[ -n "$worker_pid" ]]; then kill -TERM "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

HOME="$LUA_HOME" LD_LIBRARY_PATH="$LIBDIR" python3 -B "$HERE/launch.py" \
  --world "$WORLD" -- \
  "$ENGINE" --config "$conf" --world "$WORLD" --gameid minetest_game --logfile "$log" &
server_pid=$!

elapsed=0
if [[ "$SERVE" -eq 1 ]]; then
  wait "$server_pid"
  status=$?
  [[ "$status" -eq 0 ]] || exit "$status"
  echo "product world server stopped cleanly: $WORLD"
  exit 0
fi
while kill -0 "$server_pid" 2>/dev/null && [[ "$elapsed" -lt "$SECONDS_MAX" ]]; do
  sleep 1
  elapsed=$((elapsed + 1))
done
if kill -0 "$server_pid" 2>/dev/null; then
  kill -TERM "$server_pid" 2>/dev/null || true
fi
wait "$server_pid"
status=$?
[[ "$status" -eq 0 ]] || exit "$status"
grep -q 'SOCIETY done result=ok' "$log" || { tail -n 80 "$log" >&2; exit 1; }
! grep -q 'SOCIETY fail=' "$log" || { tail -n 80 "$log" >&2; exit 1; }
grep -q 'SOCIETY origin projection ' "$log" || { tail -n 80 "$log" >&2; exit 1; }
grep -q 'SOCIETY ev=environment ' "$log" || { tail -n 80 "$log" >&2; exit 1; }
echo "product world run passed: $WORLD"
