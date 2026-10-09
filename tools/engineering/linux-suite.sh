#!/bin/sh
# 容器内完整回归；缺工具/失败/跳过均非零。源码和 Git 历史须已复制至 /work。
set -eu
OUT=${1:?需要日志目录}
mkdir -p "$OUT"
if [ "$(id -u)" = 0 ]; then
  # root 仅设置容器回环和 docker cp 副本属主。权限故障回归必须用普通用户。
  ip addr add 192.168.77.10/32 dev lo
  ip addr add 192.168.77.11/32 dev lo
  chown -R 1000:1000 /work "$OUT"
  export NOCTURNE_LINUX_OUT="$OUT"
  exec su node -s /bin/sh -c 'cd /work; sh tools/engineering/linux-suite.sh "$NOCTURNE_LINUX_OUT"'
fi
[ "$(id -u)" = 1000 ] || { echo '完整回归要求普通测试用户'; exit 1; }
uname -a > "$OUT/environment.log"
node --version >> "$OUT/environment.log"
node -p 'JSON.stringify({platform:process.platform,arch:process.arch})' >> "$OUT/environment.log"
busybox | head -1 >> "$OUT/environment.log"
id >> "$OUT/environment.log"
npm run check > "$OUT/syntax.log" 2>&1
npm test > "$OUT/full.log" 2>&1
node tools/engineering/assert-tap.js "$OUT/full.log" > "$OUT/full-summary.json"
# 在隔离容器内添加回环别名；不接入宿主/NAS 网络。不得接受脚本自己的 SKIP。
sh test/v2test-kit/run.sh dash busybox > "$OUT/v2kit.log" 2>&1
if grep -q 'SKIP\|FAIL ' "$OUT/v2kit.log"; then exit 1; fi
grep -Eq '^合计：[1-9][0-9]* 通过，0 失败$' "$OUT/v2kit.log" || { tail -5 "$OUT/v2kit.log"; exit 1; }
# 回归结束后顺序测量，不与本机其他测试争抢 CPU；测量的是隔离容器磁盘。
node tools/engineering/bench-auth-io.js "$OUT" > "$OUT/auth-io-benchmark.log" 2>&1
