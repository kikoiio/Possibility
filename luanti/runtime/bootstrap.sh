#!/usr/bin/env bash
# 幂等地把 Luanti 运行时物化到 luanti/.runtime/。
#
# 为什么是这样：本项目要求「只用免费资源」并且不希望为了实验装系统包，
# 所以不打 apt install、不用 sudo、不装 Java，而是把需要的 deb 下载下来
# 就地解包成一份项目内运行时（约 60 MB），用 HOME 与 LD_LIBRARY_PATH 隔离。
# 已下载的 deb 不重复下载，已解包的树不重复解包，因此可以反复执行。
#
# 用法：
#   runtime/bootstrap.sh            # 缺什么补什么
#   runtime/bootstrap.sh --force    # 丢掉解包树重建（deb 缓存保留）
#
# 退出码：0 成功；1 依赖缺失（apt-get/dpkg-deb 不可用）；2 引擎自检失败。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXP="$(cd "$HERE/.." && pwd)"
RT="${LUANTI_RT:-$EXP/.runtime}"
CACHE="$RT/deb"
TREE="$RT/root"
LUA_HOME="$RT/home"
ENGINE="$TREE/usr/libexec/luanti/luantiserver"
LIBDIR="$TREE/usr/lib/x86_64-linux-gnu"

# 引擎 + 发行版自带的 Minetest Game + 运行时缺的 .so。版本由 apt 解析，解包后写进 manifest。
PKGS=(
  luanti luanti-server luanti-data luanti-game-minetest
  libjsoncpp26 libluajit-5.1-2 libpq5
  libprometheus-cpp-core1.0 libprometheus-cpp-pull1.0 libspatialindex8 libcivetweb1
)

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

for tool in apt-get dpkg-deb sha256sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "bootstrap: 缺少依赖 $tool（本脚本不用 sudo，但需要 apt/dpkg 工具链）" >&2
    exit 1
  fi
done

mkdir -p "$CACHE"

# 1. 下载：任何一个包在缓存里已有 .deb 就跳过，避免重复联网。
#    镜像会间歇性连不上（实测 cn.archive.ubuntu.com 超时、security.ubuntu.com 正常），
#    所以按「还缺哪些」重试几次，而不是一次失败就整个放弃。
missing=()
for pkg in "${PKGS[@]}"; do
  compgen -G "$CACHE/${pkg}_*.deb" >/dev/null || missing+=("$pkg")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "bootstrap: 需要下载 ${#missing[@]} 个包 -> $CACHE"
  for attempt in 1 2 3; do
    still=()
    for pkg in "${missing[@]}"; do
      compgen -G "$CACHE/${pkg}_*.deb" >/dev/null || still+=("$pkg")
    done
    [[ ${#still[@]} -eq 0 ]] && break
    echo "bootstrap: 第 $attempt 次尝试，还缺 ${#still[@]} 个：${still[*]}"
    ( cd "$CACHE" && apt-get download "${still[@]}" ) || true
  done

  absent=()
  for pkg in "${PKGS[@]}"; do
    compgen -G "$CACHE/${pkg}_*.deb" >/dev/null || absent+=("$pkg")
  done
  if [[ ${#absent[@]} -gt 0 ]]; then
    echo "bootstrap: 仍缺 ${#absent[@]} 个包：${absent[*]}" >&2
    echo "bootstrap: 是镜像不可达，不是脚本问题；网络恢复后重跑本脚本即可（已下好的不会重下）" >&2
    exit 1
  fi
else
  echo "bootstrap: deb 缓存已完整，跳过下载"
fi

# 2. 解包。任何一次 deb 版本变化都应重跑 --force。
if [[ $FORCE -eq 1 ]]; then
  echo "bootstrap: --force，删除旧解包树 $TREE"
  rm -rf "$TREE"
fi

if [[ ! -x "$ENGINE" ]]; then
  echo "bootstrap: 解包 -> $TREE"
  mkdir -p "$TREE"
  for f in "$CACHE"/*.deb; do
    dpkg-deb -x "$f" "$TREE" || { echo "bootstrap: 解包失败 $f" >&2; exit 1; }
  done
else
  echo "bootstrap: 解包树已存在，跳过解包"
fi

# 3. 让引擎找得到自己的 builtin/ 与 share/。
#    deb 把二进制放在 usr/libexec/luanti/，但内置资源在 usr/share/luanti/。
ln -sfn ../share "$TREE/usr/libexec/share"

# 4. 游戏包发现：Luanti 在 $HOME/.minetest/games 与 $HOME/.luanti/games 下找游戏。
mkdir -p "$LUA_HOME/.luanti/games" "$LUA_HOME/.minetest"
if [[ ! -d "$LUA_HOME/.luanti/games/minetest_game" ]]; then
  cp -r "$TREE/usr/share/luanti/games/minetest_game" "$LUA_HOME/.luanti/games/" || {
    echo "bootstrap: 从 deb 里找不到 minetest_game" >&2
    exit 1
  }
fi
ln -sfn ../.luanti/games "$LUA_HOME/.minetest/games"

# 5. 记录产物哈希：容量与行为数字必须能对应到具体的二进制。
MANIFEST="$RT/manifest.sha256"
( cd "$CACHE" && sha256sum ./*.deb ) > "$MANIFEST"
sha256sum "$ENGINE" >> "$MANIFEST"
echo "bootstrap: 产物哈希写入 $MANIFEST"

# 6. 自检：能报版本才算物化成功。
VERSION_OUT="$(HOME="$LUA_HOME" LD_LIBRARY_PATH="$LIBDIR" "$ENGINE" --version 2>&1)"
if [[ -z "$VERSION_OUT" ]]; then
  echo "bootstrap: 引擎无法启动，检查 $LIBDIR 与 $MANIFEST" >&2
  exit 2
fi
echo "bootstrap: 引擎自检通过 -> ${VERSION_OUT%%$'\n'*}"
echo "bootstrap: 运行时位于 $RT"
