#!/bin/sh
# 夜曲 Nocturne · 独立的 data/ 备份（不依赖夜曲本身；POSIX sh，群晖 DSM 的 SSH 里可直接运行）
#
# 用法：sh backup.sh [选项] <DATA_DIR>
#   -o, --out DIR          备份放到哪个目录（默认当前目录）。生成：
#                            nocturne-backup-<时间>.tar.gz          归档（data/… + SHA256SUMS + BACKUP-INFO.txt）
#                            nocturne-backup-<时间>.tar.gz.sha256   归档本身的 sha256
#   --stop CONTAINER       备份前 docker stop 这个容器、结束后（含失败）docker start（最稳：没有写入在进行）
#   --exclude-ring         不备份 data/backup/（夜曲自己的配置快照环；默认备份）
#   --exclude-cache        不备份 data/cache/（图标缓存，可重新下载；默认备份）
#   -h, --help
#
# 一致性：
#   - 推荐 --stop（或先在 Container Manager 里停止容器）。
#   - 不停容器（热备份）：夜曲的每个文件都是「写临时文件 → rename」原子替换的，单个文件不会是半截的；
#     本脚本先把文件复制到输出目录下的暂存目录，复制完再逐个对比原文件的 sha256：备份期间有文件被改动 / 删除就整份重来
#     （最多 3 次），仍不一致则失败退出；打包后再解开归档逐个核对一次。暂存目录需要与 data 差不多大的空闲空间，结束后删除。
#   - 只跳过正在写入的临时文件 *.tmp（不是持久数据）。其余全部备份，包括账户密码哈希、会话、已知设备、配置、快照环、
#     上传的图标、壁纸、回滚写保护旁路文件、固定的升级前快照。
#   - 归档里有密码哈希和会话：文件权限 600（umask 077），请放在只有你能读的地方。脚本不会打印任何文件内容。
set -eu
umask 077
LC_ALL=C; export LC_ALL

OUT=.; STOP=""; EX_RING=0; EX_CACHE=0; DATA=""
die() { echo "错误：$*" >&2; exit 1; }
usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) [ $# -ge 2 ] || die "$1 需要一个目录"; OUT=$2; shift 2 ;;
    --stop) [ $# -ge 2 ] || die "--stop 需要容器名"; STOP=$2; shift 2 ;;
    --exclude-ring) EX_RING=1; shift ;;
    --exclude-cache) EX_CACHE=1; shift ;;
    -h|--help) usage 0 ;;
    -*) die "不认识的选项 $1（--help 查看用法）" ;;
    *) [ -z "$DATA" ] || die "只能指定一个 DATA_DIR"; DATA=$1; shift ;;
  esac
