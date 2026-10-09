#!/bin/sh
# Nocturne 完整 data 备份，归档格式仍为 1。
# backup.sh [-o DIR] [--stop CONTAINER] [--exclude-ring] [--exclude-cache] DATA_DIR
# 升级/灾备基准须先停唯一写入实例。热备份仅尽力检测变化，不是事务快照。
set -eu
umask 077
LC_ALL=C; export LC_ALL
OUT=.; STOP=""; EX_RING=0; EX_CACHE=0; DATA=""; STAGE=""; STARTED=0; SIDECAR_OWN=0; ARCHIVE=""
die() { echo "错误：$*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) [ $# -ge 2 ] || die "需要输出目录"; OUT=$2; shift 2 ;;
    --stop) [ $# -ge 2 ] || die "需要容器名"; STOP=$2; shift 2 ;;
    --exclude-ring) EX_RING=1; shift ;;
    --exclude-cache) EX_CACHE=1; shift ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# //'; exit 0 ;;
    -*) die "不认识的选项 $1" ;;
    *) [ -z "$DATA" ] || die "仅支持一个 DATA_DIR"; DATA=$1; shift ;;
  esac
done
[ -n "$DATA" ] && [ -d "$DATA" ] || die "需要 DATA_DIR"
DATA=$(cd "$DATA" && pwd -P)
[ -f "$DATA/users.json" ] || [ -d "$DATA/config" ] || die "不是夜曲 data 目录"
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd -P)
case "$OUT/" in "$DATA/"*) die "备份目录不能在 data 内" ;; esac
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/archive-common.sh"
restart_original() {
  if [ "$STARTED" = 1 ]; then
    STARTED=0
    docker start "$STOP" >/dev/null || { echo "归档状态另行核查；原运行容器重新启动失败：$STOP" >&2; return 1; }
    nc_running=$(docker inspect --format '{{.State.Running}}' "$STOP") || return 1
    [ "$nc_running" = true ] || { echo "容器启动后仍未运行：$STOP" >&2; return 1; }
  fi
}
cleanup() {
  nc_rc=$?; trap - EXIT INT TERM
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  if [ "$SIDECAR_OWN" = 1 ] && [ ! -f "$ARCHIVE" ]; then rm -f "$ARCHIVE.sha256"; fi
  restart_original || nc_rc=1
  exit "$nc_rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [ -n "$STOP" ]; then
  command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
  running=$(docker inspect --format '{{.State.Running}}' "$STOP") || die "无法确认容器原状态"
  case "$running" in
    true)
      if docker stop "$STOP" >/dev/null; then STARTED=1
      else
        nc_after=$(docker inspect --format '{{.State.Running}}' "$STOP") || die "停止失败且状态未知"
        [ "$nc_after" != false ] || STARTED=1
        die "docker stop 失败，未开始备份"
      fi
      nc_after=$(docker inspect --format '{{.State.Running}}' "$STOP") || die "无法确认停止状态"
      [ "$nc_after" = false ] || die "容器尚未停止，未开始备份" ;;
    false) ;; # 初始已停止的实例绝不自动启动。
    *) die "容器状态不明确" ;;
  esac
