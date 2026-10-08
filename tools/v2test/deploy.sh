#!/bin/sh
# 夜曲 Nocturne · V2 RC 并行测试容器一键部署（群晖 DSM 7，SSH 里 sudo 运行；POSIX sh）
#
# 用法：sudo sh tools/v2test/deploy.sh [选项]
#   --prod-container NAME  生产容器名（默认 nocturne）。只读取它的信息，绝不停止 / 重启它
#   --prod-data DIR        生产 data 目录（默认从 docker inspect 生产容器的 /data 挂载自动检测；
#                          检测不到才用 /volume1/docker/nocturne/data）。指定了但与检测结果不同 → 拒绝
#   --test-root DIR        测试项目目录（默认 /volume1/docker/nocturne-v2test）；测试数据固定在 <DIR>/data
#   --port N               测试端口（默认 8089）
#   --lan-ip IP            绑定的内网 IP（默认自动检测默认路由网卡的 RFC1918 地址）
#   --backup-dir DIR       备份放哪（默认 <测试目录>/backups）
#   --from-backup FILE     不做热备份，改用一份已有的 backup.sh 备份（仍会完整校验）
#   --prod-opened-by ip|name  你平时怎么打开生产站：ip（默认，如 http://192.168.x.x:8088）或 name（<主机名>.local / 域名）
#                          只影响推荐的测试网址：测试站必须用和生产站不同的「主机名」打开
#   --yes                  不询问，直接执行
#   --dry-run              只做预检，不做任何改动
#   -h, --help
#
# 它会做：预检（路径隔离、8089 空闲、容器名、内网 IP）→ 拉取并核对固定镜像 digest → 生产 data 清单（之前）
#   → 热备份（不停生产容器）→ 校验备份 → 恢复到测试目录 → 只在副本里清空会话与已知设备 → 启动 nocturne-v2test
#   → 启动后检查 → 生产 data 清单（之后）对比 → 写报告 <测试目录>/v2test-report-<时间>.txt（可直接贴回给我）
# 它不会：停止 / 重启生产容器、挂载或修改生产 data、改生产 compose / 反向代理 / Cloudflare / 路由器、挂 docker.sock、关闭登录。
# shellcheck disable=SC2015,SC2016,SC2012,SC2153 # pass/ok/note 总是返回 0；{{…}} 是 docker 模板不是 shell 变量；LAN_IP 等来自 state.env
set -eu
umask 077
HERE=$(cd "$(dirname "$0")" && pwd -P)
TOOLS=$(cd "$HERE/.." && pwd -P)
# shellcheck source=tools/v2test/lib.sh
. "$HERE/lib.sh"

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
PROD_CONTAINER=$DEFAULT_PROD_CONTAINER; PROD_DATA_ARG=""; TEST_ROOT=$DEFAULT_TEST_ROOT; PORT=$DEFAULT_PORT; LAN_IP_ARG=""
BACKUP_DIR=""; FROM_BACKUP=""; PROD_OPENED_BY=ip; ASSUME_YES=0; DRY_RUN=0
WAIT_SECS=${V2TEST_WAIT_SECS:-150}
while [ $# -gt 0 ]; do
  case "$1" in
    --prod-container) [ $# -ge 2 ] || die "$1 需要参数"; PROD_CONTAINER=$2; shift 2 ;;
    --prod-data) [ $# -ge 2 ] || die "$1 需要参数"; PROD_DATA_ARG=$2; shift 2 ;;
    --test-root) [ $# -ge 2 ] || die "$1 需要参数"; TEST_ROOT=$2; shift 2 ;;
    --port) [ $# -ge 2 ] || die "$1 需要参数"; PORT=$2; shift 2 ;;
    --lan-ip) [ $# -ge 2 ] || die "$1 需要参数"; LAN_IP_ARG=$2; shift 2 ;;
    --backup-dir) [ $# -ge 2 ] || die "$1 需要参数"; BACKUP_DIR=$2; shift 2 ;;
    --from-backup) [ $# -ge 2 ] || die "$1 需要参数"; FROM_BACKUP=$2; shift 2 ;;
    --prod-opened-by) [ $# -ge 2 ] || die "$1 需要参数"; PROD_OPENED_BY=$2; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "不认识的参数 $1（--help 查看用法）" ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) die "--port 必须是数字" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port 超出范围"
case "$PROD_OPENED_BY" in ip|name) ;; *) die "--prod-opened-by 只能是 ip 或 name" ;; esac

need_root
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令（群晖请安装 Container Manager，并用 sudo 运行）"
for f in backup.sh verify-backup.sh restore.sh; do [ -f "$TOOLS/$f" ] || die "缺少 $TOOLS/$f（请把整个 tools/ 目录一起放到 NAS 上）"; done
for c in tar gzip find awk sed sort comm; do command -v "$c" >/dev/null 2>&1 || die "缺少命令 $c"; done

