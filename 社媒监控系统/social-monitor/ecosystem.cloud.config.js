module.exports = {
  apps: [
    {
      name: "worker-wa-wa_shebi",
      script: "./workers/worker-wa.js",
      max_memory_restart: "1G",
      cron_restart: "0 4 * * *",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      kill_timeout: 15000,
      restart_delay: 30000,
      max_restarts: 5,
      min_uptime: "2m",
      env: {
        NODE_ENV: "production",
        ACCOUNT_NAME: "wa_shebi",
        WA_ORCHESTRATOR_MANAGED_INIT: "true",
        PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium",
        PUPPETEER_SKIP_DOWNLOAD: "true"
      }
    },
    {
      name: "worker-tgu-tgu_supplier",
      script: "./workers/worker-tg-user.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        TG_ACCOUNT_NAME: "tgu_supplier",
        TG_WARMUP_SECONDS: "600",
        TG_DAILY_LIMIT: "2000",
        TG_BATCH_SIZE: "100",
        TG_SLEEP_MIN_MS: "3000",
        TG_SLEEP_MAX_MS: "8000",
        TG_BACKFILL_DAYS: "0",
        TG_ENABLE_BACKFILL: "true"
      }
    },
    {
      name: "worker-tgu-laffic_service",
      script: "./workers/worker-tg-user.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        TG_ACCOUNT_NAME: "laffic_service",
        TG_WARMUP_SECONDS: "600",
        TG_DAILY_LIMIT: "2000",
        TG_BATCH_SIZE: "100",
        TG_SLEEP_MIN_MS: "3000",
        TG_SLEEP_MAX_MS: "8000",
        TG_BACKFILL_DAYS: "0",
        TG_ENABLE_BACKFILL: "true"
      }
    },
    {
      name: "ui-server",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "384M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "sync-agent",
      script: "./sync-agent.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "wa-supervisor",
      script: "./workers/wa-supervisor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      restart_delay: 30000,
      max_restarts: 5,
      min_uptime: "2m",
      env: {
        NODE_ENV: "production",
        WA_RUNTIME_ADAPTER: "pm2"
      }
    },
    {
      name: "supplier-analyzer",
      script: "./analyzers/supplier-analyzer.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "issue-lifecycle-tracker",
      script: "./analyzers/issue-lifecycle-tracker.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "daily-digest",
      script: "./analyzers/daily-digest.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "supplier-reliability-scorer",
      script: "./analyzers/supplier-reliability-scorer.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "content-review-extractor",
      script: "./analyzers/content-review-extractor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "knowledge-extractor",
      script: "./analyzers/knowledge-extractor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "supplier-profiler",
      script: "./analyzers/supplier-profiler.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