fi
ARCHIVE="$OUT/nocturne-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
[ ! -e "$ARCHIVE" ] && [ ! -e "$ARCHIVE.sha256" ] || die "备份名称已存在，拒绝覆盖"
# 一套枚举规则用于三次清单，find / sort 错误均直接传递。
list_files() {
  nc_list=$1
  (
    cd "$DATA"
    set -- . -name '*.tmp' -prune
    [ "$EX_RING" = 0 ] || set -- "$@" -o -path ./backup -prune
    [ "$EX_CACHE" = 0 ] || set -- "$@" -o -path ./cache -prune
    find "$@" -o ! -type f ! -type d -print > "$nc_list.types" || exit 1
    [ ! -s "$nc_list.types" ] || { echo "data 含链接或特殊文件，拒绝备份" >&2; exit 1; }
    find "$@" -o -type f -print > "$nc_list.raw" || exit 1
    find "$@" -o -type d -print > "$nc_list.dirs-raw" || exit 1
  ) || return 1
  sed 's|^\./||' "$nc_list.raw" > "$nc_list.rel" || return 1
  sort "$nc_list.rel" > "$nc_list" || return 1
  sed 's|^\./||' "$nc_list.dirs-raw" > "$nc_list.dirs-rel" || return 1
  sort "$nc_list.dirs-rel" > "$nc_list.dirs" || return 1
  if grep -q '[[:cntrl:]]' "$nc_list"; then return 1; fi
}
attempt=1
while :; do
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  STAGE=$(mktemp -d "$OUT/.nocturne-backup.XXXXXX")
  list_files "$STAGE/BEFORE" || die "源目录枚举失败"
  mkdir "$STAGE/data"; : > "$STAGE/SHA256SUMS"; BYTES=0; N=0; SAME=1
  while IFS= read -r nc_dir; do mkdir -p "$STAGE/data/$nc_dir"; done < "$STAGE/BEFORE.dirs"
  while IFS= read -r f; do
    if [ ! -f "$DATA/$f" ] || [ -L "$DATA/$f" ]; then SAME=0; break; fi
    mkdir -p "$STAGE/data/$(dirname "$f")"
    cp -p "$DATA/$f" "$STAGE/data/$f" || { SAME=0; break; }
    [ -f "$STAGE/data/$f" ] && [ ! -L "$STAGE/data/$f" ] || die "复制期间文件类型变化"
    h=$(hash_of "$STAGE/data/$f") || die "读取复制件 hash 失败"
    printf '%s  data/%s\n' "$h" "$f" >> "$STAGE/SHA256SUMS"
    s=$(wc -c < "$STAGE/data/$f"); BYTES=$((BYTES + s)); N=$((N + 1))
  done < "$STAGE/BEFORE"
  list_files "$STAGE/AFTER" || die "复制后枚举失败"
  cmp -s "$STAGE/BEFORE" "$STAGE/AFTER" || SAME=0
  cmp -s "$STAGE/BEFORE.dirs" "$STAGE/AFTER.dirs" || SAME=0
  if [ "$SAME" = 1 ]; then
    while IFS= read -r line; do
      h=${line%%  *}; f=${line#*  data/}
      if [ ! -f "$DATA/$f" ] || [ -L "$DATA/$f" ]; then SAME=0; break; fi
      got=$(hash_of "$DATA/$f") || { SAME=0; break; }
      [ "$got" = "$h" ] || { SAME=0; break; }
    done < "$STAGE/SHA256SUMS"
  fi
  list_files "$STAGE/FINAL" || die "校验后枚举失败"
  cmp -s "$STAGE/AFTER" "$STAGE/FINAL" || SAME=0
  cmp -s "$STAGE/AFTER.dirs" "$STAGE/FINAL.dirs" || SAME=0
  [ "$SAME" = 0 ] || break
  [ "$attempt" -lt 3 ] || die "备份期间数据一直在变或读取失败（重试 3 次）；先停写再备份"
  attempt=$((attempt + 1)); echo "数据变动，重试第 $attempt 次"; sleep 2
done
{
  echo app=nocturne; echo format=1; echo "created=$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "host=$(hostname)"; echo "data_dir=$DATA"; echo "files=$N"; echo "bytes=$BYTES"
  echo "exclude_ring=$EX_RING"; echo "exclude_cache=$EX_CACHE"; echo "container_stopped=${STOP:-no}"
} > "$STAGE/BACKUP-INFO.txt"
# 分开检查 tar/gzip，不吞管道前段错误。最终归档最后发布，已有同名文件绝不覆盖。
( cd "$STAGE" && tar -cf archive.tar SHA256SUMS BACKUP-INFO.txt data ) || die "tar 打包失败"
gzip -6 -c "$STAGE/archive.tar" > "$STAGE/archive.part" || die "gzip 打包失败"
sh "$HERE/verify-backup.sh" --quiet --no-sidecar "$STAGE/archive.part" || die "归档内部校验失败"
h=$(hash_of "$STAGE/archive.part") || die "归档 hash 失败"
printf '%s  %s\n' "$h" "$(basename "$ARCHIVE")" > "$STAGE/archive.sha256"
ln "$STAGE/archive.sha256" "$ARCHIVE.sha256" || die "侧车已存在或写入失败"
SIDECAR_OWN=1
ln "$STAGE/archive.part" "$ARCHIVE" || die "归档已存在或写入失败"
SIDECAR_OWN=0
restart_original || die "归档已校验生成，但服务原运行状态未恢复"
echo "备份完成：$ARCHIVE（文件 $N 个，原始大小 $BYTES 字节）"
[ -n "$STOP" ] || echo "热备份只做变化检测，不保证跨文件事务一致；升级/灾备基准须停写完整备份"
exit 0