TS=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/nocturne-v2test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM
FAILS=0; WARNS=0
: > "$WORK/report"
rep() { printf '%s\n' "$*" >> "$WORK/report"; }
fail() { printf '  [失败] %s\n' "$*"; FAILS=$((FAILS + 1)); rep "  [失败] $*"; }
pass() { ok "$*"; rep "  [通过] $*"; }
note() { warn "$*"; WARNS=$((WARNS + 1)); rep "  [注意] $*"; }

say "夜曲 Nocturne · V2 RC 并行测试部署（套件 v$KIT_VERSION）"
docker version >/dev/null 2>&1 || die "docker 无法使用（是否用了 sudo？Container Manager 是否在运行？）"

# ------------------------------------------------------------------ 1. 预检
step "1/9 预检"
container_exists "$PROD_CONTAINER" || die "找不到生产容器 $PROD_CONTAINER（用 --prod-container 指定正确的名字）"
[ "$PROD_CONTAINER" != "$TEST_NAME" ] || die "生产容器名不能是 $TEST_NAME"
PROD_STATE_BEFORE=$(state_of "$PROD_CONTAINER")
PROD_IMAGE=$(cinspect "$PROD_CONTAINER" '{{.Config.Image}}')
PROD_PROJECT=$(label_of "$PROD_CONTAINER" com.docker.compose.project || :)
PROD_WORKDIR=$(label_of "$PROD_CONTAINER" com.docker.compose.project.working_dir || :)
[ "$PROD_PROJECT" != "$TEST_NAME" ] || die "生产容器属于 compose 项目 $TEST_NAME —— 与测试项目同名，拒绝继续"
DETECTED=$(mount_source_of "$PROD_CONTAINER" || :)
if [ -n "$DETECTED" ]; then
  DETECTED=$(canon_path "$DETECTED")
  if [ -n "$PROD_DATA_ARG" ] && [ "$(canon_path "$PROD_DATA_ARG")" != "$DETECTED" ]; then
    die "--prod-data $PROD_DATA_ARG 与生产容器实际挂载的 $DETECTED 不一致，拒绝继续"
  fi
  PROD_DATA=$DETECTED; PROD_DATA_FROM="docker inspect $PROD_CONTAINER"
else
  PROD_DATA=$(canon_path "${PROD_DATA_ARG:-$DEFAULT_PROD_DATA}"); PROD_DATA_FROM="参数 / 默认值（容器没有 /data 挂载信息）"
  warn "没能从 docker inspect 读到 $PROD_CONTAINER 的 /data 挂载，改用 $PROD_DATA"
fi
[ -d "$PROD_DATA" ] || die "生产 data 目录不存在：$PROD_DATA"
[ -f "$PROD_DATA/users.json" ] || [ -d "$PROD_DATA/config" ] || die "$PROD_DATA 看起来不是夜曲的 data 目录"
say "  生产容器：$PROD_CONTAINER（${PROD_STATE_BEFORE%%|*}），镜像 $PROD_IMAGE"
say "  生产 data：$PROD_DATA（来自 $PROD_DATA_FROM）—— 只读，不挂载、不修改"

PUID=$(env_of "$PROD_CONTAINER" | sed -n 's/^PUID=//p' | tail -n 1); PGID=$(env_of "$PROD_CONTAINER" | sed -n 's/^PGID=//p' | tail -n 1)
IDS_FROM="生产容器环境变量"
case "$PUID$PGID" in ''|*[!0-9]*)
  PUID=$(stat -c %u "$PROD_DATA" 2>/dev/null || ls -nd "$PROD_DATA" | awk '{print $3}')
  PGID=$(stat -c %g "$PROD_DATA" 2>/dev/null || ls -nd "$PROD_DATA" | awk '{print $4}')
  IDS_FROM="生产 data 目录属主" ;;
esac
case "$PUID$PGID" in ''|*[!0-9]*) die "无法确定 PUID / PGID" ;; esac
[ "$PUID" != 0 ] || die "PUID=0（root）不受支持；请在生产容器里设置 PUID / PGID 后再试"
say "  PUID/PGID：$PUID/$PGID（来自 $IDS_FROM）"

