#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT="${LUANTI_RT:-$HERE/.runtime}"
CLIENT="$RT/root/usr/libexec/luanti/luanti"
LUA_HOME="$RT/home"
PORT=30078
NAME="observer"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    -h|--help) sed -n '1,24p' "$0"; exit 0 ;;
    *) echo "view_product.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

[[ -x "$CLIENT" ]] || { echo "view_product.sh: client unavailable: $CLIENT" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || {
  echo "view_product.sh: invalid port" >&2; exit 2;
}
[[ "$NAME" =~ ^[A-Za-z0-9_-]{1,20}$ ]] || { echo "view_product.sh: invalid name" >&2; exit 2; }

HOME="$LUA_HOME" LD_LIBRARY_PATH="$RT/root/usr/lib/x86_64-linux-gnu" \
  "$CLIENT" --address 127.0.0.1 --port "$PORT" --name "$NAME"
