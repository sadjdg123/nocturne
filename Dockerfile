# 夜曲 Nocturne · 零依赖 Node.js 镜像（linux/amd64 + linux/arm64）
FROM node:22-alpine

# TZ：日志按本地时间（带时区偏移）输出，改 TZ 环境变量即可
# UV_THREADPOOL_SIZE：DNS 解析走 libuv 线程池（默认 4），状态探测并发 8，坏域名不再拖慢配置读写
# PUID / PGID：容器内运行用户的 uid / gid（群晖常见 1026 / 100），入口脚本会改好 node 用户并 chown /data
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai \
    UV_THREADPOOL_SIZE=16 \
    PUID=1000 \
    PGID=1000

# su-exec：入口脚本修正 /data 权限后降权到非 root 的 node 用户；tzdata：让 TZ 生效（日志本地时间）
RUN apk add --no-cache su-exec tzdata

WORKDIR /app
COPY package.json server.js auth-store.js docker-entrypoint.sh ./
COPY public ./public
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
