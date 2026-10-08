#!/bin/sh
# 夜曲 Nocturne · 校验 backup.sh 生成的备份（POSIX sh）
#
# 用法：sh verify-backup.sh [--quiet] [--no-sidecar] <nocturne-backup-….tar.gz>
#   1. 有同名 .sha256 文件时先核对归档本身（--no-sidecar 跳过；没有该文件时给出警告）
#   2. gzip 完整性；归档里不许有绝对路径、..、data/ 以外的条目
#   3. 解到临时目录，逐个核对 SHA256SUMS；清单里的文件一个不少、归档里没有清单外的文件
# 退出码：0 = 完好；1 = 损坏 / 不完整；2 = 用法错误。不打印任何文件内容。
set -eu
umask 077
LC_ALL=C; export LC_ALL
QUIET=0; SIDECAR=1; A=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    --no-sidecar) SIDECAR=0; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的选项 $1" >&2; exit 2 ;;
    *) A=$1; shift ;;
  esac
done
[ -n "$A" ] || { echo "用法：sh verify-backup.sh <备份.tar.gz>" >&2; exit 2; }
[ -f "$A" ] || { echo "错误：找不到 $A" >&2; exit 2; }
say() { [ "$QUIET" = 1 ] || echo "$*"; }
bad() { echo "校验失败：$*" >&2; exit 1; }
hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r "$1" | cut -d' ' -f1; fi
}

if [ "$SIDECAR" = 1 ]; then
  if [ -f "$A.sha256" ]; then
    want=$(cut -d' ' -f1 < "$A.sha256"); got=$(hash_of "$A")
    [ "$want" = "$got" ] || bad "归档的 sha256 与 $(basename "$A").sha256 不一致（文件被改动或传输损坏）"
    say "归档 sha256 一致"
  else
    echo "警告：没有 $(basename "$A").sha256，跳过归档整体校验（仍会逐个核对文件）" >&2
  fi
fi
gzip -t "$A" 2>/dev/null || bad "gzip 数据损坏"

T=$(mktemp -d "${TMPDIR:-/tmp}/nocturne-verify.XXXXXX")
trap 'rm -rf "$T"' EXIT
trap 'exit 130' INT TERM
tar -tzf "$A" > "$T/entries" 2>/dev/null || bad "无法读取归档目录"
while IFS= read -r e; do
  case "$e" in
    /*|../*|*/../*|*/..) bad "归档里有不安全的路径：$e" ;;
    SHA256SUMS|BACKUP-INFO.txt|data|data/|data/*) ;;
    *) bad "归档里有意外的条目：$e" ;;
  esac
done < "$T/entries"
mkdir "$T/x"
tar -xzf "$A" -C "$T/x" 2>/dev/null || bad "解压失败"
[ -f "$T/x/SHA256SUMS" ] || bad "缺少 SHA256SUMS"
[ -f "$T/x/BACKUP-INFO.txt" ] || bad "缺少 BACKUP-INFO.txt"
grep -q '^app=nocturne$' "$T/x/BACKUP-INFO.txt" || bad "BACKUP-INFO.txt 不是夜曲的备份"
n=0
while IFS= read -r line; do
  h=${line%%  *}; f=${line#*  }
  case "$f" in data/*) ;; *) bad "SHA256SUMS 里有 data/ 以外的路径" ;; esac
  [ -f "$T/x/$f" ] || bad "缺少文件 $f"
  [ "$(hash_of "$T/x/$f")" = "$h" ] || bad "sha256 不一致：$f"
  n=$((n + 1))
done < "$T/x/SHA256SUMS"
( cd "$T/x" && { [ -d data ] && find data -type f | sort || :; } ) > "$T/have"
cut -d' ' -f3- "$T/x/SHA256SUMS" | sort > "$T/want"
cmp -s "$T/have" "$T/want" || bad "归档里有清单之外的文件"
want=$(sed -n 's/^files=//p' "$T/x/BACKUP-INFO.txt")
[ "$want" = "$n" ] || bad "文件数与 BACKUP-INFO.txt 不符（$n / $want）"
say "备份完好：$n 个文件 sha256 全部一致（$(sed -n 's/^created=//p' "$T/x/BACKUP-INFO.txt")）"
exit 0
