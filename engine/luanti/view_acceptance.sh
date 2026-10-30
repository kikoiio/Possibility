#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORLD=""
PORT=30079
SECONDS_MAX=60
NAME="observer"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --world) WORLD="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --seconds) SECONDS_MAX="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    -h|--help) sed -n '1,28p' "$0"; exit 0 ;;
    *) echo "view_acceptance.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

[[ -n "$WORLD" && -d "$WORLD" ]] || { echo "view_acceptance.sh: --world must name an existing product world" >&2; exit 2; }
command -v xvfb-run >/dev/null 2>&1 || { echo "view_acceptance.sh: xvfb-run unavailable" >&2; exit 2; }
command -v timeout >/dev/null 2>&1 || { echo "view_acceptance.sh: timeout unavailable" >&2; exit 2; }

server_log="$WORLD/private/view-server.log"
client_log="$WORLD/private/view-client.log"
client_config="$WORLD/private/view-client.conf"
product_log="$WORLD/private/product.log"
product_log_lines=0
if [[ -f "$product_log" ]]; then
  product_log_lines=$(wc -l < "$product_log")
fi

new_product_log() {
  [[ -f "$product_log" ]] || return 0
  local current_lines
  current_lines=$(wc -l < "$product_log")
  if [[ "$current_lines" -lt "$product_log_lines" ]]; then
    cat "$product_log"
  else
    tail -n "+$((product_log_lines + 1))" "$product_log"
  fi
}

dump_failure_logs() {
  echo "view acceptance failed: server log" >&2
  [[ -f "$server_log" ]] && tail -n 120 "$server_log" >&2 || true
  echo "view acceptance failed: product log" >&2
  new_product_log >&2 || true
  echo "view acceptance failed: client log" >&2
  [[ -f "$client_log" ]] && tail -n 120 "$client_log" >&2 || true
}

server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "$server_pid" ]]; then wait "$server_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

cat >"$client_config" <<'EOF'
enable_sound = false
EOF

"$HERE/run_product.sh" --world "$WORLD" --serve --visual-fixture --resume --port "$PORT" >"$server_log" 2>&1 &
server_pid=$!
for _ in $(seq 1 30); do
  new_product_log | grep -F 'SOCIETY view scene-ready' >/dev/null && break
  sleep 1
done
if ! new_product_log | grep -F 'SOCIETY view scene-ready' >/dev/null; then
  dump_failure_logs
  exit 1
fi

set +e
xvfb-run -a -s '-screen 0 1024x768x24 -nolisten tcp' \
  "$HERE/view_product.sh" --port "$PORT" --name "$NAME" \
  --seconds "$SECONDS_MAX" --config "$client_config" --logfile "$client_log"
client_status=$?
set -e
if [[ "$client_status" -ne 0 ]]; then
  dump_failure_logs
  exit "$client_status"
fi

if ! new_product_log | grep -F 'SOCIETY view join player=' >/dev/null \
  || ! new_product_log | grep -F 'SOCIETY view scene-ready ' >/dev/null \
  || ! new_product_log | grep -F 'SOCIETY view interaction ' >/dev/null \
  || ! new_product_log | grep -F 'SOCIETY view guide-arrival ' >/dev/null; then
  dump_failure_logs
  exit 1
fi
echo "product client acceptance passed: $WORLD"
