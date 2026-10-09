# 夜曲 Nocturne · V2 RC 并行测试套件的公共函数（由 deploy.sh / check-persist.sh / teardown.sh 用 . 引入，不单独运行）
# POSIX sh：群晖 DSM 7 的 /bin/sh、dash、busybox sh 都能运行。
# shellcheck shell=sh
# shellcheck disable=SC2034 # 这里定义的常量由引入它的脚本使用

KIT_VERSION="1"
IMAGE_REPO="ghcr.io/sadjdg123/nocturne"
IMAGE_TAG="sha-93d9bec"
IMAGE_DIGEST="sha256:477db409164737bcf6c9439703c64052628aa91cff2f009b5d8056dd985d39e5"
IMAGE_REF="$IMAGE_REPO:$IMAGE_TAG@$IMAGE_DIGEST"
EXPECT_VERSION="2.0.0"
TEST_NAME="nocturne-v2test"        # 测试容器名 = compose 项目名
OUR_LABEL="com.nocturne.v2test"    # 我们创建的容器带这个标签（值 = KIT_VERSION），用来判断「是不是我们的」
MARKER=".nocturne-v2test"          # 测试目录里的标记文件：只有带它的目录 teardown 才会删
DEFAULT_PROD_CONTAINER="nocturne"
DEFAULT_PROD_DATA="/volume1/docker/nocturne/data"
DEFAULT_TEST_ROOT="/volume1/docker/nocturne-v2test"
DEFAULT_PORT="8089"
CONTAINER_PORT="8080"

# 群晖上 sudo 之后 PATH 可能不含 docker 所在的 /usr/local/bin
PATH="$PATH:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin"; export PATH
LC_ALL=C; export LC_ALL
SUBSH=${V2TEST_SH:-sh}             # 运行 tools/*.sh 用的 shell（测试时可换成 busybox sh）

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '  [通过] %s\n' "$*"; }
warn() { printf '  [注意] %s\n' "$*" >&2; }
die()  { printf '\n错误：%s\n' "$*" >&2; exit 1; }

hash_of() { # 只输出 64 位十六进制
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else die "需要 sha256sum 或 openssl"; fi
}

need_root() {
  [ "$(id -u)" = 0 ] && return 0
  [ "${V2TEST_ALLOW_NONROOT:-}" = 1 ] && return 0  # 仅供沙盒自测
  die "请用 sudo 运行（群晖上 docker 需要 root）：sudo sh $0 …"
}

