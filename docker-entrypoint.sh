#!/bin/sh
# 以 root 启动时：按 PUID/PGID 调整 node 用户、修正 /data 权限、按需加入 docker.sock 所在组，然后降权为 node 用户运行。
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"; PGID="${PGID:-1000}"
  case "$PUID$PGID" in *[!0-9]*|"") echo "warn: PUID/PGID 必须是数字，改用 1000/1000" >&2; PUID=1000; PGID=1000 ;; esac
  if [ "$PUID" = "0" ]; then echo "warn: 不支持 PUID=0（root），改用 1000" >&2; PUID=1000; fi
  # 主组：PGID 已有组（如群晖的 100 = users）就直接用它，否则把 node 组改成 PGID
  if [ "$(id -g node)" != "$PGID" ]; then
    if ! awk -F: -v g="$PGID" '$3==g{f=1} END{exit !f}' /etc/group; then
      sed -i "s/^node:x:[0-9]*:/node:x:$PGID:/" /etc/group
    fi
    sed -i "s/^\(node:x:[0-9]*\):[0-9]*:/\1:$PGID:/" /etc/passwd
  fi
  if [ "$(id -u node)" != "$PUID" ]; then
    sed -i "s/^node:x:[0-9]*:/node:x:$PUID:/" /etc/passwd
  fi
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || echo "warn: 无法修改 $DATA_DIR 权限" >&2
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
