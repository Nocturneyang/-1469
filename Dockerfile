FROM node:20-slim

WORKDIR /app/social-monitor

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    DATA_DIR=/data \
    SKIP_CHROME_INSTALL=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_CACHE_DIR=/root/.cache/puppeteer \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright

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
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY 社媒监控系统/social-monitor/package*.json ./
COPY 社媒监控系统/social-monitor/scripts/install-chrome.js ./scripts/install-chrome.js

RUN npm ci --omit=dev --registry=https://registry.npmmirror.com

WORKDIR /app
COPY 社媒监控系统/social-monitor ./social-monitor
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

WORKDIR /app/social-monitor
RUN npm install -g pm2 --registry=https://registry.npmmirror.com

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/docker-entrypoint.sh"]
