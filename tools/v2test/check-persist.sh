#!/bin/sh
# 夜曲 Nocturne · V2 RC 测试容器持久化检查（在 deploy.sh 之后运行；群晖 SSH 里 sudo 运行；POSIX sh）
#
# 用法：sudo sh tools/v2test/check-persist.sh [--test-root DIR] [--no-edit-check]
#   先由你在测试站登录、改一处配置（例如改一个项目名称）并保存，再运行本脚本。它会：
#   1. 确认测试副本里的配置相对部署时确实被改过（--no-edit-check 跳过这一步）
#   2. 记下配置文件的 sha256，只重启 nocturne-v2test（生产容器不碰）
#   3. 重启后核对：配置 sha256 与版本号不变、/api/health 正常、容器 healthy、生产容器未被重启、生产 data 未改动
#   4. 写报告 <测试目录>/v2test-report-<时间>.txt（不含密码 / 哈希 / 会话 / 配置内容）
# shellcheck disable=SC2015,SC2016,SC2012,SC2153 # pass/ok/note 总是返回 0；{{…}} 是 docker 模板不是 shell 变量；LAN_IP 等来自 state.env
set -eu
umask 077
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=tools/v2test/lib.sh
. "$HERE/lib.sh"

ROOT_ARG=$DEFAULT_TEST_ROOT; EDIT_CHECK=1
WAIT_SECS=${V2TEST_WAIT_SECS:-150}
while [ $# -gt 0 ]; do
  case "$1" in
    --test-root) [ $# -ge 2 ] || die "$1 需要参数"; ROOT_ARG=$2; shift 2 ;;
    --no-edit-check) EDIT_CHECK=0; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "不认识的参数 $1" ;;
  esac
done
need_root
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
load_state "$(canon_path "$ROOT_ARG")"
[ -f "$TEST_ROOT/$MARKER" ] || die "$TEST_ROOT 不是本套件创建的目录"
TS=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/nocturne-v2persist.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
FAILS=0; WARNS=0; : > "$WORK/report"
rep() { printf '%s\n' "$*" >> "$WORK/report"; }
fail() { printf '  [失败] %s\n' "$*"; FAILS=$((FAILS + 1)); rep "  [失败] $*"; }
pass() { ok "$*"; rep "  [通过] $*"; }
note() { warn "$*"; WARNS=$((WARNS + 1)); rep "  [注意] $*"; }

say "夜曲 Nocturne · V2 RC 持久化检查（套件 v$KIT_VERSION）"
step "1/4 确认测试容器"
container_exists "$TEST_NAME" || die "找不到容器 $TEST_NAME（先运行 deploy.sh）"
is_ours "$TEST_NAME" || die "容器 $TEST_NAME 不是本套件创建的，不会重启它"
MSRC=$(mount_source_of "$TEST_NAME" || :)
[ -n "$MSRC" ] && [ "$(canon_path "$MSRC")" = "$TEST_DATA" ] || die "$TEST_NAME 的 /data 挂载（${MSRC:-无}）不是 $TEST_DATA，拒绝继续"
PROD_BEFORE=$(state_of "$PROD_CONTAINER" || :)
T_BEFORE=$(state_of "$TEST_NAME")
pass "$TEST_NAME 是本套件的容器，数据 $TEST_DATA"