TEST_ROOT=$(canon_path "$TEST_ROOT")
TEST_DATA="$TEST_ROOT/data"
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$TEST_ROOT/backups"
BACKUP_DIR=$(canon_path "$BACKUP_DIR")
case "$TEST_ROOT" in ""|/|/volume[0-9]|/volume[0-9]/docker) die "测试目录不能是 ${TEST_ROOT:-/}" ;; esac
[ "$TEST_DATA" != "$PROD_DATA" ] || die "测试数据路径与生产数据路径相同（$PROD_DATA），拒绝继续"
path_inside "$TEST_DATA" "$PROD_DATA" && die "测试数据路径 $TEST_DATA 在生产数据目录 $PROD_DATA 里面，拒绝继续"
path_inside "$PROD_DATA" "$TEST_DATA" && die "生产数据目录 $PROD_DATA 在测试数据路径 $TEST_DATA 里面，拒绝继续"
paths_overlap "$TEST_ROOT" "$PROD_DATA" && die "测试目录 $TEST_ROOT 与生产数据目录 $PROD_DATA 互相包含，拒绝继续"
[ "$TEST_ROOT" != "$(dirname "$PROD_DATA")" ] || die "测试目录不能是生产项目目录 $(dirname "$PROD_DATA")（那里有生产的 compose 文件）"
[ -z "$PROD_WORKDIR" ] || [ "$TEST_ROOT" != "$(canon_path "$PROD_WORKDIR")" ] || die "测试目录不能是生产 compose 项目目录 $PROD_WORKDIR"
paths_overlap "$BACKUP_DIR" "$PROD_DATA" && die "备份目录 $BACKUP_DIR 与生产数据目录重叠，拒绝继续"
paths_overlap "$BACKUP_DIR" "$TEST_DATA" && die "备份目录不能与测试数据目录重叠"
if [ -d "$TEST_ROOT" ] && [ -n "$(ls -A "$TEST_ROOT" 2>/dev/null)" ]; then
  [ -f "$TEST_ROOT/$MARKER" ] || die "$TEST_ROOT 已存在且不是本套件创建的（没有 $MARKER 标记），拒绝使用"
  if [ -d "$TEST_DATA" ] && [ -n "$(ls -A "$TEST_DATA" 2>/dev/null)" ]; then
    die "$TEST_DATA 里已经有测试数据（之前部署过）。要重新部署请先运行：sudo sh $HERE/teardown.sh"
  fi
fi
say "  测试目录：$TEST_ROOT（数据 $TEST_DATA）"
pass "路径隔离：测试数据与生产数据互不包含"

if container_exists "$TEST_NAME"; then
  if is_ours "$TEST_NAME"; then
    die "已有本套件创建的容器 $TEST_NAME（数据 $(mount_source_of "$TEST_NAME" || echo ?)）。要重新部署请先运行：sudo sh $HERE/teardown.sh"
  fi
  die "已经有一个叫 $TEST_NAME 的容器，但不是本套件创建的（没有 $OUR_LABEL 标签）。不会动它；请先确认它是什么"
fi
pass "容器名 $TEST_NAME 未被占用"

if port_in_use "$PORT"; then die "端口 $PORT 已被占用：$PORT_BUSY_BY。请先释放它，或用 --port 换一个"; fi
case "$PORT_CHECKS" in *ss*|*netstat*) ;; *) warn "没有 ss / netstat，只检查了 docker 容器的端口映射" ;; esac
pass "端口 $PORT 空闲（检查：$PORT_CHECKS）"

if [ -n "$LAN_IP_ARG" ]; then
  LAN_IP=$LAN_IP_ARG; LAN_IF="(--lan-ip)"
else
  detect_lan_ip; LAN_IP=$LAN_IP_FOUND
  [ -n "$LAN_IP" ] || die "检测不到默认路由网卡的 IPv4 地址；请用 --lan-ip 192.168.x.x 指定 NAS 的内网 IP"
fi
is_private_ipv4 "$LAN_IP" || die "$LAN_IP 不是内网地址（10/8、172.16/12、192.168/16）。测试容器只允许绑定内网 IP；请用 --lan-ip 指定"
ip_is_local "$LAN_IP" || die "$LAN_IP 不在本机任何网卡上"
pass "内网 IP $LAN_IP（网卡 $LAN_IF），只绑定 $LAN_IP:$PORT，不开隧道 / 代理 / 路由器端口"

detect_compose
[ -n "$COMPOSE" ] || die "找不到 docker compose / docker-compose（群晖请安装 Container Manager）"
pass "compose 命令：$COMPOSE"

need_kb=$(( $(du -sk "$PROD_DATA" | awk '{print $1}') * 3 + 10240 ))
probe=$TEST_ROOT; while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
free_kb=$(df -Pk "$probe" | awk 'NR==2{print $4}')
[ -z "$free_kb" ] || [ "$free_kb" -ge "$need_kb" ] || die "$probe 所在磁盘空闲 ${free_kb}KB，至少需要约 ${need_kb}KB（备份暂存 + 归档 + 副本）"

HN=$(hostname 2>/dev/null | tr 'A-Z _' 'a-z--' | cut -d. -f1)
printf '%s\n' "$HN" | grep -Eq '^[a-z0-9][a-z0-9-]*$' || HN="<NAS主机名>"
HOSTNAME_LOCAL="$HN.local"
if [ "$PROD_OPENED_BY" = ip ]; then URL_MAIN="http://$HOSTNAME_LOCAL:$PORT"; URL_ALT="http://$LAN_IP:$PORT"
else URL_MAIN="http://$LAN_IP:$PORT"; URL_ALT="http://$HOSTNAME_LOCAL:$PORT"; fi

