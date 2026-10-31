#!/usr/bin/env bash
# --reflection-every N forms a private L2 belief every N decisions (default 3;
# 0 disables it). --audit-model retains private input/output evidence per run.
# --model-workers N bounds concurrent model requests (default 1, maximum 256).
set -uo pipefail
umask 077

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
REFLECTION_EVERY=3
TIME_RATE=24
FAULT_STAGE=""
PORT=30078
FIXTURE=0
RESUME=0
SERVE=0
VISUAL_FIXTURE=0
AUDIT_MODEL=0
MODEL_WORKERS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --world) WORLD="$2"; shift 2 ;;
    --seconds) SECONDS_MAX="$2"; shift 2 ;;
    --decisions) DECISIONS="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --reflection-every) REFLECTION_EVERY="$2"; shift 2 ;;
    --speed) TIME_RATE="$2"; shift 2 ;;
    --fault-stage) FAULT_STAGE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --fake-model) FIXTURE=1; shift ;;
    --resume) RESUME=1; shift ;;
    --serve) SERVE=1; shift ;;
    --visual-fixture) VISUAL_FIXTURE=1; shift ;;
    --audit-model) AUDIT_MODEL=1; shift ;;
    --model-workers) MODEL_WORKERS="$2"; shift 2 ;;
    -h|--help) sed -n '1,26p' "$0"; exit 0 ;;
    *) echo "run_product.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$MODEL_WORKERS" =~ ^[1-9][0-9]{0,2}$ ]] || (( MODEL_WORKERS > 256 )); then
  echo "run_product.sh: --model-workers must be between 1 and 256" >&2
  exit 2
fi

if [[ "$SERVE" -eq 1 ]]; then
  SECONDS_MAX=0
  DECISIONS=0
fi

[[ "$REFLECTION_EVERY" =~ ^[0-9]+$ ]] || { echo "run_product.sh: --reflection-every must be a nonnegative integer" >&2; exit 2; }
python3 -B -c 'import sys,math; rate=float(sys.argv[1]); sys.exit(0 if math.isfinite(rate) and 0<=rate<=1000 else 2)' "$TIME_RATE" || { echo "run_product.sh: --speed must be between 0 and 1000" >&2; exit 2; }
case "$FAULT_STAGE" in ""|after_map|after_environment|after_agents|before_commit|after_commit) ;; *) echo 'run_product.sh: invalid fault stage' >&2; exit 2 ;; esac
[[ -n "$WORLD" && -d "$WORLD" ]] || { echo "run_product.sh: --world must name an existing product world" >&2; exit 2; }
[[ -x "$ENGINE" ]] || { echo "run_product.sh: engine unavailable: $ENGINE" >&2; exit 2; }
[[ -f "$WORLD/wispiva-world-id" ]] || { echo "run_product.sh: missing world identity" >&2; exit 2; }
namespace="product.$(date +%s).$$"
spool="$WORLD/private/model-spool/$namespace"
audit_dir="$WORLD/private/model-audit/$namespace"
mkdir -p "$spool"
mkdir -p "$WORLD/private/control"
chmod 700 "$WORLD/private/control"
if [[ "$AUDIT_MODEL" -eq 1 ]]; then
  mkdir -p "$audit_dir"
  chmod 700 "$WORLD/private/model-audit" "$audit_dir"
fi
chmod 700 "$WORLD/private" "$WORLD/private/model-spool" "$spool"

if pgrep -x 'luantiserver' >/dev/null 2>&1; then
  echo "run_product.sh: another luantiserver is running" >&2
  exit 2
fi

conf="$WORLD/private/.runtime.conf"
log="$WORLD/private/product.log"
worker_pid=""
server_pid=""
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
society_spool = $spool
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
society_model_audit_dir = $audit_dir
society_reflection_every = $REFLECTION_EVERY
society_time_rate = $TIME_RATE
society_control_dir = $WORLD/private/control
society_fault_stage = $FAULT_STAGE
EOF
chmod 600 "$conf"

if [[ "$VISUAL_FIXTURE" -eq 1 ]]; then
  :
elif [[ "$FIXTURE" -eq 1 ]]; then
  echo "spool worker concurrency=$MODEL_WORKERS fixture=true" > "$WORLD/private/worker.log"
  python3 -B "$ROOT/model/spool_worker.py" "$spool" --timeout 90 --workers "$MODEL_WORKERS" --fixture >> "$WORLD/private/worker.log" 2>&1 &
  worker_pid=$!
else
  echo "spool worker concurrency=$MODEL_WORKERS fixture=false" > "$WORLD/private/worker.log"
  python3 -B "$ROOT/model/spool_worker.py" "$spool" --timeout 90 --workers "$MODEL_WORKERS" >> "$WORLD/private/worker.log" 2>&1 &
  worker_pid=$!
fi

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "$worker_pid" ]]; then kill -TERM "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

HOME="$LUA_HOME" LD_LIBRARY_PATH="$LIBDIR" python3 -B "$HERE/launch.py" \
  --require-product-contract --world "$WORLD" -- \
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