hashes() { ( cd "$TEST_DATA" && for f in config/*.json; do [ -f "$f" ] && printf '%s  %s\n' "$(hash_of "$f")" "$f"; done ) || :; }
versions() { for f in "$TEST_DATA"/config/*.json; do [ -f "$f" ] && printf '%s %s\n' "${f#"$TEST_DATA"/}" "$(sed -n 's/^  "version": \([0-9]*\),*$/\1/p' "$f" | head -n 1)"; done || :; }
nsessions() { _n=0; [ -f "$TEST_DATA/sessions.json" ] && _n=$(grep -c '"user":' "$TEST_DATA/sessions.json" || :); echo "${_n:-0}"; }

step "2/4 确认你已经在测试站改过配置"
sleep "${V2TEST_SETTLE:-3}" # 让正在进行的写入（会话保存有 2 秒延迟）落盘
hashes > "$WORK/h1"; versions > "$WORK/v1"; S1=$(nsessions)
NCFG=$(wc -l < "$WORK/h1" | tr -d ' ')
[ "$NCFG" -gt 0 ] || die "测试副本里没有任何配置文件（config/*.json）。请先在测试站登录并保存一次配置"
CHANGED=0
if [ -f "$TEST_ROOT/.v2test/config-baseline" ]; then
  CHANGED=$(LC_ALL=C comm -13 "$TEST_ROOT/.v2test/config-baseline" "$WORK/h1" | wc -l | tr -d ' ')
fi
if [ "$EDIT_CHECK" = 1 ]; then
  if [ "$CHANGED" = 0 ]; then
    say "  还没有检测到配置修改。请在测试站（${URL_MAIN:-http://<NAS>:8089}，Safari 无痕窗口）登录，改一处配置并保存，再运行本脚本。"
    exit 2
  fi
  pass "检测到 $CHANGED 个配置文件相对部署时有修改（共 $NCFG 个）"
else note "跳过了修改检查（--no-edit-check）；有修改的配置文件 $CHANGED 个"; fi
[ "$S1" -gt 0 ] && pass "测试站当前有 $S1 个登录会话（你已登录）" || note "测试站当前没有登录会话"

step "3/4 只重启 $TEST_NAME"
[ "$TEST_NAME" = nocturne-v2test ] || die "内部错误：容器名不对"
docker restart "$TEST_NAME" >/dev/null || die "docker restart $TEST_NAME 失败"
HEALTH_URL="http://$LAN_IP:$PORT/api/health"
wait_healthy "$TEST_NAME" "$HEALTH_URL" "$WAIT_SECS" || true

step "4/4 重启后检查"
T_AFTER=$(state_of "$TEST_NAME" || :)
if [ "$(printf '%s' "$T_AFTER" | cut -d'|' -f2)" != "$(printf '%s' "$T_BEFORE" | cut -d'|' -f2)" ]; then pass "$TEST_NAME 已重启（启动时间已更新）"; else fail "$TEST_NAME 的启动时间没变，重启似乎没有发生"; fi
case "$T_AFTER" in running*\|healthy) pass "容器状态 running / healthy" ;; *) fail "容器状态：$(printf '%s' "$T_AFTER" | cut -d'|' -f1) / 健康 $(printf '%s' "$T_AFTER" | cut -d'|' -f4)" ;; esac
HEALTH=$(http_get "$HEALTH_URL" || :)
H_OK=$(printf '%s' "$HEALTH" | json_raw ok); H_VER=$(printf '%s' "$HEALTH" | json_str version); H_AUTH=$(printf '%s' "$HEALTH" | json_raw auth)
[ "$H_OK" = true ] && [ "$H_VER" = "$EXPECT_VERSION" ] && [ "$H_AUTH" = true ] && pass "/api/health ok，version $H_VER，auth=true" || fail "/api/health 异常（ok=${H_OK:-无响应} version=${H_VER:-?} auth=${H_AUTH:-?}）"
sleep 1
hashes > "$WORK/h2"; versions > "$WORK/v2"; S2=$(nsessions)
if cmp -s "$WORK/h1" "$WORK/h2"; then pass "重启前后 $NCFG 个配置文件 sha256 完全一致（你的修改已保留）"; else fail "重启后配置文件 sha256 变了（$(LC_ALL=C comm -3 "$WORK/h1" "$WORK/h2" | wc -l | tr -d ' ') 行不同）"; fi
cmp -s "$WORK/v1" "$WORK/v2" && pass "配置版本号不变（$(cut -d' ' -f2 "$WORK/v2" | tr '\n' ' ' | sed 's/ $//')）" || fail "配置版本号变了"
[ "$S2" -ge "$S1" ] && [ "$S1" -gt 0 ] && pass "登录会话重启后仍在（$S2 个）" || note "会话数：重启前 $S1 / 重启后 $S2"
PROD_AFTER=$(state_of "$PROD_CONTAINER" || :)
[ "${PROD_BEFORE%|*}" = "${PROD_AFTER%|*}" ] && pass "生产容器 $PROD_CONTAINER 未被停止 / 重启" || fail "生产容器状态有变化（本脚本没有对它执行任何操作）"
if [ -f "$TEST_ROOT/.v2test/prod-before.manifest" ]; then
  manifest "$PROD_DATA" "$WORK/prod-now.manifest"
  compare_manifests "$TEST_ROOT/.v2test/prod-before.manifest" "$WORK/prod-now.manifest"
  if [ "$CHANGED_TOTAL" = 0 ]; then pass "生产 data 与部署前完全一致"
  elif [ "$CHANGED_DATA" = 0 ]; then note "生产 data 只有运行时文件变化 $CHANGED_RUNTIME 个（会话 / 缓存，正常使用）"
  else note "生产 data 有 $CHANGED_DATA 个持久文件变化（目录：$CHANGED_DIRS）——是否有人在生产站保存过配置？"; fi
fi
docker logs --since 5m "$TEST_NAME" > "$WORK/logs.out" 2>&1 || :
grep -Ei 'error|exception|EACCES|EPERM|ENOSPC|EROFS|denied|warn:|failed|无法' "$WORK/logs.out" | grep -v 'login failed' | sanitize | head -n 20 > "$WORK/logerr" || :
NERR=$(wc -l < "$WORK/logerr" | tr -d ' ')
[ "$NERR" = 0 ] && pass "重启后日志没有错误行" || note "日志里有 $NERR 行可疑内容（已脱敏，见报告）"

REPORT="$TEST_ROOT/v2test-report-$TS.txt"
{
  say "夜曲 Nocturne · V2 RC 持久化检查报告（check-persist.sh，套件 v$KIT_VERSION）"
  say "时间：$(date '+%Y-%m-%d %H:%M:%S %z')    结果：$([ "$FAILS" = 0 ] && echo 通过 || echo "未通过（$FAILS 项失败）")，注意 $WARNS 项"
  say "（不含密码、哈希、会话、令牌或配置内容）"
  say "测试容器：$TEST_NAME，数据 $TEST_DATA，端口 $LAN_IP:$PORT；部署于 $DEPLOY_TS"
  say "/api/health：ok=$H_OK version=$H_VER auth=$H_AUTH"
  cat "$WORK/report"
  if [ "$NERR" != 0 ]; then say ""; say "== 日志可疑行（脱敏）"; cat "$WORK/logerr"; fi
} > "$REPORT"
chmod 600 "$REPORT"
say ""
if [ "$FAILS" = 0 ]; then say "持久化检查通过。"; else say "持久化检查有 $FAILS 项失败。"; fi
say "报告：$REPORT（可直接贴回）"
[ "$FAILS" = 0 ]