say ""
say "将要执行："
say "  - 拉取 / 核对镜像 $IMAGE_REF"
if [ -n "$FROM_BACKUP" ]; then say "  - 使用已有备份 $FROM_BACKUP（校验后恢复）"
else say "  - 热备份生产 data 到 $BACKUP_DIR（不停止 $PROD_CONTAINER）"; fi
say "  - 恢复到 $TEST_DATA，只在副本里清空会话与已知设备"
say "  - 在 $TEST_ROOT 新建 compose 项目 $TEST_NAME，端口 $LAN_IP:$PORT → 容器 $CONTAINER_PORT，登录保持开启"
if [ "$DRY_RUN" = 1 ]; then say ""; say "预检通过（--dry-run：没有做任何改动）"; exit 0; fi
if [ "$ASSUME_YES" != 1 ]; then
  printf '继续？输入 y 回车：'; read -r ans || ans=""
  case "$ans" in y|Y|yes|YES) ;; *) say "已取消，未做任何改动"; exit 0 ;; esac
fi

# ------------------------------------------------------------------ 2. 镜像
step "2/9 镜像"
IMAGE_BY_DIGEST="$IMAGE_REPO@$IMAGE_DIGEST"
if docker image inspect "$IMAGE_BY_DIGEST" >/dev/null 2>&1; then
  say "  本机已有该镜像，跳过拉取"
else
  say "  docker pull $IMAGE_REF"
  if ! docker pull "$IMAGE_REF" > "$WORK/pull.out" 2>&1; then
    sanitize < "$WORK/pull.out" | tail -n 5 | sed 's/^/    /'
    if grep -Eqi 'unauthorized|denied|authentication required|no basic auth|403' "$WORK/pull.out"; then
      cat <<EOF

拉取被拒绝：GHCR 上的镜像包可能是私有的，需要先登录（本套件不会保存任何令牌）。
  1. 在 GitHub → Settings → Developer settings → Personal access tokens (classic) 新建一个令牌，只勾选 read:packages，有效期选短一些。
  2. 在 NAS 上运行（用户名是你的 GitHub 用户名；提示 Password 时粘贴令牌，屏幕上不会显示）：
       sudo docker login ghcr.io -u <你的GitHub用户名>
  3. 重新运行本脚本。部署完成后建议注销，免得令牌留在 /root/.docker/config.json：
       sudo docker logout ghcr.io
  不要把令牌写在命令行参数里，也不要贴给我。
EOF
      exit 5
    fi
    die "docker pull 失败（网络？）。上面是脱敏后的最后几行输出"
  fi
fi
DIGESTS=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_BY_DIGEST" 2>/dev/null || :)
if ! printf '%s\n' "$DIGESTS" | grep -qx "$IMAGE_BY_DIGEST"; then
  say "  期望：$IMAGE_BY_DIGEST"
  say "  实际：$(printf '%s' "$DIGESTS" | tr '\n' ' ')"
  die "镜像 RepoDigest 与固定的 digest 不一致，拒绝启动"
fi
IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE_BY_DIGEST")
rep "镜像：$IMAGE_REF"
pass "镜像 RepoDigest = $IMAGE_BY_DIGEST"

# ------------------------------------------------------------------ 3. 生产清单（之前）
step "3/9 生产 data 清单（之前）"
mkdir -p "$TEST_ROOT"; chmod 700 "$TEST_ROOT"
[ -f "$TEST_ROOT/$MARKER" ] || printf 'created=%s\nkit=%s\n' "$TS" "$KIT_VERSION" > "$TEST_ROOT/$MARKER"
mkdir -p "$TEST_ROOT/.v2test"; chmod 700 "$TEST_ROOT/.v2test"
manifest "$PROD_DATA" "$TEST_ROOT/.v2test/prod-before.manifest"
config_stats "$PROD_DATA" > "$TEST_ROOT/.v2test/prod-before.stats"
PROD_FILES=$(wc -l < "$TEST_ROOT/.v2test/prod-before.manifest" | tr -d ' ')
say "  $PROD_FILES 个文件（清单只留在 NAS 上的 $TEST_ROOT/.v2test/，不进报告）"

# ------------------------------------------------------------------ 4. 备份
step "4/9 备份生产 data"
if [ -n "$FROM_BACKUP" ]; then
  ARCHIVE=$(canon_path "$FROM_BACKUP"); [ -f "$ARCHIVE" ] || die "找不到 $ARCHIVE"
  BACKUP_MODE="已有备份（--from-backup）"
else
  BACKUP_MODE="热备份（未停止生产容器）"
  if ! $SUBSH "$TOOLS/backup.sh" -o "$BACKUP_DIR" "$PROD_DATA" > "$WORK/backup.out" 2>&1; then
    sed 's/^/    /' "$WORK/backup.out"
    if grep -q '一直在变' "$WORK/backup.out"; then
      cat <<EOF

