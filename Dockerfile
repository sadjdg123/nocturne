# 夜曲 Nocturne · 零依赖 Node.js 镜像（linux/amd64 + linux/arm64）
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

# su-exec：入口脚本修正 /data 权限后降权到非 root 的 node 用户；tzdata：日志时区
RUN apk add --no-cache su-exec tzdata

WORKDIR /app
COPY package.json server.js docker-entrypoint.sh ./
COPY public ./public
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