# 规范化路径：存在的部分用 pwd -P 解开符号链接，不存在的尾部原样拼接；拒绝 . / .. / 引号 / 换行
canon_path() {
  _p=$1
  case "$_p" in *"'"*|*'
'*) die "路径里不能有单引号或换行：$_p" ;; esac
  case "$_p" in /*) ;; *) _p="$(pwd -P)/$_p" ;; esac
  _rest=""
  while [ ! -d "$_p" ]; do
    _b=$(basename "$_p")
    case "$_b" in .|..) die "路径里不能有 . 或 ..：$1" ;; esac
    _rest="/$_b$_rest"; _p=$(dirname "$_p")
  done
  _base=$(cd "$_p" && pwd -P) || die "无法进入 $_p"
  [ "$_base" = / ] && _base=""
  printf '%s%s\n' "$_base" "$_rest"
}
# A 等于 B 或在 B 里面（都必须是 canon_path 的结果）
path_inside() { [ "$1" = "$2" ] && return 0; case "$1/" in "$2"/*) return 0 ;; esac; return 1; }
paths_overlap() { path_inside "$1" "$2" || path_inside "$2" "$1"; }

# ---- docker
container_exists() { docker inspect --type container "$1" >/dev/null 2>&1; }
cinspect() { docker inspect --type container -f "$2" "$1" 2>/dev/null; }
# 容器 /data 挂载的宿主机路径
mount_source_of() { cinspect "$1" '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}'; }
# 状态|启动时间|重启次数|健康（没有健康检查时为空）
state_of() { cinspect "$1" '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}'; }
label_of() { cinspect "$1" "{{index .Config.Labels \"$2\"}}"; }
env_of() { cinspect "$1" '{{range .Config.Env}}{{println .}}{{end}}'; }
is_ours() { [ "$(label_of "$1" "$OUR_LABEL")" = "$KIT_VERSION" ] && [ "$(label_of "$1" com.docker.compose.project)" = "$TEST_NAME" ]; }

detect_compose() {
  if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then COMPOSE="docker-compose"
  else COMPOSE=""; fi
}
compose() { # compose <项目目录> <参数…>
  _d=$1; shift
  [ -n "${COMPOSE:-}" ] || detect_compose
  [ -n "$COMPOSE" ] || die "找不到 docker compose / docker-compose（群晖请安装 Container Manager）"
  # shellcheck disable=SC2086 # COMPOSE 是 "docker compose" 两个词
  ( cd "$_d" && $COMPOSE -p "$TEST_NAME" -f "$_d/docker-compose.yml" "$@" )
}

# ---- 网络
is_private_ipv4() { # RFC1918：10/8、172.16/12、192.168/16
  printf '%s\n' "$1" | grep -Eq '^([0-9]{1,3}[.]){3}[0-9]{1,3}$' || return 1
  _o2=$(printf '%s\n' "$1" | cut -d. -f2)
  case "$1" in 10.*|192.168.*) return 0 ;; 172.*) [ "$_o2" -ge 16 ] && [ "$_o2" -le 31 ] && return 0 ;; esac
  return 1
}
# 默认路由所在网卡的 IPv4（结果放在 LAN_IF / LAN_IP_FOUND）
detect_lan_ip() {
  LAN_IF=""; LAN_IP_FOUND=""
  if command -v ip >/dev/null 2>&1; then
    LAN_IF=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
    [ -n "$LAN_IF" ] && LAN_IP_FOUND=$(ip -4 -o addr show dev "$LAN_IF" 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="inet"){split($(i+1),a,"/"); print a[1]; exit}}')
  fi
  if [ -z "$LAN_IP_FOUND" ] && command -v route >/dev/null 2>&1; then
    LAN_IF=$(route -n 2>/dev/null | awk '$1=="0.0.0.0"{print $NF; exit}')
    [ -n "$LAN_IF" ] && command -v ifconfig >/dev/null 2>&1 && \
      LAN_IP_FOUND=$(ifconfig "$LAN_IF" 2>/dev/null | sed -n 's/.*inet \(addr:\)\{0,1\}\([0-9.]*\).*/\2/p' | head -n 1)
  fi
}
# 这个 IPv4 是否配置在本机某块网卡上
ip_is_local() {
  if command -v ip >/dev/null 2>&1; then ip -4 -o addr show 2>/dev/null | grep -q "inet $1/" && return 0; fi
  if command -v ifconfig >/dev/null 2>&1; then ifconfig 2>/dev/null | grep -Eq "inet (addr:)?$1( |$)" && return 0; fi
  return 1
}
# 端口是否已被占用：0 = 占用（PORT_BUSY_BY 说明是谁），1 = 空闲。PORT_CHECKS 记下用了哪些检查
port_in_use() {
  _port=$1; PORT_BUSY_BY=""; PORT_CHECKS="docker-ps"
  _dp=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | grep -E "[:]$_port->" | head -n 1)
  [ -n "$_dp" ] && { PORT_BUSY_BY="容器 ${_dp%%|*}（${_dp#*|}）"; return 0; }
  if command -v ss >/dev/null 2>&1; then
    PORT_CHECKS="$PORT_CHECKS ss"
    _l=$(ss -ltnH 2>/dev/null | awk -v p=":$_port" '{a=$4; if (substr(a, length(a)-length(p)+1)==p) {print a; exit}}')
    [ -n "$_l" ] && { PORT_BUSY_BY="本机进程监听 $_l"; return 0; }
  fi
  if command -v netstat >/dev/null 2>&1; then
    PORT_CHECKS="$PORT_CHECKS netstat"
    _l=$(netstat -ltn 2>/dev/null | awk -v p=":$_port" '$1 ~ /^tcp/ {a=$4; if (substr(a, length(a)-length(p)+1)==p) {print a; exit}}')
    [ -n "$_l" ] && { PORT_BUSY_BY="本机进程监听 $_l"; return 0; }
  fi
  return 1
}
http_get() { # http_get URL → 正文到 stdout；失败返回非 0
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then wget -qO- -T 5 "$1" 2>/dev/null
  else return 2; fi
}
json_str() { sed -n "s/.*\"$1\" *: *\"\\([^\"]*\\)\".*/\\1/p" | head -n 1; }  # 简单 JSON 取字符串字段
json_raw() { sed -n "s/.*\"$1\" *: *\\([^,}\"]*\\).*/\\1/p" | head -n 1; }   # 取数字 / 布尔字段

# 日志脱敏：长串（令牌 / 哈希 / base64）、cookie / 密码 / token 之类的键值、Authorization 头一律隐藏；每行最多 300 字符
sanitize() {
  sed -E \
    -e 's/(nocturne_(sid|dev)|[Cc]ookie|[Pp]ass(word)?|[Tt]oken|[Ss]ecret|[Aa]uthorization|hash)([=:" ]+)[^ ,;"}]+/\1\4<已隐藏>/g' \
    -e 's/[A-Za-z0-9_+=-]{24,}/<已隐藏>/g' | cut -c1-300
}