done
[ -n "$DATA" ] || usage 1
[ -d "$DATA" ] || die "$DATA 不是目录"
DATA=$(cd "$DATA" && pwd -P)
[ -f "$DATA/users.json" ] || [ -d "$DATA/config" ] || die "$DATA 看起来不是夜曲的 data 目录（没有 users.json 或 config/）"
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd -P)
case "$OUT/" in "$DATA"/*) rmdir "$OUT" 2>/dev/null || :; die "备份目录不能放在 data 目录里面（$OUT）" ;; esac

hash_of() { # 只输出 64 位十六进制
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else die "需要 sha256sum 或 openssl"; fi
}
command -v tar >/dev/null 2>&1 || die "需要 tar"
command -v gzip >/dev/null 2>&1 || die "需要 gzip"

STAGE=""
STARTED=0
cleanup() {
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  if [ "$STARTED" = 1 ]; then echo "重新启动容器 $STOP"; docker start "$STOP" >/dev/null || echo "警告：docker start $STOP 失败，请手动启动" >&2; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ -n "$STOP" ]; then
  command -v docker >/dev/null 2>&1 || die "找不到 docker 命令（群晖上请用 sudo 运行，或先在 Container Manager 里手动停止容器）"
  echo "停止容器 $STOP"
  docker stop "$STOP" >/dev/null || die "docker stop $STOP 失败"
  STARTED=1
fi

TS=$(date +%Y%m%d-%H%M%S)
NAME="nocturne-backup-$TS"
ARCHIVE="$OUT/$NAME.tar.gz"
[ ! -e "$ARCHIVE" ] || die "$ARCHIVE 已存在"

attempt=1
while :; do
  # 暂存目录放在输出目录里（群晖的 /tmp 很小）；先把文件复制进来，清单按复制件算——归档内容与 SHA256SUMS 必然一致
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  STAGE=$(mktemp -d "$OUT/.nocturne-backup.XXXXXX")
  # 1. 文件清单（只跳过 *.tmp；可选跳过快照环 / 图标缓存）
  ( cd "$DATA"
    set -- . -name '*.tmp' -prune
    [ "$EX_RING" = 1 ] && set -- "$@" -o -path ./backup -prune
    [ "$EX_CACHE" = 1 ] && set -- "$@" -o -path ./cache -prune
    find "$@" -o -type f -print | sed 's|^\./||' | sort ) > "$STAGE/FILES"
  if grep -q '[[:cntrl:]]' "$STAGE/FILES"; then die "data 里有文件名含控制字符，无法可靠备份"; fi
  # 2. 复制 + 每个复制件的 sha256
  mkdir "$STAGE/data"
  : > "$STAGE/SHA256SUMS"; BYTES=0; N=0; MISSING=0
  while IFS= read -r f; do
    if [ ! -f "$DATA/$f" ]; then MISSING=1; break; fi # 刚被删除 / 替换（快照环轮换、图标清理）
    mkdir -p "$STAGE/data/$(dirname "$f")"
    cp -p "$DATA/$f" "$STAGE/data/$f" 2>/dev/null || { MISSING=1; break; }
    h=$(hash_of "$STAGE/data/$f")
    printf '%s  data/%s\n' "$h" "$f" >> "$STAGE/SHA256SUMS"
    s=$(wc -c < "$STAGE/data/$f" | tr -d ' '); BYTES=$((BYTES + s)); N=$((N + 1))
  done < "$STAGE/FILES"
  # 3. 热备份一致性：复制完后逐个对比原文件——复制期间没有任何文件变化，才算同一时刻的数据
  SAME=1
  if [ "$MISSING" = 0 ] && [ -z "$STOP" ]; then
    while IFS= read -r line; do
      h=${line%%  *}; f=${line#*  data/}
      if [ ! -f "$DATA/$f" ] || [ "$(hash_of "$DATA/$f")" != "$h" ]; then SAME=0; break; fi
    done < "$STAGE/SHA256SUMS"
  fi
  if [ "$MISSING" = 0 ] && [ "$SAME" = 1 ]; then break; fi
  [ "$attempt" -lt 3 ] || die "备份期间数据一直在变（重试 3 次仍不一致）。请先停止容器（--stop nocturne）再备份"
  attempt=$((attempt + 1)); echo "备份期间有文件被改动，重来（第 $attempt 次）"; sleep 2
done
{
  echo "app=nocturne"
  echo "format=1"
  echo "created=$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "host=$(hostname 2>/dev/null || echo unknown)"
  echo "data_dir=$DATA"
  echo "files=$N"
  echo "bytes=$BYTES"
  echo "exclude_ring=$EX_RING"
  echo "exclude_cache=$EX_CACHE"
  echo "container_stopped=$([ -n "$STOP" ] && echo "$STOP" || echo no)"
} > "$STAGE/BACKUP-INFO.txt"
# 4. 打包 + 解开核对
rm -f "$ARCHIVE.part"
( cd "$STAGE" && tar -cf - SHA256SUMS BACKUP-INFO.txt data ) | gzip -6 > "$ARCHIVE.part"
sh "$(dirname "$0")/verify-backup.sh" --quiet --no-sidecar "$ARCHIVE.part" || { rm -f "$ARCHIVE.part"; die "打包后的归档校验失败（磁盘空间不足？）"; }
mv "$ARCHIVE.part" "$ARCHIVE"
( cd "$OUT" && printf '%s  %s\n' "$(hash_of "$NAME.tar.gz")" "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
echo "备份完成：$ARCHIVE"
echo "  文件 $N 个，原始大小 $BYTES 字节，归档 $(wc -c < "$ARCHIVE" | tr -d ' ') 字节"
echo "  校验文件：$ARCHIVE.sha256"
[ "$EX_RING" = 1 ] && echo "  注意：没有包含 data/backup/（配置快照环）"
[ "$EX_CACHE" = 1 ] && echo "  注意：没有包含 data/cache/（图标缓存，可重新下载）"
[ -n "$STOP" ] || echo "  （热备份：已逐个核对 sha256 一致）"
exit 0
