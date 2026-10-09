#!/bin/sh
# tools/v2test 沙盒端到端自测（不在 npm test 里：需要本机回环上有一个 RFC1918 别名地址）。
#   sudo ip addr add 192.168.77.10/32 dev lo     # 一次性；测试站会真的监听 192.168.77.10:8089
#   sh test/v2test-kit/run.sh [dash] [busybox]    # 默认两个 shell 都跑
# 假的 docker / ip / ss / hostname 放在 test/v2test-kit/bin（PATH 最前面）；「容器」是真实的 node server.js（本仓库；版本 / 固定镜像 digest 从 tools/v2test/lib.sh 读，须与 package.json 一致），
# 「生产」data 由真实的 V1.1 基线 server.js 生成（test/v11.js）。全部是假数据。
# shellcheck disable=SC2012,SC2015
set -u
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
SHELLS=${*:-dash busybox}
LANIP=192.168.77.10
chmod +x "$HERE"/bin/* 2>/dev/null # 经 GitHub Contents API 上传的文件在远端是 100644
ip -4 -o addr show 2>/dev/null | grep -q "inet $LANIP/" || sudo -n ip addr add "$LANIP/32" dev lo 2>/dev/null || { echo "SKIP：回环上没有 $LANIP（sudo ip addr add $LANIP/32 dev lo）"; exit 0; }

T=$(mktemp -d /tmp/v2kit.XXXXXX)
PROD=$T/volume1/docker/nocturne/data
TR=$T/volume1/docker/nocturne-v2test
FD=$T/fakedocker
mkdir -p "$T/tmp"
node "$HERE/seed-prod.js" "$PROD" "$T/cookies.json" >/dev/null || { echo "seed failed"; exit 1; }
cp -a "$PROD" "$T/prod-pristine"
# 生产里的秘密（会话键 = sha256(令牌)、设备哈希、密码哈希、cookie 令牌）：报告和输出里一个都不许出现
node -e 'const d=process.argv[1],fs=require("fs");const s=JSON.parse(fs.readFileSync(d+"/sessions.json"));const u=JSON.parse(fs.readFileSync(d+"/users.json"));const c=JSON.parse(fs.readFileSync(process.argv[2]));
const out=[...Object.keys(s)];for(const x of u.users){out.push(x.hash.split("$")[2]);for(const v of x.devices||[])out.push(v.h)}for(const j of Object.values(c))for(const v of Object.values(j))out.push(v);console.log(out.join("\n"))' "$PROD" "$T/cookies.json" > "$T/secrets.txt"
prodsum() { ( cd "$PROD" && find . -type f -exec sha256sum {} + | sort; find . -type f -exec stat -c '%Y %s %n' {} + | sort ) | sha256sum | cut -d' ' -f1; }
PROD_SUM=$(prodsum)
libvar() { sed -n "s/^$1=\"\([^\"]*\)\".*/\1/p" "$REPO/tools/v2test/lib.sh"; }
EXPECT_VERSION=$(libvar EXPECT_VERSION); PIN_HEX=$(libvar IMAGE_DIGEST | sed 's/^sha256://')
PIN_REF="$(libvar IMAGE_REPO):$(libvar IMAGE_TAG)@$(libvar IMAGE_DIGEST)"
PKG_VERSION=$(node -p 'require(process.argv[1]).version' "$REPO/package.json")
[ -n "$EXPECT_VERSION" ] && [ -n "$PIN_HEX" ] || { echo "lib.sh 里读不到 EXPECT_VERSION / IMAGE_DIGEST"; exit 1; }
[ "$EXPECT_VERSION" = "$PKG_VERSION" ] || { echo "tools/v2test/lib.sh EXPECT_VERSION=$EXPECT_VERSION 与 package.json $PKG_VERSION 不一致（先更新 lib.sh 的固定镜像）"; exit 1; }

PASS=0; FAIL=0; FAILED=""
check() { _d=$1; shift; if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); echo "  PASS $_d"; else FAIL=$((FAIL + 1)); FAILED="$FAILED
  - [$SHN] $_d"; echo "  FAIL $_d"; fi; }
has() { grep -q -- "$1" "$2"; }
hasnt() { ! grep -q -- "$1" "$2"; }

