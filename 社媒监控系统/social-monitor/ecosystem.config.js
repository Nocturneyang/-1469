module.exports = {
  "apps": [
    {
      "name": "worker-wa-nanya_wa",
      "script": "./workers/worker-wa.js",
      "max_memory_restart": "4G",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "kill_timeout": 12000,
      "restart_delay": 30000,
      "max_restarts": 5,
      "min_uptime": "2m",
      "env": {
        "NODE_ENV": "production",
        "WA_ORCHESTRATOR_MANAGED_INIT": "true",
        "WA_INIT_COOLDOWN_MS": "30000",
        "WA_INIT_QUARANTINE_AFTER": "10",
        "WA_INIT_QUARANTINE_MS": "60000",
        "WA_INIT_HARD_TIMEOUT_MS": "360000",
        "WA_AUTH_TIMEOUT_MS": "300000",
        "WA_PROTOCOL_TIMEOUT_MS": "600000",
        "WA_QR_IDLE_TIMEOUT_MS": "180000",
        "PUPPETEER_SKIP_DOWNLOAD": "true",
        "ACCOUNT_NAME": "nanya_wa"
      }
    },
    {
      "name": "worker-wa-yatai-wa",
      "script": "./workers/worker-wa.js",
      "max_memory_restart": "4G",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "kill_timeout": 12000,
      "restart_delay": 30000,
      "max_restarts": 5,
      "min_uptime": "2m",
      "env": {
        "NODE_ENV": "production",
        "WA_ORCHESTRATOR_MANAGED_INIT": "true",
        "WA_INIT_COOLDOWN_MS": "30000",
        "WA_INIT_QUARANTINE_AFTER": "10",
        "WA_INIT_QUARANTINE_MS": "60000",
        "WA_INIT_HARD_TIMEOUT_MS": "360000",
        "WA_AUTH_TIMEOUT_MS": "300000",
        "WA_PROTOCOL_TIMEOUT_MS": "600000",
        "WA_QR_IDLE_TIMEOUT_MS": "180000",
        "PUPPETEER_SKIP_DOWNLOAD": "true",
        "ACCOUNT_NAME": "yatai-wa"
      }
    },
    {
      "name": "worker-wa-wa_oumei2",
      "script": "./workers/worker-wa.js",
      "max_memory_restart": "4G",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "kill_timeout": 12000,
      "restart_delay": 30000,
      "max_restarts": 5,
      "min_uptime": "2m",
      "env": {
        "NODE_ENV": "production",
        "WA_ORCHESTRATOR_MANAGED_INIT": "true",
        "WA_INIT_COOLDOWN_MS": "30000",
        "WA_INIT_QUARANTINE_AFTER": "10",
        "WA_INIT_QUARANTINE_MS": "60000",
        "WA_INIT_HARD_TIMEOUT_MS": "360000",
        "WA_AUTH_TIMEOUT_MS": "300000",
        "WA_PROTOCOL_TIMEOUT_MS": "600000",
        "WA_QR_IDLE_TIMEOUT_MS": "180000",
        "PUPPETEER_SKIP_DOWNLOAD": "true",
        "ACCOUNT_NAME": "wa_oumei2"
      }
    },
    {
      "name": "worker-wa-wa_shebi",
      "script": "./workers/worker-wa.js",
      "max_memory_restart": "4G",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "kill_timeout": 12000,
      "restart_delay": 30000,
      "max_restarts": 5,
      "min_uptime": "2m",
      "env": {
        "NODE_ENV": "production",
        "WA_ORCHESTRATOR_MANAGED_INIT": "true",
        "WA_INIT_COOLDOWN_MS": "30000",
        "WA_INIT_QUARANTINE_AFTER": "10",
        "WA_INIT_QUARANTINE_MS": "60000",
        "WA_INIT_HARD_TIMEOUT_MS": "360000",
        "WA_AUTH_TIMEOUT_MS": "300000",
        "WA_PROTOCOL_TIMEOUT_MS": "600000",
        "WA_QR_IDLE_TIMEOUT_MS": "180000",
        "PUPPETEER_SKIP_DOWNLOAD": "true",
        "ACCOUNT_NAME": "wa_shebi"
      }
    },
    {
      "name": "worker-tgu-tgu_supplier",
      "script": "./workers/worker-tg-user.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "512M",
      "env": {
        "NODE_ENV": "production",
        "TG_ACCOUNT_NAME": "tgu_supplier",
        "TG_WARMUP_SECONDS": "600",
        "TG_DAILY_LIMIT": "2000",
        "TG_BATCH_SIZE": "100",
        "TG_SLEEP_MIN_MS": "3000",
        "TG_SLEEP_MAX_MS": "8000",
        "TG_BACKFILL_DAYS": "0",
        "TG_ENABLE_BACKFILL": "true"
      }
    },
    {
      "name": "worker-tgu-laffic_service",
      "script": "./workers/worker-tg-user.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "512M",
      "env": {
        "NODE_ENV": "production",
        "TG_ACCOUNT_NAME": "laffic_service",
        "ENABLE_WORKBENCH": "1",
        "ENABLE_WORKBENCH_SEND": "1",
        "ENABLE_WORKBENCH_SYNC": "1",
        "WORKBENCH_SEND_ACCOUNTS": "tgu-laffic_service",
        "WORKBENCH_SYNC_ACCOUNTS": "tgu-laffic_service",
        "WORKBENCH_DB_PATH": "/Users/a2026/Desktop/社媒监控/workbench/db/workbench.sqlite",
        "WORKBENCH_OUTBOX_DIR": "/Users/a2026/Desktop/社媒监控/workbench/outbox",
        "WORKBENCH_SEND_POLL_MS": "30000",
        "WORKBENCH_CHANNEL_SYNC_INTERVAL_MS": "900000",
        "TG_WARMUP_SECONDS": "600",
        "TG_DAILY_LIMIT": "2000",
        "TG_BATCH_SIZE": "100",
        "TG_SLEEP_MIN_MS": "3000",
        "TG_SLEEP_MAX_MS": "8000",
        "TG_BACKFILL_DAYS": "0",
        "TG_ENABLE_BACKFILL": "true"
      }
    },
    {
      "name": "worker-wa-yuyin_wa",
      "script": "./workers/worker-wa.js",
      "max_memory_restart": "4G",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "kill_timeout": 15000,
      "restart_delay": 30000,
      "max_restarts": 5,
      "min_uptime": "2m",
      "env": {
        "NODE_ENV": "production",
        "DATA_DIR": "/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor",
        "ACCOUNT_NAME": "yuyin_wa",
        "WA_ORCHESTRATOR_MANAGED_INIT": "true",
        "WA_INIT_COOLDOWN_MS": "30000",
        "WA_INIT_QUARANTINE_AFTER": "10",
        "WA_INIT_QUARANTINE_MS": "60000",
        "WA_INIT_HARD_TIMEOUT_MS": "360000",
        "WA_AUTH_TIMEOUT_MS": "300000",
        "WA_PROTOCOL_TIMEOUT_MS": "600000",
        "WA_QR_IDLE_TIMEOUT_MS": "180000",
        "PUPPETEER_SKIP_DOWNLOAD": "true",
        "COLLECTOR_API_URL": "https://social-monitor.tyhark.com",
        ...(process.env.COLLECTOR_TOKEN ? { "COLLECTOR_TOKEN": process.env.COLLECTOR_TOKEN } : {}),
        "COLLECTOR_ID": "pm2:yuyin_wa"
      }
    },
    // --- Web UI Server ---
    {
      "name": "ui-server",
      "script": "./server.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "512M",
      "env": {
        "NODE_ENV": "production",
        ...(process.env.JWT_SECRET ? { "JWT_SECRET": process.env.JWT_SECRET } : {})
      }
    },
    {
      "name": "sync-agent",
      "script": "./sync-agent.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "wa-supervisor",
      "script": "./workers/wa-supervisor.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "restart_delay": 30000,
      "max_restarts": 5,
      "min_uptime": "2m",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "supplier-analyzer",
      "script": "./analyzers/supplier-analyzer.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "512M",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "issue-lifecycle-tracker",
      "script": "./analyzers/issue-lifecycle-tracker.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "daily-digest",
      "script": "./analyzers/daily-digest.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "supplier-reliability-scorer",
      "script": "./analyzers/supplier-reliability-scorer.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "content-review-extractor",
      "script": "./analyzers/content-review-extractor.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "knowledge-extractor",
      "script": "./analyzers/knowledge-extractor.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "name": "knowledge-asset-analyzer",
      "script": "./analyzers/knowledge-asset-analyzer.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production",
        "KNOWLEDGE_ASSET_START_FROM_NOW": "true",
        "KNOWLEDGE_ASSET_SCAN_INTERVAL_MS": "60000"
      }
    },
    {
      "name": "supplier-profiler",
      "script": "./analyzers/supplier-profiler.js",
      "instances": 1,
      "exec_mode": "fork",
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "256M",
      "env": {
        "NODE_ENV": "production"
      }
    }
  ]
};
