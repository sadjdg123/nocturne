#!/bin/sh
# 唯一输出为本地镜像与日志；没有 login/push/注册表导出路径。
set -eu
ARCH=${1:?amd64 或 arm64}; OUT=${2:?日志目录}
case "$ARCH" in amd64|arm64) ;; *) echo '架构不允许' >&2; exit 2 ;; esac
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd -P)
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P); cd "$ROOT"
node tools/engineering/check-ci.js --docker
REV=$(git rev-parse HEAD)
IMAGE="nocturne-engineering:$ARCH-$REV"
RUNNER="nocturne-engineering-runner:$ARCH"
NAME="nc-engineering-$ARCH-$$"
cleanup() { nc_rc=$?; trap - EXIT INT TERM; docker cp "$NAME:/evidence/." "$OUT" 2>/dev/null || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; exit "$nc_rc"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
docker buildx build --platform "linux/$ARCH" --load --label "org.opencontainers.image.revision=$REV" --tag "$IMAGE" --metadata-file "$OUT/build.json" --progress plain . > "$OUT/build.log" 2>&1
node tools/engineering/container-smoke.js "$IMAGE" "$ARCH" "$OUT"
docker buildx build --platform "linux/$ARCH" --load --tag "$RUNNER" --progress plain --file tools/engineering/runner.Dockerfile . > "$OUT/runner-build.log" 2>&1
# 仅在临时容器网络命名空间授予 NET_ADMIN，供 RFC1918 回环测试使用；没有 Docker socket/宿主目录挂载。
node tools/engineering/registry-integration.js "$RUNNER" "$OUT"
# 合成夹具 nas.local 指向容器自身的回环别名，消除外部 DNS 等待；不联系真实 NAS。
docker create --platform "linux/$ARCH" --name "$NAME" --cap-add NET_ADMIN --network none --add-host nas.local:192.168.77.11 "$RUNNER" >/dev/null
docker cp . "$NAME:/work"
docker start "$NAME" >/dev/null
docker exec "$NAME" sh tools/engineering/linux-suite.sh /evidence