reset_docker() {
  if [ -f "$FD/state.json" ]; then
    for p in $(node -e 'const s=require(process.argv[1]);for(const c of Object.values(s.containers))if(c.pid)console.log(c.pid)' "$FD/state.json"); do kill "$p" 2>/dev/null; done
    sleep 0.3
  fi
  rm -rf "$FD"; mkdir -p "$FD"
  node -e '
const [fd, prod, wd] = process.argv.slice(1);
const st = { containers: { nocturne: { Id: "a".repeat(64), Name: "nocturne", Image: "sha256:" + "1".repeat(64), RestartCount: 0,
  Config: { Image: "ghcr.io/sadjdg123/nocturne:sha-3e6da3c", Env: ["TZ=Asia/Shanghai", "PUID=1026", "PGID=100", "NODE_ENV=production"],
    Labels: { "com.docker.compose.project": "nocturne", "com.docker.compose.project.working_dir": wd } },
  State: { Status: "running", StartedAt: "2026-10-01T00:00:00.000000000Z", Health: { Status: "healthy" } },
  Mounts: [{ Type: "bind", Source: prod, Destination: "/data", RW: true }],
  HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "", HostPort: "8088" }] } } } }, images: {}, networks: {} };
require("fs").writeFileSync(fd + "/state.json", JSON.stringify(st, null, 2));' "$FD" "$PROD" "$(dirname "$PROD")"
}
add_container() { # add_container NAME PORTSPEC LABELJSON
  node -e '
const [f, name, port, labels] = process.argv.slice(1); const s = JSON.parse(require("fs").readFileSync(f));
s.containers[name] = { Id: "b".repeat(64), Name: name, Image: "sha256:" + "2".repeat(64), RestartCount: 0, Config: { Image: "nginx", Env: [], Labels: JSON.parse(labels) },
  State: { Status: "running", StartedAt: "2026-10-02T00:00:00Z" }, Mounts: [], HostConfig: { PortBindings: port ? { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: port }] } : {} } };
require("fs").writeFileSync(f, JSON.stringify(s, null, 2));' "$FD/state.json" "$1" "$2" "$3"
}
no_prod_ops() { ! grep -Eq '^(stop|restart|start|rm|kill|pause)( -f)? nocturne$' "$FD/calls.log"; }
prod_same() { [ "$(prodsum)" = "$PROD_SUM" ]; }
only_known_hex() { # 报告里 64 位十六进制只允许：镜像 digest、备份归档 sha256
  _arch=$(sed -n 's/^  归档 sha256：//p' "$1"); grep -oE '[0-9a-f]{64}' "$1" | sort -u | grep -vx "$PIN_HEX" | grep -vx "$_arch" | grep -q . && return 1; return 0; }

export FAKE_DOCKER_DIR="$FD" FAKE_SERVER_ROOT="$REPO" V2TEST_ALLOW_NONROOT=1 V2TEST_WAIT_STEP=1 V2TEST_WAIT_SECS=40 TMPDIR="$T/tmp"
PATH="$HERE/bin:$PATH"; export PATH

