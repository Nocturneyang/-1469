module.exports = {
  apps: [
    // Production baseline: Web/API, database consumers, collector receiver, and analyzers only.
    // WhatsApp Chrome collectors run on local machines and report through /api/collector/*.
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
        DATA_DIR: process.env.DATA_DIR || "/data",
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
        DATA_DIR: process.env.DATA_DIR || "/data",
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data",
        LOCAL_WA_RUNTIME_ENABLED: "false",
        COLLECTOR_TOKEN: process.env.COLLECTOR_TOKEN || "",
        SSO_ADMIN_USERS: process.env.SSO_ADMIN_USERS || "",
        SSO_REDIRECT_PARAM: process.env.SSO_REDIRECT_PARAM || "",
        SSO_USERINFO_URL: process.env.SSO_USERINFO_URL || ""
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
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
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data"
      }
    }
  ]
};
