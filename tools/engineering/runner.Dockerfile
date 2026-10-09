# 仅隔离验证使用；不含源码/凭据，不推送注册表。
FROM node:22-alpine
RUN apk add --no-cache git python3 coreutils findutils tar gzip dash iproute2 curl strace util-linux \
    && npm install --prefix /opt/nocturne-tests --no-package-lock jsdom@24.1.3
ENV CI=true JSDOM_PATH=/opt/nocturne-tests/node_modules/jsdom
WORKDIR /work
CMD ["sleep", "infinity"]
