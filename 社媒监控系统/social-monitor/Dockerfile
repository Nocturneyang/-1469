FROM node:18

WORKDIR /app

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV SKIP_CHROME_INSTALL=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Copy package files
COPY package*.json ./
COPY frontend/package*.json ./frontend/

# Install backend dependencies
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com

# Install frontend dependencies
WORKDIR /app/frontend
RUN npm ci --registry=https://registry.npmmirror.com

WORKDIR /app

# Install PM2 globally
RUN npm install -g pm2 --registry=https://registry.npmmirror.com

# Copy application files
COPY . .

# Build frontend after source files are copied
WORKDIR /app/frontend
RUN npm run build

WORKDIR /app

# Expose port
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start with PM2
CMD ["pm2-runtime", "start", "ecosystem.cloud.config.js"]
