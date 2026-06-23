function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

const analyticsMaintenanceMode = envFlag('ANALYTICS_MAINTENANCE_MODE') ||
  envFlag('DB_MAINTENANCE_MODE') ||
  envFlag('DB_DEGRADED_BOOT');

const apps = [
    // Production baseline: Web/API, database consumers, collector receiver, and analyzers only.
    // WhatsApp Chrome collectors run on local machines and report through /api/collector/*.
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
        JWT_SECRET: process.env.JWT_SECRET || "",
        DB_DEGRADED_BOOT: process.env.DB_DEGRADED_BOOT || "0",
        DB_MAINTENANCE_MODE: process.env.DB_MAINTENANCE_MODE || "",
        DB_READONLY_MODE: process.env.DB_READONLY_MODE || "",
        COLLECTOR_WRITE_DISABLED: process.env.COLLECTOR_WRITE_DISABLED || "",
        ANALYTICS_MAINTENANCE_MODE: process.env.ANALYTICS_MAINTENANCE_MODE || "",
        LOCAL_WA_RUNTIME_ENABLED: "false",
        LOCAL_TG_RUNTIME_ENABLED: "false",
        CLOUD_COLLECTOR_ENABLED: process.env.CLOUD_COLLECTOR_ENABLED || "",
        CLOUD_COLLECTOR_IMAGE: process.env.CLOUD_COLLECTOR_IMAGE || "",
        CLOUD_COLLECTOR_API_URL: process.env.CLOUD_COLLECTOR_API_URL || "http://social-monitor/api/collector",
        CLOUD_COLLECTOR_SECRET_NAME: process.env.CLOUD_COLLECTOR_SECRET_NAME || "social-monitor-secrets",
        CLOUD_COLLECTOR_PVC: process.env.CLOUD_COLLECTOR_PVC || "social-monitor-sqlite-pvc",
        ACCOUNT_SESSION_ENCRYPTION_KEY: process.env.ACCOUNT_SESSION_ENCRYPTION_KEY || "",
        COLLECTOR_TOKEN: process.env.COLLECTOR_TOKEN || "",
        SSO_ENABLED: process.env.SSO_ENABLED || "",
        SSO_LOGIN_URL: process.env.SSO_LOGIN_URL || "",
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
      name: "cloud-collector-supervisor",
      script: "./workers/cloud-collector-supervisor.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data",
        CLOUD_COLLECTOR_ENABLED: process.env.CLOUD_COLLECTOR_ENABLED || "",
        CLOUD_COLLECTOR_IMAGE: process.env.CLOUD_COLLECTOR_IMAGE || "",
        CLOUD_COLLECTOR_API_URL: process.env.CLOUD_COLLECTOR_API_URL || "http://social-monitor/api/collector",
        CLOUD_COLLECTOR_SECRET_NAME: process.env.CLOUD_COLLECTOR_SECRET_NAME || "social-monitor-secrets",
        CLOUD_COLLECTOR_PVC: process.env.CLOUD_COLLECTOR_PVC || "social-monitor-sqlite-pvc",
        ACCOUNT_SESSION_ENCRYPTION_KEY: process.env.ACCOUNT_SESSION_ENCRYPTION_KEY || ""
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
      name: "knowledge-asset-analyzer",
      script: "./analyzers/knowledge-asset-analyzer.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        DATA_DIR: process.env.DATA_DIR || "/data",
        KNOWLEDGE_ASSET_START_FROM_NOW: "false",
        KNOWLEDGE_ASSET_BATCH_SIZE: "250",
        KNOWLEDGE_ASSET_SCAN_INTERVAL_MS: "120000",
        KNOWLEDGE_ASSET_AUTO_PROMOTE_BATCH: "25",
        KNOWLEDGE_ASSET_ACTION_EFFECT_BATCH: "10",
        KNOWLEDGE_ASSET_ENRICH_BATCH: "100"
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
  ];

module.exports = {
  apps: analyticsMaintenanceMode
    ? apps.filter((app) => app.name === "ui-server")
    : apps
};
