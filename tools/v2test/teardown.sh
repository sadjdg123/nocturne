#!/bin/sh
# 夜曲 Nocturne · 删除 V2 RC 并行测试环境（群晖 SSH 里 sudo 运行；POSIX sh）
#
# 用法：sudo sh tools/v2test/teardown.sh [--test-root DIR] [--keep-backups] [--remove-image] [--yes]
#   只删除：容器 nocturne-v2test（必须带本套件的标签）、它的 compose 网络、测试目录（必须有 .nocturne-v2test 标记）。
#   --keep-backups  保留 <测试目录>/backups/（里面的备份含密码哈希与会话，请放在只有你能读的地方）
#   --remove-image  同时删除 RC 镜像（没有其他容器在用它时）
#   --yes           不询问
#   生产容器、生产 data、生产 compose 一概不碰；删除前后核对生产容器没有被停止 / 重启。
# shellcheck disable=SC2015,SC2016,SC2012,SC2153 # pass/ok/note 总是返回 0；{{…}} 是 docker 模板不是 shell 变量；LAN_IP 等来自 state.env
set -eu
umask 077
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=tools/v2test/lib.sh
. "$HERE/lib.sh"

ROOT_ARG=$DEFAULT_TEST_ROOT; KEEP_BACKUPS=0; RM_IMAGE=0; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --test-root) [ $# -ge 2 ] || die "$1 需要参数"; ROOT_ARG=$2; shift 2 ;;
    --keep-backups) KEEP_BACKUPS=1; shift ;;
    --remove-image) RM_IMAGE=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "不认识的参数 $1" ;;
  esac
done
need_root
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
ROOT=$(canon_path "$ROOT_ARG")
case "$ROOT" in ""|/|/volume[0-9]|/volume[0-9]/docker) die "拒绝删除 ${ROOT:-/}" ;; esac
HAVE_DIR=0; [ -d "$ROOT" ] && HAVE_DIR=1
if [ "$HAVE_DIR" = 1 ]; then
  [ -f "$ROOT/$MARKER" ] || die "$ROOT 没有 $MARKER 标记，不是本套件创建的目录，拒绝删除"
fi
PROD_CONTAINER=$DEFAULT_PROD_CONTAINER; PROD_DATA=""
# shellcheck disable=SC1091
[ -f "$ROOT/.v2test/state.env" ] && . "$ROOT/.v2test/state.env"
# 安全核对：测试目录不能与生产 data 重叠（state 里没有时从生产容器检测）
[ -n "$PROD_DATA" ] || PROD_DATA=$(mount_source_of "$PROD_CONTAINER" || :)
if [ -n "$PROD_DATA" ]; then
  PROD_DATA=$(canon_path "$PROD_DATA")
  paths_overlap "$ROOT" "$PROD_DATA" && die "$ROOT 与生产 data $PROD_DATA 重叠，拒绝删除"
fi
HAVE_CT=0
if container_exists "$TEST_NAME"; then
  is_ours "$TEST_NAME" || die "容器 $TEST_NAME 不是本套件创建的（没有 $OUR_LABEL 标签），不会删除它"
  MSRC=$(mount_source_of "$TEST_NAME" || :)
  if [ -n "$MSRC" ] && [ -n "$PROD_DATA" ] && paths_overlap "$(canon_path "$MSRC")" "$PROD_DATA"; then die "容器 $TEST_NAME 挂载了生产 data？拒绝操作，请人工检查"; fi
  HAVE_CT=1
fi
[ "$HAVE_CT" = 1 ] || [ "$HAVE_DIR" = 1 ] || { say "没有找到测试容器或测试目录，无需删除"; exit 0; }
[ "$PROD_CONTAINER" != "$TEST_NAME" ] || die "生产容器名不能是 $TEST_NAME"
PROD_BEFORE=$(state_of "$PROD_CONTAINER" || :)

say "将要删除："
[ "$HAVE_CT" = 1 ] && say "  - 容器 $TEST_NAME（及 compose 网络 ${TEST_NAME}_default）"
if [ "$HAVE_DIR" = 1 ]; then
  if [ "$KEEP_BACKUPS" = 1 ]; then say "  - 目录 $ROOT 里除 backups/ 以外的全部内容（测试数据副本、compose 文件、报告）"
  else say "  - 整个目录 $ROOT（测试数据副本、备份归档、compose 文件、报告）"; fi
fi
[ "$RM_IMAGE" = 1 ] && say "  - 镜像 $IMAGE_REPO@$IMAGE_DIGEST（没有其他容器使用时）"
say "不会动：生产容器 $PROD_CONTAINER、生产 data ${PROD_DATA:-（未检测到）}"
if [ "$ASSUME_YES" != 1 ]; then
  printf '确认删除？输入 yes 回车：'; read -r ans || ans=""
  [ "$ans" = yes ] || { say "已取消"; exit 0; }
fi

if [ "$HAVE_CT" = 1 ]; then
  if [ -f "$ROOT/docker-compose.yml" ]; then compose "$ROOT" down >/dev/null 2>&1 || warn "compose down 失败，改用 docker rm"; fi
  if container_exists "$TEST_NAME"; then is_ours "$TEST_NAME" && docker rm -f "$TEST_NAME" >/dev/null; fi
  container_exists "$TEST_NAME" && die "容器 $TEST_NAME 没能删除"
  ok "容器 $TEST_NAME 已删除"
fi
NET="${TEST_NAME}_default"
if docker network inspect "$NET" >/dev/null 2>&1; then
  if [ "$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$NET" 2>/dev/null)" = "$TEST_NAME" ]; then
    docker network rm "$NET" >/dev/null 2>&1 && ok "网络 $NET 已删除" || warn "网络 $NET 没能删除（可能还有容器在用）"
  fi
fi
if [ "$HAVE_DIR" = 1 ]; then
  if [ "$KEEP_BACKUPS" = 1 ]; then
    for e in "$ROOT"/* "$ROOT"/.[!.]*; do
      [ -e "$e" ] || continue
      [ "$e" = "$ROOT/backups" ] && continue
      [ "$e" = "$ROOT/$MARKER" ] && continue
      rm -rf "$e"
    done
    ok "已删除测试数据等，保留 $ROOT/backups 与标记文件"
  else
    rm -rf "$ROOT"
    ok "目录 $ROOT 已删除"
  fi
fi
if [ "$RM_IMAGE" = 1 ]; then
  if docker ps -a --format '{{.Image}}' | grep -q "$IMAGE_DIGEST\|$IMAGE_TAG"; then warn "还有容器在用 RC 镜像，没有删除镜像"
  else docker image rm "$IMAGE_REPO@$IMAGE_DIGEST" >/dev/null 2>&1 && ok "RC 镜像已删除" || warn "RC 镜像没能删除"; fi
fi
PROD_AFTER=$(state_of "$PROD_CONTAINER" || :)
if [ -n "$PROD_BEFORE" ] && [ "${PROD_BEFORE%|*}" = "${PROD_AFTER%|*}" ]; then ok "生产容器 $PROD_CONTAINER 未被停止 / 重启"
elif [ -n "$PROD_BEFORE" ]; then warn "生产容器状态有变化（本脚本没有对它执行任何操作）"; fi
say "完成。"