热备份没能得到一致的数据：备份期间生产 data 一直在被修改（重试 3 次仍不一致）。
已停止，测试容器没有创建，生产容器没有被停止或重启。可以选择：
  A. 换一个没人使用夜曲的时间，再运行一次本脚本（推荐，仍然不停生产容器）。
  B. 如果你同意让生产容器短暂停止几秒，请【你自己】运行（它会先停止、备份完再启动 $PROD_CONTAINER）：
       sudo sh $TOOLS/backup.sh --stop $PROD_CONTAINER -o $BACKUP_DIR $PROD_DATA
     然后用这份备份继续部署（本脚本仍然不会碰生产容器）：
       sudo sh $0 --from-backup $BACKUP_DIR/nocturne-backup-<时间>.tar.gz
EOF
      exit 4
    fi
    die "备份失败（见上面的输出）。生产容器没有被停止或重启"
  fi
  sed 's/^/    /' "$WORK/backup.out" # backup.sh 只打印路径和计数，从不打印文件内容
  ARCHIVE=$(sed -n 's/^备份完成：//p' "$WORK/backup.out" | tail -n 1)
  [ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || die "找不到 backup.sh 生成的归档"
fi
step "5/9 校验备份"
$SUBSH "$TOOLS/verify-backup.sh" "$ARCHIVE" > "$WORK/verify.out" 2>&1 || { sed 's/^/    /' "$WORK/verify.out"; die "备份校验失败，未恢复"; }
sed 's/^/    /' "$WORK/verify.out"
[ -f "$ARCHIVE.sha256" ] || die "缺少 $ARCHIVE.sha256（备份必须带校验文件）"
ARCHIVE_SHA=$(hash_of "$ARCHIVE")
[ "$ARCHIVE_SHA" = "$(cut -d' ' -f1 < "$ARCHIVE.sha256")" ] || die "归档 sha256 与 .sha256 文件不一致"
BACKUP_FILES=$(tar -xzOf "$ARCHIVE" BACKUP-INFO.txt | sed -n 's/^files=//p')
BACKUP_CREATED=$(tar -xzOf "$ARCHIVE" BACKUP-INFO.txt | sed -n 's/^created=//p')
BACKUP_STOPPED=$(tar -xzOf "$ARCHIVE" BACKUP-INFO.txt | sed -n 's/^container_stopped=//p')
pass "备份校验通过：$BACKUP_FILES 个文件，归档 sha256 一致"

# ------------------------------------------------------------------ 6. 恢复
step "6/9 恢复到测试目录"
$SUBSH "$TOOLS/restore.sh" "$ARCHIVE" "$TEST_DATA" > "$WORK/restore.out" 2>&1 || { sed 's/^/    /' "$WORK/restore.out"; die "恢复失败"; }
sed 's/^/    /' "$WORK/restore.out"
TEST_DATA=$(canon_path "$TEST_DATA")
RESTORED=$(count_files "$TEST_DATA")
[ "$RESTORED" = "$BACKUP_FILES" ] || fail "恢复后的文件数 $RESTORED 与备份 $BACKUP_FILES 不一致"
pass "恢复完成：$RESTORED 个文件"

# ------------------------------------------------------------------ 7. 只清副本里的会话 / 已知设备
step "7/9 清空副本里的会话与已知设备"
# server.js：会话 = data/sessions.json（{sha256(令牌): {user, created, expires}}，cookie nocturne_sid）；
#           已知设备 = data/users.json 里每个账户的 devices 数组（[{h: sha256(令牌), exp}]，cookie nocturne_dev）。
# 只改这两处，账户 / 密码 / 配置都不动；只输出条数。用固定镜像里的 node 执行（不联网、不挂其他目录）。
SCRUB_JS='const fs=require("fs"),P=require("path"),D=process.env.SCRUB_DIR;
function rd(f){let t;try{t=fs.readFileSync(f,"utf8")}catch(e){if(e.code==="ENOENT")return undefined;throw e}try{return JSON.parse(t)}catch(e){throw new Error("无法解析 "+P.basename(f))}}
function wr(f,o){const st=fs.statSync(f),t=f+".v2test-scrub.tmp";fs.writeFileSync(t,JSON.stringify(o,null,2),{mode:st.mode&0o777});try{fs.chownSync(t,st.uid,st.gid)}catch(e){}fs.renameSync(t,f)}
let s=0,dv=0,du=0,uc=0;const sf=P.join(D,"sessions.json"),uf=P.join(D,"users.json");
const so=rd(sf);if(so!==undefined){if(so&&typeof so==="object"&&!Array.isArray(so))s=Object.keys(so).length;wr(sf,{})}
const uo=rd(uf);if(uo&&Array.isArray(uo.users)){uc=uo.users.length;let ch=false;for(const u of uo.users){if(u&&Array.isArray(u.devices)&&u.devices.length){dv+=u.devices.length;du++;u.devices=[];ch=true}}if(ch)wr(uf,uo)}
const a=rd(sf),b=rd(uf);const left=(a?Object.keys(a).length:0)+((b&&Array.isArray(b.users))?b.users.reduce((n,u)=>n+(u&&Array.isArray(u.devices)?u.devices.length:0),0):0);
console.log("sessions="+s);console.log("devices="+dv);console.log("device_users="+du);console.log("users="+uc);console.log("left="+left);'
docker run --rm --network none --user 0:0 --entrypoint node -e SCRUB_DIR=/data -v "$TEST_DATA:/data" "$IMAGE_BY_DIGEST" -e "$SCRUB_JS" > "$WORK/scrub.out" 2>&1 || { sanitize < "$WORK/scrub.out" | sed 's/^/    /'; die "清理副本失败"; }
SCRUB_SESS=$(sed -n 's/^sessions=//p' "$WORK/scrub.out"); SCRUB_DEV=$(sed -n 's/^devices=//p' "$WORK/scrub.out")
SCRUB_DEVU=$(sed -n 's/^device_users=//p' "$WORK/scrub.out"); SCRUB_USERS=$(sed -n 's/^users=//p' "$WORK/scrub.out")
SCRUB_LEFT=$(sed -n 's/^left=//p' "$WORK/scrub.out")
[ -n "$SCRUB_SESS" ] && [ "$SCRUB_LEFT" = 0 ] || die "清理结果异常（剩余 ${SCRUB_LEFT:-?} 条）"
pass "副本：清除会话 $SCRUB_SESS 条、已知设备 $SCRUB_DEV 条（$SCRUB_DEVU 个账户，共 $SCRUB_USERS 个账户）；生产数据未动"

# ------------------------------------------------------------------ 8. 启动
step "8/9 启动 $TEST_NAME"
cat > "$TEST_ROOT/docker-compose.yml" <<EOF
# 夜曲 Nocturne V2 RC 并行测试（由 tools/v2test/deploy.sh 生成，$TS）。与生产 $PROD_CONTAINER 完全分开：
# 独立项目 / 独立数据副本 / 只绑定内网 IP / 不挂 docker.sock / 登录保持开启。删除：sudo sh tools/v2test/teardown.sh
version: "3.8"
services:
  $TEST_NAME:
    image: $IMAGE_REF
    container_name: $TEST_NAME
    restart: unless-stopped
    ports:
      - "$LAN_IP:$PORT:$CONTAINER_PORT"
    environment:
      - TZ=Asia/Shanghai
      - PUID=$PUID
      - PGID=$PGID
      - NOCTURNE_COOKIE_PREFIX=nocturne_v2test_
    volumes:
      - "$TEST_DATA:/data"
    labels:
      $OUR_LABEL: "$KIT_VERSION"
EOF
STATE_FILE="$TEST_ROOT/.v2test/state.env"
: > "$STATE_FILE"
state_set TEST_ROOT "$TEST_ROOT"; state_set TEST_DATA "$TEST_DATA"; state_set PROD_CONTAINER "$PROD_CONTAINER"; state_set PROD_DATA "$PROD_DATA"
state_set LAN_IP "$LAN_IP"; state_set PORT "$PORT"; state_set ARCHIVE "$ARCHIVE"; state_set BACKUP_DIR "$BACKUP_DIR"; state_set DEPLOY_TS "$TS"
state_set URL_MAIN "$URL_MAIN"; state_set URL_ALT "$URL_ALT"
compose "$TEST_ROOT" up -d > "$WORK/up.out" 2>&1 || { sanitize < "$WORK/up.out" | sed 's/^/    /'; die "compose up 失败"; }
HEALTH_URL="http://$LAN_IP:$PORT/api/health"
say "  等待容器健康（最多 ${WAIT_SECS} 秒；镜像自带健康检查首次在约 30 秒后）…"
wait_healthy "$TEST_NAME" "$HEALTH_URL" "$WAIT_SECS" || true

# ------------------------------------------------------------------ 9. 检查
step "9/9 启动后检查"
rep ""; rep "== 启动后检查"
ST=$(state_of "$TEST_NAME" || :)
case "$ST" in running*\|healthy) pass "容器状态 running / healthy" ;; running*) fail "容器在运行但健康检查不是 healthy（${ST##*|}）" ;; *) fail "容器没有在运行（${ST%%|*}）" ;; esac
HEALTH=$(http_get "$HEALTH_URL" || :)
H_OK=$(printf '%s' "$HEALTH" | json_raw ok); H_VER=$(printf '%s' "$HEALTH" | json_str version); H_AUTH=$(printf '%s' "$HEALTH" | json_raw auth)
if [ "$H_OK" = true ] && [ "$H_VER" = "$EXPECT_VERSION" ]; then pass "/api/health ok，version $H_VER"; else fail "/api/health 异常（ok=${H_OK:-无响应} version=${H_VER:-?}）"; fi
[ "$H_AUTH" = true ] && pass "登录保持开启（auth=true）" || fail "auth 不是 true（$H_AUTH）"
if env_of "$TEST_NAME" | grep -q '^NOCTURNE_NO_AUTH='; then fail "容器里有 NOCTURNE_NO_AUTH"; fi
MOUNTS=$(cinspect "$TEST_NAME" '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}};{{end}}' | tr ';' '\n' | sed '/^$/d')
NM=$(printf '%s\n' "$MOUNTS" | sed '/^$/d' | wc -l | tr -d ' ')
MSRC=$(printf '%s\n' "$MOUNTS" | awk -F'|' '$3=="/data"{print $2}')
if [ "$NM" = 1 ] && [ -n "$MSRC" ] && [ "$(canon_path "$MSRC")" = "$TEST_DATA" ]; then pass "唯一的挂载：$TEST_DATA → /data（没有 docker.sock，没有生产目录）"
else
  fail "挂载不符合预期：$(printf '%s' "$MOUNTS" | tr '\n' ' ')"
  if printf '%s\n' "$MOUNTS" | awk -F'|' -v p="$PROD_DATA" '$2==p || index($2, p "/")==1 || $2 ~ /docker[.]sock/ {f=1} END{exit !f}'; then docker stop "$TEST_NAME" >/dev/null 2>&1 || :; fail "检测到生产目录或 docker.sock 挂载：已停止测试容器"; fi