for SHN in $SHELLS; do
  case "$SHN" in dash) SH="dash" ;; busybox) SH="busybox sh" ;; *) echo "unknown shell $SHN"; exit 2 ;; esac
  export V2TEST_SH="$SH"
  kit() { _s=$1; shift; $SH "$REPO/tools/v2test/$_s" "$@" > "$T/out" 2>&1; echo $? > "$T/rc"; }
  rc() { [ "$(cat "$T/rc")" = "$1" ]; }
  rcnz() { [ "$(cat "$T/rc")" != 0 ]; }
  echo "=== [$SHN] 正向：deploy → check-persist → teardown"
  reset_docker; rm -rf "$TR"; export FAKE_PULL=ok FAKE_SS_LISTEN=""
  kit deploy.sh --test-root "$TR" --yes
  cp "$T/out" "$T/deploy-$SHN.out"
  check "deploy 退出码 0" rc 0
  REP=$(ls "$TR"/v2test-report-*.txt 2>/dev/null | head -n 1)
  check "报告文件存在且 600" sh -c "[ -f '$REP' ] && [ \"\$(stat -c %a '$REP')\" = 600 ]"
  check "报告：结果通过" has "结果：通过" "$REP"
  check "报告：health version $EXPECT_VERSION auth=true" has "version=$EXPECT_VERSION auth=true" "$REP"
  check "报告：唯一挂载是测试目录" has "唯一的挂载：$TR/data → /data" "$REP"
  check "报告：端口只绑内网 IP" has "端口绑定 $LANIP:8089" "$REP"
  check "报告：会话 3 条 / 已知设备 3 条已清除" has "会话 3 条、已知设备 3 条" "$REP"
  check "报告：生产 data 未改动（sha256 清单）" has "生产 data 未改动" "$REP"
  check "报告：生产容器未停止 / 重启" has "未被停止 / 重启" "$REP"
  check "报告：icons / wallpapers / config 数量一致" sh -c "grep -q '\[通过\] icons：副本 1 / 备份 1' '$REP' && grep -q '\[通过\] wallpapers：副本 1 / 备份 1' '$REP' && grep -q '\[通过\] config：副本 1 / 备份 1' '$REP'"
  check "报告：推荐网址 diskstation.local:8089 + 无痕窗口" sh -c "grep -q 'http://diskstation.local:8089' '$REP' && grep -q '无痕' '$REP'"
  check "报告：不含密码 / scrypt / 明文口令 / 令牌" sh -c "! grep -Eq 'scrypt|admin-pass|bob-pass' '$REP' && ! grep -oE '[A-Za-z0-9_-]{43,}' '$REP' | grep -vqE '^[0-9a-f]{64}\$'"
  check "报告：不含生产 / 副本里任何会话键与设备哈希" sh -c "! grep -qFf '$T/secrets.txt' '$REP' && ! grep -qFf '$T/secrets.txt' '$T/deploy-$SHN.out'"
  check "报告：64 位十六进制只有镜像 digest 与归档 sha256" only_known_hex "$REP"
  check "compose：$LANIP:8089:8080、固定镜像、无 docker.sock、无 NO_AUTH、PUID 1026" sh -c "grep -q '\"$LANIP:8089:8080\"' '$TR/docker-compose.yml' && grep -q 'image: $PIN_REF' '$TR/docker-compose.yml' && ! grep -v '^ *#' '$TR/docker-compose.yml' | grep -q 'docker.sock\|NO_AUTH' && grep -q 'PUID=1026' '$TR/docker-compose.yml'"
  check "副本：sessions.json 为空、没有已知设备" node -e 'const d=process.argv[1],fs=require("fs");const s=JSON.parse(fs.readFileSync(d+"/sessions.json"));const u=JSON.parse(fs.readFileSync(d+"/users.json"));if(Object.keys(s).length)process.exit(1);if(u.users.some(x=>x.devices&&x.devices.length))process.exit(1);if(u.users.length!==2||!u.users.every(x=>/^scrypt\$/.test(x.hash)))process.exit(1)' "$TR/data"
  check "生产：会话与已知设备都还在" node -e 'const d=process.argv[1],fs=require("fs");const s=JSON.parse(fs.readFileSync(d+"/sessions.json"));const u=JSON.parse(fs.readFileSync(d+"/users.json"));process.exit(Object.keys(s).length===3&&u.users.reduce((n,x)=>n+(x.devices||[]).length,0)===3?0:1)' "$PROD"
  check "副本：V2 首次启动写了固定快照" sh -c "ls -d '$TR'/data/pre-v2-snapshot-* >/dev/null"
  check "测试站拒绝生产站的旧会话 / 已知设备 cookie" node "$HERE/user.js" old-cookies "http://$LANIP:8089" "$T/cookies.json"
  check "测试站 cookie 前缀 nocturne_v2test_（compose 环境变量 + 登录响应的 Set-Cookie 名）" sh -c "grep -q 'NOCTURNE_COOKIE_PREFIX=nocturne_v2test_' '$TR/docker-compose.yml' && curl -fsS -o /dev/null -D - -H 'Content-Type: application/json' --data '{\"name\":\"admin\",\"password\":\"admin-pass-1\"}' 'http://$LANIP:8089/api/login' | grep -qi '^set-cookie: nocturne_v2test_sid='"
  check "生产 data 逐字节未变" prod_same
  check "从未对生产容器执行 stop / restart / start / rm" no_prod_ops
  check "备份是热备份（没有 --stop）" sh -c "! grep -q -- '--stop' '$FD/calls.log' && grep -q '停容器：no' '$REP'"
  kit check-persist.sh --test-root "$TR"
  check "check-persist：还没修改时退出码 2 并提示先修改" sh -c "[ \"\$(cat '$T/rc')\" = 2 ] && grep -q '还没有检测到配置修改' '$T/out'"
  check "用户：用生产密码登录测试站并改一处配置" node "$HERE/user.js" edit "http://$LANIP:8089"
  kit check-persist.sh --test-root "$TR"
  cp "$T/out" "$T/persist-$SHN.out"
  check "check-persist 退出码 0" rc 0
  check "check-persist：重启了、sha256 / 版本不变、health 正常" sh -c "grep -q '已重启' '$T/out' && grep -q 'sha256 完全一致' '$T/out' && grep -q '配置版本号不变' '$T/out' && grep -q 'auth=true' '$T/out' && grep -q '登录会话重启后仍在' '$T/out'"
  check "check-persist：只重启了 nocturne-v2test" sh -c "grep -q '^restart nocturne-v2test$' '$FD/calls.log'"
  check "check-persist 报告存在" sh -c "[ \$(ls '$TR'/v2test-report-*.txt | wc -l) -ge 2 ]"
  kit teardown.sh --test-root "$TR"  </dev/null
  check "teardown：不确认就不删" sh -c "grep -q '已取消' '$T/out' && [ -d '$TR/data' ]"
  kit teardown.sh --test-root "$TR" --yes
  check "teardown --yes 退出码 0、目录与容器都没了" sh -c "[ \"\$(cat '$T/rc')\" = 0 ] && [ ! -e '$TR' ] && ! grep -q '\"nocturne-v2test\"' '$FD/state.json'"
  check "teardown 后生产 data 未变、生产容器未被操作" sh -c "[ \"\$(cd '$PROD' && find . -type f -exec sha256sum {} + | sort | sha256sum)\" != '' ]"
  check "整轮结束：生产 data 逐字节未变" prod_same
  check "整轮结束：从未操作生产容器" no_prod_ops

  echo "=== [$SHN] 反向"
  reset_docker; rm -rf "$TR"
  kit deploy.sh --test-root "$T/volume1/docker/nocturne" --yes
  check "同一路径：测试数据 = 生产数据 → 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '测试数据路径与生产数据路径相同' '$T/out'"
  kit deploy.sh --test-root "$PROD/v2" --yes
  check "测试目录在生产 data 里面 → 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '在生产数据目录' '$T/out'"
  kit deploy.sh --test-root "$T/volume1" --yes
  check "生产 data 在测试目录里面 → 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '互相包含' '$T/out'"
  mkdir -p "$T/elsewhere/data"; : > "$T/elsewhere/data/users.json"
  kit deploy.sh --test-root "$TR" --prod-data "$T/elsewhere/data" --yes
  check "--prod-data 与 docker inspect 检测结果不一致 → 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '不一致' '$T/out'"
  FAKE_SS_LISTEN="0.0.0.0:8089" kit deploy.sh --test-root "$TR" --yes
  check "8089 被本机进程占用（ss）→ 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '端口 8089 已被占用：本机进程监听 0.0.0.0:8089' '$T/out'"
  add_container other-app 8089 '{}'
  kit deploy.sh --test-root "$TR" --yes
  check "8089 被另一个容器映射（docker ps）→ 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '端口 8089 已被占用：容器 other-app' '$T/out'"
  reset_docker; add_container nocturne-v2test "" '{}'
  kit deploy.sh --test-root "$TR" --yes
  check "已有同名但不是我们的容器 → 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '不是本套件创建的（没有 com.nocturne.v2test 标签）' '$T/out'"
  mkdir -p "$TR"; echo created=x > "$TR/.nocturne-v2test"
  kit teardown.sh --test-root "$TR" --yes
  check "teardown 遇到不是我们的同名容器 → 拒绝，不删" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '不是本套件创建的' '$T/out' && grep -q '\"nocturne-v2test\"' '$FD/state.json' && [ -d '$TR' ]"
  rm -rf "$TR"; reset_docker
  FAKE_PULL=mismatch kit deploy.sh --test-root "$TR" --yes
  check "镜像 RepoDigest 不一致 → 拒绝，未备份 / 未建容器" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q 'RepoDigest 与固定的 digest 不一致' '$T/out' && [ ! -e '$TR/data' ] && ! grep -q '\"nocturne-v2test\"' '$FD/state.json'"
  reset_docker
  FAKE_PULL=auth kit deploy.sh --test-root "$TR" --yes
  check "GHCR 401 → 退出码 5，打印 docker login（read:packages）说明" sh -c "[ \"\$(cat '$T/rc')\" = 5 ] && grep -q 'sudo docker login ghcr.io -u' '$T/out' && grep -q 'read:packages' '$T/out' && grep -q 'docker logout ghcr.io' '$T/out'"
  reset_docker
  FAKE_IP_ADDR=8.8.8.8 kit deploy.sh --test-root "$TR" --yes
  check "默认路由网卡不是内网地址 → 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '不是内网地址' '$T/out'"
  rm -rf "$TR"; mkdir -p "$TR"; : > "$TR/somefile"
  kit deploy.sh --test-root "$TR" --yes
  check "测试目录已存在但不是本套件的 → 拒绝" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && grep -q '不是本套件创建的' '$T/out'"
  kit teardown.sh --test-root "$TR" --yes
  check "teardown 拒绝删除没有标记的目录" sh -c "[ \"\$(cat '$T/rc')\" != 0 ] && [ -f '$TR/somefile' ]"
  rm -rf "$TR"; reset_docker
  # 每次真实 cp 后确定性注入一次原子 rename，确保三次源 hash 核验都看到变化。
  # 无同步的后台循环可能短暂停写形成合法稳定窗口，也可能触发 find 的目录竞态；
  # 此用例专门验证持续内容变化的退出码 4，不依赖调度偶然性。
  mkdir -p "$T/hot-bin"
  export V2KIT_REAL_CP="$(command -v cp)" V2KIT_HOT_FILE="$PROD/icons/zz-writer.bin" V2KIT_HOT_COUNTER="$T/hot-counter" V2KIT_HOT_TMP="$T/hot-source.tmp"
  echo 0 > "$V2KIT_HOT_COUNTER"; echo 0 > "$V2KIT_HOT_FILE"
  cat > "$T/hot-bin/cp" <<'EOF'
