#!/bin/sh
# Nocturne：校验和解压完成后才切换目标；中断记录位于 <TARGET>.restore-state。
# 用法：sh restore.sh [--force] <备份.tar.gz> <TARGET_DIR>。容器须由操作者事先停止。
# 中断后重跑同一命令：完成已安装的新目录（0），或回退旧目录（4，需再次执行恢复）。
set -eu
umask 077
LC_ALL=C; export LC_ALL
FORCE=0; A=""; TARGET=""; STAGE=""; STATE=""; SWITCHING=0; OWN_STATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# //'; exit 0 ;;
    -*) echo "不认识的选项 $1" >&2; exit 2 ;;
    *) if [ -z "$A" ]; then A=$1; elif [ -z "$TARGET" ]; then TARGET=$1; else exit 2; fi; shift ;;
  esac
done
[ -n "$A" ] && [ -n "$TARGET" ] || { echo "用法：restore.sh [--force] <备份> <目标>" >&2; exit 2; }
die() { echo "错误：$*" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/archive-common.sh"
TARGET=${TARGET%/}
case "$TARGET" in ""|/|.|..) die "危险目标目录" ;; esac
BASE=$(basename "$TARGET")
case "$BASE" in .|..|"") die "目标名称不安全" ;; esac
nc_clean=$(printf '%s' "$BASE" | tr -d '[:cntrl:]') || die "目标名称检查失败"
[ "$nc_clean" = "$BASE" ] || die "目标名称含控制字符"
PARENT=$(dirname "$TARGET"); mkdir -p "$PARENT"; PARENT=$(cd "$PARENT" && pwd -P); TARGET="$PARENT/$BASE"
[ "$PARENT" != / ] || die "禁止恢复到顶层目录"
[ "$TARGET" != "$HOME" ] || die "禁止恢复到用户主目录"
case "$(pwd -P)/" in "$TARGET/"*) die "禁止恢复当前目录或其上级" ;; esac
[ ! -L "$TARGET" ] || die "目标不能是符号链接"
STATE="$TARGET.restore-state"
inode_of() { nc_inode_line=$(ls -di "$1") || return 1; nc_inode=$(printf '%s\n' "$nc_inode_line" | sed 's/^[[:space:]]*//;s/[[:space:]].*$//') || return 1; case "$nc_inode" in ''|*[!0-9]*) return 1 ;; esac; printf '%s\n' "$nc_inode"; }
read_record() {
  [ -d "$STATE" ] && [ ! -L "$STATE" ] || die "恢复记录目录异常，保留 $STATE"
  for nc_key in READY TARGET STAGE OLD OLD-ID NEW-ID; do [ -f "$STATE/$nc_key" ] && [ ! -L "$STATE/$nc_key" ] || die "恢复记录不完整，保留 $STATE"; done
  [ "$(cat "$STATE/READY")" = ready ] && [ "$(cat "$STATE/TARGET")" = "$TARGET" ] || die "恢复记录目标不符"
  STAGE=$(cat "$STATE/STAGE"); OLD=$(cat "$STATE/OLD"); OLD_ID=$(cat "$STATE/OLD-ID"); NEW_ID=$(cat "$STATE/NEW-ID")
  case "$STAGE" in "$PARENT/.nocturne-restore."*) nc_suffix=${STAGE#"$PARENT/.nocturne-restore."} ;; *) die "恢复材料路径不安全" ;; esac
  case "$nc_suffix" in ''|*[!A-Za-z0-9]*) die "恢复材料路径不安全" ;; esac
  case "$OLD" in "$TARGET.before-restore-"*) nc_suffix=${OLD#"$TARGET.before-restore-"} ;; *) die "旧目录路径不安全" ;; esac
  case "$nc_suffix" in ''|*[!A-Za-z0-9_.-]*) die "旧目录路径不安全" ;; esac
  case "$OLD_ID" in none) ;; ''|*[!0-9]*) die "旧目录身份错误" ;; esac
  case "$NEW_ID" in ''|*[!0-9]*) die "新目录身份错误" ;; esac
  for nc_path in "$TARGET" "$OLD" "$STAGE" "$STAGE/data"; do [ ! -L "$nc_path" ] || die "恢复材料出现链接，保留 $STATE"; done
}
finish_record() { rm -rf "$STATE"; rm -rf "$STAGE"; sync; STAGE=""; SWITCHING=0; }
recover_record() {
  read_record
  if [ -e "$TARGET" ]; then
    [ -d "$TARGET" ] || die "目标出现冲突，保留 $OLD $STAGE $STATE"
    nc_id=$(inode_of "$TARGET") || die "读取目标身份失败"
    if [ "$nc_id" = "$NEW_ID" ]; then
      if [ "$OLD_ID" != none ]; then [ -d "$OLD" ] && [ "$(inode_of "$OLD")" = "$OLD_ID" ] || die "旧目录冲突，保留材料"; fi
      echo "已完成验证后的新目录：$TARGET；原目录保留：$OLD"
      finish_record; RECOVERED=new; return
    fi
    [ "$nc_id" = "$OLD_ID" ] && [ ! -e "$OLD" ] || die "目标或旧目录冲突，保留 $OLD $STAGE $STATE"
  elif [ "$OLD_ID" != none ]; then
    [ -d "$OLD" ] && [ "$(inode_of "$OLD")" = "$OLD_ID" ] || die "旧目录身份冲突，保留材料"
    mv "$OLD" "$TARGET" || die "回退失败；旧=$OLD 新=$STAGE/data 记录=$STATE"
    sync || die "回退同步失败，保留 $STATE"
  else
    [ -d "$STAGE/data" ] && [ "$(inode_of "$STAGE/data")" = "$NEW_ID" ] || die "新目录身份冲突"
    mv "$STAGE/data" "$TARGET" || die "新目录放置失败，保留 $STAGE $STATE"
    sync || die "放置同步失败，保留材料"
    finish_record; RECOVERED=new; return
  fi
  [ -d "$STAGE/data" ] && [ "$(inode_of "$STAGE/data")" = "$NEW_ID" ] || die "新材料冲突，保留 $STAGE $STATE"
  echo "已回退原目录：$TARGET；请核验后再次执行恢复"
  finish_record; RECOVERED=old
}
if [ -e "$STATE" ] || [ -L "$STATE" ]; then recover_record; [ "$RECOVERED" = new ] && exit 0; exit 4; fi
[ ! -e "$TARGET" ] || [ -d "$TARGET" ] || die "目标不是目录"
if [ -d "$TARGET" ]; then
  nc_listing=$(ls -A "$TARGET") || die "无法读取目标目录"
  if [ -n "$nc_listing" ] && [ "$FORCE" != 1 ]; then echo "拒绝：$TARGET 不是空目录，需 --force" >&2; exit 3; fi
