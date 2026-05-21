FROM node:18

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY frontend/package*.json ./frontend/

# Install backend dependencies
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com

# Install frontend dependencies and build
WORKDIR /app/frontend
RUN npm ci --registry=https://registry.npmmirror.com
RUN npm run build

WORKDIR /app

# Install PM2 globally
RUN npm install -g pm2 --registry=https://registry.npmmirror.com

# Copy application files
COPY . .

# Expose port
EXPOSE 3000

# Start with PM2
CMD ["pm2-runtime", "start", "ecosystem.cloud.config.js"]
