#!/bin/sh
# 夜曲 Nocturne · 从 backup.sh 的备份恢复 data 目录（POSIX sh）
#
# 用法：sh restore.sh [--force] <nocturne-backup-….tar.gz> <TARGET_DIR>
#   - 先完整校验备份（verify-backup.sh：归档 sha256 + 每个文件 sha256），不通过就什么都不做。
#   - TARGET_DIR 不存在或是空目录：直接恢复到这里。
#   - TARGET_DIR 非空：拒绝（退出码 3），除非加 --force；--force 时先把原目录整体改名为
#     <TARGET_DIR>.before-restore-<时间>（不删除任何东西），再恢复到一个新的 TARGET_DIR。
#   - 先解到 TARGET_DIR 旁边的临时目录、再核对一遍 sha256，最后一次 rename 到位：中途失败不会留下半个 data 目录。
#   - 恢复到正在运行的容器的 data 目录之前，请先停止容器；恢复后启动即可（入口脚本会按 PUID/PGID 修正属主）。
set -eu
umask 077
LC_ALL=C; export LC_ALL
FORCE=0; A=""; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的选项 $1" >&2; exit 2 ;;
    *) if [ -z "$A" ]; then A=$1; elif [ -z "$TARGET" ]; then TARGET=$1; else echo "参数太多" >&2; exit 2; fi; shift ;;
  esac
done
[ -n "$A" ] && [ -n "$TARGET" ] || { echo "用法：sh restore.sh [--force] <备份.tar.gz> <目标目录>" >&2; exit 2; }
die() { echo "错误：$*" >&2; exit 1; }
hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r "$1" | cut -d' ' -f1; fi
}
HERE=$(cd "$(dirname "$0")" && pwd -P)

echo "1/3 校验备份 …"
sh "$HERE/verify-backup.sh" "$A" || die "备份校验没通过，未做任何改动"

TARGET=${TARGET%/}; [ -n "$TARGET" ] || TARGET=/
PARENT=$(dirname "$TARGET"); mkdir -p "$PARENT"; PARENT=$(cd "$PARENT" && pwd -P)
TARGET="$PARENT/$(basename "$TARGET")"
if [ -e "$TARGET" ] && [ ! -d "$TARGET" ]; then die "$TARGET 已存在且不是目录"; fi
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  if [ "$FORCE" != 1 ]; then
    echo "拒绝：$TARGET 不是空目录。确认要替换就加 --force（原目录会被改名保留，不会删除）" >&2
    exit 3
  fi
  OLD="$TARGET.before-restore-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$OLD"
  echo "原目录已改名保留：$OLD"
fi

echo "2/3 解压到临时目录并再次核对 …"
TMP=$(mktemp -d "$PARENT/.nocturne-restore.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
tar -xzf "$A" -C "$TMP" || die "解压失败"
n=0
while IFS= read -r line; do
  h=${line%%  *}; f=${line#*  }
  [ "$(hash_of "$TMP/$f")" = "$h" ] || die "解压后 sha256 不一致：$f（目标未改动）"
  n=$((n + 1))
done < "$TMP/SHA256SUMS"
[ -d "$TMP/data" ] || mkdir "$TMP/data"
chmod 700 "$TMP/data"

echo "3/3 放到位 …"
[ -d "$TARGET" ] && rmdir "$TARGET"
mv "$TMP/data" "$TARGET"
cp "$TMP/BACKUP-INFO.txt" "$TARGET.restored-from.txt" 2>/dev/null || :
echo "恢复完成：$TARGET（$n 个文件，sha256 全部一致）"
echo "  备份信息：$TARGET.restored-from.txt"
echo "  提示：用 Docker 运行时，入口脚本启动时会按 PUID/PGID 自动 chown；直接用 node 运行时请确认运行用户能读写该目录。"
exit 0
