#!/bin/sh
# 容器内完整回归；缺工具/失败/跳过均非零。源码和 Git 历史须已复制至 /work。
set -eu
OUT=${1:?需要日志目录}
mkdir -p "$OUT"
# docker cp 保留宿主 UID；仅信任这个隔离副本，不放宽其他目录的 Git 检查。
git config --global --add safe.directory /work
uname -a > "$OUT/environment.log"
node --version >> "$OUT/environment.log"
node -p 'JSON.stringify({platform:process.platform,arch:process.arch})' >> "$OUT/environment.log"
busybox | head -1 >> "$OUT/environment.log"
npm run check > "$OUT/syntax.log" 2>&1
npm test > "$OUT/full.log" 2>&1
node tools/engineering/assert-tap.js "$OUT/full.log" > "$OUT/full-summary.json"
# 在隔离容器内添加回环别名；不接入宿主/NAS 网络。不得接受脚本自己的 SKIP。
ip addr add 192.168.77.10/32 dev lo
sh test/v2test-kit/run.sh dash busybox > "$OUT/v2kit.log" 2>&1
if grep -q 'SKIP\|FAIL ' "$OUT/v2kit.log"; then exit 1; fi
grep -Eq '^合计：[1-9][0-9]* 通过，0 失败$' "$OUT/v2kit.log" || { tail -5 "$OUT/v2kit.log"; exit 1; }
# 回归结束后顺序测量，不与本机其他测试争抢 CPU；测量的是隔离容器磁盘。
node tools/engineering/bench-auth-io.js "$OUT" > "$OUT/auth-io-benchmark.log" 2>&1