# 目录清单：每行「sha256  字节数  修改时间(秒)  相对路径」，跳过 *.tmp（写入中的临时文件）
manifest() { # manifest DIR OUT
  ( cd "$1" && find . -name '*.tmp' -prune -o -type f -print | sed 's|^\./||' | LC_ALL=C sort ) > "$2.list"
  : > "$2"
  while IFS= read -r _f; do
    [ -f "$1/$_f" ] || continue
    printf '%s  %s  %s  %s\n' "$(hash_of "$1/$_f")" "$(wc -c < "$1/$_f" | tr -d ' ')" "$(date -r "$1/$_f" +%s 2>/dev/null || echo 0)" "$_f" >> "$2"
  done < "$2.list"
  rm -f "$2.list"
}
# 对比两份清单：输出 CHANGED_* 计数（总数、运行时文件、持久数据）
compare_manifests() { # compare_manifests BEFORE AFTER
  CHANGED_TOTAL=0; CHANGED_RUNTIME=0; CHANGED_DATA=0; CHANGED_DIRS=""
  # 用路径 join：增 / 删 / 改都算
  _tmpd=$(mktemp -d "${TMPDIR:-/tmp}/v2test-cmp.XXXXXX")
  awk '{h=$1; s=$2; m=$3; $1=$2=$3=""; sub(/^ +/, ""); print $0 "\t" h " " s " " m}' "$1" | LC_ALL=C sort > "$_tmpd/a"
  awk '{h=$1; s=$2; m=$3; $1=$2=$3=""; sub(/^ +/, ""); print $0 "\t" h " " s " " m}' "$2" | LC_ALL=C sort > "$_tmpd/b"
  LC_ALL=C comm -3 "$_tmpd/a" "$_tmpd/b" | sed 's/^\t//' | cut -f1 | LC_ALL=C sort -u > "$_tmpd/d"
  while IFS= read -r _f; do
    [ -n "$_f" ] || continue
    CHANGED_TOTAL=$((CHANGED_TOTAL + 1))
    case "$_f" in sessions.json|cache/*) CHANGED_RUNTIME=$((CHANGED_RUNTIME + 1)) ;; *) CHANGED_DATA=$((CHANGED_DATA + 1)) ;; esac
    _top=${_f%%/*}; case " $CHANGED_DIRS " in *" $_top "*) ;; *) CHANGED_DIRS="$CHANGED_DIRS $_top" ;; esac
  done < "$_tmpd/d"
  rm -rf "$_tmpd"
}
# 配置文件（users.json、config/*.json）的「修改时间 字节数」
config_stats() { # config_stats DATA_DIR → 每行「相对路径 mtime size」
  for _f in "$1/users.json" "$1"/config/*.json; do
    [ -f "$_f" ] || continue
    printf '%s %s %s\n' "${_f#"$1"/}" "$(date -r "$_f" +%s 2>/dev/null || echo 0)" "$(wc -c < "$_f" | tr -d ' ')"
  done
}
count_files() { # count_files DIR → 普通文件数（跳过 *.tmp）
  [ -d "$1" ] || { echo 0; return; }
  find "$1" -name '*.tmp' -prune -o -type f -print | wc -l | tr -d ' '
}

# 状态文件（deploy.sh 写，另外两个脚本读）：KEY='值'，只放路径 / 名称 / 计数，不放任何秘密
state_set() { printf "%s='%s'\n" "$1" "$2" >> "$STATE_FILE"; }
load_state() { # load_state TEST_ROOT
  STATE_FILE="$1/.v2test/state.env"
  [ -f "$STATE_FILE" ] || die "找不到 $STATE_FILE（还没有用 deploy.sh 部署过？用 --test-root 指定测试目录）"
  # shellcheck disable=SC1090
  . "$STATE_FILE"
}

wait_healthy() { # wait_healthy NAME URL SECONDS → 成功 0；WAIT_STATE 记下最后的状态
  _n=$1; _url=$2; _max=$3; _step=${V2TEST_WAIT_STEP:-3}; _t=0
  while :; do
    WAIT_STATE=$(state_of "$_n")
    case "$WAIT_STATE" in
      exited*|dead*) return 1 ;;
      running*\|healthy|running*\|) http_get "$_url" >/dev/null && return 0 ;;
    esac
    [ "$_t" -lt "$_max" ] || return 1
    sleep "$_step"; _t=$((_t + _step))
  done
}
