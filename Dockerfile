# 零依赖 Node 应用，镜像可以很小
FROM node:22-alpine

WORKDIR /app

# 先拷清单（本项目没有依赖，但保留这层便于以后扩展）
COPY package.json ./
# 如果将来加了依赖，取消下面两行的注释
# RUN npm ci --omit=dev

COPY server ./server
COPY web ./web

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# 非 root 运行
USER node

CMD ["node", "server/index.mjs"]
