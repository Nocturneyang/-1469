FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    WORKBENCH_DB_DIR=/data/db \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com

COPY . .

RUN npm run build

RUN npm install -g pm2 --registry=https://registry.npmmirror.com && \
    chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