fi
BIND=$(cinspect "$TEST_NAME" '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{$p}}={{.HostIp}}:{{.HostPort}};{{end}}{{end}}' | sed 's/;$//')
[ "$BIND" = "$CONTAINER_PORT/tcp=$LAN_IP:$PORT" ] && pass "端口绑定 $LAN_IP:$PORT → $CONTAINER_PORT（只在内网 IP 上）" || fail "端口绑定不符合预期：$BIND"
[ "$(cinspect "$TEST_NAME" '{{.Image}}')" = "$IMAGE_ID" ] && pass "容器使用的就是核对过 digest 的镜像" || fail "容器的镜像 ID 与核对过的镜像不一致"
is_ours "$TEST_NAME" && pass "容器标签：$OUR_LABEL=$KIT_VERSION，compose 项目 $TEST_NAME" || fail "容器标签不对"

docker logs "$TEST_NAME" > "$WORK/logs.out" 2>&1 || :
grep -q "v$EXPECT_VERSION 已启动" "$WORK/logs.out" && pass "启动日志：v$EXPECT_VERSION 已启动，auth=$(sed -n 's/.*auth=\([a-z]*\).*/\1/p' "$WORK/logs.out" | head -n 1)" || fail "日志里没有 v$EXPECT_VERSION 的启动行"
grep -Ei 'error|exception|EACCES|EPERM|ENOSPC|EROFS|denied|warn:|failed|无法' "$WORK/logs.out" | grep -v 'login failed' | sanitize | head -n 20 > "$WORK/logerr" || :
NERR=$(wc -l < "$WORK/logerr" | tr -d ' ')
if [ "$NERR" = 0 ]; then pass "日志扫描：没有错误行"; else note "日志里有 $NERR 行可疑内容（已脱敏，见报告）"; fi
grep -q 'pre-v2 snapshot written' "$WORK/logs.out" && SNAP="已在副本里创建（V1.1 数据首次以 V2 启动）" || SNAP="未创建（数据已是 V2 写过的，或没有配置）"