fi
[ -f "$A" ] && [ ! -L "$A" ] || die "归档不是普通文件"
A_DIR=$(cd "$(dirname "$A")" && pwd -P); A="$A_DIR/$(basename "$A")"
case "$A" in "$TARGET"/*|"$STATE"/*) die "归档不能在待恢复目标内" ;; esac
cleanup() {
  nc_rc=$?; trap - EXIT INT TERM
  if [ "$SWITCHING" = 1 ]; then
    # 子 shell 的失败不清理唯一材料，保留原退出码及明确恢复位置。
    ( recover_record ) || { echo "回退未完成：旧=$OLD 新=$STAGE/data 记录=$STATE" >&2; exit 1; }
  elif [ -n "$STAGE" ]; then rm -rf "$STAGE"; [ "$OWN_STATE" = 0 ] || rm -rf "$STATE"; fi
  exit "$nc_rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
sh "$HERE/verify-backup.sh" "$A" || die "备份校验没通过，目标未改动"
STAGE=$(mktemp -d "$PARENT/.nocturne-restore.XXXXXX")
tar -xzf "$A" -C "$STAGE" || die "解压失败，目标未改动"
n=0
while IFS= read -r line; do
  h=${line%%  *}; f=${line#*  }; got=$(hash_of "$STAGE/$f") || die "二次读取失败，目标未改动"
  [ "$got" = "$h" ] || die "二次 sha256 不一致，目标未改动"; n=$((n + 1))
done < "$STAGE/SHA256SUMS"
[ -d "$STAGE/data" ] || mkdir "$STAGE/data"
chmod 700 "$STAGE/data"
OLD="$TARGET.before-restore-$(date +%Y%m%d-%H%M%S)-$(basename "$STAGE")"
[ ! -e "$OLD" ] && [ ! -L "$OLD" ] || die "旧目录保存名称冲突"
OLD_ID=none; [ ! -d "$TARGET" ] || OLD_ID=$(inode_of "$TARGET")
NEW_ID=$(inode_of "$STAGE/data")
mkdir "$STATE" || die "恢复记录已存在，拒绝覆盖"
OWN_STATE=1
# 没有 READY 的不完整记录永远不能触发目标切换。
printf '%s\n' "$TARGET" > "$STATE/TARGET"
printf '%s\n' "$STAGE" > "$STATE/STAGE"
printf '%s\n' "$OLD" > "$STATE/OLD"
printf '%s\n' "$OLD_ID" > "$STATE/OLD-ID"
printf '%s\n' "$NEW_ID" > "$STATE/NEW-ID"
printf '%s\n' ready > "$STATE/READY"
sync || die "记录同步失败，目标未改动"
SWITCHING=1
[ "$OLD_ID" = none ] || { mv "$TARGET" "$OLD" || die "旧目录移动失败"; sync || die "旧目录同步失败"; }
[ ! -e "$TARGET" ] || die "目标出现冲突"
mv "$STAGE/data" "$TARGET" || die "新目录放置失败"
sync || die "新目录同步失败，材料保留"
cp "$STAGE/BACKUP-INFO.txt" "$TARGET.restored-from.txt" || die "恢复信息保存失败，已验证目录保留"
finish_record
trap - EXIT INT TERM
echo "恢复完成：$TARGET（$n 个文件 sha256 一致）"
echo "原目录保留：$OLD"
