#!/bin/sh
# 以 root 启动时：修正 /data 权限、按需加入 docker.sock 所在组，然后降权为 node 用户运行。
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || echo "warn: 无法修改 $DATA_DIR 权限" >&2
  SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
  if [ -S "$SOCK" ]; then
    gid="$(stat -c %g "$SOCK")"
    grp="$(awk -F: -v g="$gid" '$3==g{print $1; exit}' /etc/group)"
    if [ -z "$grp" ]; then addgroup -g "$gid" dockersock; grp=dockersock; fi
    addgroup node "$grp" 2>/dev/null || true
  fi
  exec su-exec node "$@"
fi
exec "$@"