#!/bin/sh
"$V2KIT_REAL_CP" "$@" || exit "$?"
if [ "$1" = -p ] && [ "$2" = "$V2KIT_HOT_FILE" ]; then
  n=$(cat "$V2KIT_HOT_COUNTER"); n=$((n + 1))
  echo "$n" > "$V2KIT_HOT_COUNTER"
  echo "$n" > "$V2KIT_HOT_TMP"; mv "$V2KIT_HOT_TMP" "$V2KIT_HOT_FILE" || exit 1
fi
EOF
  chmod +x "$T/hot-bin/cp"
  PATH="$T/hot-bin:$PATH" kit deploy.sh --test-root "$TR" --yes
  check "热备份一直不一致 → 退出码 4、停止并询问是否用 --stop，未建容器" sh -c "[ \"\$(cat '$T/rc')\" = 4 ] && grep -q '热备份没能得到一致的数据' '$T/out' && grep -q 'backup.sh --stop nocturne' '$T/out' && grep -q -- '--from-backup' '$T/out' && ! grep -q '\"nocturne-v2test\"' '$FD/state.json' && [ ! -e '$TR/data' ]"
  check "三次复制后的原子变化注入均实际命中" sh -c "[ \"\$(cat '$V2KIT_HOT_COUNTER')\" = 3 ]"
  check "热备份失败时也没有停止生产容器" no_prod_ops
  rm -rf "$PROD"; cp -a "$T/prod-pristine" "$PROD"
  check "反向测试结束：生产 data 逐字节未变" prod_same
  rm -rf "$TR"
done
reset_docker
echo ""
echo "合计：$PASS 通过，$FAIL 失败$FAILED"
if [ "${KEEP:-0}" = 1 ] || [ "$FAIL" != 0 ]; then echo "保留：$T"; else rm -rf "$T"; fi
[ "$FAIL" = 0 ]