for d in icons wallpapers config; do
  b=$(tar -tzf "$ARCHIVE" | grep -c "^data/$d/.*[^/]\$" || :); c=$(count_files "$TEST_DATA/$d")
  if [ "$b" = "$c" ]; then pass "$d：副本 $c / 备份 $b"
  elif [ "$c" -gt "$b" ]; then note "$d：副本 $c / 备份 $b（副本多出的可能是 V2 启动时迁移出的文件）"
  else fail "$d：副本 $c / 备份 $b（副本少了文件）"; fi
done

sleep 1
manifest "$PROD_DATA" "$TEST_ROOT/.v2test/prod-after.manifest"
compare_manifests "$TEST_ROOT/.v2test/prod-before.manifest" "$TEST_ROOT/.v2test/prod-after.manifest"
config_stats "$PROD_DATA" > "$TEST_ROOT/.v2test/prod-after.stats"
if [ "$CHANGED_TOTAL" = 0 ]; then pass "生产 data 未改动：$PROD_FILES 个文件 sha256 / 大小 / 修改时间前后一致"
elif [ "$CHANGED_DATA" = 0 ]; then note "生产 data 只有运行时文件变化 $CHANGED_RUNTIME 个（sessions.json / cache，有人在用生产站时正常）；持久数据未改动"
else note "生产 data 有 $CHANGED_DATA 个持久文件变化（目录：$CHANGED_DIRS）。部署期间有人在生产站保存过配置？本脚本没有写生产目录"; fi
cmp -s "$TEST_ROOT/.v2test/prod-before.stats" "$TEST_ROOT/.v2test/prod-after.stats" && pass "生产配置文件（users.json、config/*.json）修改时间与大小未变" || note "生产配置文件的修改时间 / 大小有变化（见上一条）"
PROD_STATE_AFTER=$(state_of "$PROD_CONTAINER" || :)
if [ "${PROD_STATE_BEFORE%|*}" = "${PROD_STATE_AFTER%|*}" ]; then pass "生产容器 $PROD_CONTAINER 未被停止 / 重启（状态、启动时间、重启次数不变）"
else fail "生产容器状态有变化：之前 ${PROD_STATE_BEFORE%|*}，之后 ${PROD_STATE_AFTER%|*}（本脚本没有对它执行任何操作）"; fi

