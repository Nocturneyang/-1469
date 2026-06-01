const WA_COLLECTOR_ENV = {
  NODE_ENV: "production",
  COLLECTOR_API_URL: process.env.COLLECTOR_API_URL || "",
  COLLECTOR_TOKEN: process.env.COLLECTOR_TOKEN || "",
  COLLECTOR_OUTBOX_ENABLED: process.env.COLLECTOR_OUTBOX_ENABLED || "true",
  WA_ORCHESTRATOR_MANAGED_INIT: "true",
  WA_INIT_COOLDOWN_MS: "30000",
  WA_INIT_QUARANTINE_AFTER: "10",
  WA_INIT_QUARANTINE_MS: "60000",
  WA_INIT_HARD_TIMEOUT_MS: "360000",
  WA_AUTH_TIMEOUT_MS: "300000",
  WA_PROTOCOL_TIMEOUT_MS: "600000",
  WA_QR_IDLE_TIMEOUT_MS: "180000",
  PUPPETEER_SKIP_DOWNLOAD: "true"
};

function waCollector(accountName, priority = 50) {
  return {
    name: `worker-wa-${accountName}`,
    script: "./workers/worker-wa.js",
    max_memory_restart: "4G",
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
      ...WA_COLLECTOR_ENV,
      ACCOUNT_NAME: accountName,
      COLLECTOR_ID: process.env.COLLECTOR_ID || `local:${accountName}`,
      WA_ACCOUNT_PRIORITY: String(priority)
    }
  };
}

module.exports = {
  apps: [
    // Recommended local WA placement for the current resource split.
    waCollector("nanya_wa", 100),
    waCollector("wa_oumei2", 80),
    waCollector("wa_shebi", 70),

    // Keep local orchestration with the collectors; it must not run in production.
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
        WA_RUNTIME_ADAPTER: "pm2",
        WA_PM2_ECOSYSTEM_FILE: "ecosystem.local-collectors.config.js"
      }
    }
  ]
};
