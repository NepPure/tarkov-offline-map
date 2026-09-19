# 塔可夫地图 · 房间服务端
# 极轻量：单进程、纯内存（落盘可选）、运行时只有一个依赖 ws。
#
#   构建： docker build -t tarkov-room server/
#   运行： docker run -d --name tarkov-room -p 8787:8787 tarkov-room
#   带落盘：docker run -d -p 8787:8787 -e PERSIST=1 -v tarkov-room-data:/data tarkov-room
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app

# 只装运行时依赖：devDependencies 一律不装，镜像里就是 node 基础镜像 + 一个 ws
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY protocol.js server.js ./

# PERSIST=1 时写 /data。命名卷会继承这里的属主；bind mount 需要自己 chown 1000:1000
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