# 给 check-persist.sh 的基线：副本里配置文件的 sha256（只留在 NAS 上）
( cd "$TEST_DATA" && for f in config/*.json; do [ -f "$f" ] && printf '%s  %s\n' "$(hash_of "$f")" "$f"; done ) > "$TEST_ROOT/.v2test/config-baseline" || :

# ------------------------------------------------------------------ 报告
REPORT="$TEST_ROOT/v2test-report-$TS.txt"
{
  say "夜曲 Nocturne · V2 RC 并行测试部署报告（deploy.sh，套件 v$KIT_VERSION）"
  say "时间：$(date '+%Y-%m-%d %H:%M:%S %z')    结果：$([ "$FAILS" = 0 ] && echo 通过 || echo "未通过（$FAILS 项失败）")，注意 $WARNS 项"
  say "（本报告不含密码、密码哈希、会话、令牌或配置内容，可以直接贴回）"
  say ""
  say "镜像：$IMAGE_REF"
  say "  RepoDigest 核对：一致"
  say "生产容器：$PROD_CONTAINER，镜像 $PROD_IMAGE，状态 ${PROD_STATE_AFTER%%|*}"
  say "生产 data：$PROD_DATA（来自 $PROD_DATA_FROM），$PROD_FILES 个文件"
  say "测试容器：$TEST_NAME，compose 项目目录 $TEST_ROOT，数据 $TEST_DATA"
  say "端口：$LAN_IP:$PORT → $CONTAINER_PORT（网卡 $LAN_IF）；PUID/PGID $PUID/$PGID（来自 $IDS_FROM）；compose：$COMPOSE"
  say "备份：$BACKUP_MODE，$(basename "$ARCHIVE")，$BACKUP_FILES 个文件，创建于 $BACKUP_CREATED，停容器：$BACKUP_STOPPED"
  say "  归档 sha256：$ARCHIVE_SHA"
  say "副本清理：会话 $SCRUB_SESS 条、已知设备 $SCRUB_DEV 条（$SCRUB_DEVU / $SCRUB_USERS 个账户）已清除，剩余 0"
  say "固定的升级前快照：$SNAP"
  say "/api/health：ok=$H_OK version=$H_VER auth=$H_AUTH"
  say "容器状态：$(printf '%s' "$ST" | cut -d'|' -f1)，健康 $(printf '%s' "$ST" | cut -d'|' -f4)"
  cat "$WORK/report"
  if [ "$NERR" != 0 ]; then say ""; say "== 日志可疑行（脱敏，最多 20 行）"; cat "$WORK/logerr"; fi
  say ""
  say "== 打开测试站（务必与生产站用不同的主机名 + 单独的浏览器会话）"
  say "  推荐：$URL_MAIN    备选：$URL_ALT"
  say "  原因：cookie 不按端口区分。测试站设置了 NOCTURNE_COOKIE_PREFIX=nocturne_v2test_（2.0.0-rc.2 起生效：cookie 名为"
  say "  nocturne_v2test_sid / nocturne_v2test_dev，与生产的 nocturne_sid / nocturne_dev 互不覆盖）；镜像是 rc.1 时这个变量不起作用，"
  say "  同一主机名下打开测试站会覆盖生产站的登录与「已知设备」cookie。稳妥起见仍请换主机名，并用 Safari 无痕窗口打开测试站。"
  say "下一步：在测试站登录、改一处配置，然后运行 sudo sh tools/v2test/check-persist.sh"
} > "$REPORT"
chmod 600 "$REPORT"

say ""
say "================================================================"
if [ "$FAILS" = 0 ]; then say "部署完成，检查全部通过（注意 $WARNS 项）。"; else say "部署完成，但有 $FAILS 项检查失败（见上面 [失败]）。"; fi
say ""
say "打开测试站（Safari 无痕窗口）：$URL_MAIN"
say "  生产站如果是用 IP 打开的，就用上面的 <主机名>.local 地址；生产站用主机名 / 域名打开的，就用 $URL_ALT"
say "  不要在打开生产站的同一个浏览器会话里、用同一个主机名打开测试站（cookie 名相同、不按端口区分，会互相覆盖）"
say "  （<主机名>.local 需要群晖「控制面板 → 文件服务 → 高级 → Bonjour」开启；打不开就用 IP，但仍用无痕窗口）"
say ""
say "测试站里的会话 / 已知设备已清空：用你生产站的账户密码重新登录。测试站的修改不会回到生产。"
say "登录并改一处配置后运行：sudo sh $HERE/check-persist.sh"
say "报告：$REPORT（可直接贴回）"
say "删除测试环境：sudo sh $HERE/teardown.sh"
[ "$FAILS" = 0 ]
